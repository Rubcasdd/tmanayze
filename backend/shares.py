"""Shared comparisons ("challenge a friend").

The site is stateless, so a shared comparison needs somewhere to live for a while: two runs' driving data,
gzipped, kept for 30 days under a short random id. On Vercel that is Upstash/KV (the same store the rate
limits use); locally, in memory. Without a shared store on a serverless host the feature says so instead of
handing out links that would stop working.
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import re
import secrets
import threading
import time

import requests

TTL_S = 30 * 24 * 3600
MAX_PACKED = 900_000          # bytes of base64: under Upstash's 1 MB request limit
MAX_SAMPLES = 6000            # per run; longer runs are thinned
ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,16}$")
_KEYS = ("time_ms", "x", "y", "z", "speed", "steer", "gas", "brake", "fx", "fy", "fz", "ux", "uy", "uz")


class ShareError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class MemoryStore:
    persistent = False

    def __init__(self):
        self._data: dict[str, tuple[float, str]] = {}
        self._lock = threading.Lock()

    def put(self, key: str, value: str, ttl: int) -> None:
        with self._lock:
            now = time.time()
            self._data = {k: v for k, v in self._data.items() if v[0] > now}
            while len(self._data) >= 200:  # keep memory bounded
                self._data.pop(next(iter(self._data)))
            self._data[key] = (now + ttl, value)

    def get(self, key: str) -> str | None:
        with self._lock:
            hit = self._data.get(key)
            return hit[1] if hit and hit[0] > time.time() else None


class UpstashStore:
    persistent = True

    def __init__(self, url: str, token: str):
        self._url = url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"}

    def _run(self, command: list) -> object:
        try:
            resp = requests.post(f"{self._url}/pipeline", headers=self._headers, json=[command], timeout=8)
            resp.raise_for_status()
            result = resp.json()[0]
        except (requests.RequestException, ValueError, IndexError) as e:
            raise ShareError("The sharing storage isn't responding. Try again in a moment.", 503) from e
        if isinstance(result, dict) and result.get("error"):
            raise ShareError("The sharing storage refused the data.", 503)
        return result.get("result") if isinstance(result, dict) else None

    def put(self, key: str, value: str, ttl: int) -> None:
        self._run(["SET", key, value, "EX", ttl])

    def get(self, key: str) -> str | None:
        value = self._run(["GET", key])
        return value if isinstance(value, str) else None


_store = None


def get_store():
    global _store
    if _store is None:
        url = os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL")
        token = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN")
        _store = UpstashStore(url, token) if url and token else MemoryStore()
    return _store


def available() -> bool:
    """False on a serverless host with no shared store: a memory store would lose the link on the next request."""
    return get_store().persistent or not os.environ.get("VERCEL")


def _thin(run: dict, stride: int = 1) -> dict:
    samples = run.get("samples") or []
    step = max(stride, -(-len(samples) // MAX_SAMPLES))
    slim = [{k: s[k] for k in _KEYS if s.get(k) is not None} for s in samples[::step]]
    return {k: run.get(k) for k in ("id", "map_uid", "map_name", "player_nickname", "race_time_ms", "world_position")} | {"samples": slim}


def pack(subject: dict, reference: dict, note: str | None) -> str:
    for stride in (1, 2, 3, 4):
        payload = {"v": 1, "created": int(time.time()), "note": (note or "").strip()[:140], "subject": _thin(subject, stride), "reference": _thin(reference, stride)}
        packed = base64.b64encode(gzip.compress(json.dumps(payload, separators=(",", ":")).encode(), 6)).decode()
        if len(packed) <= MAX_PACKED:
            return packed
    raise ShareError("These runs are too long to share as a link.", 413)


def unpack(packed: str) -> dict:
    try:
        return json.loads(gzip.decompress(base64.b64decode(packed)))
    except (ValueError, OSError) as e:
        raise ShareError("That shared comparison is damaged.", 410) from e


def create(subject: dict, reference: dict, note: str | None) -> str:
    if not available():
        raise ShareError("Sharing needs storage that this deployment doesn't have yet (connect Upstash/Vercel KV).", 503)
    if not subject.get("samples") or not reference.get("samples"):
        raise ShareError("Both runs need driving data to be shared.", 400)
    packed = pack(subject, reference, note)
    share_id = secrets.token_urlsafe(8)
    get_store().put(f"tmshare:{share_id}", packed, TTL_S)
    return share_id


def fetch(share_id: str) -> dict:
    if not ID_RE.match(share_id or ""):
        raise ShareError("That isn't a valid share link.", 400)
    packed = get_store().get(f"tmshare:{share_id}")
    if packed is None:
        raise ShareError("That shared comparison has expired or doesn't exist.", 404)
    return unpack(packed)
