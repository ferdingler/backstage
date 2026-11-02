"""Small private API client. The transport, not a browser cookie, grants access."""

from __future__ import annotations

import json
import ssl
import os
from typing import Any
from urllib.parse import urlsplit

import httpx


class ServiceError(Exception):
    def __init__(self, status: int, code: str):
        self.status = status
        self.code = code
        super().__init__(f"service {status}: {code}")


class Client:
    def __init__(self, base_url: str):
        parsed = urlsplit(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("BACKSTAGE_API_URL must be an HTTP(S) origin without credentials")
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("BACKSTAGE_API_URL must be an origin, not an endpoint")
        # Box installs a private CA and gateway variables. Do not bypass that gateway
        # for a loopback API: its policy is the agent's method/path boundary.
        ca = os.environ.get("SSL_CERT_FILE") or os.environ.get("AWS_CA_BUNDLE")
        verify = ssl.create_default_context(cafile=ca) if ca else True
        proxy = os.environ.get("HTTP_PROXY") if parsed.scheme == "http" else os.environ.get("HTTPS_PROXY")
        self.http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"), timeout=8, trust_env=True, verify=verify, proxy=proxy,
        )

    async def close(self) -> None:
        await self.http.aclose()

    async def request(self, method: str, operation: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        response = await self.http.request(method, f"/api/agent/{operation}", json=payload)
        if response.status_code >= 400:
            try:
                code = response.json().get("error", {}).get("code", "request_failed")
            except (ValueError, AttributeError):
                code = "invalid_response"
            raise ServiceError(response.status_code, str(code)[:80])
        try:
            result = response.json()
        except json.JSONDecodeError as error:
            raise ServiceError(502, "invalid_json") from error
        if not isinstance(result, dict):
            raise ServiceError(502, "invalid_shape")
        return result

    async def state(self) -> dict[str, Any]:
        return await self.request("GET", "state")

    async def post(self, operation: str, **payload: Any) -> dict[str, Any]:
        return await self.request("POST", operation, payload)
