"""Turns a comparison into a short, ranked list of titled things to work on.

This is deterministic (no AI): every title and number comes straight from the
measured corner/section data, so it is always available and always agrees
with the charts. The AI gets the same list as pre-ranked candidates and
expands on it, rather than inventing its own.
"""

from __future__ import annotations

MIN_LOSS_MS = 15
MAX_FOCUS = 5
MAX_STRENGTHS = 2


def _min_loss(stats: dict) -> float:
    gap = stats.get("final_delta_ms") or 0
    return max(MIN_LOSS_MS, 0.03 * gap) if gap > 0 else MIN_LOSS_MS


def _speed_margin(ref_speed: float) -> float:
    return max(3.0, 0.02 * ref_speed)


def _shape(corner: dict) -> str:
    return "hairpin" if corner["turn_deg"] >= 120 else f"{corner['direction']} turn"


def _before(metres: float) -> str:
    return "right at the corner entry" if abs(metres) < 1.5 else f"{abs(metres):.0f} m before it"


def _steer_more(player_avg: float, ghost_avg: float, player_rev: int, ghost_rev: int) -> bool:
    return player_avg > ghost_avg * 1.15 + 0.03 or player_rev - ghost_rev >= 2


def _corner_candidate(c: dict) -> dict:
    tags: list[str] = []
    sb, rb = c.get("subject_brake_point_m"), c.get("reference_brake_point_m")
    entry = c["subject_entry_speed"] - c["reference_entry_speed"]
    low = c["subject_min_speed"] - c["reference_min_speed"]
    out = c["subject_exit_speed"] - c["reference_exit_speed"]
    margin = _speed_margin(c["reference_min_speed"])

    if sb is not None and rb is None:
        tags.append("brake_extra")
    if sb is not None and rb is not None and sb - rb <= -5:
        tags.append("brake_early")
    if entry < -margin:
        tags.append("slow_entry")
    if low < -margin:
        tags.append("slow_min")
    if out < -margin:
        tags.append("slow_exit")
    if _steer_more(c["subject_avg_steer"], c["reference_avg_steer"], c["subject_steer_reversals"], c["reference_steer_reversals"]):
        tags.append("steer_more")
    if sb is None and rb is not None:
        tags.append("brake_missing")

    actions = {
        "brake_extra": "Stop braking for",
        "brake_early": "Brake later for",
        "slow_entry": "Arrive faster at",
        "slow_min": "Carry more speed through",
        "slow_exit": "Get back on the gas earlier out of",
        "steer_more": "Smooth your steering through",
        "brake_missing": "Rethink your braking into",
    }
    primary = next((t for t in actions if t in tags), "general")
    base = actions.get(primary, "Tidy up your line through")

    evidence = []
    if low < -margin:
        evidence.append(f"slowest point {c['subject_min_speed']:.0f} vs {c['reference_min_speed']:.0f} km/h")
    if entry < -margin:
        evidence.append(f"entry {c['subject_entry_speed']:.0f} vs {c['reference_entry_speed']:.0f} km/h")
    if out < -margin:
        evidence.append(f"exit {c['subject_exit_speed']:.0f} vs {c['reference_exit_speed']:.0f} km/h")
    if "steer_more" in tags:
        evidence.append(
            f"steering avg {c['subject_avg_steer']:.2f} vs {c['reference_avg_steer']:.2f}, "
            f"{c['subject_steer_reversals']} vs {c['reference_steer_reversals']} reversals"
        )
    if "brake_extra" in tags:
        evidence.append(f"you braked {_before(sb)}; the ghost didn't brake")
    elif "brake_early" in tags:
        evidence.append(f"you began braking {abs(sb - rb):.0f} m earlier than the ghost")
    elif "brake_missing" in tags:
        evidence.append(f"the ghost braked {_before(rb)}; you didn't")

    return {
        "kind": "corner",
        "index": c["corner_index"],
        "tag": primary,
        "where": f"the {_shape(c)} at {c['distance_start']:.0f}–{c['distance_end']:.0f} m (corner {c['corner_index']})",
        "title": f"{base} the {_shape(c)} at {c['distance_start']:.0f}–{c['distance_end']:.0f} m (corner {c['corner_index']})",
        "time_change_ms": c["time_change_ms"],
        "distance_start": c["distance_start"],
        "distance_end": c["distance_end"],
        "evidence": evidence[:4],
    }


def _section_candidate(s: dict) -> dict:
    speed_gap = s["subject_avg_speed"] - s["reference_avg_speed"]
    margin = max(2.0, 0.015 * s["reference_avg_speed"])
    wobble = _steer_more(s["subject_avg_steer"], s["reference_avg_steer"], s["subject_steer_reversals"], s["reference_steer_reversals"])
    if speed_gap < -margin and not wobble:
        tag, base = "hold_speed", "Hold your speed on the stretch"
    elif wobble:
        tag, base = "steer_more", "Stop fidgeting with the steering on the stretch"
    else:
        tag, base = "general", "Find the missing speed on the stretch"

    evidence = []
    if speed_gap < -margin:
        evidence.append(f"average speed {s['subject_avg_speed']:.0f} vs {s['reference_avg_speed']:.0f} km/h")
    if wobble:
        evidence.append(
            f"steering avg {s['subject_avg_steer']:.2f} vs {s['reference_avg_steer']:.2f}, "
            f"{s['subject_steer_reversals']} vs {s['reference_steer_reversals']} reversals"
        )
    if s["subject_brake_events"] > s["reference_brake_events"]:
        evidence.append(f"{s['subject_brake_events']} brake taps vs {s['reference_brake_events']}")

    return {
        "kind": "section",
        "index": s["index"],
        "tag": tag,
        "where": f"the stretch between {s['distance_start']:.0f}–{s['distance_end']:.0f} m (section {s['index']})",
        "title": f"{base} between {s['distance_start']:.0f}–{s['distance_end']:.0f} m (section {s['index']})",
        "time_change_ms": s["time_change_ms"],
        "distance_start": s["distance_start"],
        "distance_end": s["distance_end"],
        "evidence": evidence[:4],
    }


def _section_for(distance: float, sections: list[dict]) -> int | None:
    for s in sections:
        if s["distance_start"] <= distance <= s["distance_end"]:
            return s["index"]
    return None


def find_focus(stats: dict, corners: list[dict], sections: list[dict]) -> dict:
    """Ranked areas to work on, plus the stretches already going well."""
    if not stats.get("telemetry"):
        return {"focus": [], "strengths": []}
    threshold = _min_loss(stats)

    candidates = [_corner_candidate(c) for c in corners]
    # Sections without corners are straights/sweepers the corner list can't
    # explain; sections that do contain corners are already covered by them.
    candidates += [_section_candidate(s) for s in sections if not s["corner_indices"]]

    # A sliver of track right at the finish is mostly sample-granularity
    # noise (the last sample of each run rarely lands on the line), not driving.
    total = sections[-1]["distance_end"] if sections else None
    if total:
        candidates = [
            c for c in candidates
            if not (c["distance_end"] >= total - 3 and c["distance_end"] - c["distance_start"] < 25)
        ]

    for cand in candidates:
        cand["section_index"] = _section_for((cand["distance_start"] + cand["distance_end"]) / 2, sections)
        cand["time_change_ms"] = int(cand["time_change_ms"])

    losses = sorted((c for c in candidates if c["time_change_ms"] >= threshold), key=lambda c: -c["time_change_ms"])
    gains = sorted((c for c in candidates if c["time_change_ms"] <= -threshold), key=lambda c: c["time_change_ms"])

    focus = losses[:MAX_FOCUS]
    for i, item in enumerate(focus, start=1):
        item["rank"] = i
        item["evidence"] = [f"{item['time_change_ms'] / 1000:+.2f} s lost here"] + item["evidence"]

    strengths = []
    for item in gains[:MAX_STRENGTHS]:
        item = dict(item)
        lead = "how you take" if item["kind"] == "corner" else "your pace through"
        item["title"] = f"Keep doing this: {lead} {item['where']}"
        item["evidence"] = [f"{-item['time_change_ms'] / 1000:.2f} s gained here"]
        strengths.append(item)
    return {"focus": focus, "strengths": strengths}
