import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_SCRIPT = path.resolve(__dirname, '..', 'telegram_helper.py');

const config = {
	apiId: process.env.TELEGRAM_API_ID ?? '',
	apiHash: process.env.TELEGRAM_API_HASH ?? '',
	sessionString: process.env.TELEGRAM_SESSION_STRING ?? '',
	authToken: process.env.MCP_AUTH_TOKEN ?? '',
	port: Number.parseInt(process.env.PORT ?? '3001', 10),
};

interface ToolArguments {
	message?: string;
	timeout_seconds?: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const transports = new Map<string, { transport: StreamableHTTPServerTransport; lastAccess: number }>();

function cleanupStaleSessions(): void {
	const now = Date.now();
	for (const [sessionId, session] of transports) {
		if (now - session.lastAccess > SESSION_TTL_MS) {
			session.transport.close().catch(() => {});
			transports.delete(sessionId);
		}
	}
}

setInterval(cleanupStaleSessions, 5 * 60 * 1000);

async function callTelegramHelper(message: string, timeoutSeconds: number): Promise<string> {
	const args = JSON.stringify({
		api_id: config.apiId,
		api_hash: config.apiHash,
		session_string: config.sessionString,
		message,
		timeout_seconds: timeoutSeconds,
	});

	const maxExec = (timeoutSeconds + 60) * 1000;

	try {
		const { stdout, stderr } = await execFileAsync('python3', [HELPER_SCRIPT, args], {
			timeout: maxExec,
			maxBuffer: 10 * 1024 * 1024,
		});

		if (stderr) {
			process.stderr.write(`[telegram-helper stderr] ${stderr}\n`);
		}

		const result = JSON.parse(stdout.trim());
		if (result.error) {
			return `Error: ${result.error}`;
		}
		return result.result;
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return `Error calling Telegram helper: ${message}`;
	}
}

function createMcpServer(): Server {
	const server = new Server(
		{ name: 'telegram-mcp-server', version: '1.0.0' },
		{ capabilities: { tools: {} } }
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'telegram_send_and_wait',
				description:
					'Send a command message to the @NSHClawBot Telegram bot and wait for the complete response. ' +
					'The bot may reply with a burst of sequential messages as it streams its response. ' +
					'This tool collects all messages until the bot stops sending (5 seconds of silence) ' +
					'and returns them concatenated as a single string.',
				inputSchema: {
					type: 'object',
					properties: {
						message: {
							type: 'string',
							description: 'The command message to send to @NSHClawBot',
						},
						timeout_seconds: {
							type: 'number',
							description:
								'Maximum seconds to wait for the first response before considering the bot unresponsive (default: 120)',
						},
					},
					required: ['message'],
				},
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async request => {
		const { name, arguments: args } = request.params;
		const typedArgs = (args ?? {}) as ToolArguments;

		if (name !== 'telegram_send_and_wait') {
			throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
		}

		if (!typedArgs.message) {
			throw new McpError(ErrorCode.InvalidParams, 'message is required');
		}

		const timeout = typedArgs.timeout_seconds ?? 120;
		const result = await callTelegramHelper(typedArgs.message, timeout);

		return { content: [{ type: 'text', text: result }] };
	});

	return server;
}

async function main(): Promise<void> {
	const app = express();
	app.use((req, res, next) => {
		if (req.path === '/mcp') return next();
		express.json()(req, res, next);
	});

	// Auth middleware for /mcp
	const authMiddleware = (req: Request, res: Response, next: () => void): void => {
		if (req.path !== '/mcp') {
			next();
			return;
		}

		const authHeader = req.headers.authorization;
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			res.status(401).json({ error: 'Missing or invalid Authorization header' });
			return;
		}

		const token = authHeader.slice(7);
		if (token !== config.authToken) {
			res.status(403).json({ error: 'Invalid auth token' });
			return;
		}

		next();
	};

	app.use(authMiddleware);

	app.get('/health', (_req: Request, res: Response) => {
		res.json({ status: 'ok' });
	});

	app.all('/mcp', async (req: Request, res: Response) => {
		const sessionId = req.headers['mcp-session-id'] as string | undefined;

		if (req.method === 'DELETE' && sessionId && transports.has(sessionId)) {
			const session = transports.get(sessionId)!;
			await session.transport.close();
			transports.delete(sessionId);
			res.status(200).send('Session closed');
			return;
		}

		if (req.method === 'POST') {
			let transport: StreamableHTTPServerTransport;

			if (sessionId && transports.has(sessionId)) {
				const session = transports.get(sessionId)!;
				session.lastAccess = Date.now();
				transport = session.transport;
			} else if (sessionId) {
				process.stderr.write(`Session ${sessionId} not found, sending 404 to force re-init\n`);
				res.status(404).json({ error: 'Session not found. Please re-initialize.' });
				return;
			} else {
				transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => crypto.randomUUID(),
					onsessioninitialized: newSessionId => {
						transports.set(newSessionId, { transport, lastAccess: Date.now() });
						process.stderr.write(`New session created: ${newSessionId}\n`);
					},
				});

				const server = createMcpServer();
				await server.connect(transport);
			}

			await transport.handleRequest(req, res);
			return;
		}

		res.status(405).send('Method not allowed');
	});

	const server = app.listen(config.port, '0.0.0.0', () => {
		process.stdout.write(`Telegram MCP server running on http://0.0.0.0:${config.port}\n`);
	});

	const shutdown = (): void => {
		process.stdout.write('\nShutting down...\n');
		for (const [, session] of transports) {
			session.transport.close().catch(() => {});
		}
		transports.clear();
		server.close(() => process.exit(0));
	};

	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}

main().catch(error => {
	process.stderr.write(`Fatal error: ${error}\n`);
	process.exit(1);
});
