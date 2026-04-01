# Bridge-your-copilot

Bridge-your-copilot is a local VS Code extension that exposes the VS Code Language Model API over `localhost`. It lets Python scripts and OpenAI-compatible clients reuse the GitHub Copilot access already available in your editor.

This project does not automate the Copilot Chat UI. It runs inside the VS Code extension host and forwards requests to `vscode.lm`.

## Requirements

- VS Code `1.91.0` or newer
- GitHub Copilot access in VS Code
- Python `3.9+` if you want the helper client

## What You Get

- local bridge server started from the Command Palette
- native endpoint: `POST /v1/chat`
- OpenAI-compatible endpoint: `POST /v1/chat/completions`
- model discovery endpoint: `GET /v1/models`
- optional Python package: `copilot_bridge`

## Quick Start

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In the new window, run `Copilot Bridge: Start Server`.
4. Approve Copilot consent if VS Code prompts for it.
5. Call `http://127.0.0.1:8765`.

Check that the bridge is alive:

```bash
curl http://127.0.0.1:8765/healthz
```

## Example Requests

Native endpoint:

```bash
curl -X POST http://127.0.0.1:8765/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Explain BFS in one paragraph."}'
```

OpenAI-compatible endpoint:

```bash
curl -X POST http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"copilot","messages":[{"role":"user","content":"Summarize this repo."}]}'
```

Python client:

```bash
pip install -e .
```

```python
from copilot_bridge import CopilotBridgeClient

client = CopilotBridgeClient(api_key="my-local-token")
print(client.ask("Summarize the latest git diff in Korean."))
```

OpenAI SDK:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8765/v1", api_key="my-local-token")
response = client.chat.completions.create(
    model="copilot",
    messages=[{"role": "user", "content": "Explain BFS briefly."}],
)
print(response.choices[0].message.content)
```

## Configuration

- `copilotBridge.port`: local port, default `8765`
- `copilotBridge.host`: bind host, default `127.0.0.1`
- `copilotBridge.modelFamily`: optional family such as `gpt-4o`
- `copilotBridge.defaultInstruction`: prepended as a user message
- `copilotBridge.authToken`: optional shared secret accepted as `Authorization: Bearer ...` or `X-Copilot-Bridge-Token`

## Notes

- Start the server from a VS Code command because `selectChatModels(...)` requires user action.
- `system` and `developer` roles are folded into user instructions because the VS Code LM API currently exposes user and assistant messages only.
- `stream=true` is not implemented.
- Keep the server on `127.0.0.1` unless you explicitly want remote access.
