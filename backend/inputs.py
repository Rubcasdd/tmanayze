"""What a driver actually pressed through a corner.

Turns the raw steering / brake / throttle samples around a corner into a short
list of runs ("steer right for 0.9 s, average 0.55", "brake for 0.3 s starting
45 m before the corner"), positioned in metres from the corner's start. This is
the "script" for a corner: what to do with the inputs and when. It is built the
same way for the player and the ghost so the two can be set side by side.

Steering is positive to the right (as in the game).
"""

from __future__ import annotations

STEER_ON = 0.15      # below this the wheel counts as straight
FULL_LOCK = 0.9
BRAKE_ON = 0.1
LIFT_GAS = 0.5       # gas below this (with no brake) is a lift
LEAD_M = 70.0        # metres before the corner start to include
TAIL_M = 30.0        # and after its end
MAX_RUNS = 10


def _dt_s(samples: list[dict], a: int, b: int) -> float:
    return (samples[b]["time_ms"] - samples[a]["time_ms"]) / 1000.0 + 0.05


def _groups(keys: list, gap: int = 1) -> list[tuple[int, int, object]]:
    """Runs of equal non-None keys; up to `gap` odd samples inside a run are ignored."""
    out: list[tuple[int, int, object]] = []
    start = None
    key = None
    last = -10
    for i, k in enumerate(keys):
        if start is None:
            if k is not None:
                start, key, last = i, k, i
        elif k is not None and k == key:
            last = i
        elif i - last > gap:
            out.append((start, last, key))
            start = None
            if k is not None:
                start, key, last = i, k, i
    if start is not None:
        out.append((start, last, key))
    return out


def corner_inputs(samples: list[dict], dist: list[float], start: int, end: int) -> list[dict]:
    n = len(samples)
    base = dist[start]
    lo = start
    while lo > 0 and base - dist[lo - 1] <= LEAD_M:
        lo -= 1
    hi = end
    while hi < n - 1 and dist[hi + 1] - dist[end] <= TAIL_M:
        hi += 1
    window = samples[lo:hi + 1]
    runs: list[dict] = []

    def where(a: int, b: int) -> tuple[float, float]:
        return round(dist[lo + a] - base, 1), round(dist[lo + b] - base, 1)

    steer_keys = [("right" if s["steer"] > 0 else "left") if abs(s["steer"]) >= STEER_ON else None for s in window]
    for a, b, d in _groups(steer_keys):
        dur = _dt_s(window, a, b)
        if dur < 0.1:
            continue
        mags = [abs(s["steer"]) for s in window[a:b + 1]]
        f, t = where(a, b)
        runs.append({
            "kind": "steer", "dir": d, "from_m": f, "to_m": t, "dur_s": round(dur, 2),
            "avg": round(sum(mags) / len(mags), 2), "peak": round(max(mags), 2),
            "full": round(sum(1 for m in mags if m >= FULL_LOCK) / len(mags), 2),
        })

    brake_keys = [True if s["brake"] > BRAKE_ON else None for s in window]
    for a, b, _ in _groups(brake_keys):
        f, t = where(a, b)
        runs.append({"kind": "brake", "from_m": f, "to_m": t, "dur_s": round(_dt_s(window, a, b), 2),
                     "peak": round(max(s["brake"] for s in window[a:b + 1]), 2)})

    lift_keys = [True if (s["gas"] < LIFT_GAS and s["brake"] <= BRAKE_ON) else None for s in window]
    for a, b, _ in _groups(lift_keys):
        dur = _dt_s(window, a, b)
        if dur < 0.15:
            continue
        f, t = where(a, b)
        runs.append({"kind": "lift", "from_m": f, "to_m": t, "dur_s": round(dur, 2)})

    runs.sort(key=lambda r: r["from_m"])
    return runs[:MAX_RUNS * 3]


def describe(runs: list[dict]) -> str:
    """One compact line for the coach prompt."""
    if not runs:
        return "no steering, braking or lifting"
    parts = []
    for r in runs:
        at = f"{abs(r['from_m']):.0f} m {'before' if r['from_m'] < 0 else 'into'} the corner" if abs(r["from_m"]) >= 1 else "at the corner start"
        if r["kind"] == "steer":
            full = f", full lock {int(r['full'] * 100)}%" if r["full"] >= 0.3 else ""
            parts.append(f"steer {r['dir']} {r['dur_s']:.1f}s (avg {r['avg']:.2f}, peak {r['peak']:.2f}{full}) from {at}")
        elif r["kind"] == "brake":
            parts.append(f"brake {r['dur_s']:.2f}s from {at}")
        else:
            parts.append(f"lift {r['dur_s']:.2f}s from {at}")
    return "; ".join(parts)
