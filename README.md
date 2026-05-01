# Telegram MCP Server

A Model Context Protocol (MCP) server that lets Claude send commands to a Telegram bot and collect the complete response — even when the bot streams its reply across multiple sequential messages. Async job pattern survives proxy timeouts on long-running operations.

Designed to be hosted remotely and used as a custom connector in Claude.ai on any device (desktop, mobile, web).

Built by [Neal Shankar](https://nealshankar.com). Architecture modeled after [NealShankarGit/whoop-mcp-server](https://github.com/NealShankarGit/whoop-mcp-server).

## Problem

Telegram bots that stream responses send them as a burst of sequential messages rather than a single reply. Long-running operations can take minutes, but proxy timeouts (claude.ai, Cloudflare, nginx) kill blocking HTTP connections after 60-120 seconds. There's no native way for Claude to send a command to a Telegram bot and reliably get the full response back.

## Solution

Async job pattern: `telegram_send_and_wait` returns a job token immediately, then Claude polls with `telegram_poll` every 20-30 seconds. Each poll returns in under 5 seconds — the long-running work happens server-side between polls. Combined with EOT detection (checkmark emoji) and lenient nonce matching, the tool reliably captures the full response regardless of how long it takes.

## MCP Tools

| Tool | When to use | Returns | Description |
|------|-------------|---------|-------------|
| `telegram_send_and_wait` | New tasks | Job token (async) | Send command, get job_id, poll for result |
| `telegram_context_and_send` | Iterating on existing work | Job token (async) | Prepend `[WITH CONTEXT n]`, same async pattern |
| `telegram_poll` | After send_and_wait or context_and_send | Result or "pending" | Check if a job has completed |
| `telegram_status` | Pulse checks | Sync response | Quick 30s status query |
| `telegram_get_history` | Reading past messages | Sync response | Fetch last N messages |
| `telegram_send_message` | Fire-and-forget | Sync confirmation | Send without waiting |

### `telegram_send_and_wait`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | string | Yes | — | The command message to send to @NSHClawBot |
| `timeout_seconds` | number | No | 300 | Hard timeout before diagnostic ping |

Returns immediately with a job_id. Use `telegram_poll` to get the result.

### `telegram_context_and_send`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | string | Yes | — | The follow-up instruction to send |
| `history_limit` | number | No | 10 | Number of recent messages OpenClaw should fetch as context |
| `timeout_seconds` | number | No | 300 | Hard timeout before diagnostic ping |

The message is sent as `[WITH CONTEXT 10] Your instruction here`. OpenClaw strips the prefix, fetches the last N messages from its own Telegram chat locally, prepends them as context, then executes. Context never travels through Telegram — it stays on Oracle.

### `telegram_poll`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `job_id` | string | Yes | — | The job_id returned by send_and_wait or context_and_send |

Returns the full concatenated response when the job is complete, or a "pending" message with elapsed time if still running. Call every 20-30 seconds.

### `telegram_status`

No parameters. Sends a fixed status query, returns within 30 seconds. Synchronous — no job pattern needed.

### `telegram_get_history`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | number | No | 10 | Number of recent messages to retrieve |

### `telegram_send_message`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | string | Yes | — | The message to send to @NSHClawBot |

## Async Job Pattern

```
Claude                        MCP Server                    Telegram
  |                              |                              |
  |-- send_and_wait(msg) ------->|                              |
  |<-- job_id: "a3f7b2" --------|-- spawn Python helper ------>|
  |                              |   (runs in background)       |-- send msg -->
  |   (wait 20-30s)             |                              |
  |-- poll(a3f7b2) ------------>|                              |
  |<-- "pending (25s)" ---------|   (helper still polling)     |<-- reply 1 --
  |                              |                              |<-- reply 2 --
  |   (wait 20-30s)             |                              |<-- reply 3 + EOT
  |-- poll(a3f7b2) ------------>|                              |
  |<-- "Full result here" ------|   (helper finished)          |
  |                              |                              |
```

Each individual HTTP call returns in under 5 seconds. The Python helper runs server-side between polls, immune to proxy timeouts.

Jobs are stored in memory with a 30-minute TTL and cleaned up every 5 minutes.

## End-of-Transmission (EOT) Protocol

### 1. EOT Signal with Lenient Nonce Matching (primary path)

Each outgoing message is prepended with a unique 6-character hex nonce: `[req:a3f7b2] Your instruction here`.

When the server sees a message ending with the checkmark:

- **Nonce matched**: if any collected message contains `[req:XXXXXX]`, return immediately
- **Bare EOT (no nonce)**: start a 5-second grace window — if the nonce arrives in a subsequent message within 5s, return immediately; if not, accept the bare EOT after the grace period

This lenient matching prevents hangs when the bot doesn't echo the nonce while still using nonces as tiebreakers for concurrent sessions.

Both the nonce tag and EOT marker are **always stripped** before returning.

### 2. Hard Timeout (safety net)

If `timeout_seconds` (default 300) elapses with no EOT detected:

1. A diagnostic ping is sent: _"Previous command may not have completed — are you still running?"_
2. Waits an additional 30 seconds
3. If any messages were collected, returns them concatenated (partial result)
4. If nothing was collected, returns an error with troubleshooting instructions

### Bot-Side Configuration

OpenClaw's `AGENTS.md` has been updated with:
- **EOT rule**: append the checkmark only to the final completion message
- **Nonce rule**: when a message starts with `[req:XXXXXX]`, include `[req:XXXXXX]` in the final message before the checkmark
- **Context rule**: when a message starts with `[WITH CONTEXT n]`, strip the prefix, fetch the last n messages locally, prepend as context, then execute

## Architecture

```
+--------------------------------------------------+
|           Telegram MCP Server                    |
|                                                  |
|  +-------------+      +------------------+      |
|  | MCP Server  |      | Python Helpers   |      |
|  | (Streamable |      | (Telethon)       |      |
|  |  HTTP)      |      |                  |      |
|  | Express +   |      | Background jobs: |      |
|  | TypeScript  |----->|  - Send & wait   |      |
|  |             |      |  - Context+send  |      |
|  | Job store   |      |                  |      |
|  | (in-memory) |      | Sync calls:      |      |
|  +-------------+      |  - Status check  |      |
|                       |  - Get history   |      |
|                       |  - Send message  |      |
|                       +------------------+      |
|                              |                   |
|                              v                   |
|                       +------------------+      |
|                       |  Telegram API    |      |
|                       |  (MTProto)       |      |
|                       +------------------+      |
+--------------------------------------------------+
         |
         v
+--------------------------------------------------+
|  Claude.ai Custom Connector                     |
|  Desktop - Mobile - Web                          |
|  "Send /status to OpenClaw"                      |
+--------------------------------------------------+
```

### Why Python + Telethon?

The Telegram session string was generated by the [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) Python library using Telethon. TypeScript Telegram clients (GramJS, etc.) cannot natively consume Telethon session strings. Rather than fight the session format, the server calls a small Python helper script that uses Telethon directly — clean separation, zero compatibility issues.

## Setup

### 1. Generate a Telegram Session String

Use the [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) library or any Telethon-based script to generate a session string for your Telegram user account.

You'll need:
- A Telegram API ID and API Hash from [my.telegram.org](https://my.telegram.org)
- A logged-in Telegram account (not a bot token — this uses the user API to read bot replies)

### 2. Install Dependencies

```bash
git clone https://github.com/NealShankarGit/telegram-mcp-server.git
cd telegram-mcp-server
npm install
pip3 install telethon
```

### 3. Configure Environment

Create a `.env` file:

```env
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_SESSION_STRING=your_session_string
PORT=3001
```

### 4. Build and Run

```bash
npm run build
node dist/index.js
```

### 5. Production Deployment (systemd + Nginx)

Create a systemd service at `/etc/systemd/system/telegram-mcp.service`:

```ini
[Unit]
Description=Telegram MCP Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/telegram-mcp-server
ExecStart=/usr/bin/node dist/index.js
Restart=always
EnvironmentFile=/opt/telegram-mcp-server/.env

[Install]
WantedBy=multi-user.target
```

Nginx reverse proxy:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_connect_timeout 10s;
    }
}
```

> **Note:** The proxy timeouts are set high as a safety margin, but the async job pattern means no individual HTTP request blocks for more than a few seconds. The long timeouts are mainly relevant for `telegram_status` and other synchronous tools.

Then add SSL and enable:

```bash
certbot --nginx -d your-domain.com
systemctl daemon-reload
systemctl enable telegram-mcp
systemctl start telegram-mcp
```

### 6. Connect to Claude

1. Go to Claude.ai → Settings → Integrations
2. Click "Add custom integration"
3. Enter your server URL: `https://your-domain.com/mcp`
4. No authentication required — the server accepts direct connections
5. Use it in any chat on any device

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_API_ID` | Telegram API ID from my.telegram.org | Required |
| `TELEGRAM_API_HASH` | Telegram API hash from my.telegram.org | Required |
| `TELEGRAM_SESSION_STRING` | Telethon session string for the user account | Required |
| `PORT` | HTTP server port | `3001` |

## Tuning Parameters

| Parameter | Value | Location | Description |
|-----------|-------|----------|-------------|
| `poll_interval` | 2s | telegram_helper.py | How often to check for new Telegram messages |
| `nonce_grace_seconds` | 5s | telegram_helper.py | Grace window for bare EOT without nonce |
| `timeout_seconds` | 300s | telegram_helper.py | Hard ceiling before diagnostic ping |
| Diagnostic ping wait | 30s | telegram_helper.py | Extra wait after diagnostic ping |
| Job TTL | 30min | index.ts | How long completed jobs stay in memory |
| `telegram_status` timeout | 30s | telegram_helper.py | Fixed timeout for pulse checks |
| `telegram_status` idle | 15s | telegram_helper.py | Idle return for status responses |

## Session Management

- **24-hour session TTL** — MCP sessions persist across chats for a full day
- **Automatic cleanup** — stale sessions and expired jobs are pruned every 5 minutes
- **Graceful re-init** — if a client sends a stale session ID (e.g., after server restart), the server returns 404 to trigger automatic re-initialization

## Known Limitations

- **User account required** — uses the Telegram user API (MTProto) via Telethon, not the Bot API, because it needs to read messages _from_ the bot in a private chat
- **Single bot target** — currently hardcoded to @NSHClawBot / "NSH OpenClaw" sender name
- **In-memory job store** — jobs are lost on server restart; completed results not persisted
- **Sequential polling** — polls every 2 seconds rather than using real-time updates; adds minor latency but is simpler and more reliable for a subprocess architecture
- **Python dependency** — requires Python 3 + Telethon installed on the host alongside Node.js

## License

MIT
