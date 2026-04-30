#!/usr/bin/env python3
"""Telegram helper that uses Telethon to send messages and collect responses from @NSHClawBot."""

import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone

from telethon import TelegramClient
from telethon.sessions import StringSession

EOT_MARKER = "\u2705"
BOT_USERNAME = "NSHClawBot"
SENDER_NAME = "NSH OpenClaw"


def make_client(api_id, api_hash, session_string):
    return TelegramClient(StringSession(session_string), api_id, api_hash)


def is_from_bot(msg):
    """Return True if msg is an incoming message from the bot / NSH OpenClaw."""
    if msg.out:
        return False
    sender = msg.sender
    if not sender:
        return False
    if getattr(sender, "bot", False):
        return True
    name_parts = []
    if getattr(sender, "first_name", None):
        name_parts.append(sender.first_name)
    if getattr(sender, "last_name", None):
        name_parts.append(sender.last_name)
    return " ".join(name_parts) == SENDER_NAME


def strip_eot(text):
    """Strip the EOT marker and surrounding whitespace from the end of text."""
    if text.rstrip().endswith(EOT_MARKER):
        return text.rstrip()[: -len(EOT_MARKER)].rstrip()
    return text


async def send_and_wait(api_id, api_hash, session_string, message, timeout_seconds=120):
    poll_interval = 2.0
    idle_timeout = 30.0

    client = make_client(api_id, api_hash, session_string)
    await client.connect()

    if not await client.is_user_authorized():
        print(json.dumps({"error": "Telegram session is not authorized. Re-generate the session string."}))
        await client.disconnect()
        return

    try:
        entity = await client.get_entity(BOT_USERNAME)
    except Exception as e:
        print(json.dumps({"error": f"Could not resolve bot @{BOT_USERNAME}: {e}"}))
        await client.disconnect()
        return

    history = await client.get_messages(entity, limit=1)
    baseline_id = history[0].id if history else 0
    send_time = time.time()

    await client.send_message(entity, message)

    collected = []
    first_received = False
    last_message_time = None
    deadline = send_time + timeout_seconds
    ping_sent = False
    eot_detected = False

    while True:
        now = time.time()

        # Hard timeout — no first message received
        if not first_received and now >= deadline:
            if not ping_sent:
                await client.send_message(
                    entity,
                    "Previous command may not have completed \u2014 are you still running?",
                )
                ping_sent = True
                deadline = now + 30
                continue
            else:
                print(json.dumps({
                    "error": "OpenClaw unresponsive \u2014 recommend checking systemctl --user status openclaw-gateway on Oracle instance 132.226.77.178"
                }))
                await client.disconnect()
                return

        # Idle fallback — 30s silence after first message, no EOT detected
        if first_received and last_message_time and (now - last_message_time >= idle_timeout):
            break

        # Poll for new messages
        messages = await client.get_messages(entity, limit=50, min_id=baseline_id)
        collected_ids = {m.id for m in collected}
        new_msgs = []
        for msg in messages:
            if msg.id <= baseline_id:
                continue
            if not is_from_bot(msg):
                continue
            if msg.id not in collected_ids:
                new_msgs.append(msg)

        if new_msgs:
            new_msgs.sort(key=lambda m: m.id)
            collected.extend(new_msgs)
            baseline_id = max(m.id for m in collected)
            last_message_time = time.time()
            if not first_received:
                first_received = True

            # EOT detection — check the latest message
            latest_text = (new_msgs[-1].text or "").rstrip()
            if latest_text.endswith(EOT_MARKER):
                eot_detected = True
                break

        await asyncio.sleep(poll_interval)

    await client.disconnect()

    collected.sort(key=lambda m: m.id)
    texts = []
    for msg in collected:
        text = msg.text or ""
        texts.append(text)

    # Strip EOT marker from the final message if present
    if eot_detected and texts:
        texts[-1] = strip_eot(texts[-1])

    result = "\n".join(texts)
    print(json.dumps({"result": result}))


async def get_history(api_id, api_hash, session_string, limit=10):
    client = make_client(api_id, api_hash, session_string)
    await client.connect()

    if not await client.is_user_authorized():
        print(json.dumps({"error": "Telegram session is not authorized. Re-generate the session string."}))
        await client.disconnect()
        return

    try:
        entity = await client.get_entity(BOT_USERNAME)
    except Exception as e:
        print(json.dumps({"error": f"Could not resolve bot @{BOT_USERNAME}: {e}"}))
        await client.disconnect()
        return

    messages = await client.get_messages(entity, limit=limit)
    await client.disconnect()

    lines = []
    for msg in reversed(messages):
        sender = msg.sender
        if msg.out:
            name = "You"
        elif sender:
            parts = []
            if getattr(sender, "first_name", None):
                parts.append(sender.first_name)
            if getattr(sender, "last_name", None):
                parts.append(sender.last_name)
            name = " ".join(parts) or "Unknown"
        else:
            name = "Unknown"
        ts = msg.date.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        text = (msg.text or "[non-text message]").replace("\n", "\n    ")
        lines.append(f"[{ts}] {name}:\n    {text}")

    print(json.dumps({"result": "\n\n".join(lines)}))


async def send_message(api_id, api_hash, session_string, message):
    client = make_client(api_id, api_hash, session_string)
    await client.connect()

    if not await client.is_user_authorized():
        print(json.dumps({"error": "Telegram session is not authorized. Re-generate the session string."}))
        await client.disconnect()
        return

    try:
        entity = await client.get_entity(BOT_USERNAME)
    except Exception as e:
        print(json.dumps({"error": f"Could not resolve bot @{BOT_USERNAME}: {e}"}))
        await client.disconnect()
        return

    await client.send_message(entity, message)
    await client.disconnect()
    print(json.dumps({"result": f"Message sent to @{BOT_USERNAME}"}))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: telegram_helper.py <json_args>"}))
        sys.exit(1)

    args = json.loads(sys.argv[1])
    api_id = int(args.get("api_id") or os.environ.get("TELEGRAM_API_ID", ""))
    api_hash = args.get("api_hash") or os.environ.get("TELEGRAM_API_HASH", "")
    session_string = args.get("session_string") or os.environ.get("TELEGRAM_SESSION_STRING", "")
    command = args.get("command", "send_and_wait")

    if command == "send_and_wait":
        asyncio.run(send_and_wait(
            api_id=api_id,
            api_hash=api_hash,
            session_string=session_string,
            message=args["message"],
            timeout_seconds=int(args.get("timeout_seconds", 120)),
        ))
    elif command == "get_history":
        asyncio.run(get_history(
            api_id=api_id,
            api_hash=api_hash,
            session_string=session_string,
            limit=int(args.get("limit", 10)),
        ))
    elif command == "send_message":
        asyncio.run(send_message(
            api_id=api_id,
            api_hash=api_hash,
            session_string=session_string,
            message=args["message"],
        ))
    else:
        print(json.dumps({"error": f"Unknown command: {command}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
