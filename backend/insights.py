"""Aggregates map metadata (ManiaExchange) + world leaderboard position and
zone standing (trackmania.io) into one payload, used both by the /api/insights
endpoint (for display) and /api/analyze (to enrich the AI prompt).
"""

from __future__ import annotations

from . import mx_client, tmio_client

LEADERBOARD_SCAN_LENGTH = 50


def map_context(map_uid: str) -> dict | None:
    try:
        m = mx_client.get_map_by_uid(map_uid)
    except mx_client.MxError:
        return None
    if not m:
        return None
    return {
        "name": m.get("Name"),
        "authors": [a["User"]["Name"] for a in m.get("Authors", [])],
        "tags": [t["Name"] for t in m.get("Tags", [])],
        "difficulty": m.get("Difficulty"),
        "award_count": m.get("AwardCount"),
        "thumbnail_url": mx_client.thumbnail_url(m["MapId"]) if m.get("MapId") else None,
        "map_id": m.get("MapId"),
    }


def world_leaderboard(map_uid: str, length: int = LEADERBOARD_SCAN_LENGTH) -> list[dict]:
    try:
        tops = tmio_client.get_map_leaderboard(map_uid, length=length)
    except tmio_client.TmioError:
        return []
    out = []
    for t in tops:
        out.append({
            "position": t.get("position"),
            "player_name": t.get("player", {}).get("name"),
            "account_id": t.get("player", {}).get("id"),
            "time_ms": t.get("time"),
            "ghost_url": t.get("url"),
        })
    return out


def player_world_position(leaderboard: list[dict], race_time_ms: int | None) -> dict | None:
    if race_time_ms is None or not leaderboard:
        return None
    faster = [r for r in leaderboard if r["time_ms"] is not None and r["time_ms"] < race_time_ms]
    nth = leaderboard[-1]
    if len(faster) < len(leaderboard):
        # There's at least one leaderboard entry at or slower than race_time_ms,
        # so the player's exact position among the scanned entries is knowable.
        return {"position": len(faster) + 1, "exact": True, "scanned": len(leaderboard)}
    return {
        "position": None,
        "exact": False,
        "scanned": len(leaderboard),
        "gap_to_nth_ms": race_time_ms - nth["time_ms"] if nth["time_ms"] is not None else None,
        "nth_place": len(leaderboard),
    }


def player_zone_standing(account_id: str) -> dict | None:
    try:
        profile = tmio_client.get_player(account_id)
    except tmio_client.TmioError:
        return None
    return {
        "name": profile.get("displayname"),
        "club_tag": profile.get("clubtag"),
        "trophy_points": (profile.get("trophies") or {}).get("points"),
        "zones": tmio_client.zone_standing(profile),
    }


def gather(map_uid: str, race_time_ms: int | None = None, account_id: str | None = None) -> dict:
    leaderboard = world_leaderboard(map_uid)
    return {
        "map": map_context(map_uid),
        "world_leaderboard_top": leaderboard[:10],
        "player_world_position": player_world_position(leaderboard, race_time_ms),
        "player_zone": player_zone_standing(account_id) if account_id else None,
    }
