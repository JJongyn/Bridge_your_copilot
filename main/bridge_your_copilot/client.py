"""Python client for the local Bridge your Copilot extension."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Iterator


class BridgeYourCopilotError(RuntimeError):
    """Raised when the bridge returns an error or cannot be reached."""


class BridgeYourCopilotClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8765/v1",
        api_key: str | None = None,
        timeout: int = 120,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    @property
    def root_url(self) -> str:
        if self.base_url.endswith("/v1"):
            return self.base_url[: -len("/v1")]
        return self.base_url

    def _headers(self, *, stream: bool = False) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if stream:
            headers["Accept"] = "text/event-stream"
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        base = self.root_url if path.startswith("/healthz") else self.base_url
        url = f"{base}{path}"
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            headers=self._headers(),
            method=method,
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise BridgeYourCopilotError(f"HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise BridgeYourCopilotError(f"Connection error: {exc.reason}") from exc

    def _stream_request(
        self, method: str, path: str, payload: dict[str, Any]
    ) -> Iterator[str]:
        url = f"{self.base_url}{path}"
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=self._headers(stream=True),
            method=method,
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                for raw_line in response:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line or not line.startswith("data: "):
                        continue
                    yield line[6:]
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise BridgeYourCopilotError(f"HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise BridgeYourCopilotError(f"Connection error: {exc.reason}") from exc

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/healthz")

    def models(self) -> list[dict[str, Any]]:
        response = self._request("GET", "/models")
        return response.get("data", [])

    def chat(
        self,
        prompt: str = "",
        *,
        instruction: str = "",
        messages: list[dict[str, str]] | None = None,
    ) -> str:
        payload: dict[str, Any] = {}
        if instruction:
            payload["instruction"] = instruction

        if messages is not None:
            payload["messages"] = messages
        else:
            payload["prompt"] = prompt

        response = self._request("POST", "/chat", payload)
        return response.get("content", "")

    def chat_completion(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str = "copilot",
        instructions: str = "",
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": False,
        }
        if instructions:
            payload["instructions"] = instructions

        return self._request("POST", "/chat/completions", payload)

    def stream_chat_completion(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str = "copilot",
        instructions: str = "",
    ) -> Iterator[str]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
        }
        if instructions:
            payload["instructions"] = instructions

        for data in self._stream_request("POST", "/chat/completions", payload):
            if data == "[DONE]":
                break

            chunk = json.loads(data)
            choices = chunk.get("choices", [])
            if not choices:
                continue

            delta = choices[0].get("delta", {})
            content = delta.get("content")
            if content:
                yield content

    def ask(
        self,
        prompt: str,
        *,
        instruction: str = "",
        model: str = "copilot",
    ) -> str:
        response = self.chat_completion(
            [{"role": "user", "content": prompt}],
            model=model,
            instructions=instruction,
        )
        return response["choices"][0]["message"]["content"]


CopilotBridgeError = BridgeYourCopilotError
CopilotBridgeClient = BridgeYourCopilotClient
