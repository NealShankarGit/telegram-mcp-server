# Telegram MCP Server

A Model Context Protocol (MCP) server that lets Claude send commands to a Telegram bot and collect the complete response — even when the bot streams its reply across multiple sequential messages. Blocking call pattern returns the full response in a single tool call.

Designed to be hosted remotely and used as a custom connector in Claude.ai on any device (desktop, mobile, web).

Built by [Neal Shankar](https://nealshankar.com). Architecture modeled after [NealShankarGit/whoop-mcp-server](https://github.com/NealShankarGit/whoop-mcp-server).

## Problem

Telegram bots that stream responses send them as a burst of sequential messages rather than a single reply. Long-running operations can take minutes. There's no native way for Claude to send a command to a Telegram bot and reliably get the full response back.

## Solution

Blocking call pattern: `telegram_send_and_wait` sends the message and blocks server-side until the bot's response is complete (detected by a ✅ marker) or timeout is reached. Claude makes one tool call and gets the full response back — no polling, no job IDs, no wasted context window. The Python helper polls Telegram internally every 2 seconds, completely transparent to Claude.

## MCP Tools

| Tool | When to use | Behavior | Description |
|------|-------------|----------|-------------|
| `telegram_send_and_wait` | New tasks | Blocking | Send command, block until ✅ response arrives |
| `telegram_context_and_send` | Iterating on existing work | Blocking | Prepend `[WITH CONTEXT n]`, same blocking pattern |
| `telegram_get_history` | Reading past messages | Blocking (fast) | Fetch last N messages |
| `telegram_send_message` | Fire-and-forget | Returns immediately | Send without waiting |

### `telegram_send_and_wait`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | string | Yes | — | The command message to send to @NSHClawBot |
| `timeout_seconds` | number | No | 300 | Max seconds to wait for response |

Blocks until the bot sends a message ending with ✅, then returns the full concatenated response. If timeout is reached, use `telegram_get_history` as a manual fallback.

### `telegram_context_and_send`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | string | Yes | — | The follow-up instruction to send |
| `history_limit` | number | No | 10 | Number of recent messages OpenClaw should fetch as context |
| `timeout_seconds` | number | No | 300 | Max seconds to wait for response |

The message is sent as `[WITH CONTEXT 10] Your instruction here`. OpenClaw strips the prefix, fetches the last N messages from its own Telegram chat locally, prepends them as context, then executes. Context never travels through Telegram — it stays on Oracle.

### `telegram_get_history`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | number | No | 10 | Number of recent messages to retrieve |

Manual fallback if `telegram_send_and_wait` or `telegram_context_and_send` times out.

### `telegram_send_message`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | string | Yes | — | The message to send to @NSHClawBot |

## How It Works

```
Claude                        MCP Server                    Telegram
  |                              |                              |
  |-- send_and_wait(msg) ------->|                              |
  |                              |-- spawn Python helper ------>|
  |   (HTTP connection held      |   (polls every 2s)          |-- send msg -->
  |    open, blocking)           |                              |
  |                              |                              |<-- reply 1 --
  |                              |                              |<-- reply 2 --
  |                              |                              |<-- reply 3 + ✅
  |                              |<-- helper returns result ----|
  |<-- "Full result here" ------|                              |
  |                              |                              |
```

One tool call, one response. The Python helper blocks server-side, polling Telegram every 2 seconds until ✅ is detected. Claude's HTTP connection stays open for the duration. The nginx proxy_read_timeout (300s) matches the default tool timeout.

## End-of-Transmission (EOT) Protocol

### 1. ✅ Detection (primary path)

Messages are sent to the bot unchanged. The server records which Telegram message ID was latest before sending, then only considers bot messages that arrive after that baseline. When any bot message ends with ✅, the response is complete — all collected messages are concatenated and returned with the ✅ stripped.

This recency-based approach handles concurrent sessions without nonces: each `send_and_wait` call only sees messages that arrived after its own send.

### 2. Hard Timeout (safety net)

If `timeout_seconds` (default 300) elapses with no ✅ detected:

1. If any messages were collected, returns them concatenated (partial result)
2. If nothing was collected, returns an error with troubleshooting instructions

### Bot-Side Configuration

OpenClaw's `AGENTS.md` has been updated with:
- **EOT rule**: append the checkmark only to the final completion message
- **Context rule**: when a message starts with `[WITH CONTEXT n]`, strip the prefix, fetch the last n messages locally, prepend as context, then execute

## Architecture

```
+--------------------------------------------------+
|           Telegram MCP Server                    |
|                                                  |
|  +-------------+      +------------------+      |
|  | MCP Server  |      | Python Helper    |      |
|  | (Streamable |      | (Telethon)       |      |
|  |  HTTP)      |      |                  |      |
|  | Express +   |      | All calls block: |      |
|  | TypeScript  |----->|  - Send & wait   |      |
|  |             |      |  - Context+send  |      |
|  +-------------+      |  - Get history   |      |
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

> **Note:** The `proxy_read_timeout` of 300s matches the default `timeout_seconds` for blocking calls. For longer operations, increase both the tool's `timeout_seconds` parameter and the nginx timeout.

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
| `timeout_seconds` | 300s | telegram_helper.py | Hard ceiling before returning partial result or error |

## Session Management

- **24-hour session TTL** — MCP sessions persist across chats for a full day
- **Automatic cleanup** — stale sessions are pruned every 5 minutes
- **Graceful re-init** — if a client sends a stale session ID (e.g., after server restart), the server returns 404 to trigger automatic re-initialization

## Known Limitations

- **User account required** — uses the Telegram user API (MTProto) via Telethon, not the Bot API, because it needs to read messages _from_ the bot in a private chat
- **Single bot target** — currently hardcoded to @NSHClawBot / "NSH OpenClaw" sender name
- **Sequential polling** — polls every 2 seconds rather than using real-time updates; adds minor latency but is simpler and more reliable for a subprocess architecture
- **Python dependency** — requires Python 3 + Telethon installed on the host alongside Node.js
- **Blocking calls hold connections** — long-running operations keep the HTTP connection open; ensure nginx timeouts are configured to match

## License

MIT
