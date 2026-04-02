# Bridge-your-copilot

[![CI](https://github.com/JJongyn/Bridge_your_copilot/actions/workflows/ci.yml/badge.svg)](https://github.com/JJongyn/Bridge_your_copilot/actions/workflows/ci.yml)
[![Release VSIX](https://github.com/JJongyn/Bridge_your_copilot/actions/workflows/release.yml/badge.svg)](https://github.com/JJongyn/Bridge_your_copilot/actions/workflows/release.yml)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.91%2B-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/updates/v1_91)
[![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-10A37F)](#openai-compatible-api)

Bridge-your-copilot exposes the VS Code Language Model API over `localhost` so local scripts, agents, and tools can reuse GitHub Copilot access from your editor.

It ships as a VS Code extension with:

- a native `POST /v1/chat` endpoint
- an OpenAI-compatible `POST /v1/chat/completions` endpoint
- SSE streaming for both APIs
- generated or user-supplied access tokens
- per-request model routing by model id or family

## Requirements

- VS Code `1.91.0` or newer
- GitHub Copilot enabled in VS Code
- Python `3.9+` for the helper package and CLI

## Project Layout

- `src/extension.js`: activation, server lifecycle, token and model UX
- `src/http-handler.js`: testable HTTP routing, auth, JSON, and SSE helpers
- `src/model-selection.js`: model matching and default selection logic
- `bridge_your_copilot/`: Python client package and CLI
- `tests/`: Node tests for HTTP contract and model selection
- `.github/workflows/`: CI and VSIX release automation

## Quick Start

1. Open the repository in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. Run `Bridge your Copilot: Start Server`.
4. Run `Bridge your Copilot: Copy Connection Info` or `Bridge your Copilot: Copy Access Token`.
5. Call the local bridge on `http://127.0.0.1:8765`.

If `bridgeYourCopilot.authToken` is empty, the extension generates a local token and stores it in VS Code secret storage. You can rotate it later with `Bridge your Copilot: Rotate Access Token`.

## Command Palette

- `Bridge your Copilot: Start Server`: starts the local bridge and selects a default model
- `Bridge your Copilot: Stop Server`: stops the local bridge
- `Bridge your Copilot: Show Status`: shows base URL and current model
- `Bridge your Copilot: Select Model`: chooses the default model for requests without `model`
- `Bridge your Copilot: Reveal Model Details`: lists all discovered models in the output panel
- `Bridge your Copilot: Copy Access Token`: copies the active bearer token
- `Bridge your Copilot: Copy Connection Info`: copies base URL, token, and selected model
- `Bridge your Copilot: Rotate Access Token`: generates a new stored token when settings do not override one

## Model Selection

- `GET /v1/models` returns discovered model ids, families, versions, and which model is selected
- every request can override the default with `model` or `modelFamily`
- if `bridgeYourCopilot.modelFamily` is empty, startup tries `gpt-5.1 mini` aliases first, then `gpt-5 mini`, then the first available Copilot model

## API

Health:

```bash
curl http://127.0.0.1:8765/healthz
```

Models:

```bash
curl http://127.0.0.1:8765/v1/models
```

### Native API

Non-streaming:

```bash
curl -X POST http://127.0.0.1:8765/v1/chat \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{"prompt":"Explain BFS in one paragraph.","model":"gpt-5-mini"}'
```

Streaming:

```bash
curl -N -X POST http://127.0.0.1:8765/v1/chat \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{"prompt":"Write a short release note.","stream":true}'
```

Native streaming returns SSE `ready`, `chunk`, and `done` events plus keep-alive heartbeats.

### OpenAI-Compatible API

Non-streaming:

```bash
curl -X POST http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"Summarize this repo."}]}'
```

Streaming:

```bash
curl -N -X POST http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{"model":"gpt-5-mini","stream":true,"messages":[{"role":"user","content":"Write a haiku about debugging."}]}'
```

OpenAI-compatible streaming returns SSE chunks followed by `data: [DONE]`.

## Python Client

Install locally:

```bash
pip install -e .
```

Basic usage:

```python
from bridge_your_copilot import BridgeClient

client = BridgeClient(api_key="YOUR_TOKEN")
print(client.ask("Summarize the latest git diff in Korean.", model="gpt-5-mini"))
```

Streaming:

```python
from bridge_your_copilot import BridgeClient

client = BridgeClient(api_key="YOUR_TOKEN")
for chunk in client.stream_chat_completion(
    [{"role": "user", "content": "Write a short release note."}],
    model="gpt-5-mini",
):
    print(chunk, end="", flush=True)
print()
```

CLI:

```bash
bridge-your-copilot --model gpt-5-mini "Explain Dijkstra briefly."
bridge-your-copilot --stream --model gpt-5-mini "Write a short poem about latency."
```

## OpenAI SDK Example

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8765/v1",
    api_key="YOUR_TOKEN",
)

response = client.chat.completions.create(
    model="gpt-5-mini",
    messages=[{"role": "user", "content": "Explain BFS briefly."}],
)
print(response.choices[0].message.content)
```

## Development

Validation:

```bash
npm run check
npm test
```

Package a VSIX:

```bash
vsce package
```

The release workflow packages a VSIX on tags matching `v*` and uploads it to the GitHub release.

## Configuration

- `bridgeYourCopilot.port`: local port, default `8765`
- `bridgeYourCopilot.host`: bind host, default `127.0.0.1`
- `bridgeYourCopilot.modelFamily`: preferred startup model family
- `bridgeYourCopilot.defaultInstruction`: prepended user instruction
- `bridgeYourCopilot.authToken`: optional token override; if empty the extension manages a generated token for you

## Notes

- Start the server from a VS Code command because `selectChatModels(...)` requires user action.
- The VS Code LM API exposes user and assistant messages only, so `system` and `developer` roles are folded into user instructions.
- Token usage values are returned as `0` because the VS Code LM API does not expose exact accounting here.
- Keep the server bound to `127.0.0.1` unless you intentionally want remote access.
