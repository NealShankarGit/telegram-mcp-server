# Telegram MCP Server

A Model Context Protocol (MCP) server that lets Claude send commands to a Telegram bot and collect the complete response — even when the bot streams its reply across multiple sequential messages. One tool, one call, full response back.

Designed to be hosted remotely and used as a custom connector in Claude.ai on any device (desktop, mobile, web).

Built by [Neal Shankar](https://nealshankar.com). Architecture modeled after [NealShankarGit/whoop-mcp-server](https://github.com/NealShankarGit/whoop-mcp-server).

## Problem

Telegram bots that stream responses send them as a burst of sequential messages rather than a single reply. There's no native way for Claude to send a command to a Telegram bot and get the full concatenated response back in one tool call — especially on mobile where manual relay isn't practical.

## Solution

`telegram_send_and_wait` sends a message to the target bot, polls for new replies, and uses an end-of-transmission (EOT) protocol to detect when the bot has finished. All collected messages are concatenated chronologically and returned as a single string.

## MCP Tools

| Tool | Description |
|------|-------------|
| `telegram_send_and_wait` | Send a command to @NSHClawBot, wait for the complete response using EOT detection, return all messages concatenated |
| `telegram_get_history` | Read the last N messages from the @NSHClawBot chat with sender, timestamp, and text |
| `telegram_send_message` | Fire-and-forget: send a message to @NSHClawBot and return immediately with no polling |

### `telegram_send_and_wait`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | string | Yes | — | The command message to send to @NSHClawBot |
| `timeout_seconds` | number | No | 120 | Max seconds to wait for the first response before considering the bot unresponsive |

### `telegram_get_history`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | number | No | 10 | Number of recent messages to retrieve |

### `telegram_send_message`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | string | Yes | — | The message to send to @NSHClawBot |

## End-of-Transmission (EOT) Protocol

The server uses a three-tier detection system to know when the bot has finished responding:

### 1. EOT Signal (primary path)

The bot appends a checkmark emoji to its final completion message. The moment the server sees a message ending with that marker, it:

- Strips the marker and any surrounding whitespace from the message
- Concatenates all collected messages in chronological order
- Returns immediately — no idle wait needed

The marker is **always stripped** before returning, so callers never see it.

### 2. Idle Timer (fallback path)

If the bot does not send the EOT marker (crash, stuck loop, older bot version), a **30-second idle timer** kicks in. Every new message resets the timer. If 30 full seconds pass with no new message, the server returns all collected messages.

### 3. Hard Timeout (safety net)

If `timeout_seconds` (default 120) elapses before the **first** reply ever arrives:

1. A diagnostic ping is sent: _"Previous command may not have completed — are you still running?"_
2. Waits an additional 30 seconds for any response
3. If still nothing, returns an error: `"OpenClaw unresponsive — recommend checking systemctl --user status openclaw-gateway on Oracle instance 132.226.77.178"`

### Bot-Side Configuration

OpenClaw's `AGENTS.md` has been updated with the corresponding rule: append the EOT marker only to the final completion message of any response. The marker must be the last non-whitespace character in the message.

## How It Works

```
Claude sends "telegram_send_and_wait" tool call
         │
         ▼
┌─────────────────────────────────────────────────┐
│  1. Record baseline (latest message ID)         │
│  2. Send command to @NSHClawBot via Telegram    │
│  3. Poll every 2s for new messages              │
│  4. On each message, check for EOT marker       │
│  5. EOT found → strip marker, return instantly  │
│  6. No EOT → 30s idle fallback                  │
│  7. Concatenate all messages, return as string   │
└─────────────────────────────────────────────────┘
         │
         ▼
Claude receives full response in one tool result
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│           Telegram MCP Server                   │
│                                                 │
│  ┌─────────────┐      ┌──────────────────┐     │
│  │ MCP Server  │      │  Python Helper   │     │
│  │ (Streamable │─────►│  (Telethon)      │     │
│  │  HTTP)      │      │                  │     │
│  │ Express +   │      │  - Send & wait   │     │
│  │ TypeScript  │      │  - Get history   │     │
│  └─────────────┘      │  - Send message  │     │
│                       │  - EOT detect    │     │
│                       └──────────────────┘     │
│                              │                  │
│                              ▼                  │
│                       ┌──────────────────┐     │
│                       │  Telegram API    │     │
│                       │  (MTProto)       │     │
│                       └──────────────────┘     │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│  Claude.ai Custom Connector                     │
│  Desktop · Mobile · Web                         │
│  "Send /status to OpenClaw"                     │
└─────────────────────────────────────────────────┘
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
    }
}
```

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
| `idle_timeout` | 30s | Silence duration before fallback return (when no EOT received) |
| `timeout_seconds` | 120s | Hard ceiling before diagnostic ping (configurable per-call) |
| Diagnostic ping wait | 30s | Extra wait after sending a diagnostic ping |

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
