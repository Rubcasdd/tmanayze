"""Client for the ManiaExchange (trackmania.exchange) v2 API.

No API key needed — only a descriptive User-Agent header.
"""

from __future__ import annotations

import time

import requests

from . import net

BASE = "https://trackmania.exchange"

MAP_FIELDS = (
    "MapId,Name,MapUid,Authors[],Environment,Tags[],Length,Difficulty,"
    "AwardCount,DownloadCount,ReplayCount,OnlineWR,UploadedAt"
)
REPLAY_FIELDS = "ReplayId,User.Name,ReplayTime,ReplayAt,Position,IsBest,HasFile"


# Statuses that mean "try again shortly" rather than "your request was wrong".
_RETRY_STATUSES = {429, 500, 502, 503, 504}


class MxError(RuntimeError):
    def __init__(self, message: str, unavailable: bool = False):
        super().__init__(message)
        # True when ManiaExchange itself is down or overloaded (as opposed to
        # rejecting this particular request), so callers can fall back.
        self.unavailable = unavailable


# Successful answers are kept for a while, and an old answer is better than an
# error when ManiaExchange goes down.
_cache: dict[str, tuple[float, object]] = {}


def _cached(key: str, ttl_s: float, fetch):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl_s:
        return hit[1]
    try:
        value = fetch()
    except MxError:
        if hit:
            return hit[1]
        raise
    _cache[key] = (time.time(), value)
    if len(_cache) > 500:
        _cache.pop(next(iter(_cache)))
    return value


def _headers() -> dict:
    return {"User-Agent": net.user_agent()}


# After ManiaExchange has failed, don't keep every request waiting on it: fail
# straight away for a short while (callers fall back or show a message).
_down_until = 0.0
_down_error: MxError | None = None
_DOWN_FOR_S = 45.0


def _get(path: str, params: dict | None = None, retries: int = 1) -> dict:
    global _down_until, _down_error
    if time.time() < _down_until and _down_error is not None:
        raise _down_error
    last: MxError | None = None
    for attempt in range(retries + 1):
        try:
            resp = requests.get(f"{BASE}{path}", params=params, headers=_headers(), timeout=10)
        except requests.RequestException as e:
            last = MxError(f"request to ManiaExchange failed: {e}", unavailable=True)
        else:
            if resp.ok:
                _down_until = 0.0
                return resp.json()
            if resp.status_code not in _RETRY_STATUSES:
                raise MxError(f"ManiaExchange returned {resp.status_code} for {path}")
            last = MxError(
                f"ManiaExchange isn't responding right now (it returned {resp.status_code}). Try again in a minute.",
                unavailable=True,
            )
        if attempt < retries:
            time.sleep(0.6 * (attempt + 1))
    assert last is not None
    _down_until = time.time() + _DOWN_FOR_S
    _down_error = last
    raise last


def search_maps(name: str | None = None, tag: str | None = None, count: int = 24) -> list[dict]:
    params = {"count": max(1, min(int(count), 50)), "fields": MAP_FIELDS}
    if name:
        params["name"] = name[:100]
    if tag:
        params["tag"] = tag[:50]
    return _cached(f"search:{name}:{tag}:{params['count']}", 300, lambda: _get("/api/maps", params).get("Results", []))


def get_map_by_uid(map_uid: str) -> dict | None:
    try:
        net.valid_map_uid(map_uid)
    except ValueError as e:
        raise MxError(str(e)) from e
    def fetch():
        results = _get("/api/maps", {"uid": map_uid, "fields": MAP_FIELDS}).get("Results", [])
        return results[0] if results else None

    return _cached(f"map:{map_uid}", 3600, fetch)


def list_replays(map_id: int, count: int = 20) -> list[dict]:
    params = {"mapid": int(map_id), "count": max(1, min(int(count), 50)), "fields": REPLAY_FIELDS}
    return _cached(f"replays:{map_id}:{params['count']}", 300, lambda: _get("/api/replays", params).get("Results", []))


def thumbnail_url(map_id: int) -> str:
    return f"{BASE}/mapimage/{int(map_id)}/1"


def download_replay_bytes(replay_id: int) -> bytes:
    url = f"{BASE}/recordgbx/{int(replay_id)}"
    try:
        return net.download_limited(url, _headers())
    except requests.RequestException as e:
        raise MxError(f"failed to download replay {int(replay_id)}: {e}") from e
