#!/usr/bin/env python3
"""Telegram helper that uses Telethon to send messages and collect responses from @NSHClawBot."""

import asyncio
import json
import os
import sys
import time
from datetime import timezone

from telethon import TelegramClient
from telethon.sessions import StringSession

EOT_MARKER = "\u2705"
BOT_USERNAME = "NSHClawBot"
SENDER_NAME = "NSH OpenClaw"


def make_client(api_id, api_hash, session_string):
    return TelegramClient(StringSession(session_string), api_id, api_hash)


async def connect_and_resolve(client):
    """Connect, authorize, and resolve the bot entity. Returns entity or prints error and returns None."""
    await client.connect()
    if not await client.is_user_authorized():
        print(json.dumps({"error": "Telegram session is not authorized. Re-generate the session string."}))
        await client.disconnect()
        return None
    try:
        entity = await client.get_entity(BOT_USERNAME)
        return entity
    except Exception as e:
        print(json.dumps({"error": f"Could not resolve bot @{BOT_USERNAME}: {e}"}))
        await client.disconnect()
        return None


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


def has_eot(text):
    """Check if text ends with the EOT marker."""
    return text.rstrip().endswith(EOT_MARKER)


def format_history(messages):
    """Format messages into readable text with sender, timestamp, and content."""
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
    return "\n\n".join(lines)


def collect_and_return(collected, eot_detected):
    """Sort collected messages, strip EOT if needed, concatenate and print result."""
    collected.sort(key=lambda m: m.id)
    texts = [m.text or "" for m in collected]
    if eot_detected and texts:
        texts[-1] = strip_eot(texts[-1])
    result = "\n".join(texts)
    print(json.dumps({"result": result}))


async def send_and_wait(api_id, api_hash, session_string, message, timeout_seconds=300):
    """Send message and wait for EOT or hard timeout. Idle timer does NOT cause return."""
    poll_interval = 2.0

    client = make_client(api_id, api_hash, session_string)
    entity = await connect_and_resolve(client)
    if not entity:
        return

    history = await client.get_messages(entity, limit=1)
    baseline_id = history[0].id if history else 0
    send_time = time.time()

    await client.send_message(entity, message)

    collected = []
    first_received = False
    deadline = send_time + timeout_seconds
    ping_sent = False
    eot_detected = False

    while True:
        now = time.time()

        # Hard timeout
        if now >= deadline:
            if not ping_sent:
                await client.send_message(
                    entity,
                    "Previous command may not have completed \u2014 are you still running?",
                )
                ping_sent = True
                deadline = now + 30
                continue
            else:
                if collected:
                    await client.disconnect()
                    collect_and_return(collected, False)
                    return
                print(json.dumps({
                    "error": "OpenClaw unresponsive \u2014 recommend checking systemctl --user status openclaw-gateway on Oracle instance 132.226.77.178"
                }))
                await client.disconnect()
                return

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
            if not first_received:
                first_received = True

            # EOT detection — check the latest message
            latest_text = (new_msgs[-1].text or "").rstrip()
            if has_eot(latest_text):
                eot_detected = True
                break

        await asyncio.sleep(poll_interval)

    await client.disconnect()
    collect_and_return(collected, eot_detected)


async def context_and_send(api_id, api_hash, session_string, message, history_limit=10, timeout_seconds=300):
    """Read recent history, prepend as context, then send_and_wait."""
    client = make_client(api_id, api_hash, session_string)
    entity = await connect_and_resolve(client)
    if not entity:
        return

    # Fetch history for context
    history_msgs = await client.get_messages(entity, limit=history_limit)
    context_text = format_history(history_msgs)
    await client.disconnect()

    full_message = f"Recent conversation context:\n{context_text}\n\nNew instruction: {message}"

    # Reuse send_and_wait with the context-enriched message
    await send_and_wait(api_id, api_hash, session_string, full_message, timeout_seconds)


async def status_check(api_id, api_hash, session_string):
    """Quick pulse check with 30s timeout, no EOT detection."""
    poll_interval = 2.0
    timeout_seconds = 30

    client = make_client(api_id, api_hash, session_string)
    entity = await connect_and_resolve(client)
    if not entity:
        return

    history = await client.get_messages(entity, limit=1)
    baseline_id = history[0].id if history else 0
    send_time = time.time()

    await client.send_message(
        entity,
        "Quick status check \u2014 what are you currently working on, or are you idle? Reply in one sentence.",
    )

    collected = []
    last_message_time = None
    idle_timeout = 15.0
    deadline = send_time + timeout_seconds

    while True:
        now = time.time()

        if now >= deadline:
            break

        # Idle return after first message
        if last_message_time and (now - last_message_time >= idle_timeout):
            break

        messages = await client.get_messages(entity, limit=10, min_id=baseline_id)
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

        await asyncio.sleep(poll_interval)

    await client.disconnect()

    if not collected:
        print(json.dumps({"result": "No response within 30 seconds — bot may be offline."}))
        return

    collected.sort(key=lambda m: m.id)
    texts = [strip_eot(m.text or "") for m in collected]
    print(json.dumps({"result": "\n".join(texts)}))


async def get_history(api_id, api_hash, session_string, limit=10):
    client = make_client(api_id, api_hash, session_string)
    entity = await connect_and_resolve(client)
    if not entity:
        return

    messages = await client.get_messages(entity, limit=limit)
    await client.disconnect()
    print(json.dumps({"result": format_history(messages)}))


async def send_message(api_id, api_hash, session_string, message):
    client = make_client(api_id, api_hash, session_string)
    entity = await connect_and_resolve(client)
    if not entity:
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
            api_id=api_id, api_hash=api_hash, session_string=session_string,
            message=args["message"],
            timeout_seconds=int(args.get("timeout_seconds", 300)),
        ))
    elif command == "context_and_send":
        asyncio.run(context_and_send(
            api_id=api_id, api_hash=api_hash, session_string=session_string,
            message=args["message"],
            history_limit=int(args.get("history_limit", 10)),
            timeout_seconds=int(args.get("timeout_seconds", 300)),
        ))
    elif command == "status":
        asyncio.run(status_check(
            api_id=api_id, api_hash=api_hash, session_string=session_string,
        ))
    elif command == "get_history":
        asyncio.run(get_history(
            api_id=api_id, api_hash=api_hash, session_string=session_string,
            limit=int(args.get("limit", 10)),
        ))
    elif command == "send_message":
        asyncio.run(send_message(
            api_id=api_id, api_hash=api_hash, session_string=session_string,
            message=args["message"],
        ))
    else:
        print(json.dumps({"error": f"Unknown command: {command}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
