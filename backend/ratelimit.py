"""Per-visitor rate limiting.

Fixed-window counters keyed by (scope, visitor, window). Two backends:

* Memory (default): a dict in this process. Good enough locally, and a
  best-effort brake on serverless — but each serverless instance counts
  separately, so a determined visitor can exceed the limit across instances.
* Upstash Redis over its REST API (optional): one shared counter for every
  instance, so limits are exact. Used automatically when UPSTASH_REDIS_REST_URL
  / UPSTASH_REDIS_REST_TOKEN (or Vercel's KV_REST_API_URL / KV_REST_API_TOKEN)
  are set — the "Upstash for Redis" Marketplace integration provides them.
  If that store is unreachable the limiter falls back to memory rather than
  blocking everyone ("fail open").

Visitors are identified by a hash of their IP address; raw addresses are
never stored.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
from dataclasses import dataclass

import requests


@dataclass
class Hit:
    allowed: bool
    limit: int
    remaining: int
    retry_after: int  # seconds until this window resets
    _backend: object = None
    _key: str = ""

    def refund(self) -> None:
        """Give the hit back (e.g. the AI call failed through no fault of the user)."""
        if self.allowed and self._backend is not None:
            self._backend.decr(self._key)


class MemoryBackend:
    name = "memory"

    def __init__(self):
        self._counts: dict[str, tuple[int, float]] = {}
        self._lock = threading.Lock()

    def incr(self, key: str, ttl: int) -> int:
        now = time.time()
        with self._lock:
            if len(self._counts) > 5000:
                self._counts = {k: v for k, v in self._counts.items() if v[1] > now}
            count, expires = self._counts.get(key, (0, now + ttl))
            if expires <= now:
                count, expires = 0, now + ttl
            count += 1
            self._counts[key] = (count, expires)
            return count

    def decr(self, key: str) -> None:
        with self._lock:
            if key in self._counts:
                count, expires = self._counts[key]
                self._counts[key] = (max(0, count - 1), expires)


class _UpstashBackend:
    name = "upstash"

    def __init__(self, url: str, token: str):
        self._url = url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"}
        self._fallback = MemoryBackend()

    def _pipeline(self, commands: list[list]) -> list[dict]:
        resp = requests.post(f"{self._url}/pipeline", headers=self._headers, json=commands, timeout=3)
        resp.raise_for_status()
        return resp.json()

    def incr(self, key: str, ttl: int) -> int:
        try:
            result = self._pipeline([["INCR", key], ["EXPIRE", key, ttl]])
            if "error" in result[0]:
                raise RuntimeError(result[0]["error"])
            return int(result[0]["result"])
        except (requests.RequestException, RuntimeError, KeyError, ValueError, IndexError):
            return self._fallback.incr(key, ttl)

    def decr(self, key: str) -> None:
        try:
            self._pipeline([["DECR", key]])
        except requests.RequestException:
            self._fallback.decr(key)


def _make_backend():
    url = os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN")
    return _UpstashBackend(url, token) if url and token else MemoryBackend()


class RateLimiter:
    def __init__(self, backend=None):
        self.backend = backend or _make_backend()

    @staticmethod
    def visitor_id(ip: str) -> str:
        return hashlib.sha256(ip.encode()).hexdigest()[:16]

    def check(self, scope: str, visitor: str, limit: int, window_s: int) -> Hit:
        """Count one hit. `limit <= 0` means unlimited."""
        if limit <= 0:
            return Hit(True, 0, 10**9, 0)
        now = time.time()
        window = int(now // window_s)
        key = f"tmrl:{scope}:{visitor}:{window}"
        count = self.backend.incr(key, window_s + 5)
        retry_after = max(1, int(window_s - (now % window_s)))
        if count > limit:
            self.backend.decr(key)  # a refused request shouldn't eat quota
            return Hit(False, limit, 0, retry_after, self.backend, key)
        return Hit(True, limit, limit - count, retry_after, self.backend, key)


_limiter: RateLimiter | None = None


def get_limiter() -> RateLimiter:
    global _limiter
    if _limiter is None:
        _limiter = RateLimiter()
    return _limiter


def client_ip(headers, fallback: str | None) -> str:
    """The visitor's address. Behind Vercel (and most proxies) the first
    X-Forwarded-For entry is the client."""
    forwarded = headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return headers.get("x-real-ip") or fallback or "unknown"
