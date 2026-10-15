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


WIGGLE_MIN_AMP = 0.12       # a back-and-forth smaller than this (peak to peak) isn't a wiggle
WIGGLE_ACTIVE_HZ = 1.0      # reversals per second above this count as wiggling


def _zigzag(vals: list[float], min_amp: float) -> list[float]:
    """The turning points of a signal, ignoring moves smaller than min_amp."""
    if not vals:
        return []
    out: list[float] = []
    cand, direction = vals[0], 0
    for v in vals[1:]:
        if direction >= 0 and v >= cand:
            cand, direction = v, 1 if v > cand else direction
        elif direction <= 0 and v <= cand:
            cand, direction = v, -1 if v < cand else direction
        elif abs(v - cand) >= min_amp:
            out.append(cand)
            cand, direction = v, -direction if direction else (1 if v > cand else -1)
    out.append(cand)
    return out


def wiggle_stats(points: list[dict], a_m: float, b_m: float, key: str, speed_key: str) -> dict | None:
    """How much the wheel is wiggled over a stretch: reversals per second and the typical size of one swing."""
    seg = [p for p in points if a_m <= p["distance_m"] <= b_m]
    if len(seg) < 6:
        return None
    ext = _zigzag([p[key] for p in seg], WIGGLE_MIN_AMP)
    secs = 0.0
    for p, q in zip(seg, seg[1:]):
        secs += (q["distance_m"] - p["distance_m"]) / max(5.0, p[speed_key] / 3.6)
    if secs <= 0.1:
        return None
    swings = [abs(y - x) for x, y in zip(ext, ext[1:])]
    return {"hz": max(0, len(ext) - 1) / secs, "amp": statistics.fmean(swings) if swings else 0.0, "secs": secs}


def line_offset(points: list[dict], a_m: float, b_m: float) -> float | None:
    """How far to the right (+) or left (-) of the reference's line the player drives, in metres, on average."""
    seg = [(i, p) for i, p in enumerate(points) if a_m <= p["distance_m"] <= b_m]
    if len(seg) < 3:
        return None
    vals = []
    for i, p in seg:
        a, b = points[max(0, i - 1)], points[min(len(points) - 1, i + 1)]
        dx, dz = b["reference_x"] - a["reference_x"], b["reference_z"] - a["reference_z"]
        m = (dx * dx + dz * dz) ** 0.5
        if m < 0.01:
            continue
        dx, dz = dx / m, dz / m
        vals.append((p["x"] - p["reference_x"]) * -dz + (p["z"] - p["reference_z"]) * dx)  # right of travel on the map (x right, z down)
    return statistics.fmean(vals) if vals else None


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
        # the wiggle and the line, from the unsmoothed points
        ref_w = [w for w in (wiggle_stats(pts, z["from_m"], z["to_m"], "reference_steer", "reference_speed") for pts in refs.values()) if w]
        you_w = wiggle_stats(primary, z["from_m"], z["to_m"], "subject_steer", "subject_speed")
        z["ref_wig_hz"] = round(statistics.fmean(w["hz"] for w in ref_w), 1) if ref_w else None
        z["ref_wig_amp"] = round(statistics.fmean(w["amp"] for w in ref_w), 2) if ref_w else None
        z["you_wig_hz"] = round(you_w["hz"], 1) if you_w else None
        z["you_wig_amp"] = round(you_w["amp"], 2) if you_w else None
        offs = [o for o in (line_offset(pts, z["from_m"], z["to_m"]) for pts in refs.values()) if o is not None]
        z["line_off_m"] = round(statistics.fmean(offs), 1) if offs else None
        confidence = 1.0 / (1.0 + 3.0 * z["agree"])  # zones where the references agree matter more than ones they split on
        z["score"] = round((max(0, z["time_ms"]) / 8 + 60 * abs(z["you_avg"] - z["ref_avg"])) * confidence, 1)
        z["text"] = zone_text(z, analog)
    # a difference between two near-centred wheels (under ~0.18) is noise, not a plan
    zones = [z for z in zones if max(abs(z["ref_avg"]), abs(z["you_avg"])) >= (0.18 if analog else 0.5)]
    zones.sort(key=lambda z: -z["score"])
    zones = sorted(zones[:MAX_ZONES], key=lambda z: z["from_m"])

    whole = {"ref": [wiggle_stats(pts, 0, total, "reference_steer", "reference_speed") for pts in refs.values()], "you": wiggle_stats(primary, 0, total, "subject_steer", "subject_speed")}
    ref_whole = [w for w in whole["ref"] if w]
    wig = {
        "ref_hz": round(statistics.fmean(w["hz"] for w in ref_whole), 1) if ref_whole else None,
        "ref_amp": round(statistics.fmean(w["amp"] for w in ref_whole), 2) if ref_whole else None,
        "you_hz": round(whole["you"]["hz"], 1) if whole["you"] else None,
        "you_amp": round(whole["you"]["amp"], 2) if whole["you"] else None,
    }
    return {
        "refs": len(refs), "style": "analog" if analog else "digital", "wiggle": wig,
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
    return f"{where}: the references steer {z['ref_dir']} {abs(z['ref_avg']):.2f} on average (peak {abs(z['ref_peak']):.2f}); {fix}{onset}{_extras(z)} ({agree})"


def _extras(z: dict) -> str:
    """The wiggle and the line, when they differ enough to be worth saying."""
    out = ""
    r, y = z.get("ref_wig_hz"), z.get("you_wig_hz")
    if r is not None and y is not None and (abs(r - y) >= 0.6 or max(r, y) >= WIGGLE_ACTIVE_HZ):
        out += f"; wheel wiggle: the references reverse {r:.1f} times a second with swings of about {z['ref_wig_amp']:.2f}, you {y:.1f} a second with swings of {z['you_wig_amp']:.2f}"
    off = z.get("line_off_m")
    if off is not None and abs(off) >= 1.5:
        out += f"; your line is {abs(off):.1f} m to the {'right' if off > 0 else 'left'} of the references'"
    return out


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


def lessons(bp: dict | None, bob: bool) -> list[dict]:
    """Step-by-step lessons with the player's and the references' numbers in them. Each is
    {id, title, why, steps[], drill, yours, theirs}; the same text is shown in the app and given to the coach."""
    if not bp:
        return []
    out: list[dict] = []
    zones = sorted(bp["zones"], key=lambda z: -z["score"])
    analog = bp["style"] == "analog"
    wig = bp.get("wiggle") or {}

    # 1. set the angle early and hold it
    movers = [z for z in zones if z["ref_dir"] != "straight"][:3]
    if movers:
        z = movers[0]
        start_ref = z["ref_onset_m"]
        steps = []
        if start_ref is not None:
            if z["you_onset_m"] is None:
                late = ""
            elif abs(z["you_onset_m"] - start_ref) < 8:
                late = " (you start at about the same place: the difference is in how much you hold)"
            else:
                late = f" (you start at {z['you_onset_m']:.0f} m, {abs(z['you_onset_m'] - start_ref):.0f} m {'later' if z['you_onset_m'] > start_ref else 'earlier'})"
            steps.append(f"Start steering {z['ref_dir']} at {start_ref:.0f} m{late}, before the bend, not in it.")
        steps.append(
            f"Hold about {abs(z['ref_avg']):.2f} of full lock{' (peaking near ' + format(abs(z['ref_peak']), '.2f') + ')' if analog else ''} until {z['to_m']:.0f} m"
            if analog else f"Hold {z['ref_dir']} for about {z['ref_hold_s']:.1f} s until {z['to_m']:.0f} m"
        )
        steps.append("Let go smoothly and do not correct for about half a second: on ice the car keeps going the way it was already moving.")
        out.append({
            "id": "hold", "title": "Set the angle early and hold it",
            "why": "Ice gives almost no sideways grip, so the wheel decides where the car points long before it decides where the car goes. Late or repeated corrections cost the speed that a steady hold keeps.",
            "steps": steps,
            "drill": f"Drive {z['from_m'] - 60:.0f}-{z['to_m'] + 20:.0f} m again and only try to start at {start_ref:.0f} m and hold {abs(z['ref_avg']):.2f}; ignore everything else." if start_ref is not None else f"Drive {z['from_m']:.0f}-{z['to_m']:.0f} m again and only hold {z['ref_dir']} about {abs(z['ref_avg']):.2f}.",
            "yours": f"{z['from_m']:.0f}-{z['to_m']:.0f} m: you steer {z['you_dir']} {abs(z['you_avg']):.2f}", "theirs": f"they steer {z['ref_dir']} {abs(z['ref_avg']):.2f}",
        })

    # 2. the wiggle
    r_hz, y_hz = wig.get("ref_hz"), wig.get("you_hz")
    if r_hz is not None and r_hz >= WIGGLE_ACTIVE_HZ:
        r_amp, y_amp = wig.get("ref_amp") or 0.0, wig.get("you_amp") or 0.0
        wzones = [z for z in zones if z.get("ref_wig_hz") and z["ref_wig_hz"] >= WIGGLE_ACTIVE_HZ and z.get("you_wig_hz") is not None][:3]
        steps = [
            f"Hold the steering you are meant to have at that spot, then add small alternating taps on top of it: about {r_hz:.1f} reversals a second.",
            (f"Each swing goes about {r_amp:.2f} of full lock from one side to the other (about {r_amp / 2:.2f} either side of the value you are holding). On a keyboard that is a short tap each way; on a pad or wheel a quick flick and back.") if analog else
            "Keep each tap short and even; the rhythm matters more than the size.",
            "Keep the rhythm steady: do not wiggle through a gear shift (about 100, 160, 235 and 341 km/h), hold the wheel still for those moments.",
            "Stop wiggling when the references go quiet (the straights) and when the car is in the air.",
        ]
        where = "; ".join(f"{z['from_m']:.0f}-{z['to_m']:.0f} m ({z['ref_wig_hz']:.1f}/s vs your {z['you_wig_hz']:.1f}/s)" for z in wzones)
        out.append({
            "id": "wiggle", "title": "The wheel wiggle",
            "why": "The fastest runs on this map do not hold the wheel perfectly still: they ride a small, steady back-and-forth on top of the held steering. "
                   "Note: Nadeo's October 2022 update says ice wiggles no longer add speed by themselves, so treat this as the pros' way of steering the slide, and copy the rate and the size rather than inventing your own.",
            "steps": steps,
            "drill": ("Practise the rhythm on a long, straight-ish ice stretch first" + (f" (for example {wzones[0]['from_m']:.0f}-{wzones[0]['to_m']:.0f} m)" if wzones else "") +
                      ", counting the reversals against a replay of the ghost; the Trackmania Exchange bobsleigh training packs (check which physics version they were built for) are good places to rehearse it."),
            "yours": f"you reverse {y_hz:.1f} a second with swings of {y_amp:.2f}" if y_hz is not None else "", "theirs": f"they reverse {r_hz:.1f} a second with swings of {r_amp:.2f}" + (f"; strongest at {where}" if where else ""),
        })

    # 3. the line
    offs = [z for z in zones if z.get("line_off_m") is not None and abs(z["line_off_m"]) >= 1.5][:3]
    if offs:
        z = offs[0]
        side = "right" if z["line_off_m"] > 0 else "left"
        other = "left" if side == "right" else "right"
        out.append({
            "id": "line", "title": "Drive the ghosts' line",
            "why": "On a bank or between walls the line sets how much of the bend the car rides and how much speed it carries out. Being a few metres off the ghosts' line is usually a steering difference from earlier in the section.",
            "steps": [
                f"At {z['from_m']:.0f}-{z['to_m']:.0f} m you are about {abs(z['line_off_m']):.1f} m to the {side} of the references: aim {abs(z['line_off_m']):.1f} m further {other}.",
                "To move there, change the steering earlier and by a small amount: a small input 60-80 m before has the effect a big one cannot have in the bend.",
                "Replay the stretch and check the gap to the references' line, not just the time.",
            ],
            "drill": f"Drive {z['from_m'] - 80:.0f}-{z['to_m']:.0f} m with one aim: stay {abs(z['line_off_m']):.1f} m further {other}.",
            "yours": f"{abs(z['line_off_m']):.1f} m {side} of the references at {z['from_m']:.0f}-{z['to_m']:.0f} m", "theirs": "the references' line",
        })
    return out


def lessons_text(items: list[dict]) -> str:
    """The lessons as prompt text: the coach re-states these with its own explanation and must keep the numbers."""
    if not items:
        return ""
    lines = ["LESSONS (how to do it, with the measured numbers; explain them to the player step by step and keep every number):"]
    for it in items:
        lines.append(f"- {it['title']}: {it['why']}")
        lines.extend(f"    {i}. {s}" for i, s in enumerate(it["steps"], start=1))
        lines.append(f"    Drill: {it['drill']}")
        if it["yours"] or it["theirs"]:
            lines.append(f"    Numbers: {it['yours']}; {it['theirs']}.")
    return "\n".join(lines)
