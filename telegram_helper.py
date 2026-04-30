#!/usr/bin/env python3
"""Telegram helper that uses Telethon to send a message to a bot and collect burst responses."""

import asyncio
import json
import os
import sys
import time

from telethon import TelegramClient
from telethon.sessions import StringSession


async def send_and_wait(
    api_id: int,
    api_hash: str,
    session_string: str,
    message: str,
    timeout_seconds: int = 120,
    poll_interval: float = 2.0,
    idle_timeout: float = 15.0,
    bot_username: str = "NSHClawBot",
    sender_name: str = "NSH OpenClaw",
):
    client = TelegramClient(StringSession(session_string), api_id, api_hash)
    await client.connect()

    if not await client.is_user_authorized():
        print(json.dumps({"error": "Telegram session is not authorized. Re-generate the session string."}))
        await client.disconnect()
        return

    try:
        entity = await client.get_entity(bot_username)
    except Exception as e:
        print(json.dumps({"error": f"Could not resolve bot @{bot_username}: {e}"}))
        await client.disconnect()
        return

    # Get the latest message ID before sending so we know what's "new"
    history = await client.get_messages(entity, limit=1)
    baseline_id = history[0].id if history else 0
    send_time = time.time()

    # Send the command
    await client.send_message(entity, message)

    collected = []
    first_received = False
    last_message_time = None
    deadline = send_time + timeout_seconds
    ping_sent = False

    while True:
        now = time.time()

        # Check overall timeout (before first message)
        if not first_received and now >= deadline:
            if not ping_sent:
                # Send diagnostic ping
                await client.send_message(
                    entity,
                    "Previous command may not have completed — are you still running?"
                )
                ping_sent = True
                deadline = now + 30  # Wait 30 more seconds
                continue
            else:
                print(json.dumps({
                    "error": "OpenClaw unresponsive — recommend checking systemctl --user status openclaw-gateway on Oracle instance 132.226.77.178"
                }))
                await client.disconnect()
                return

        # Check idle timeout (after first message)
        if first_received and last_message_time and (now - last_message_time >= idle_timeout):
            break

        # Poll for new messages
        messages = await client.get_messages(entity, limit=50, min_id=baseline_id)
        new_msgs = []
        for msg in messages:
            if msg.id <= baseline_id:
                continue
            # Filter: must be from the bot / "NSH OpenClaw" sender, not from us
            if msg.out:
                continue
            # Check sender name if available
            sender = msg.sender
            if sender:
                name_parts = []
                if hasattr(sender, 'first_name') and sender.first_name:
                    name_parts.append(sender.first_name)
                if hasattr(sender, 'last_name') and sender.last_name:
                    name_parts.append(sender.last_name)
                full_name = " ".join(name_parts)
                # Also accept messages from bots (the bot itself)
                is_bot = getattr(sender, 'bot', False)
                if not is_bot and full_name != sender_name:
                    continue
            if msg.id not in [m.id for m in collected]:
                new_msgs.append(msg)

        if new_msgs:
            new_msgs.sort(key=lambda m: m.id)
            collected.extend(new_msgs)
            baseline_id = max(m.id for m in collected)
            last_message_time = time.time()
            if not first_received:
                first_received = True

        await asyncio.sleep(poll_interval)

    await client.disconnect()

    # Concatenate all messages chronologically
    collected.sort(key=lambda m: m.id)
    texts = [m.text or "" for m in collected]
    result = "\n".join(texts)
    print(json.dumps({"result": result}))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: telegram_helper.py <json_args>"}))
        sys.exit(1)

    args = json.loads(sys.argv[1])
    api_id = int(args.get("api_id") or os.environ.get("TELEGRAM_API_ID", ""))
    api_hash = args.get("api_hash") or os.environ.get("TELEGRAM_API_HASH", "")
    session_string = args.get("session_string") or os.environ.get("TELEGRAM_SESSION_STRING", "")
    message = args["message"]
    timeout_seconds = int(args.get("timeout_seconds", 120))

    asyncio.run(send_and_wait(
        api_id=api_id,
        api_hash=api_hash,
        session_string=session_string,
        message=message,
        timeout_seconds=timeout_seconds,
    ))


if __name__ == "__main__":
    main()
