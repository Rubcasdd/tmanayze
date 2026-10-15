"""The map blueprint: exactly what the fastest runs do with the wheel, metre by metre, and where yours differs.

With one or more reference ghosts aligned to the player's distance axis (compare.py already does this), the
steering of the references is combined into a median trace with the spread between them. From that we get

- a script: where the references steer left or right, how much (peak and average) and for how long, and
- zones: the stretches where the player's steering differs from the references' by a clear margin, each with
  the numbers (their steer, your steer, where they start, where you start, how much time went there) and a
  plain instruction built from those numbers.

It is made for ice and bobsleigh maps, where the whole lap is steering, but it works on any map. For a
reference driven on a keyboard (steering only ever -1, 0 or 1) the numbers are expressed as holds in seconds,
because "0.31" means nothing there. Steering is positive to the right.
"""

from __future__ import annotations

import bisect
import statistics

GRID_M = 10.0
WINDOW_CELLS = 4            # 40 m windows
DIFF_ANALOG = 0.13          # mean steering difference that makes a zone
DIFF_DIGITAL = 0.35
RUN_ON_ANALOG = 0.10        # |steer| above this counts as steering in the script
RUN_ON_DIGITAL = 0.5
ONSET = 0.08
MAX_ZONES = 10
MAX_SCRIPT = 40


def _series(points: list[dict], key: str) -> tuple[list[float], list[float]]:
    return [p["distance_m"] for p in points], [p[key] for p in points]


def _at(ds: list[float], vs: list[float], x: float) -> float:
    i = bisect.bisect_left(ds, x)
    if i <= 0:
        return vs[0]
    if i >= len(ds):
        return vs[-1]
    span = ds[i] - ds[i - 1]
    k = 0.0 if span <= 0 else (x - ds[i - 1]) / span
    return vs[i - 1] + k * (vs[i] - vs[i - 1])


def _smooth(vals: list[float], passes: int = 2) -> list[float]:
    """A light low-pass over neighbouring cells (about 30 m): the wheel is jittery at a fine scale, and a plan
    means the steering that is held, not every twitch."""
    out = list(vals)
    for _ in range(passes):
        out = [(out[max(0, i - 1)] + 2 * out[i] + out[min(len(out) - 1, i + 1)]) / 4 for i in range(len(out))]
    return out


def _dir(v: float, floor: float = 0.04) -> str:
    return "straight" if abs(v) < floor else ("right" if v > 0 else "left")


def _runs(vals: list[float], on: float, gap: int = 1) -> list[tuple[int, int]]:
    """Index ranges where |value| >= on, with up to `gap` quiet cells inside a run and no sign flips inside one."""
    out: list[tuple[int, int]] = []
    start = None
    last = -10
    sign = 0
    for i, v in enumerate(vals):
        s = 1 if v > 0 else -1
        if abs(v) >= on:
            if start is not None and s != sign:
                out.append((start, last))
                start = None
            if start is None:
                start, sign = i, s
            last = i
        elif start is not None and i - last > gap:
            out.append((start, last))
            start = None
    if start is not None:
        out.append((start, last))
    return out


def build(points_by_ref: dict[str, list[dict]], primary_id: str, analog: bool = True) -> dict | None:
    """The blueprint from every reference's aligned points. None when there isn't enough to say anything."""
    refs = {rid: pts for rid, pts in points_by_ref.items() if len(pts) >= 20}
    if primary_id not in refs:
        return None
    primary = refs[primary_id]
    total = primary[-1]["distance_m"]
    if total < 200:
        return None
    n = int(total // GRID_M) + 1
    grid = [i * GRID_M for i in range(n)]

    sd, sv = _series(primary, "subject_steer")
    you = _smooth([_at(sd, sv, x) for x in grid])
    per_ref = []
    for pts in refs.values():
        d, v = _series(pts, "reference_steer")
        per_ref.append(_smooth([_at(d, v, x) for x in grid]))
    med = [statistics.median(col) for col in zip(*per_ref)]
    lo = [min(col) for col in zip(*per_ref)]
    hi = [max(col) for col in zip(*per_ref)]
    spread = [h - l for h, l in zip(hi, lo)]
    speed_d, speed_v = _series(primary, "reference_speed")
    speed = [_at(speed_d, speed_v, x) for x in grid]
    delta_d, delta_v = _series(primary, "delta_ms")

    diff_floor = DIFF_ANALOG if analog else DIFF_DIGITAL
    run_on = RUN_ON_ANALOG if analog else RUN_ON_DIGITAL

    # ---- the script of the references
    script = []
    for a, b in _runs(med, run_on, gap=1):
        seg = med[a:b + 1]
        length = (b - a + 1) * GRID_M
        v_ms = max(1.0, statistics.fmean(speed[a:b + 1]) / 3.6)
        script.append({
            "from_m": round(grid[a], 0), "to_m": round(grid[b] + GRID_M, 0), "dir": _dir(statistics.fmean(seg)),
            "avg": round(statistics.fmean(abs(x) for x in seg), 2), "peak": round(max(abs(x) for x in seg), 2),
            "dur_s": round(length / v_ms, 2), "agree": round(statistics.fmean(spread[a:b + 1]), 2),
        })
    script = script[:MAX_SCRIPT]

    # ---- zones where the player's steering differs
    flagged = []
    for a in range(0, n - WINDOW_CELLS + 1, WINDOW_CELLS // 2):
        b = a + WINDOW_CELLS
        m_mean = statistics.fmean(med[a:b])
        y_mean = statistics.fmean(you[a:b])
        opposite = abs(m_mean) >= 0.1 and abs(y_mean) >= 0.1 and (m_mean > 0) != (y_mean > 0)
        if abs(y_mean - m_mean) >= diff_floor or opposite:
            flagged.append((a, b))
    merged: list[list[int]] = []
    for a, b in flagged:
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])

    def onset(vals: list[float], a: int, b: int) -> float | None:
        for i in range(max(0, a - 6), min(n, b)):
            if abs(vals[i]) >= (ONSET if analog else 0.5):
                return grid[i]
        return None

    zones = []
    for a, b in merged:
        b = min(b, n)
        m_seg, y_seg = med[a:b], you[a:b]
        if not m_seg:
            continue
        m_mean, y_mean = statistics.fmean(m_seg), statistics.fmean(y_seg)
        m_peak = max(m_seg, key=abs)
        y_peak = max(y_seg, key=abs)
        t0, t1 = _at(delta_d, delta_v, grid[a]), _at(delta_d, delta_v, grid[min(b, n - 1)])
        v_ms = max(1.0, statistics.fmean(speed[a:b]) / 3.6)
        length = (b - a) * GRID_M
        zones.append({
            "from_m": round(grid[a], 0), "to_m": round(grid[min(b, n - 1)], 0),
            "ref_avg": round(m_mean, 2), "ref_peak": round(m_peak, 2), "you_avg": round(y_mean, 2), "you_peak": round(y_peak, 2),
            "ref_dir": _dir(m_mean, 0.08), "you_dir": _dir(y_mean, 0.08), "agree": round(statistics.fmean(spread[a:b]), 2),
            "ref_onset_m": onset(med, a, b), "you_onset_m": onset(you, a, b),
            "time_ms": round(t1 - t0), "dur_s": round(length / v_ms, 2),
            "ref_hold_s": round(sum(1 for x in m_seg if abs(x) >= run_on) * GRID_M / v_ms, 2),
            "you_hold_s": round(sum(1 for x in y_seg if abs(x) >= run_on) * GRID_M / v_ms, 2),
        })
    for z in zones:
        confidence = 1.0 / (1.0 + 3.0 * z["agree"])  # zones where the references agree matter more than ones they split on
        z["score"] = round((max(0, z["time_ms"]) / 8 + 60 * abs(z["you_avg"] - z["ref_avg"])) * confidence, 1)
        z["text"] = zone_text(z, analog)
    # a difference between two near-centred wheels (under ~0.18) is noise, not a plan
    zones = [z for z in zones if max(abs(z["ref_avg"]), abs(z["you_avg"])) >= (0.18 if analog else 0.5)]
    zones.sort(key=lambda z: -z["score"])
    zones = sorted(zones[:MAX_ZONES], key=lambda z: z["from_m"])

    return {
        "refs": len(refs), "style": "analog" if analog else "digital",
        "series": {
            "d": [round(x) for x in grid], "you": [round(x, 2) for x in you], "median": [round(x, 2) for x in med],
            "lo": [round(x, 2) for x in lo], "hi": [round(x, 2) for x in hi],
        },
        "script": script, "zones": zones,
        "agreement": round(statistics.fmean(spread), 2),
    }


def zone_text(z: dict, analog: bool) -> str:
    """The instruction for one zone, from its numbers."""
    where = f"{z['from_m']:.0f}-{z['to_m']:.0f} m"
    agree = "the references agree closely" if z["agree"] < 0.08 else "the references differ here (partly a style choice)" if z["agree"] > 0.2 else "the references mostly agree"
    onset = ""
    if z["ref_onset_m"] is not None and z["you_onset_m"] is not None and abs(z["you_onset_m"] - z["ref_onset_m"]) >= 8:
        d = z["you_onset_m"] - z["ref_onset_m"]
        onset = f"; they start steering at {z['ref_onset_m']:.0f} m, you at {z['you_onset_m']:.0f} m ({abs(d):.0f} m {'later' if d > 0 else 'earlier'})"
    if not analog:
        r = f"hold {z['ref_dir']} for about {z['ref_hold_s']:.1f} s" if z["ref_dir"] != "straight" else "stay straight"
        y = f"you hold {z['you_dir']} for {z['you_hold_s']:.1f} s" if z["you_dir"] != "straight" else "you stay straight"
        return f"{where}: the references {r}; {y}{onset} ({agree})"
    if z["ref_dir"] == "straight":
        return f"{where}: the references keep the wheel near straight (average {abs(z['ref_avg']):.2f}); you steer {z['you_dir']} {abs(z['you_avg']):.2f} (peak {abs(z['you_peak']):.2f}) - leave it centred{onset} ({agree})"
    if z["you_dir"] == "straight":
        fix = f"you hold the wheel almost centred ({abs(z['you_avg']):.2f}) - steer {z['ref_dir']} to about {abs(z['ref_avg']):.2f}"
    elif z["you_dir"] != z["ref_dir"]:
        fix = f"you steer the other way ({z['you_dir']} {abs(z['you_avg']):.2f}) - steer {z['ref_dir']} instead"
    elif abs(z["you_avg"]) > abs(z["ref_avg"]):
        fix = f"you steer {z['you_dir']} {abs(z['you_avg']):.2f} (peak {abs(z['you_peak']):.2f}) - ease it to about {abs(z['ref_avg']):.2f}"
    else:
        fix = f"you steer {z['you_dir']} {abs(z['you_avg']):.2f} (peak {abs(z['you_peak']):.2f}) - add to about {abs(z['ref_avg']):.2f}"
    return f"{where}: the references steer {z['ref_dir']} {abs(z['ref_avg']):.2f} on average (peak {abs(z['ref_peak']):.2f}); {fix}{onset} ({agree})"


def blueprint_text(bp: dict | None, deep: bool = False) -> str:
    """Prompt lines for the coach: the references' steering script and the zones where the player differs."""
    if not bp:
        return ""
    analog = bp["style"] == "analog"
    who = f"{bp['refs']} reference ghost(s), aligned to the player's distance" if bp["refs"] > 1 else "the reference ghost"
    lines = [
        f"MAP BLUEPRINT (the steering of {who}; steering positive = right; "
        + ("analog values -1..1" if analog else "keyboard-style: expressed as holds in seconds") + f"; typical disagreement between references {bp['agreement']:.2f}):"
    ]
    lines.append("SCRIPT (where the references steer; 'agree' is how much they differ from each other there):")
    limit = MAX_SCRIPT if deep else 18
    for r in bp["script"][:limit]:
        if analog:
            lines.append(f"- {r['from_m']:.0f}-{r['to_m']:.0f} m: {r['dir']} avg {r['avg']:.2f}, peak {r['peak']:.2f}, ~{r['dur_s']:.1f}s (agree ±{r['agree']:.2f})")
        else:
            lines.append(f"- {r['from_m']:.0f}-{r['to_m']:.0f} m: hold {r['dir']} ~{r['dur_s']:.1f}s")
    if bp["zones"]:
        lines.append("ZONES WHERE THE PLAYER'S STEERING DIFFERS MOST (use these numbers exactly):")
        for z in sorted(bp["zones"], key=lambda z: -z["score"]):
            lines.append(f"- {z['text']}; time {z['time_ms'] / 1000:+.3f}s over this stretch")
    else:
        lines.append("ZONES: the player's steering follows the references' everywhere within the thresholds.")
    return "\n".join(lines)
