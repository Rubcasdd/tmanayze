"""Client for the ManiaExchange (trackmania.exchange) v2 API.

No API key needed — only a descriptive User-Agent header.
"""

from __future__ import annotations

import requests

from . import net

BASE = "https://trackmania.exchange"

MAP_FIELDS = (
    "MapId,Name,MapUid,Authors[],Environment,Tags[],Length,Difficulty,"
    "AwardCount,DownloadCount,ReplayCount,OnlineWR,UploadedAt"
)
REPLAY_FIELDS = "ReplayId,User.Name,ReplayTime,ReplayAt,Position,IsBest,HasFile"


class MxError(RuntimeError):
    pass


def _headers() -> dict:
    return {"User-Agent": net.user_agent()}


def _get(path: str, params: dict | None = None) -> dict:
    try:
        resp = requests.get(f"{BASE}{path}", params=params, headers=_headers(), timeout=20)
    except requests.RequestException as e:
        raise MxError(f"request to ManiaExchange failed: {e}") from e
    if not resp.ok:
        raise MxError(f"ManiaExchange returned {resp.status_code} for {path}")
    return resp.json()


def search_maps(name: str | None = None, tag: str | None = None, count: int = 24) -> list[dict]:
    params = {"count": max(1, min(int(count), 50)), "fields": MAP_FIELDS}
    if name:
        params["name"] = name[:100]
    if tag:
        params["tag"] = tag[:50]
    return _get("/api/maps", params).get("Results", [])


def get_map_by_uid(map_uid: str) -> dict | None:
    try:
        net.valid_map_uid(map_uid)
    except ValueError as e:
        raise MxError(str(e)) from e
    results = _get("/api/maps", {"uid": map_uid, "fields": MAP_FIELDS}).get("Results", [])
    return results[0] if results else None


def list_replays(map_id: int, count: int = 20) -> list[dict]:
    data = _get("/api/replays", {"mapid": int(map_id), "count": max(1, min(int(count), 50)), "fields": REPLAY_FIELDS})
    return data.get("Results", [])


def thumbnail_url(map_id: int) -> str:
    return f"{BASE}/mapimage/{int(map_id)}/1"


def download_replay_bytes(replay_id: int) -> bytes:
    url = f"{BASE}/recordgbx/{int(replay_id)}"
    try:
        return net.download_limited(url, _headers())
    except requests.RequestException as e:
        raise MxError(f"failed to download replay {int(replay_id)}: {e}") from e
