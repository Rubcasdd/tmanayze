"""One-time bridge for runs saved by the earlier server-side-storage version
of this app (flat JSON files under data/). The app now keeps runs in the
browser, so locally the frontend asks for these once and copies them into
its own storage. The files themselves are never modified or deleted.
"""

from __future__ import annotations

import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_MS_TO_KMH = 3.6  # the old pipeline stored speed in m/s


def _compact(sample: dict) -> dict | None:
    try:
        return {
            "time_ms": int(sample["time_ms"]),
            "x": round(float(sample["x"]), 2),
            "y": round(float(sample["y"]), 2),
            "z": round(float(sample["z"]), 2),
            "speed": round(float(sample["speed"]) * _MS_TO_KMH, 1),
            "steer": round(float(sample["steer"]), 3),
            "gas": round(float(sample["gas"]), 2),
            "brake": round(float(sample["brake"]), 2),
        }
    except (KeyError, TypeError, ValueError):
        return None


def load_legacy_runs() -> list[dict]:
    if not DATA_DIR.is_dir():
        return []
    runs = []
    for path in sorted(DATA_DIR.glob("*/*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        samples = [s for s in (_compact(x) for x in data.get("samples", [])) if s]
        if not data.get("id") or not data.get("map_uid"):
            continue
        runs.append({
            "id": f"legacy-{data['id']}",
            "map_uid": data["map_uid"],
            "map_name": data.get("map_name"),
            "player_nickname": data.get("player_nickname"),
            "race_time_ms": data.get("race_time_ms"),
            "kind": data.get("kind") or "run",
            "source": data.get("source") or "upload",
            "world_position": data.get("world_position"),
            "source_filename": data.get("source_filename"),
            "uploaded_at": data.get("uploaded_at"),
            "telemetry_available": bool(samples),
            "samples": samples,
        })
    return runs
