#!/usr/bin/env python3
"""CLI for the local Copilot Bridge VS Code extension."""

from __future__ import annotations

import argparse
import json
import sys

from copilot_bridge import CopilotBridgeClient
from copilot_bridge.client import CopilotBridgeError


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send a prompt to the local Copilot Bridge extension."
    )
    parser.add_argument("prompt", nargs="?", help="Prompt text to send")
    parser.add_argument(
        "--url",
        default="http://127.0.0.1:8765/v1/chat",
        help="Bridge endpoint URL",
    )
    parser.add_argument(
        "--instruction",
        default="",
        help="Extra instruction prepended as a user message",
    )
    parser.add_argument(
        "--token",
        default="",
        help="Optional shared token matching copilotBridge.authToken",
    )
    parser.add_argument(
        "--messages-json",
        default="",
        help='Raw JSON message array, for example [{"role":"user","content":"hello"}]',
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not args.prompt and not args.messages_json:
        print("error: provide a prompt or --messages-json", file=sys.stderr)
        return 2

    base_url = args.url.rstrip("/")
    for suffix in ("/chat/completions", "/chat", "/v1"):
        if base_url.endswith(suffix):
            base_url = base_url[: -len(suffix)] or base_url
            break
    if not base_url.endswith("/v1"):
        base_url = f"{base_url.rstrip('/')}/v1"

    client = CopilotBridgeClient(base_url=base_url, api_key=args.token or None)

    try:
        if args.messages_json:
            response = client.chat_completion(
                json.loads(args.messages_json),
                instructions=args.instruction,
            )
            print(response["choices"][0]["message"]["content"])
            return 0

        print(client.ask(args.prompt, instruction=args.instruction))
        return 0
    except CopilotBridgeError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
