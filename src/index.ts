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
	port: Number.parseInt(process.env.PORT ?? '3001', 10),
};

interface ToolArguments {
	message?: string;
	timeout_seconds?: number;
	limit?: number;
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

async function callTelegramHelper(args: Record<string, unknown>, timeoutMs: number): Promise<string> {
	const payload = JSON.stringify({
		api_id: config.apiId,
		api_hash: config.apiHash,
		session_string: config.sessionString,
		...args,
	});

	try {
		const { stdout, stderr } = await execFileAsync('python3', [HELPER_SCRIPT, payload], {
			timeout: timeoutMs,
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
		const msg = error instanceof Error ? error.message : 'Unknown error';
		return `Error calling Telegram helper: ${msg}`;
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
					'Send a command to @NSHClawBot and wait for the complete response. ' +
					'Uses an end-of-transmission (EOT) protocol: watches for a checkmark emoji ' +
					'as termination signal in the bot\'s final message, then returns immediately. ' +
					'Falls back to a 30-second idle timer if EOT is not received. ' +
					'Hard timeout at 120 seconds (configurable) triggers a diagnostic ping. ' +
					'All collected messages are concatenated chronologically. The EOT marker is always stripped before returning.',
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
			{
				name: 'telegram_get_history',
				description:
					'Read the last N messages from the @NSHClawBot chat. ' +
					'Returns formatted messages with sender, timestamp, and text. ' +
					'Useful for reading truncated responses or checking recent activity without sending a new command.',
				inputSchema: {
					type: 'object',
					properties: {
						limit: {
							type: 'number',
							description: 'Number of recent messages to retrieve (default: 10)',
						},
					},
				},
			},
			{
				name: 'telegram_send_message',
				description:
					'Fire-and-forget: send a message to @NSHClawBot and return immediately after send confirmation. ' +
					'No polling, no waiting for a response. Useful for quick commands where a blocking response is not needed.',
				inputSchema: {
					type: 'object',
					properties: {
						message: {
							type: 'string',
							description: 'The message to send to @NSHClawBot',
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

		switch (name) {
			case 'telegram_send_and_wait': {
				if (!typedArgs.message) {
					throw new McpError(ErrorCode.InvalidParams, 'message is required');
				}
				const timeout = typedArgs.timeout_seconds ?? 120;
				const result = await callTelegramHelper(
					{ command: 'send_and_wait', message: typedArgs.message, timeout_seconds: timeout },
					(timeout + 60) * 1000,
				);
				return { content: [{ type: 'text', text: result }] };
			}

			case 'telegram_get_history': {
				const limit = typedArgs.limit ?? 10;
				const result = await callTelegramHelper(
					{ command: 'get_history', limit },
					30_000,
				);
				return { content: [{ type: 'text', text: result }] };
			}

			case 'telegram_send_message': {
				if (!typedArgs.message) {
					throw new McpError(ErrorCode.InvalidParams, 'message is required');
				}
				const result = await callTelegramHelper(
					{ command: 'send_message', message: typedArgs.message },
					30_000,
				);
				return { content: [{ type: 'text', text: result }] };
			}

			default:
				throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
		}
	});

	return server;
}

async function main(): Promise<void> {
	const app = express();
	app.use((req, res, next) => {
		if (req.path === '/mcp') return next();
		express.json()(req, res, next);
	});

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
