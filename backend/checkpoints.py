"""The game's own checkpoint times, and what they give us.

A replay or ghost carries the time the game recorded at every checkpoint (the last one is the finish). With
those we can show real splits, cut the track into "CP 2 -> CP 3" sections instead of equal slices, and put
flags on the track where the checkpoints are (the player's position at each checkpoint time).

Runs saved before the parser read these have no checkpoint times: they get the equal-distance sections as before.
A reference with a different number of checkpoints (another map version) gives no splits.
"""

from __future__ import annotations

MIN_SECTION_M = 60.0    # a stretch shorter than this is merged into its neighbour
MAX_SECTIONS = 12


def _usable(cps) -> bool:
    return isinstance(cps, list) and len(cps) >= 2 and all(isinstance(t, int) and t > 0 for t in cps) and all(b > a for a, b in zip(cps, cps[1:]))


def subject_passes(samples: list[dict], cps: list[int] | None) -> dict | None:
    """Where the player was at each checkpoint (the last entry of `cps` is the finish). None without usable times."""
    if len(samples) < 20 or not _usable(cps):
        return None
    from .compare import _cumulative_distance

    dist = _cumulative_distance(samples)
    times = [s["time_ms"] for s in samples]  # the same clock as the checkpoint times
    passes = []
    k = 0
    for index, t in enumerate(cps, start=1):
        while k < len(times) - 2 and times[k + 1] < t:
            k += 1
        a, b = samples[k], samples[k + 1]
        span = max(1, times[k + 1] - times[k])
        u = max(0.0, min(1.0, (t - times[k]) / span))
        passes.append({
            "index": index, "t_ms": t,
            "dist_m": dist[k] + u * (dist[k + 1] - dist[k]),
            "x": round(a["x"] + u * (b["x"] - a["x"]), 1), "y": round(a["y"] + u * (b["y"] - a["y"]), 1),
            "z": round(a["z"] + u * (b["z"] - a["z"]), 1),
        })
    finish = passes.pop()  # the last time is the finish: it gives the length of the lap up to the line
    return {"passes": passes, "end_ms": cps[-1], "total_m": finish["dist_m"]}


def rows(info: dict, ref_cps: list[int] | None) -> list[dict]:
    """Split table: for each checkpoint and the finish, both runs' times, the gap there, and the same for the stretch."""
    if not info or not _usable(ref_cps) or len(ref_cps) != len(info["passes"]) + 1:
        return []
    out = []
    prev_s = prev_r = 0
    items = [(f"CP {p['index']}", p["t_ms"], ref_cps[i], p) for i, p in enumerate(info["passes"])]
    items.append(("Finish", info["end_ms"], ref_cps[-1], {"dist_m": info["total_m"], "x": None, "y": None, "z": None}))
    for k, (label, s_ms, r_ms, p) in enumerate(items, start=1):
        out.append({
            "index": k, "label": label, "subject_ms": s_ms, "reference_ms": r_ms, "delta_ms": s_ms - r_ms,
            "split_subject_ms": s_ms - prev_s, "split_reference_ms": r_ms - prev_r,
            "split_delta_ms": (s_ms - prev_s) - (r_ms - prev_r),
            "dist_m": round(p["dist_m"], 1), "x": p["x"], "y": p["y"], "z": p["z"],
        })
        prev_s, prev_r = s_ms, r_ms
    return out


def section_bounds(info: dict | None) -> list[dict] | None:
    """Where to cut the track into sections: start, every checkpoint, finish, as distances along the player's run.
    Short stretches are merged and the count is capped so the section charts stay readable."""
    if not info:
        return None
    pts = [{"label": "Start", "dist_m": 0.0}] + [{"label": f"CP {p['index']}", "dist_m": p["dist_m"]} for p in info["passes"]] + [{"label": "Finish", "dist_m": info["total_m"]}]
    changed = True
    while changed and len(pts) > 2:
        changed = False
        for i in range(len(pts) - 1):
            if pts[i + 1]["dist_m"] - pts[i]["dist_m"] < MIN_SECTION_M:
                drop = i + 1 if i + 1 < len(pts) - 1 else i  # keep the finish; merge the last stretch into the one before it
                if drop == 0:
                    drop = 1
                pts.pop(drop)
                changed = True
                break
    while len(pts) - 1 > MAX_SECTIONS:  # still too many: merge the two shortest neighbours
        gaps = [pts[i + 2]["dist_m"] - pts[i]["dist_m"] for i in range(len(pts) - 2)]
        k = min(range(len(gaps)), key=lambda i: gaps[i]) + 1
        pts.pop(k)
    return pts if len(pts) >= 3 else None


def splits_text(rows_: list[dict]) -> str:
    """Prompt lines for the coach."""
    if not rows_:
        return ""
    lines = ["CHECKPOINT SPLITS (the game's own checkpoint times; + means the player is slower):"]
    for r in rows_:
        lines.append(
            f"- {r['label']}: player {r['subject_ms'] / 1000:.3f}s vs ghost {r['reference_ms'] / 1000:.3f}s "
            f"(gap {r['delta_ms'] / 1000:+.3f}s); this stretch {r['split_subject_ms'] / 1000:.3f}s vs {r['split_reference_ms'] / 1000:.3f}s "
            f"({r['split_delta_ms'] / 1000:+.3f}s), ending at ~{r['dist_m']:.0f}m"
        )
    worst = max(rows_, key=lambda r: r["split_delta_ms"])
    if worst["split_delta_ms"] > 30:
        prev = "Start" if worst["index"] == 1 else rows_[worst["index"] - 2]["label"]
        lines.append(f"- The biggest loss between checkpoints is {prev} -> {worst['label']}: {worst['split_delta_ms'] / 1000:+.3f}s.")
    return "\n".join(lines)
