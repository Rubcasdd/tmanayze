"""Client for the trackmania.io public API (community-run mirror of Nadeo's
live services). No OAuth needed — a descriptive User-Agent is enough; see
https://openplanet.dev/tmio/api for the usage terms this follows (40 req/min
by default, or 150/min with a free key supplied as TMIO_API_KEY).
"""

from __future__ import annotations

import os
import re
import threading
import time

import requests

from . import net

BASE = "https://trackmania.io/api"
SITE = "https://trackmania.io"

_MIN_INTERVAL_S = 60.0 / 40.0  # stay under the 40 req/min default tier
_last_call_lock = threading.Lock()
_last_call_at = 0.0

_GHOST_PATH = re.compile(r"^/api/download/ghost/([0-9a-fA-F-]{36})$")


class TmioError(RuntimeError):
    pass


def _throttle() -> None:
    global _last_call_at
    with _last_call_lock:
        wait = _MIN_INTERVAL_S - (time.monotonic() - _last_call_at)
        if wait > 0:
            time.sleep(wait)
        _last_call_at = time.monotonic()


def _headers() -> dict:
    headers = {"User-Agent": net.user_agent()}
    api_key = os.environ.get("TMIO_API_KEY")
    if api_key:
        headers["X-API-Key"] = api_key
    return headers


def _get(path: str, params: dict | None = None) -> dict | list:
    _throttle()
    try:
        resp = requests.get(f"{BASE}{path}", params=params, headers=_headers(), timeout=20)
    except requests.RequestException as e:
        raise TmioError(f"request to trackmania.io failed: {e}") from e
    if not resp.ok:
        raise TmioError(f"trackmania.io returned {resp.status_code} for {path}")
    return resp.json()


def search_players(name: str) -> list[dict]:
    data = _get("/players/find", {"search": name[:60]})
    return [entry["player"] for entry in data] if isinstance(data, list) else []


def get_player(account_id: str) -> dict:
    try:
        net.valid_uuid(account_id)
    except ValueError as e:
        raise TmioError(str(e)) from e
    return _get(f"/player/{account_id}")


def zone_standing(player: dict) -> list[dict]:
    """Flatten trophies.zone (Region->Country->Continent->World, nested via
    `parent`) into a list paired with the player's rank at each level from
    trophies.zonepositions (index 0 = the most local zone)."""
    trophies = player.get("trophies") or {}
    positions = trophies.get("zonepositions") or []
    levels = []
    node = trophies.get("zone")
    idx = 0
    while node:
        levels.append({
            "name": node.get("name"),
            "flag": node.get("flag"),
            "rank": positions[idx] if idx < len(positions) else None,
        })
        node = node.get("parent")
        idx += 1
    return levels


def get_map_leaderboard_page(map_uid: str, length: int = 20, offset: int = 0) -> tuple[list[dict], int | None]:
    """One page of the world leaderboard plus the total number of players."""
    try:
        net.valid_map_uid(map_uid)
    except ValueError as e:
        raise TmioError(str(e)) from e
    data = _get(f"/leaderboard/map/{map_uid}", {"offset": max(0, int(offset)), "length": max(1, min(int(length), 100))})
    if not isinstance(data, dict):
        return [], None
    total = data.get("playercount")
    return (data.get("tops") or []), (int(total) if isinstance(total, (int, float)) else None)


def get_map_leaderboard(map_uid: str, length: int = 20, offset: int = 0) -> list[dict]:
    return get_map_leaderboard_page(map_uid, length=length, offset=offset)[0]


def locate_time(map_uid: str, time_ms: int, page: int = 100) -> dict:
    """Find where a finish time sits on the world leaderboard.

    The board is sorted by time, so a binary search over pages (comparing each
    page's first time) lands on the right page in ~log2(players/100) requests,
    however deep the board is. Returns the page offset to show and, if exactly
    that time was found, its position.
    """
    first, total = get_map_leaderboard_page(map_uid, length=page, offset=0)
    if not first or total is None:
        return {"offset": 0, "total": total, "position": None}
    if time_ms <= (first[0].get("time") or 0):
        return {"offset": 0, "total": total, "position": 1 if time_ms == first[0].get("time") else None}
    lo, hi = 0, max(0, (total - 1) // page)  # page indexes
    # find the last page whose first time is <= time_ms
    best = 0
    while lo <= hi:
        mid = (lo + hi) // 2
        tops = first if mid == 0 else get_map_leaderboard_page(map_uid, length=page, offset=mid * page)[0]
        if not tops:
            hi = mid - 1
            continue
        if (tops[0].get("time") or 0) <= time_ms:
            best = mid
            lo = mid + 1
        else:
            hi = mid - 1
    tops = first if best == 0 else get_map_leaderboard_page(map_uid, length=page, offset=best * page)[0]
    position = next((t.get("position") for t in tops if t.get("time") == time_ms), None)
    return {"offset": best * page, "total": total, "position": position}


def ghost_download_url(ref: str) -> str:
    """Accept only a bare ghost id or the leaderboard's own relative path —
    never an arbitrary URL — and build the download URL ourselves."""
    ref = (ref or "").strip()
    if m := _GHOST_PATH.match(ref):
        return f"{SITE}/api/download/ghost/{m.group(1)}"
    try:
        return f"{SITE}/api/download/ghost/{net.valid_uuid(ref)}"
    except ValueError as e:
        raise TmioError("invalid ghost reference") from e


def download_ghost_bytes(ref: str) -> bytes:
    url = ghost_download_url(ref)
    _throttle()
    try:
        return net.download_limited(url, _headers())
    except requests.RequestException as e:
        raise TmioError(f"failed to download ghost: {e}") from e
