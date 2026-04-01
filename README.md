# Bridge-your-copilot

[![VS Code](https://img.shields.io/badge/VS%20Code-1.91%2B-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/updates/v1_91)
[![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-10A37F)](#openai-compatible-api)
[![Localhost Only](https://img.shields.io/badge/Security-Localhost%20First-555555)](#configuration)

Bridge-your-copilot exposes the VS Code Language Model API over `localhost` so your own scripts, tools, and agents can reuse the GitHub Copilot access already available in VS Code.

It runs as a VS Code extension, starts a local HTTP server from the Command Palette, and supports both a small native API and an OpenAI-compatible chat completions API.

## Why use it

- Reuse Copilot access from Python, shell scripts, and local agent tools
- Call a simple local endpoint instead of automating the VS Code UI
- Use OpenAI SDKs against `http://127.0.0.1:8765/v1`
- Stream chat completion output when your client supports SSE

## Requirements

- VS Code `1.91.0` or newer
- GitHub Copilot access enabled in VS Code
- Python `3.9+` for the helper package and CLI

## Project layout

- `src/extension.js`: VS Code extension entrypoint and HTTP bridge
- `copilot/`: Python client package
- `pyproject.toml`: Python packaging metadata
- `package.json`: VS Code extension manifest

## Quick start

1. Clone this repository and open it in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In the new window, run `Bridge your Copilot: Start Server`.
4. Approve Copilot consent if VS Code asks.
5. Call the local bridge on `http://127.0.0.1:8765`.

Health check:

```bash
curl http://127.0.0.1:8765/healthz
```

List the selected model:

```bash
curl http://127.0.0.1:8765/v1/models
```

## Native API

Non-streaming request:

```bash
curl -X POST http://127.0.0.1:8765/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Explain BFS in one paragraph."}'
```

Streaming request:

```bash
curl -N -X POST http://127.0.0.1:8765/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Explain BFS in one paragraph.","stream":true}'
```

The native streaming endpoint returns Server-Sent Events with `chunk` and `done` events.

## OpenAI-compatible API

Non-streaming request:

```bash
curl -X POST http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"copilot","messages":[{"role":"user","content":"Summarize this repo."}]}'
```

Streaming request:

```bash
curl -N -X POST http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"copilot","stream":true,"messages":[{"role":"user","content":"Write a haiku about debugging."}]}'
```

This endpoint returns OpenAI-style SSE chunks followed by `data: [DONE]`.

## Python package

Install locally:

```bash
pip install -e .
```

Python usage:

```python
from copilot import CopilotClient

client = CopilotClient(api_key="my-local-token")
print(client.ask("Summarize the latest git diff in Korean."))
```

Streaming with Python:

```python
from copilot import CopilotClient

client = CopilotClient()
for chunk in client.stream_chat_completion(
    [{"role": "user", "content": "Write a short release note."}]
):
    print(chunk, end="", flush=True)
print()
```

CLI usage:

```bash
bridge-your-copilot "Explain Dijkstra briefly."
bridge-your-copilot --stream "Write a short poem about latency."
```

## OpenAI SDK example

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8765/v1",
    api_key="my-local-token",
)

response = client.chat.completions.create(
    model="copilot",
    messages=[{"role": "user", "content": "Explain BFS briefly."}],
)
print(response.choices[0].message.content)
```

## Configuration

VS Code settings:

- `bridgeYourCopilot.port`: local port, default `8765`
- `bridgeYourCopilot.host`: bind host, default `127.0.0.1`
- `bridgeYourCopilot.modelFamily`: optional model family such as `gpt-4o`
- `bridgeYourCopilot.defaultInstruction`: prepended as a user message
- `bridgeYourCopilot.authToken`: optional shared secret accepted as `Authorization: Bearer ...` or `X-Bridge-Your-Copilot-Token`

Keep the bridge on `127.0.0.1` unless you explicitly want remote access.

## Notes and limitations

- Start the server from a VS Code command because `selectChatModels(...)` requires user action.
- The VS Code LM API currently exposes user and assistant messages only, so `system` and `developer` roles are folded into user instructions.
- Usage token counts are returned as `0` because the VS Code LM API does not expose exact token accounting here.
- This project bridges local editor access. It does not control the built-in Copilot Chat UI.
