"""A pool of NVIDIA NIM API keys, used one at a time.

The owner supplies any number of keys; each AI request starts from the next
key in rotation (so load, and each key's own free-tier limits, are spread
evenly). If NVIDIA rejects or throttles a key, it is put on a short cooldown
and the request moves on to the next key, so one exhausted key never fails a
user while another still has headroom.

State lives in process memory. On a serverless platform every instance has
its own pool state, which is fine here: rotation just needs to be roughly
even, and cooldowns only save a wasted attempt.

Keys are never logged or returned to clients; only a short fingerprint is
exposed for diagnostics.
"""

from __future__ import annotations

import os
import random
import re
import threading
import time

_SPLIT = re.compile(r"[\s,;]+")


def parse_keys(*values: str | None) -> list[str]:
    """Split env-style values (comma, semicolon, space or newline separated)
    into a de-duplicated list of keys, order preserved."""
    keys: list[str] = []
    for value in values:
        for part in _SPLIT.split(value or ""):
            part = part.strip().strip("\"'")
            if part and part not in keys:
                keys.append(part)
    return keys


def fingerprint(key: str) -> str:
    return f"…{key[-4:]}" if len(key) >= 8 else "…"


class KeyPool:
    def __init__(self, keys: list[str]):
        self._keys = list(keys)
        self._cooldown_until: dict[str, float] = {}
        self._lock = threading.Lock()
        # Different serverless instances start at different positions.
        self._cursor = random.randrange(len(self._keys)) if self._keys else 0

    def __len__(self) -> int:
        return len(self._keys)

    def order(self) -> list[str]:
        """Keys to try for one request: rotate the starting key, and put any
        key that is cooling down last (it is still returned, so a request is
        only ever refused when *every* key is cooling down — see
        `all_cooling`)."""
        n = len(self._keys)
        if n == 0:
            return []
        now = time.monotonic()
        with self._lock:
            start = self._cursor % n
            self._cursor += 1
            rotated = self._keys[start:] + self._keys[:start]
            ready = [k for k in rotated if self._cooldown_until.get(k, 0.0) <= now]
            cooling = [k for k in rotated if self._cooldown_until.get(k, 0.0) > now]
        return ready + cooling

    def all_cooling(self) -> float:
        """Seconds until the earliest key is usable again, or 0 if any key is
        usable now."""
        if not self._keys:
            return 0.0
        now = time.monotonic()
        with self._lock:
            waits = [self._cooldown_until.get(k, 0.0) - now for k in self._keys]
        soonest = min(waits)
        return max(0.0, soonest)

    def penalize(self, key: str, seconds: float) -> None:
        with self._lock:
            until = time.monotonic() + seconds
            self._cooldown_until[key] = max(self._cooldown_until.get(key, 0.0), until)

    def describe(self) -> list[dict]:
        now = time.monotonic()
        with self._lock:
            return [
                {"key": fingerprint(k), "cooling_for_s": max(0, round(self._cooldown_until.get(k, 0.0) - now))}
                for k in self._keys
            ]


_pool: KeyPool | None = None
_pool_lock = threading.Lock()


def get_pool() -> KeyPool:
    """The process-wide pool, built once from the environment:
    NVIDIA_NIM_API_KEYS (several keys) and/or NVIDIA_NIM_API_KEY (one)."""
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = KeyPool(parse_keys(os.environ.get("NVIDIA_NIM_API_KEYS"), os.environ.get("NVIDIA_NIM_API_KEY")))
        return _pool


def reset_pool_for_tests() -> None:
    global _pool
    with _pool_lock:
        _pool = None
