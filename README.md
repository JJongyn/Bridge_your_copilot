# Bridge-your-copilot

[![CI](https://github.com/JJongyn/Bridge_your_copilot/actions/workflows/ci.yml/badge.svg)](https://github.com/JJongyn/Bridge_your_copilot/actions/workflows/ci.yml)
[![Release VSIX](https://github.com/JJongyn/Bridge_your_copilot/actions/workflows/release.yml/badge.svg)](https://github.com/JJongyn/Bridge_your_copilot/actions/workflows/release.yml)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.91%2B-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/updates/v1_91)
[![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-10A37F)](#openai-compatible-api)

Bridge-your-copilot exposes the VS Code Language Model API over `localhost` so local scripts, agents, and tools can reuse GitHub Copilot access from your editor.

## Install

Requirements:

- VS Code `1.91.0` or newer
- GitHub Copilot enabled in VS Code
- Python `3.9+` if you want the helper package and CLI

Development install:

1. Clone this repository.
2. Open it in VS Code.
3. Press `F5` to launch an Extension Development Host.
4. In the new window, run `Bridge your Copilot: Start Server`.

VSIX install:

1. Build a package with `vsce package`.
2. In VS Code, run `Extensions: Install from VSIX...`.
3. Pick `bridge-your-copilot-0.1.0.vsix`.
4. Run `Bridge your Copilot: Start Server`.

## First Use

After the server starts:

1. Run `Bridge your Copilot: Copy Connection Info` or `Bridge your Copilot: Copy Access Token`.
2. Check health:

```bash
curl http://127.0.0.1:8765/healthz
```

3. List available models:

```bash
curl http://127.0.0.1:8765/v1/models
```

4. Send your first request:

```bash
curl -X POST http://127.0.0.1:8765/v1/chat \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{"prompt":"Explain BFS in one paragraph.","model":"gpt-5-mini"}'
```

If `bridgeYourCopilot.authToken` is empty, the extension generates a local token and stores it in VS Code secret storage. You can rotate it later with `Bridge your Copilot: Rotate Access Token`.

## Python

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

## CLI

```bash
bridge-your-copilot --model gpt-5-mini "Explain Dijkstra briefly."
bridge-your-copilot --stream --model gpt-5-mini "Write a short poem about latency."
```

## OpenAI-Compatible API

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

OpenAI SDK:

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

## Native API

Streaming:

```bash
curl -N -X POST http://127.0.0.1:8765/v1/chat \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{"prompt":"Write a short release note.","stream":true}'
```

Native streaming returns SSE `ready`, `chunk`, and `done` events plus keep-alive heartbeats.

## Command Palette

- `Bridge your Copilot: Start Server`
- `Bridge your Copilot: Stop Server`
- `Bridge your Copilot: Show Status`
- `Bridge your Copilot: Select Model`
- `Bridge your Copilot: Reveal Model Details`
- `Bridge your Copilot: Copy Access Token`
- `Bridge your Copilot: Copy Connection Info`
- `Bridge your Copilot: Rotate Access Token`

## Model Selection

- `GET /v1/models` returns discovered model ids, families, versions, and which model is selected
- each request can override the default with `model` or `modelFamily`
- if `bridgeYourCopilot.modelFamily` is empty, startup tries `gpt-5.1 mini` aliases first, then `gpt-5 mini`, then the first available Copilot model

## Configuration

- `bridgeYourCopilot.port`: local port, default `8765`
- `bridgeYourCopilot.host`: bind host, default `127.0.0.1`
- `bridgeYourCopilot.modelFamily`: preferred startup model family
- `bridgeYourCopilot.defaultInstruction`: prepended user instruction
- `bridgeYourCopilot.authToken`: optional token override; if empty the extension manages a generated token for you

## Development

Project layout:

- `src/extension.js`: activation, server lifecycle, token and model UX
- `src/http-handler.js`: testable HTTP routing, auth, JSON, and SSE helpers
- `src/model-selection.js`: model matching and default selection logic
- `bridge_your_copilot/`: Python client package and CLI
- `tests/`: Node tests for HTTP contract and model selection
- `.github/workflows/`: CI and VSIX release automation

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

## Notes

- Start the server from a VS Code command because `selectChatModels(...)` requires user action.
- The VS Code LM API exposes user and assistant messages only, so `system` and `developer` roles are folded into user instructions.
- Token usage values are returned as `0` because the VS Code LM API does not expose exact accounting here.
- Keep the server bound to `127.0.0.1` unless you intentionally want remote access.
