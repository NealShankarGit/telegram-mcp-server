# Telegram MCP Server

A Model Context Protocol (MCP) server that lets Claude send commands to a Telegram bot and collect the complete response — even when the bot streams its reply across multiple sequential messages. One tool, one call, full response back.

Designed to be hosted remotely and used as a custom connector in Claude.ai on any device (desktop, mobile, web).

Built by [Neal Shankar](https://nealshankar.com). Architecture modeled after [NealShankarGit/whoop-mcp-server](https://github.com/NealShankarGit/whoop-mcp-server).

## Problem

Telegram bots that stream responses send them as a burst of sequential messages rather than a single reply. There's no native way for Claude to send a command to a Telegram bot and get the full concatenated response back in one tool call — especially on mobile where manual relay isn't practical.

## Solution

`telegram_send_and_wait` sends a message to the target bot, polls for new replies, and uses an end-of-transmission (EOT) protocol to detect when the bot has finished. All collected messages are concatenated chronologically and returned as a single string.

## MCP Tools

| Tool | When to use | Description |
|------|-------------|-------------|
| `telegram_send_and_wait` | New tasks | Send a fresh command, block until EOT or hard timeout |
| `telegram_context_and_send` | Iterating on existing work | Prepend `[WITH CONTEXT n]` prefix — OpenClaw fetches its own history locally on Oracle |
| `telegram_status` | Pulse checks | Quick 30s status query — is the bot alive, what's it doing? |
| `telegram_get_history` | Reading past messages | Fetch last N messages with sender, timestamp, text |
| `telegram_send_message` | Fire-and-forget | Send without waiting for any response |

### `telegram_send_and_wait`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | string | Yes | — | The command message to send to @NSHClawBot |
| `timeout_seconds` | number | No | 300 | Hard timeout before diagnostic ping |

### `telegram_context_and_send`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | string | Yes | — | The follow-up instruction to send |
| `history_limit` | number | No | 10 | Number of recent messages OpenClaw should fetch as context |
| `timeout_seconds` | number | No | 300 | Hard timeout before diagnostic ping |

The message is sent as `[WITH CONTEXT 10] Your instruction here`. OpenClaw strips the prefix, fetches the last N messages from its own Telegram chat using its local Telethon client, prepends them internally as context, then executes the instruction. Context never travels through Telegram — it stays on Oracle.

### `telegram_status`

No parameters. Sends a fixed status query, returns within 30 seconds.

### `telegram_get_history`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | number | No | 10 | Number of recent messages to retrieve |

### `telegram_send_message`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | string | Yes | — | The message to send to @NSHClawBot |

## End-of-Transmission (EOT) Protocol

The server uses a two-tier detection system to know when the bot has finished responding:

### 1. EOT Signal with Nonce (primary — only return path)

Each outgoing message is prepended with a unique 6-character hex nonce: `[req:a3f7b2] Your instruction here`. The bot must echo this nonce back in its final message alongside the checkmark EOT marker.

When the server sees a message ending with the checkmark **and** the collected burst contains the matching `[req:XXXXXX]` tag, it:

- Strips the EOT marker and all `[req:XXXXXX]` tags from the output
- Concatenates all collected messages in chronological order
- Returns immediately

Any checkmark that arrives **without** the matching nonce is ignored — it belongs to a different session or a manual message. This prevents race conditions when multiple senders use the same Telegram chat simultaneously.

Nonces are generated with `secrets.token_hex(3)` (6 hex chars). Both the nonce tag and EOT marker are **always stripped** before returning, so callers never see them.

### 2. Hard Timeout (safety net)

If `timeout_seconds` (default 300) elapses with no matching EOT detected:

1. A diagnostic ping is sent: _"Previous command may not have completed — are you still running?"_
2. Waits an additional 30 seconds
3. If any messages were collected, returns them concatenated (partial result)
4. If nothing was collected, returns an error: `"OpenClaw unresponsive — recommend checking systemctl --user status openclaw-gateway on Oracle instance 132.226.77.178"`

### Bot-Side Configuration

OpenClaw's `AGENTS.md` has been updated with:
- **EOT rule**: append the checkmark only to the final completion message
- **Nonce rule**: when a message starts with `[req:XXXXXX]`, include `[req:XXXXXX]` in the final message before the checkmark (e.g., `[req:a3f7b2] ✅`)
- **Context rule**: when a message starts with `[WITH CONTEXT n]`, strip the prefix, fetch the last n messages from the Telegram chat locally, prepend as context, then execute

## How It Works

```
Claude sends "telegram_send_and_wait" tool call
         |
         v
+--------------------------------------------------+
|  1. Record baseline (latest message ID)          |
|  2. Send command to @NSHClawBot via Telegram     |
|  3. Poll every 2s for new messages               |
|  4. On each message, check for EOT marker        |
|  5. EOT found -> strip marker, return instantly  |
|  6. No EOT -> keep blocking until hard timeout   |
|  7. Concatenate all messages, return as string    |
+--------------------------------------------------+
         |
         v
Claude receives full response in one tool result
```

## Architecture

```
+--------------------------------------------------+
|           Telegram MCP Server                    |
|                                                  |
|  +-------------+      +------------------+      |
|  | MCP Server  |      |  Python Helper   |      |
|  | (Streamable |----->|  (Telethon)      |      |
|  |  HTTP)      |      |                  |      |
|  | Express +   |      |  - Send & wait   |      |
|  | TypeScript  |      |  - Context+send  |      |
|  +-------------+      |  - Status check  |      |
|                       |  - Get history   |      |
|                       |  - Send message  |      |
|                       |  - EOT detect    |      |
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

> **Important:** The `proxy_read_timeout` and `proxy_send_timeout` must be set high enough to cover the longest possible tool call (up to 300s + 30s diagnostic wait + buffer). The defaults (60s) will cause nginx to drop the SSE connection mid-request, resulting in `"MCP server connection lost"` errors on the client.

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

These values are set in `telegram_helper.py`:

| Parameter | Value | Description |
|-----------|-------|-------------|
| `poll_interval` | 2s | How often to check for new messages |
| `timeout_seconds` | 300s | Hard ceiling before diagnostic ping (configurable per-call) |
| Diagnostic ping wait | 30s | Extra wait after sending a diagnostic ping |
| `telegram_status` timeout | 30s | Fixed short timeout for pulse checks |
| `telegram_status` idle | 15s | Idle return for status responses |

## Timeout Configuration

Tool calls can take up to 330 seconds (300s timeout + 30s diagnostic ping wait). Every layer must allow this:

| Layer | Setting | Value | Why |
|-------|---------|-------|-----|
| Nginx | `proxy_read_timeout` | 300s | Prevents nginx from killing the SSE stream while waiting for the Python helper |
| Nginx | `proxy_send_timeout` | 300s | Prevents nginx from killing the upstream response mid-write |
| Node.js | `server.timeout` | 0 (disabled) | Prevents Node from aborting long-running requests |
| Node.js | `server.keepAliveTimeout` | 300s | Prevents Node from closing idle keep-alive connections (Cloudflare reuses them) |
| Node.js | `server.headersTimeout` | 305s | Must exceed `keepAliveTimeout` per Node.js docs |

## Session Management

- **24-hour session TTL** — MCP sessions persist across chats for a full day
- **Automatic cleanup** — stale sessions are pruned every 5 minutes
- **Graceful re-init** — if a client sends a stale session ID (e.g., after server restart), the server returns 404 to trigger automatic re-initialization

## Known Limitations

- **User account required** — uses the Telegram user API (MTProto) via Telethon, not the Bot API, because it needs to read messages _from_ the bot in a private chat
- **Single bot target** — currently hardcoded to @NSHClawBot / "NSH OpenClaw" sender name
- **Sequential polling** — polls every 2 seconds rather than using real-time updates; adds minor latency but is simpler and more reliable for a subprocess architecture
- **Python dependency** — requires Python 3 + Telethon installed on the host alongside Node.js

## License

MIT
