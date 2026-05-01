import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
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
	history_limit?: number;
	job_id?: string;
}

// --- Job system ---
interface Job {
	id: string;
	status: 'pending' | 'completed' | 'error';
	result?: string;
	createdAt: number;
}

const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
const jobs = new Map<string, Job>();

function cleanupStaleJobs(): void {
	const now = Date.now();
	for (const [id, job] of jobs) {
		if (now - job.createdAt > JOB_TTL_MS) {
			jobs.delete(id);
		}
	}
}

setInterval(cleanupStaleJobs, 5 * 60 * 1000);

// Serial queue — Telethon session can only have one active connection at a time
const jobQueue: Array<{ job: Job; args: Record<string, unknown> }> = [];
let jobRunning = false;

function runNextJob(): void {
	if (jobRunning || jobQueue.length === 0) return;
	jobRunning = true;

	const { job, args } = jobQueue.shift()!;
	const payload = JSON.stringify({
		api_id: config.apiId,
		api_hash: config.apiHash,
		session_string: config.sessionString,
		...args,
	});

	const child = spawn('python3', [HELPER_SCRIPT, payload], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let stdout = '';
	let stderr = '';

	child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
	child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

	child.on('close', () => {
		if (stderr) {
			process.stderr.write(`[telegram-helper job=${job.id} stderr] ${stderr}\n`);
		}

		try {
			const parsed = JSON.parse(stdout.trim());
			if (parsed.error) {
				job.status = 'error';
				job.result = `Error: ${parsed.error}`;
			} else {
				job.status = 'completed';
				job.result = parsed.result;
			}
		} catch {
			job.status = 'error';
			job.result = `Error: Failed to parse helper output: ${stdout.slice(0, 200)}`;
		}

		jobRunning = false;
		runNextJob();
	});

	child.on('error', (err: Error) => {
		job.status = 'error';
		job.result = `Error: Failed to spawn helper: ${err.message}`;
		jobRunning = false;
		runNextJob();
	});
}

function launchJob(args: Record<string, unknown>): string {
	const jobId = crypto.randomUUID().slice(0, 8);
	const job: Job = { id: jobId, status: 'pending', createdAt: Date.now() };
	jobs.set(jobId, job);
	jobQueue.push({ job, args });
	runNextJob();
	return jobId;
}

// --- Synchronous helper for short-lived tools ---
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

// --- MCP sessions ---
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
					'Send a new task or command to @NSHClawBot. Returns a job token immediately (does NOT block). ' +
					'Use telegram_poll with the returned job_id to check for the result. ' +
					'Claude should call telegram_poll every 20-30 seconds until the result arrives. ' +
					'This async pattern survives proxy timeouts on long-running operations. ' +
					'Use this for fresh instructions where no prior context is needed.',
				inputSchema: {
					type: 'object',
					properties: {
						message: {
							type: 'string',
							description: 'The command message to send to @NSHClawBot',
						},
						timeout_seconds: {
							type: 'number',
							description: 'Hard timeout in seconds before diagnostic ping (default: 300)',
						},
					},
					required: ['message'],
				},
			},
			{
				name: 'telegram_context_and_send',
				description:
					'Send a follow-up instruction to @NSHClawBot with conversation context. Returns a job token immediately. ' +
					'Prepends [WITH CONTEXT n] to the message — OpenClaw reads its own chat history locally on Oracle. ' +
					'Use telegram_poll with the returned job_id to check for the result. ' +
					'Use this when iterating on an existing task so OpenClaw has context from the prior exchange.',
				inputSchema: {
					type: 'object',
					properties: {
						message: {
							type: 'string',
							description: 'The follow-up instruction to send to @NSHClawBot',
						},
						history_limit: {
							type: 'number',
							description: 'Number of recent messages to include as context (default: 10)',
						},
						timeout_seconds: {
							type: 'number',
							description: 'Hard timeout in seconds before diagnostic ping (default: 300)',
						},
					},
					required: ['message'],
				},
			},
			{
				name: 'telegram_poll',
				description:
					'Poll for the result of a previously submitted job from telegram_send_and_wait or telegram_context_and_send. ' +
					'Returns {status: "pending"} if the bot has not finished yet, or the full concatenated response if complete. ' +
					'Call this every 20-30 seconds after submitting a job until you get a completed result.',
				inputSchema: {
					type: 'object',
					properties: {
						job_id: {
							type: 'string',
							description: 'The job_id returned by telegram_send_and_wait or telegram_context_and_send',
						},
					},
					required: ['job_id'],
				},
			},
			{
				name: 'telegram_status',
				description:
					'Quick pulse check on @NSHClawBot. Sends a short status query and returns whatever comes back within 30 seconds. ' +
					'Use this to check if the bot is alive and what it is currently working on before sending a new task. ' +
					'This tool returns synchronously (not a job) since it completes quickly.',
				inputSchema: {
					type: 'object',
					properties: {},
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
				const timeout = typedArgs.timeout_seconds ?? 300;
				const jobId = launchJob({
					command: 'send_and_wait',
					message: typedArgs.message,
					timeout_seconds: timeout,
				});
				return {
					content: [{
						type: 'text',
						text: `Job submitted. Use telegram_poll with job_id "${jobId}" to get the result.`,
					}],
				};
			}

			case 'telegram_context_and_send': {
				if (!typedArgs.message) {
					throw new McpError(ErrorCode.InvalidParams, 'message is required');
				}
				const timeout = typedArgs.timeout_seconds ?? 300;
				const historyLimit = typedArgs.history_limit ?? 10;
				const jobId = launchJob({
					command: 'context_and_send',
					message: typedArgs.message,
					history_limit: historyLimit,
					timeout_seconds: timeout,
				});
				return {
					content: [{
						type: 'text',
						text: `Job submitted. Use telegram_poll with job_id "${jobId}" to get the result.`,
					}],
				};
			}

			case 'telegram_poll': {
				if (!typedArgs.job_id) {
					throw new McpError(ErrorCode.InvalidParams, 'job_id is required');
				}
				const job = jobs.get(typedArgs.job_id);
				if (!job) {
					return {
						content: [{
							type: 'text',
							text: `Error: Job "${typedArgs.job_id}" not found. It may have expired or the server was restarted.`,
						}],
					};
				}
				if (job.status === 'pending') {
					const elapsed = Math.round((Date.now() - job.createdAt) / 1000);
					return {
						content: [{
							type: 'text',
							text: `Job "${job.id}" is still pending (${elapsed}s elapsed). Poll again in 20-30 seconds.`,
						}],
					};
				}
				// Completed or error — return result and clean up
				const result = job.result ?? '';
				jobs.delete(job.id);
				return { content: [{ type: 'text', text: result }] };
			}

			case 'telegram_status': {
				const result = await callTelegramHelper(
					{ command: 'status' },
					60_000,
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
		res.json({ status: 'ok', pending_jobs: [...jobs.values()].filter(j => j.status === 'pending').length });
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

	server.timeout = 0;
	server.keepAliveTimeout = 300_000;
	server.headersTimeout = 305_000;

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
