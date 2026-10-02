"""Shared helpers for talking to the outside world safely.

The server fetches things on behalf of anonymous visitors when deployed, so
every identifier that ends up inside an outbound URL is validated here first
(otherwise a crafted id could redirect the request to another endpoint or
host), and downloads are size-capped.
"""

from __future__ import annotations

import os
import re

import requests

_MAP_UID = re.compile(r"^[A-Za-z0-9_-]{10,64}$")
_UUID = re.compile(r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")

MAX_DOWNLOAD_BYTES = 30_000_000

_BASE_UA = "trackmania-ai-analyzer/1.0"


def user_agent() -> str:
    """Descriptive User-Agent, as ManiaExchange and trackmania.io require.
    The deployer can append contact details via API_CONTACT."""
    contact = os.environ.get("API_CONTACT", "").strip()
    return f"{_BASE_UA} ({contact})" if contact else _BASE_UA


def valid_map_uid(value: str) -> str:
    if not _MAP_UID.match(value or ""):
        raise ValueError("invalid map uid")
    return value


def valid_uuid(value: str) -> str:
    if not _UUID.match(value or ""):
        raise ValueError("invalid id")
    return value


def download_limited(url: str, headers: dict, timeout: float = 30.0, limit: int = MAX_DOWNLOAD_BYTES) -> bytes:
    """GET `url` and return the body, refusing anything larger than `limit`."""
    with requests.get(url, headers=headers, timeout=timeout, stream=True) as resp:
        if not resp.ok:
            raise requests.HTTPError(f"{resp.status_code} from {resp.url}")
        declared = resp.headers.get("Content-Length")
        if declared and declared.isdigit() and int(declared) > limit:
            raise requests.HTTPError(f"file too large ({int(declared)} bytes)")
        chunks, size = [], 0
        for chunk in resp.iter_content(65536):
            size += len(chunk)
            if size > limit:
                raise requests.HTTPError("file too large")
            chunks.append(chunk)
        return b"".join(chunks)
