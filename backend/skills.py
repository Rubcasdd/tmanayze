"""Trackmania skills found in a replay, and how two runs compare on them.

The corner and section numbers say WHERE time went. This module says WHICH driving
skills each run used: speed drifts, slides, air-brakes, jumps, clean landings, flips,
wall-rides, boosts, and the mistakes (lifts, wall hits, rough landings). Each skill is
found from the recorded telemetry alone (position, speed, wheel, pedals and the car's
orientation) and every find carries where it happened, so the same skill in two runs
can be matched by place and compared.

What a replay cannot show (it holds no wheel contact or slip data, only the car's
position and orientation) is listed in NOT_VISIBLE so the page can say so honestly.

Everything is optional: a run without orientation just has no slides, and every
function returns empty results rather than failing.
"""

from __future__ import annotations

import math

from . import driving, signals

# ------------------------------------------------------------------ the catalogue

# more_is: whether a bigger count is the better driving ("more"), the worse ("less"), or just a different style.
CATALOGUE: list[dict] = [
    {"id": "speed_drift", "name": "Speed drift", "glyph": "⤳", "group": "Cornering", "more_is": "more",
     "what": "A sideways slide started with a short brake tap while steering, above about 150 km/h. The car keeps its speed through the corner far better than plain steering.",
     "try": "Steer into the corner, tap the brake for about half a second, release, and let the car slide. It only works on grippy ground (asphalt, concrete) above ~180 km/h."},
    {"id": "slide", "name": "Slide", "glyph": "↯", "group": "Cornering", "more_is": "neutral",
     "what": "The car travels sideways (more than 10° between where it points and where it goes) for at least 0.3 s without a brake tap: a steer-started or low-speed slide, or the natural slide on ice and dirt.",
     "try": "A long, deep slide scrubs speed on grip and is normal on ice. Compare how much speed each run keeps through the same slide."},
    {"id": "ice_slide", "name": "Ice slide", "glyph": "❄", "group": "Cornering", "more_is": "neutral",
     "what": "A slide on ice. There is almost no grip, so the car keeps its heading and speed while it rotates; the skill is choosing the angle and the exit, and steering early and gently.",
     "try": "Set the angle before the ice starts, keep the wheel small and steady, and don't brake: braking on ice does very little."},
    {"id": "bugslide", "name": "Bug slide", "glyph": "⊥", "group": "Cornering", "more_is": "neutral",
     "what": "Sliding through a corner with the car turned about sideways to its path (60-120°), held there for at least 0.3 s. Done into hairpins to lose as little speed as possible.",
     "try": "Throw the car sideways early, hold the angle with the wheel, and straighten when the exit opens up. Advanced: a sloppy one scrubs more speed than a normal turn."},
    {"id": "backslide", "name": "Back slide", "glyph": "⇆", "group": "Cornering", "more_is": "neutral",
     "what": "The car travels tail-first: its nose points more than 120° away from where it is going, held for at least 0.3 s. Common on ice and in deep slides.",
     "try": "Keep the throttle and wheel steady and bring the nose back round before the exit; the deeper the angle, the more you must hold it."},
    {"id": "nose_slide", "name": "Nose slide", "glyph": "◢", "group": "Cornering", "more_is": "neutral",
     "what": "The car rides on its front end: its nose points at least 25° lower than the ground it is travelling over, without being in the air. Inferred from the car's pitch against its path.",
     "try": "It is deliberate only on nosebug-style tricks. Otherwise it usually means a landing or a bump pushed the nose down: brake gently to level the car."},
    {"id": "quantum_slide", "name": "Quantum slide", "glyph": "∿", "group": "Cornering", "more_is": "neutral",
     "what": "Turning hard on dirt or grass at speed without actually sliding: the no-slide speedslide. Inferred from the replay: a held steering input and a real change of heading with the car pointing where it goes.",
     "try": "A hard, brief steering input and the right gear timing keep the wheels from breaking away on loose ground. Listen for the gear changes."},
    {"id": "airbrake", "name": "Air-brake", "glyph": "⇩", "group": "In the air", "more_is": "more",
     "what": "Braking while airborne. It stops the car rotating so it lands flat on all four wheels, which cushions the landing.",
     "try": "Tap the brake in the air when the car would otherwise land nose-first, tail-first or on one side."},
    {"id": "jump", "name": "Jump", "glyph": "⌃", "group": "In the air", "more_is": "neutral",
     "what": "A flight: the car leaves the ground for at least 0.45 s or 25 m. Some jumps are the intended line; an unplanned one usually costs time.",
     "try": "If the ghost stays on the ground where you fly, ease off before the rise or change the line so the car doesn't take off."},
    {"id": "clean_landing", "name": "Clean landing", "glyph": "⤓", "group": "In the air", "more_is": "more",
     "what": "A jump that ends flat and in line with the slope, losing little speed.",
     "try": "Level the car in the air with a short brake or steer tap so all wheels meet the slope together."},
    {"id": "rough_landing", "name": "Rough landing", "glyph": "⚠", "group": "In the air", "more_is": "less",
     "what": "A jump that ends nose-first, tail-first or tilted, or that costs a lot of speed.",
     "try": "Check the take-off speed and angle, and use an air-brake to level the car before touchdown."},
    {"id": "flip", "name": "Flip", "glyph": "⟳", "group": "In the air", "more_is": "neutral",
     "what": "The car turned over by 150° or more in the air. Deliberate on some tricks, usually a mistake otherwise.",
     "try": "An air-brake right after take-off stops the spin."},
    {"id": "wallride", "name": "Wall ride", "glyph": "◐", "group": "Surfaces", "more_is": "neutral",
     "what": "The car drives on a wall or steep bank (its roof tilted more than about 70° away from straight up) for at least 0.3 s.",
     "try": "Treat the wall as a turn and take the straightest line; steering up the wall slows the car."},
    {"id": "bank_ride", "name": "Bank ride (bob turn)", "glyph": "◐", "group": "Surfaces", "more_is": "neutral",
     "what": "On a bobsleigh or ice map: the car rides the banked wall of a bob turn (its roof tilted more than about 70° away from straight up) for at least 0.3 s. This is the track itself, not a trick.",
     "try": "Pick one smooth line along the bank, set the angle early and hold it; the speed you carry out depends on how little you correct."},
    {"id": "upside_down", "name": "Upside down", "glyph": "◑", "group": "Surfaces", "more_is": "neutral",
     "what": "The car drives on a ceiling or inside a loop, with its roof pointing down.",
     "try": "Hold speed and a steady wheel through loops and ceilings."},
    {"id": "boost", "name": "Boost", "glyph": "➤", "group": "Speed", "more_is": "more",
     "what": "A sudden gain of speed on the ground: a turbo, booster or reactor pad. Hitting it earlier and squarely is a measurable gain.",
     "try": "Line up the pad early so the car crosses it without any steering."},
    {"id": "lift", "name": "Throttle lift", "glyph": "⏸", "group": "Mistakes", "more_is": "less",
     "what": "Letting go of the throttle for 0.15 s or more above 100 km/h without braking. On a full-speed map every lift is time given away.",
     "try": "Keep the throttle down and fix the line or entry that made you lift."},
    {"id": "impact", "name": "Wall hit", "glyph": "✖", "group": "Mistakes", "more_is": "less",
     "what": "A sudden loss of 22 km/h or more in a fifth of a second without braking and not from a landing: the car clipped a wall or a block.",
     "try": "Take a wider line before the hit, or turn in earlier so the car doesn't touch the wall."},
]
BY_ID = {s["id"]: s for s in CATALOGUE}

# Skills a replay cannot show, so the page can say what it does not look for.
NOT_VISIBLE = [
    "Nosebug and uberbug (they depend on exactly how the wheels touch a block, which a replay does not record)",
    "Gear-shift timing and wheel contact (not stored in the ghost)",
    "Which surface you are on (the replay stores the car, not the ground; the page reads the ground from the map's blocks)",
    "Respawns and restarts (a ghost is one clean run)",
]

SLIDE_MIN_DEG = 10.0
SLIDE_MIN_S = 0.3
SLIDE_MIN_KMH = 90.0
DRIFT_MIN_KMH = 150.0
BRAKE_BEFORE_S, BRAKE_AFTER_S = 0.4, 0.8
WALL_MIN_S = 0.3
IMPACT_DROP_KMH = 22.0
IMPACT_WINDOW_S = 0.2
BOOST_GAIN_KMH = 28.0
BOOST_WINDOW_S = 0.3
BIG_JUMP_S, BIG_JUMP_M = 0.45, 25.0
PAIR_RADIUS_M = 45.0
BUG_MIN_DEG, BACK_MIN_DEG = 60.0, 120.0
NOSE_MIN_DEG, NOSE_MIN_S = 25.0, 0.25
QUANTUM_MIN_KMH, QUANTUM_MIN_STEER, QUANTUM_MIN_S = 150.0, 0.4, 0.5
QUANTUM_MAX_SLIP, QUANTUM_MIN_TURN = 8.0, 15.0
LOOSE_GROUND = {"dirt", "grass"}

# Skills that need to know the ground under the car: without it in either run they can't be compared.
NEEDS_GROUND = {"ice_slide", "quantum_slide"}

# Skills that need the car's orientation: with it missing in either run they can't be compared.
NEEDS_ORIENTATION = {"speed_drift", "slide", "ice_slide", "bugslide", "backslide", "nose_slide", "quantum_slide", "clean_landing", "rough_landing", "flip", "wallride", "upside_down"}


def _slip_angles(samples: list[dict]) -> list[float]:
    """Degrees between where the car points and where it is going (signed: + is the nose to the left of
    the direction of travel). 0 where the car is too slow or too still to say."""
    n = len(samples)
    out = [0.0] * n
    for i in range(1, n - 1):
        a, b, s = samples[i - 1], samples[i + 1], samples[i]
        vx, vz = b["x"] - a["x"], b["z"] - a["z"]
        if math.hypot(vx, vz) < 0.3:
            continue
        fx, fz = s["fx"], s["fz"]
        if math.hypot(fx, fz) < 0.2:  # pointing straight up or down: no heading to compare
            continue
        out[i] = math.degrees(math.atan2(vx * fz - vz * fx, vx * fx + vz * fz))
    return out


def _idx_after(samples: list[dict], i: int, seconds: float) -> int:
    """The index about `seconds` after sample i."""
    target = samples[i]["time_ms"] + seconds * 1000.0
    j = i
    while j + 1 < len(samples) and samples[j]["time_ms"] < target:
        j += 1
    return j


def _idx_before(samples: list[dict], i: int, seconds: float) -> int:
    target = samples[i]["time_ms"] - seconds * 1000.0
    j = i
    while j > 0 and samples[j]["time_ms"] > target:
        j -= 1
    return j


def _event(skill: str, samples: list[dict], dist: list[float], a: int, b: int, **extra) -> dict:
    mid = (a + b) // 2
    return {
        "skill": skill, "t_ms": samples[a]["time_ms"], "dist_m": round(dist[mid], 1),
        "start_m": round(dist[a], 1), "end_m": round(dist[b], 1),
        "x": round(samples[mid]["x"], 1), "z": round(samples[mid]["z"], 1),
        "duration_s": round((samples[b]["time_ms"] - samples[a]["time_ms"]) / 1000.0 + 0.05, 2),
        "speed": round(samples[a]["speed"], 0), "speed_out": round(samples[b]["speed"], 0),
        **extra,
    }


def _near_air(air: list[bool], i: int, pad: int) -> bool:
    lo, hi = max(0, i - pad), min(len(air), i + pad + 1)
    return any(air[lo:hi])


# ------------------------------------------------------------------ detection

def _ground_of(labels: list[str] | None, a: int, b: int) -> str | None:
    """The most common ground label between samples a and b (None when the ground isn't known)."""
    if not labels:
        return None
    seg = [l for l in labels[a:b + 1] if l != "unknown"] or labels[a:b + 1]
    return max(set(seg), key=seg.count) if seg else None


def _deep_part(slip, lo, hi, floor, ceiling=None) -> tuple[int, int] | None:
    """The longest stretch of a slide whose angle is at least `floor` (and below `ceiling`), or None."""
    flags = [abs(slip[k]) >= floor and (ceiling is None or abs(slip[k]) < ceiling) for k in range(lo, hi + 1)]
    best = max(signals._runs(flags, 2, gap=1), key=lambda r: r[1] - r[0], default=None)
    return None if best is None else (lo + best[0], lo + best[1])


def _slides(samples, dist, air, slip, labels=None) -> list[dict]:
    """Stretches where the car goes sideways, split at a change of direction. Each is a speed drift when a
    brake tap started it at speed, an ice slide when it is on ice, otherwise a plain slide; its deepest part
    also counts as a back slide (over 120 degrees) or, failing that, a bug slide (60-120 degrees)."""
    n = len(samples)
    flags = [
        (not _near_air(air, i, 2)) and samples[i]["uy"] > 0.6 and samples[i]["speed"] >= SLIDE_MIN_KMH and abs(slip[i]) >= SLIDE_MIN_DEG
        for i in range(n)
    ]
    # a slide that swings from one side to the other is two slides
    out = []
    for a, b in signals._runs(flags, 2, gap=1):
        cuts = [a]
        for i in range(a + 1, b + 1):
            if slip[i] * slip[i - 1] < 0 and abs(slip[i]) >= SLIDE_MIN_DEG and abs(slip[i - 1]) >= SLIDE_MIN_DEG:
                cuts.append(i)
        cuts.append(b + 1)
        for lo, hi in zip(cuts, cuts[1:]):
            hi -= 1
            seconds = (samples[hi]["time_ms"] - samples[lo]["time_ms"]) / 1000.0 + 0.05
            if seconds < SLIDE_MIN_S:
                continue
            j0, j1 = _idx_before(samples, lo, BRAKE_BEFORE_S), _idx_after(samples, lo, BRAKE_AFTER_S)
            braked = any(samples[k]["brake"] > signals.BRAKE_ON for k in range(j0, min(j1, hi) + 1))
            drift = braked and samples[lo]["speed"] >= DRIFT_MIN_KMH
            peak = max(abs(slip[k]) for k in range(lo, hi + 1))
            entry, exit_ = samples[lo]["speed"], samples[hi]["speed"]
            ground = _ground_of(labels, lo, hi)
            skill = "ice_slide" if ground == "ice" else ("speed_drift" if drift else "slide")
            direction = "right" if slip[lo + (hi - lo) // 2] < 0 else "left"
            how = "started with a brake tap" if drift else "no brake tap"
            out.append(_event(
                skill, samples, dist, lo, hi, peak_deg=round(peak, 0), direction=direction, surface=ground,
                info=f"{seconds:.1f} s {direction}, up to {peak:.0f}°, {entry:.0f} → {exit_:.0f} km/h, {how}",
                score=seconds,
            ))
            kind, deep = "backslide", (_deep_part(slip, lo, hi, BACK_MIN_DEG) if peak >= BACK_MIN_DEG else None)
            if deep is None and peak >= BUG_MIN_DEG:
                kind, deep = "bugslide", _deep_part(slip, lo, hi, BUG_MIN_DEG, BACK_MIN_DEG)
            if deep is None:
                continue
            da, db = deep
            dsec = (samples[db]["time_ms"] - samples[da]["time_ms"]) / 1000.0 + 0.05
            if dsec < SLIDE_MIN_S:
                continue
            floor = BACK_MIN_DEG if kind == "backslide" else BUG_MIN_DEG
            out.append(_event(
                kind, samples, dist, da, db, peak_deg=round(peak, 0), direction=direction, surface=ground,
                info=f"{dsec:.1f} s past {floor:.0f}° ({direction}, up to {peak:.0f}°), {samples[da]['speed']:.0f} → {samples[db]['speed']:.0f} km/h",
                score=dsec,
            ))
    return out


def _nose_slides(samples, dist, air) -> list[dict]:
    """Riding on the front end: the nose points well below the slope the car is moving along, without being airborne."""
    n = len(samples)
    flags = [False] * n
    drop = [0.0] * n
    for i in range(2, n - 2):
        if _near_air(air, i, 3) or samples[i]["speed"] < 60:
            continue
        a, b = samples[i - 2], samples[i + 2]
        run = math.hypot(b["x"] - a["x"], b["z"] - a["z"])
        if run < 0.5:
            continue
        slope = math.degrees(math.atan2(b["y"] - a["y"], run))
        pitch = math.degrees(math.asin(max(-1.0, min(1.0, samples[i]["fy"]))))
        drop[i] = slope - pitch
        flags[i] = drop[i] >= NOSE_MIN_DEG
    out = []
    for a, b in signals._runs(flags, int(NOSE_MIN_S / 0.05), gap=1):
        seconds = (samples[b]["time_ms"] - samples[a]["time_ms"]) / 1000.0 + 0.05
        worst = max(drop[a:b + 1])
        out.append(_event("nose_slide", samples, dist, a, b, nose_down_deg=round(worst, 0),
                          info=f"{seconds:.1f} s on the nose, up to {worst:.0f}° below the slope, {samples[a]['speed']:.0f} → {samples[b]['speed']:.0f} km/h",
                          score=seconds))
    return out


def _heading_deg(s: dict) -> float:
    return math.degrees(math.atan2(s["fx"], s["fz"]))


def _quantum_slides(samples, dist, air, slip, labels) -> list[dict]:
    """Turning hard on dirt or grass at speed while the car stays pointed where it goes: no slide, a real change of heading."""
    if not labels:
        return []
    n = len(samples)
    flags = [
        (not _near_air(air, i, 2)) and labels[i] in LOOSE_GROUND and samples[i]["uy"] > 0.6 and samples[i]["speed"] >= QUANTUM_MIN_KMH
        and abs(samples[i]["steer"]) >= QUANTUM_MIN_STEER and abs(slip[i]) < QUANTUM_MAX_SLIP
        for i in range(n)
    ]
    out = []
    for a, b in signals._runs(flags, int(QUANTUM_MIN_S / 0.05), gap=1):
        seconds = (samples[b]["time_ms"] - samples[a]["time_ms"]) / 1000.0 + 0.05
        turn = abs((_heading_deg(samples[b]) - _heading_deg(samples[a]) + 180.0) % 360.0 - 180.0)
        if turn < QUANTUM_MIN_TURN:
            continue
        ground = _ground_of(labels, a, b)
        out.append(_event("quantum_slide", samples, dist, a, b, turn_deg=round(turn, 0), surface=ground,
                          info=f"{seconds:.1f} s on {ground}, turned {turn:.0f}° at {samples[a]['speed']:.0f} → {samples[b]['speed']:.0f} km/h without sliding",
                          score=seconds))
    return out


def _from_flights(samples, dist, fl, lands) -> list[dict]:
    out = []
    for k, f in enumerate(fl):
        a, b = f["start_i"], f["end_i"]
        big = f["duration_s"] >= BIG_JUMP_S or f["length_m"] >= BIG_JUMP_M
        if f["brake_s"] >= 0.08 and big:
            out.append(_event(
                "airbrake", samples, dist, a, b, brake_s=round(f["brake_s"], 2),
                info=f"braked {f['brake_s']:.2f} s of a {f['duration_s']:.1f} s flight", score=f["brake_s"],
            ))
        if not big:
            continue
        out.append(_event(
            "jump", samples, dist, a, b, length_m=round(f["length_m"], 0), height_m=round(f["height_m"], 1),
            info=f"{f['duration_s']:.1f} s in the air over {f['length_m']:.0f} m, {f['speed_in']:.0f} km/h at take-off",
            score=f["duration_s"],
        ))
        land = next((l for l in lands if abs(l["dist_m"] - dist[b]) < 1.0), None)
        if land is None:
            continue
        clean = land["clean"] and land["speed_lost"] < 12
        out.append(_event(
            "clean_landing" if clean else "rough_landing", samples, dist, b, min(len(samples) - 1, b + 6),
            speed_lost=round(land["speed_lost"], 0), nose_down_deg=land["nose_down_deg"], tilt_deg=land["tilt_deg"],
            info=driving.landing_word(land)[0].upper() + driving.landing_word(land)[1:],
            score=abs(land["nose_down_deg"]) + land["tilt_deg"] + max(0.0, land["speed_lost"]),
        ))
        if land["flip"]:
            out.append(_event("flip", samples, dist, a, b, spin_deg=land["spin_deg"], info=f"turned over about {land['spin_deg']:.0f}° in the air", score=land["spin_deg"]))
    return out


def _surfaces(samples, dist, air, bob: bool = False) -> list[dict]:
    flags = [(not air[i]) and s["uy"] < driving.WALL_UP_Y for i, s in enumerate(samples)]
    out = []
    for a, b in signals._runs(flags, int(WALL_MIN_S / 0.05), gap=2):
        lowest = min(samples[i]["uy"] for i in range(a, b + 1))
        seconds = (samples[b]["time_ms"] - samples[a]["time_ms"]) / 1000.0 + 0.05
        upside = lowest < driving.INVERTED_UP_Y
        out.append(_event(
            "upside_down" if upside else ("bank_ride" if bob else "wallride"), samples, dist, a, b,
            info=f"{seconds:.1f} s at {sum(samples[i]['speed'] for i in range(a, b + 1)) / (b - a + 1):.0f} km/h",
            score=seconds,
        ))
    return out


def _lifts(samples, dist, air) -> list[dict]:
    return [
        _event("lift", samples, dist, x["start_i"], x["end_i"], info=f"{x['duration_s']:.2f} s off the throttle at {x['speed']:.0f} km/h", score=x["duration_s"])
        for x in signals.throttle_lifts(samples, dist, air)
    ]


def _impacts_and_boosts(samples, dist, air) -> list[dict]:
    n = len(samples)
    out = []
    last_hit = last_boost = -10_000
    for i in range(n - 1):
        s = samples[i]
        if air[i]:
            continue
        j = _idx_after(samples, i, IMPACT_WINDOW_S)
        if j <= i:
            continue
        window = range(max(0, i - 2), j + 1)
        drop = s["speed"] - samples[j]["speed"]
        if (drop >= IMPACT_DROP_KMH and s["speed"] >= 60 and s["time_ms"] - last_hit > 1000
                and all(samples[k]["brake"] <= signals.BRAKE_ON for k in window)
                and not _near_air(air, i, 8) and not _near_air(air, j, 8)):
            out.append(_event("impact", samples, dist, i, j, info=f"lost {drop:.0f} km/h in {IMPACT_WINDOW_S:.1f} s at {s['speed']:.0f} km/h", score=drop))
            last_hit = s["time_ms"]
        k = _idx_after(samples, i, BOOST_WINDOW_S)
        gain = samples[k]["speed"] - s["speed"]
        if (gain >= BOOST_GAIN_KMH and s["speed"] >= 60 and s["time_ms"] > 2000 and s["time_ms"] - last_boost > 1500
                and all(samples[m]["gas"] > 0.5 and samples[m]["uy"] > 0.7 for m in range(i, k + 1))
                and not _near_air(air, i, 4) and samples[k]["y"] - s["y"] > -3.0):
            out.append(_event("boost", samples, dist, i, k, info=f"+{gain:.0f} km/h in {BOOST_WINDOW_S:.1f} s ({s['speed']:.0f} → {samples[k]['speed']:.0f} km/h)", score=gain))
            last_boost = s["time_ms"]
    return out


def detect(samples: list[dict], labels: list[str] | None = None, bob: bool = False) -> dict:
    """Every skill found in one run: {"events": [...], "metrics": {...}, "oriented": bool, "ground": bool}.
    `labels` is the ground under each sample (surface.py), when the map's blocks could be read."""
    if len(samples) < 40:
        return {"oriented": False, "ground": False, "events": [], "metrics": None}
    if labels is not None and len(labels) != len(samples):
        labels = None
    dist = signals._cumulative_distance(samples)
    fl = signals.flights(samples, dist)
    air = signals._in_flight(len(samples), fl)
    oriented = driving.has_orientation(samples)
    events: list[dict] = []
    if oriented:
        slip = _slip_angles(samples)
        events += _slides(samples, dist, air, slip, labels)
        events += _nose_slides(samples, dist, air)
        events += _quantum_slides(samples, dist, air, slip, labels)
        lands = driving.landings(samples, dist, fl, bob)
        events += _from_flights(samples, dist, fl, lands)
        events += _surfaces(samples, dist, air, bob)
    else:  # without orientation the jumps and air-brakes still show
        events += _from_flights(samples, dist, fl, [])
    events += _lifts(samples, dist, air)
    events += _impacts_and_boosts(samples, dist, air)
    events.sort(key=lambda e: e["t_ms"])
    total = max(1.0, (samples[-1]["time_ms"] - samples[0]["time_ms"]) / 1000.0)
    n = len(samples)
    metrics = {
        "top_speed": round(max(s["speed"] for s in samples), 0),
        "avg_speed": round(sum(s["speed"] for s in samples) / n, 0),
        "full_throttle_pct": round(100.0 * sum(1 for s in samples if s["gas"] > 0.9 and s["brake"] <= signals.BRAKE_ON) / n, 0),
        "brake_pct": round(100.0 * sum(1 for s in samples if s["brake"] > signals.BRAKE_ON) / n, 1),
        "drift_window_pct": round(100.0 * sum(1 for s in samples if s["speed"] >= 180) / n, 0),
        "sliding_pct": round(100.0 * sum(e["duration_s"] for e in events if e["skill"] in ("slide", "speed_drift", "ice_slide")) / total, 0),
        "air_pct": round(100.0 * sum(1 for a in air if a) / n, 1),
    }
    return {"oriented": oriented, "ground": bool(labels), "events": events, "metrics": metrics}


# ------------------------------------------------------------------ comparing two runs

def _where(item: dict, subject_samples: list[dict], subject_dist: list[float]) -> float:
    return signals._where(item, subject_samples, subject_dist)


def _pair(player: list[dict], ghost: list[dict]) -> tuple[list[tuple[dict, dict]], list[dict], list[dict]]:
    """Match events of one skill by where on the track they happen."""
    used: set[int] = set()
    pairs, ghost_only = [], []
    for g in ghost:
        best, best_d = None, PAIR_RADIUS_M
        for idx, p in enumerate(player):
            if idx in used:
                continue
            d = math.hypot(g["x"] - p["x"], g["z"] - p["z"])
            if d < best_d:
                best, best_d = idx, d
        if best is None:
            ghost_only.append(g)
        else:
            used.add(best)
            pairs.append((player[best], g))
    return pairs, [p for i, p in enumerate(player) if i not in used], ghost_only


def _status(more_is: str, mine: int, theirs: int, ghost_only: int, player_only: int) -> str:
    """One word for the card: where the player stands on this skill."""
    if mine == 0 and theirs == 0:
        return "unused"
    if more_is == "less":  # a mistake: fewer is better
        if mine > theirs:
            return "worse"
        return "better" if mine < theirs else "level"
    if more_is == "more":
        if theirs > mine or (ghost_only and mine <= theirs):
            return "missing" if mine == 0 else "behind"
        return "ahead" if mine > theirs else "level"
    return "level" if mine == theirs else ("more" if mine > theirs else "fewer")


def compare(subject: dict, reference: dict, subject_samples: list[dict], subject_dist: list[float] | None = None) -> dict:
    """The skills of the player and of one reference side by side: per skill the counts, every find placed
    on the player's distance axis, and a one-word verdict."""
    if subject_dist is None:
        subject_dist = signals._cumulative_distance(subject_samples) if len(subject_samples) >= 20 else []
    both_oriented = subject["oriented"] and reference["oriented"]
    both_ground = subject.get("ground", False) and reference.get("ground", False)
    rows = []
    for skill in CATALOGUE:
        sid = skill["id"]
        if (sid in NEEDS_ORIENTATION and not both_oriented) or (sid in NEEDS_GROUND and not both_ground):
            rows.append({"id": sid, "you": 0, "ghost": 0, "you_s": 0, "ghost_s": 0, "both": 0, "you_only": 0, "ghost_only": 0, "status": "unknown", "events": []})
            continue
        mine = [e for e in subject["events"] if e["skill"] == sid]
        theirs = [e for e in reference["events"] if e["skill"] == sid]
        pairs, p_only, g_only = _pair(mine, theirs)
        events = []
        for p, g in pairs:
            events.append({"who": "both", "dist_m": p["dist_m"], "start_m": p["start_m"], "end_m": p["end_m"], "you": p["info"], "ghost": g["info"],
                           "you_score": p["score"], "ghost_score": g["score"]})
        for p in p_only:
            events.append({"who": "you", "dist_m": p["dist_m"], "start_m": p["start_m"], "end_m": p["end_m"], "you": p["info"], "you_score": p["score"]})
        for g in g_only:
            d = _where(g, subject_samples, subject_dist) if subject_dist else g["dist_m"]
            span = max(g["end_m"] - g["start_m"], 0.0)
            events.append({"who": "ghost", "dist_m": round(d, 1), "start_m": round(max(0.0, d - span / 2), 1), "end_m": round(d + span / 2, 1),
                           "ghost": g["info"], "ghost_score": g["score"]})
        events.sort(key=lambda e: e["dist_m"])
        rows.append({
            "id": sid, "you": len(mine), "ghost": len(theirs),
            "you_s": round(sum(e["duration_s"] for e in mine), 1), "ghost_s": round(sum(e["duration_s"] for e in theirs), 1),
            "both": len(pairs), "you_only": len(p_only), "ghost_only": len(g_only),
            "status": _status(skill["more_is"], len(mine), len(theirs), len(g_only), len(p_only)),
            "events": events,
        })
    return {
        "catalogue": CATALOGUE, "not_visible": NOT_VISIBLE, "rows": rows,
        "oriented": both_oriented, "ground": both_ground,
        "metrics": {"you": subject["metrics"], "ghost": reference["metrics"]},
    }


def skills_text(report: dict) -> str:
    """The comparison as prompt lines for the coach (only skills that differ or matter)."""
    lines = []
    names = {s["id"]: s["name"] for s in report["catalogue"]}
    for r in report["rows"]:
        if r["status"] in ("unused", "level", "unknown") or (r["you"] == 0 and r["ghost"] == 0):
            continue
        lines.append(f"- {names[r['id']]}: player {r['you']}, ghost {r['ghost']} ({r['both']} at the same place, {r['you_only']} only the player, {r['ghost_only']} only the ghost)")
    return "SKILLS FOUND IN BOTH RUNS (counts by technique):\n" + "\n".join(lines) if lines else ""
