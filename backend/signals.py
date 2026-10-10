"""Technique signals measured from the raw telemetry of two runs.

The corner/section numbers tell the coach WHERE time went; these tell it WHAT
the faster driver did there that the slower one didn't, in terms a Trackmania
coach would use: jumps and whether they were air-braked, brake taps while
steering at speed (how a speed drift starts), lifting off the throttle, and
how much each run used the brake at all.

Everything here is measured, not guessed. The coach is told these are
observations and that the technique behind them is a hypothesis.
"""

from __future__ import annotations

import math

from .compare import _cumulative_distance

# Free fall in this game is about -24.5 m/s^2 (the peak of vertical
# acceleration measured on 16 maps), far stronger than real gravity.
FREE_FALL_LO = -28.5
FREE_FALL_HI = -21.0
MIN_FLIGHT_SAMPLES = 5      # ~0.25 s
MIN_FLIGHT_S = 0.25

BRAKE_ON = 0.1
DRIFT_MIN_KMH = 180.0       # speed drifts only work above this
DRIFT_MIN_STEER = 0.35
TAP_MIN_S, TAP_MAX_S = 0.10, 1.6
LIFT_GAS = 0.5
LIFT_MIN_KMH = 100.0
LIFT_MIN_S = 0.15
PAIR_RADIUS_M = 45.0


def _dt(samples: list[dict], i: int, j: int) -> float:
    return (samples[j]["time_ms"] - samples[i]["time_ms"]) / 1000.0


def _vertical_accel(samples: list[dict]) -> list[float | None]:
    """Vertical acceleration (m/s^2), smoothed over +-3 samples."""
    n = len(samples)
    out: list[float | None] = [None] * n
    for i in range(3, n - 3):
        d1, d0 = _dt(samples, i, i + 3), _dt(samples, i - 3, i)
        span = _dt(samples, i - 3, i + 3)
        if d1 <= 0 or d0 <= 0 or span <= 0:
            continue
        v1 = (samples[i + 3]["y"] - samples[i]["y"]) / d1
        v0 = (samples[i]["y"] - samples[i - 3]["y"]) / d0
        out[i] = (v1 - v0) / (span / 2.0)
    return out


def _runs(flags: list[bool], min_len: int, gap: int = 0) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start = None
    last_true = -10
    for i, f in enumerate(flags):
        if f:
            if start is None:
                start = i
            last_true = i
        elif start is not None and i - last_true > gap:
            if last_true - start + 1 >= min_len:
                runs.append((start, last_true))
            start = None
    if start is not None and last_true - start + 1 >= min_len:
        runs.append((start, last_true))
    return runs


def flights(samples: list[dict], dist: list[float]) -> list[dict]:
    n = len(samples)
    ay = _vertical_accel(samples)
    air = [a is not None and FREE_FALL_LO <= a <= FREE_FALL_HI for a in ay]
    out = []
    for a, b in _runs(air, MIN_FLIGHT_SAMPLES, gap=2):
        a, b = max(0, a - 2), min(n - 1, b + 2)  # the smoothing window hides the edges
        seg = samples[a:b + 1]
        duration = _dt(samples, a, b)
        if duration < MIN_FLIGHT_S:
            continue
        braking = sum(1 for s in seg if s["brake"] > BRAKE_ON)
        landing = samples[min(n - 1, b + 3)]
        out.append({
            "start_i": a, "end_i": b,
            "x": samples[a]["x"], "y": samples[a]["y"], "z": samples[a]["z"],
            "end_x": samples[b]["x"], "end_y": samples[b]["y"], "end_z": samples[b]["z"],
            "dist_m": dist[a], "length_m": dist[b] - dist[a],
            "duration_s": duration,
            "speed_in": samples[a]["speed"], "speed_out": landing["speed"],
            "brake_s": braking * duration / max(1, len(seg)),
            "height_m": max(s["y"] for s in seg) - samples[a]["y"],
        })
    return out


def _in_flight(n: int, fl: list[dict]) -> list[bool]:
    mask = [False] * n
    for f in fl:
        for i in range(f["start_i"], f["end_i"] + 1):
            mask[i] = True
    return mask


def brake_taps(samples: list[dict], dist: list[float], airborne: list[bool]) -> list[dict]:
    """Brake pressed while steering hard at speed: how a speed drift is started."""
    flags = [
        (not airborne[i]) and s["brake"] > BRAKE_ON and abs(s["steer"]) >= DRIFT_MIN_STEER and s["speed"] >= DRIFT_MIN_KMH
        for i, s in enumerate(samples)
    ]
    out = []
    for a, b in _runs(flags, 2, gap=1):
        d = _dt(samples, a, b) + 0.05
        if not TAP_MIN_S <= d <= TAP_MAX_S:
            continue
        out.append({
            "start_i": a, "end_i": b, "x": samples[a]["x"], "z": samples[a]["z"],
            "dist_m": dist[a], "duration_s": d, "speed": samples[a]["speed"],
            "direction": "right" if sum(s["steer"] for s in samples[a:b + 1]) > 0 else "left",
        })
    return out


def throttle_lifts(samples: list[dict], dist: list[float], airborne: list[bool]) -> list[dict]:
    flags = [
        (not airborne[i]) and s["gas"] < LIFT_GAS and s["brake"] <= BRAKE_ON and s["speed"] >= LIFT_MIN_KMH
        for i, s in enumerate(samples)
    ]
    out = []
    for a, b in _runs(flags, 3, gap=1):
        d = _dt(samples, a, b) + 0.05
        if d < LIFT_MIN_S:
            continue
        out.append({
            "start_i": a, "end_i": b, "x": samples[a]["x"], "z": samples[a]["z"],
            "dist_m": dist[a], "duration_s": d, "speed": samples[a]["speed"],
        })
    return out


def analyze_run(samples: list[dict]) -> dict:
    """All signals for one run."""
    if len(samples) < 20:
        return {"flights": [], "taps": [], "lifts": [], "brake_s": 0.0, "duration_s": 0.0, "avg_speed": 0.0, "dist": []}
    dist = _cumulative_distance(samples)
    fl = flights(samples, dist)
    air = _in_flight(len(samples), fl)
    total_s = _dt(samples, 0, len(samples) - 1)
    brake_s = sum(1 for s in samples if s["brake"] > BRAKE_ON) * total_s / len(samples)
    return {
        "flights": fl,
        "taps": brake_taps(samples, dist, air),
        "lifts": throttle_lifts(samples, dist, air),
        "brake_s": brake_s,
        "duration_s": total_s,
        "avg_speed": sum(s["speed"] for s in samples) / len(samples),
        "top_speed": max(s["speed"] for s in samples),
        "dist": dist,
    }


# ------------------------------------------------------------------ pairing

def _near(a: dict, b: dict) -> float:
    return math.hypot(a["x"] - b["x"], a["z"] - b["z"])


def public_flights(samples: list[dict]) -> list[dict]:
    """A run's jumps in the form the frontend draws: where it took off and
    landed, how long it was airborne, the speeds and whether it was air-braked."""
    if len(samples) < 20:
        return []
    dist = _cumulative_distance(samples)
    return [
        {
            "x": round(f["x"], 1), "y": round(f["y"], 1), "z": round(f["z"], 1),
            "end_x": round(f["end_x"], 1), "end_y": round(f["end_y"], 1), "end_z": round(f["end_z"], 1),
            "duration_s": round(f["duration_s"], 2), "length_m": round(f["length_m"], 1),
            "height_m": round(f["height_m"], 1), "speed_in": round(f["speed_in"], 1), "speed_out": round(f["speed_out"], 1),
            "brake_s": round(f["brake_s"], 2),
            "t_ms": samples[f["start_i"]]["time_ms"], "end_t_ms": samples[f["end_i"]]["time_ms"],
        }
        for f in flights(samples, dist)
    ]


def pair_items(player: list[dict], ghost: list[dict]) -> tuple[list[tuple[dict, dict]], list[dict], list[dict]]:
    """Match a player's items to the ghost's by where on the track they happen."""
    used: set[int] = set()
    pairs = []
    ghost_only = []
    for g in ghost:
        best, best_d = None, PAIR_RADIUS_M
        for idx, p in enumerate(player):
            if idx in used:
                continue
            d = _near(g, p)
            if d < best_d:
                best, best_d = idx, d
        if best is None:
            ghost_only.append(g)
        else:
            used.add(best)
            pairs.append((player[best], g))
    player_only = [p for idx, p in enumerate(player) if idx not in used]
    return pairs, player_only, ghost_only


def _where(item: dict, subject_samples: list[dict], subject_dist: list[float]) -> float:
    """Distance along the PLAYER's path nearest to an item (so ghost items can be
    quoted in the same distances as the rest of the report)."""
    best_i, best_d = 0, 1e18
    for i, s in enumerate(subject_samples):
        d = (s["x"] - item["x"]) ** 2 + (s["z"] - item["z"]) ** 2
        if d < best_d:
            best_i, best_d = i, d
    return subject_dist[best_i]


# --------------------------------------------------------------------- text

def _f(item: dict, who: str) -> str:
    lost = item["speed_in"] - item["speed_out"]
    change = f"lost {lost:.0f} km/h" if lost >= 1 else (f"gained {-lost:.0f} km/h" if lost <= -1 else "speed unchanged")
    return (
        f"{who} air {item['duration_s']:.1f}s over {item['length_m']:.0f}m, speed {item['speed_in']:.0f} -> {item['speed_out']:.0f} km/h"
        f" ({change}), braked {item['brake_s']:.2f}s in the air"
    )


MAX_FINDINGS = 6
SKIP_START_M = 30.0  # nothing meaningful happens in the first metres of a run


def _finding(technique: str, where_m: float, level: str, summary: str, how: str, score: float = 1.0) -> dict:
    return {"technique": technique, "where_m": where_m, "level": level, "summary": summary, "how": how, "score": score}


def find_techniques(s: dict, g: dict, subject_samples: list[dict]) -> list[dict]:
    """Concrete, data-backed technique differences between the two runs. The
    coach's "Techniques to try" section is built ONLY from these, so it can't
    recommend a speed drift on a straight or an airbrake nothing supports."""
    out: list[dict] = []
    sd = s["dist"]

    # speed drifts: the brake taps while steering hard at speed
    pairs, p_only, g_only = pair_items(s["taps"], g["taps"])
    for gh in g_only:
        d = _where(gh, subject_samples, sd)
        if d < SKIP_START_M:
            continue
        out.append(_finding(
            "Speed drift", d, "measured signal, technique inferred",
            f"at ~{d:.0f}m the ghost tapped the brake for {gh['duration_s']:.2f}s at {gh['speed']:.0f} km/h while steering "
            f"{gh['direction']}; the player did not brake there",
            "steer into the corner and hold a short brake tap of about that length, keeping speed above ~180 km/h, "
            "then release and let the car slide",
            score=60 + 40 * gh["duration_s"],
        ))
    for p, gh in pairs:
        if p["duration_s"] > gh["duration_s"] * 1.8 + 0.1:
            out.append(_finding(
                "Speed drift timing", p["dist_m"], "measured",
                f"at ~{p['dist_m']:.0f}m both tapped the brake, but the player held it {p['duration_s']:.2f}s against the ghost's "
                f"{gh['duration_s']:.2f}s at {p['speed']:.0f} vs {gh['speed']:.0f} km/h",
                "shorten the brake tap to roughly the ghost's length; a long hold just scrubs speed",
                score=50 + 30 * (p["duration_s"] - gh["duration_s"]),
            ))
    for p in p_only:
        out.append(_finding(
            "Staying off the brake", p["dist_m"], "measured",
            f"at ~{p['dist_m']:.0f}m the player tapped the brake {p['duration_s']:.2f}s at {p['speed']:.0f} km/h while steering "
            f"{p['direction']}; the ghost carried its speed through there without braking",
            "try the same stretch with no brake: an earlier, wider entry so the car needs no tap",
            score=55 + 40 * p["duration_s"],
        ))

    # jumps: airbrake and landings
    pairs, p_only, g_only = pair_items(s["flights"], g["flights"])
    for p, gh in pairs:
        p_lost = p["speed_in"] - p["speed_out"]
        g_lost = gh["speed_in"] - gh["speed_out"]
        if gh["brake_s"] >= 0.1 and p["brake_s"] < 0.05 and p_lost - g_lost >= 3:
            out.append(_finding(
                "Airbrake", p["dist_m"], "measured",
                f"at ~{p['dist_m']:.0f}m the ghost braked {gh['brake_s']:.2f}s in the air and lost {g_lost:.0f} km/h over the jump; "
                f"the player did not brake in the air and lost {p_lost:.0f} km/h",
                "tap the brake while airborne to stop the car rotating, then land flat on all four wheels",
                score=100 + (p_lost - g_lost),
            ))
        elif p_lost - g_lost >= 6:
            out.append(_finding(
                "Landing", p["dist_m"], "measured",
                f"at ~{p['dist_m']:.0f}m the player lost {p_lost:.0f} km/h over the jump against the ghost's {g_lost:.0f} km/h "
                f"(player braked {p['brake_s']:.2f}s in the air, ghost {gh['brake_s']:.2f}s)",
                "check the take-off speed and angle and land flat and in line with the slope; an airbrake may help level the car",
                score=80 + (p_lost - g_lost),
            ))
    for p in p_only:
        lost = p["speed_in"] - p["speed_out"]
        if lost < 3 and p["duration_s"] < 0.8:
            continue  # a short hop that didn't cost speed isn't worth a tip
        out.append(_finding(
            "Staying on the ground", p["dist_m"], "measured",
            f"at ~{p['dist_m']:.0f}m the player was airborne {p['duration_s']:.1f}s over {p['length_m']:.0f}m (speed {p['speed_in']:.0f} -> "
            f"{p['speed_out']:.0f} km/h) while the ghost stayed on the ground",
            "ease off slightly before the rise or change the line so the car doesn't take off; a flight the ghost doesn't need usually costs time",
            score=40 + max(0.0, lost) + 20 * p["duration_s"],
        ))

    # throttle lifts the ghost doesn't make
    pairs, p_only, _ = pair_items(s["lifts"], g["lifts"])
    for p in p_only:
        if p["duration_s"] >= 0.25:
            out.append(_finding(
                "Holding the throttle", p["dist_m"], "measured",
                f"at ~{p['dist_m']:.0f}m the player lifted off the throttle for {p['duration_s']:.2f}s at {p['speed']:.0f} km/h; "
                "the ghost kept it down",
                "keep the throttle pinned and fix the line or entry that made you lift",
                score=70 + 60 * p["duration_s"],
            ))

    # braking overall
    s_pct = 100 * s["brake_s"] / max(1.0, s["duration_s"])
    g_pct = 100 * g["brake_s"] / max(1.0, g["duration_s"])
    if s["brake_s"] - g["brake_s"] >= 1.0 and s_pct - g_pct >= 3:
        out.append(_finding(
            "Braking less", 0.0, "measured",
            f"the player braked {s['brake_s']:.1f}s of the run ({s_pct:.1f}%) against the ghost's {g['brake_s']:.1f}s ({g_pct:.1f}%)",
            "find the corners where you brake and the ghost doesn't; lift earlier or enter wider instead of braking",
            score=65 + (s_pct - g_pct),
        ))
    # keep the most significant few, then list them in track order
    out.sort(key=lambda f: -f["score"])
    return sorted(out[:MAX_FINDINGS], key=lambda f: f["where_m"])


def filter_by_surface(findings: list[dict], labels: list[str] | None, dist: list[float] | None) -> list[dict]:
    """Drop speed-drift findings that sit on a surface where a speed drift can't work."""
    if not labels or not dist:
        return findings
    from .surface import DRIFT_SURFACES, label_at

    kept = []
    for f in findings:
        if f["technique"] in ("Speed drift", "Speed drift timing"):
            surf = label_at(labels, dist, f["where_m"])
            if surf not in DRIFT_SURFACES and surf != "unknown" and surf != "plastic":
                continue
        kept.append(f)
    return kept


def findings_text(findings: list[dict], styles: list[tuple[str, str]] | None) -> str:
    """The findings as prompt text, dropping speed drifts on surfaces where
    they don't work."""
    no_drift = {style for style, _ in (styles or [])} & {"ice", "bobsleigh", "dirt", "grass"}
    kept = []
    dropped = 0
    for f in findings:
        if no_drift and f["technique"] == "Speed drift":
            dropped += 1
            continue
        kept.append(f)
    lines = ["TECHNIQUE FINDINGS (worked out by the app from the signals above; the `Techniques to try` section must be built ONLY from these):"]
    if not kept:
        lines.append(
            "- None. The data shows no technique-specific difference between the runs (no airbrake, speed-drift, landing or "
            "throttle difference). Say that plainly: the time is in the line, the entries and the inputs, which the focus areas cover."
        )
    for f in kept:
        lines.append(f"- {f['technique']} [{f['level']}]: {f['summary']}. How to try it: {f['how']}.")
    if dropped:
        lines.append(
            f"- ({dropped} brake tap(s) by the ghost were left out: speed drifts don't work on this map's surface, so don't suggest them.)"
        )
    return "\n".join(lines)


def signals_text(subject_samples: list[dict], reference_samples: list[dict]) -> tuple[str, dict, list[dict]]:
    """Prompt text for the measured technique signals, the numbers the
    map-style detector uses, and the technique findings."""
    s = analyze_run(subject_samples)
    g = analyze_run(reference_samples)
    lines: list[str] = []
    sd = s["dist"]

    # --- jumps and airbrake
    pairs, p_only, g_only = pair_items(s["flights"], g["flights"])
    if pairs or p_only or g_only:
        lines.append("JUMPS / AIRTIME (a flight is a stretch in free fall; 'braked N s in the air' is air-braking, brake pressed while airborne):")
        for p, gh in sorted(pairs, key=lambda t: t[0]["dist_m"]):
            lines.append(f"- at ~{p['dist_m']:.0f}m: {_f(p, 'player')} | {_f(gh, 'ghost')}")
        for gh in g_only:
            lines.append(f"- at ~{_where(gh, subject_samples, sd):.0f}m (ghost only - the player did not leave the ground here): {_f(gh, 'ghost')}")
        for p in p_only:
            lines.append(f"- at ~{p['dist_m']:.0f}m (player only - the ghost stayed on the ground): {_f(p, 'player')}")
    else:
        lines.append("JUMPS / AIRTIME: neither run has a meaningful jump (no stretch of free fall of 0.25 s or more).")

    # --- brake taps while steering at speed
    pairs, p_only, g_only = pair_items(s["taps"], g["taps"])
    if pairs or p_only or g_only:
        lines.append(
            f"BRAKE TAPS WHILE STEERING HARD AT {DRIFT_MIN_KMH:.0f}+ km/h (how a speed drift / speedslide is started on a grippy surface):"
        )
        for p, gh in sorted(pairs, key=lambda t: t[0]["dist_m"]):
            lines.append(
                f"- at ~{p['dist_m']:.0f}m: both did it - player {p['duration_s']:.2f}s at {p['speed']:.0f} km/h, "
                f"ghost {gh['duration_s']:.2f}s at {gh['speed']:.0f} km/h ({gh['direction']} turn)"
            )
        for gh in g_only:
            lines.append(
                f"- at ~{_where(gh, subject_samples, sd):.0f}m: GHOST ONLY - ghost tapped the brake {gh['duration_s']:.2f}s at "
                f"{gh['speed']:.0f} km/h steering {gh['direction']}; the player did not"
            )
        for p in p_only:
            lines.append(
                f"- at ~{p['dist_m']:.0f}m: PLAYER ONLY - player tapped the brake {p['duration_s']:.2f}s at "
                f"{p['speed']:.0f} km/h steering {p['direction']}; the ghost did not"
            )
    else:
        lines.append("BRAKE TAPS WHILE STEERING HARD AT SPEED: neither run did any (no speed-drift style braking).")

    # --- throttle lifts and total braking
    def lift_total(r):
        return sum(x["duration_s"] for x in r["lifts"])

    lines.append(
        f"THROTTLE LIFTS (gas released for 0.15 s+ above 100 km/h, brake not pressed): player {len(s['lifts'])} "
        f"({lift_total(s):.1f}s total), ghost {len(g['lifts'])} ({lift_total(g):.1f}s total)."
    )
    for x in s["lifts"][:6]:
        lines.append(f"- player lifted at ~{x['dist_m']:.0f}m for {x['duration_s']:.2f}s at {x['speed']:.0f} km/h")
    lines.append(
        f"BRAKE USE OVERALL: player braked {s['brake_s']:.1f}s of a {s['duration_s']:.0f}s run "
        f"({100 * s['brake_s'] / max(1.0, s['duration_s']):.1f}%), ghost {g['brake_s']:.1f}s of {g['duration_s']:.0f}s "
        f"({100 * g['brake_s'] / max(1.0, g['duration_s']):.1f}%)."
    )

    findings = find_techniques(s, g, subject_samples)
    features = {
        "brake_pct": 100 * g["brake_s"] / max(1.0, g["duration_s"]),
        "avg_speed": g["avg_speed"],
        "top_speed": g.get("top_speed", 0.0),
        "ghost_taps": len(g["taps"]),
        "ghost_flights": len(g["flights"]),
        "player_flights": len(s["flights"]),
    }
    return "\n".join(lines), features, findings
