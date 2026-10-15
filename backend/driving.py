"""What a replay says about *how* a lap was driven, beyond the line.

- landings: how each jump ended (nose angle, tilt at touchdown, speed lost, flips in the air),
  from the car's recorded orientation
- wall-rides and inverted stretches, from the same orientation
- input smoothness: how calm the steering and pedals were
- field moves: lines, jumps and air-brakes the top ghosts share and the player doesn't

Everything here is optional: a run saved without orientation just has no landings or wall-rides,
and every function returns empty results rather than failing.
"""

from __future__ import annotations

import math

from . import signals

FLIP_DEG = 150.0        # the car turned over this much in the air: a flip
CLEAN_PITCH_DEG = 8.0   # a landing within this of the ground's slope is clean
CLEAN_TILT_DEG = 15.0
WALL_UP_Y = 0.35        # up vector below this: on a wall or steeper
INVERTED_UP_Y = -0.3
WALL_MIN_SAMPLES = 6    # about 0.3 s


def has_orientation(samples: list[dict]) -> bool:
    return bool(samples) and samples[0].get("fx") is not None and samples[0].get("ux") is not None


def _angle(u: tuple[float, float, float], v: tuple[float, float, float]) -> float:
    dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
    nu = math.sqrt(u[0] ** 2 + u[1] ** 2 + u[2] ** 2) or 1.0
    nv = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) or 1.0
    return math.degrees(math.acos(max(-1.0, min(1.0, dot / (nu * nv)))))


def _up(s: dict) -> tuple[float, float, float]:
    return s["ux"], s["uy"], s["uz"]


# ------------------------------------------------------------------ landings

def landings(samples: list[dict], dist: list[float], fl: list[dict], bob: bool = False) -> list[dict]:
    """One entry per flight: how the car came down. On a bobsleigh/ice map a sideways landing is usually right (the car comes
    down onto a bank), so there the verdict follows the speed it kept and the nose angle, not the sideways tilt."""
    if not has_orientation(samples):
        return []
    n = len(samples)
    out = []
    for f in fl:
        a, b = f["start_i"], f["end_i"]
        touch = samples[min(n - 1, b + 1)]
        after = samples[min(n - 1, b + 9)]
        settled = samples[min(n - 1, b + 11)]
        pitch = math.degrees(math.asin(max(-1.0, min(1.0, touch["fy"]))))
        run = math.hypot(after["x"] - touch["x"], after["z"] - touch["z"])
        slope = math.degrees(math.atan2(after["y"] - touch["y"], max(run, 1.0)))
        nose_down = slope - pitch  # positive: the nose points lower than the ground it's about to meet
        tilt = _angle(_up(touch), _up(settled))
        spin = max((_angle(_up(samples[a]), _up(samples[i])) for i in range(a, min(n, b + 1))), default=0.0)
        lost = f["speed_in"] - samples[min(n - 1, b + 7)]["speed"]
        nose_ok = abs(nose_down) <= CLEAN_PITCH_DEG
        sideways_ok = bool(bob and nose_ok and tilt > CLEAN_TILT_DEG and lost < 12)
        clean = nose_ok and (tilt <= CLEAN_TILT_DEG or sideways_ok)
        entry = {
            "dist_m": round(dist[b], 1), "x": round(touch["x"], 1), "y": round(touch["y"], 1), "z": round(touch["z"], 1),
            "duration_s": round(f["duration_s"], 2), "height_m": round(f["height_m"], 1), "length_m": round(f["length_m"], 1),
            "nose_down_deg": round(nose_down, 1), "tilt_deg": round(tilt, 1), "speed_lost": round(lost, 1),
            "spin_deg": round(spin, 0), "flip": spin >= FLIP_DEG, "clean": clean, "sideways_ok": sideways_ok,
        }
        entry["text"] = landing_word(entry)
        out.append(entry)
    return out


def landing_word(land: dict) -> str:
    """The landing in plain words, for the track view and the coach."""
    nd = land["nose_down_deg"]
    if land.get("sideways_ok"):
        return f"landed sideways onto the bank ({land['tilt_deg']:.0f}° tilt, right for a bob track) and lost {max(0.0, land['speed_lost']):.0f} km/h"
    if abs(nd) <= CLEAN_PITCH_DEG and land["tilt_deg"] <= CLEAN_TILT_DEG:
        angle = "landed flat"
    elif nd > 0:
        angle = f"landed {abs(nd):.0f}° nose-down"
    else:
        angle = f"landed {abs(nd):.0f}° nose-up"
    extra = f", tilted {land['tilt_deg']:.0f}° sideways" if land["tilt_deg"] > CLEAN_TILT_DEG else ""
    flip = " after turning over in the air" if land["flip"] else ""
    return f"{angle}{extra}{flip} and lost {max(0.0, land['speed_lost']):.0f} km/h"


# ------------------------------------------------------------------ wall-rides and inverted stretches

def inverted(samples: list[dict], dist: list[float], air: list[bool], bob: bool = False) -> list[dict]:
    """Stretches on a wall or ceiling. On a bobsleigh/ice map the tilted stretches are the banked turns of the track
    itself, not a trick, so they are named "bank ride"."""
    if not has_orientation(samples):
        return []
    flags = [(not air[i]) and s["uy"] < WALL_UP_Y for i, s in enumerate(samples)]
    out = []
    for a, b in signals._runs(flags, WALL_MIN_SAMPLES, gap=2):
        lowest = min(samples[i]["uy"] for i in range(a, b + 1))
        entry = {
            "start_m": round(dist[a], 1), "end_m": round(dist[b], 1), "dist_m": round((dist[a] + dist[b]) / 2, 1),
            "x": round(samples[(a + b) // 2]["x"], 1), "y": round(samples[(a + b) // 2]["y"], 1), "z": round(samples[(a + b) // 2]["z"], 1),
            "duration_s": round(signals._dt(samples, a, b) + 0.05, 2), "lowest_up_y": round(lowest, 2),
            "kind": "upside down" if lowest < INVERTED_UP_Y else ("bank ride" if bob else "wall ride"),
            "speed": round(sum(samples[i]["speed"] for i in range(a, b + 1)) / (b - a + 1), 0),
        }
        what = {"upside down": "upside down", "bank ride": "riding the banked bob turn"}.get(entry["kind"], "on a wall")
        entry["text"] = f"were {what} for {entry['duration_s']:.1f}s at {entry['speed']:.0f} km/h"
        out.append(entry)
    return out


# ------------------------------------------------------------------ input smoothness

SMOOTH_JERK = 0.12     # steering change per 50 ms where the wheel score has halved
SMOOTH_TWITCH = 6.0    # twitches per second that cut the score by half again
MIN_SPEED = 40.0


def smoothness(samples: list[dict]) -> dict | None:
    """How calm the inputs were: 0-100 for the wheel and for the pedals, plus the numbers behind them.
    It compares two runs on the same map; it isn't a skill rating (a bobsleigh needs a busier wheel than a straight)."""
    use = [s for s in samples if s["speed"] >= MIN_SPEED]
    if len(use) < 30:
        return None
    steer = [s["steer"] for s in use]
    steps = [abs(b - a) for a, b in zip(steer, steer[1:])]
    jerk = sum(steps) / len(steps)
    # tiny back-and-forth corrections: direction changes of a small size
    twitch = 0
    last_dir = 0
    for a, b in zip(steer, steer[1:]):
        d = b - a
        if abs(d) < 0.02:
            continue
        direction = 1 if d > 0 else -1
        if last_dir and direction != last_dir and abs(d) < 0.25:
            twitch += 1
        last_dir = direction
    seconds = max(1.0, (use[-1]["time_ms"] - use[0]["time_ms"]) / 1000.0)
    gas_flips = sum(1 for a, b in zip(use, use[1:]) if (a["gas"] > 0.5) != (b["gas"] > 0.5))
    brake_flips = sum(1 for a, b in zip(use, use[1:]) if (a["brake"] > 0.1) != (b["brake"] > 0.1))
    pedal_rate = (gas_flips + brake_flips) / seconds * 60.0
    twitch_rate = twitch / seconds
    wheel = 100.0 / (1.0 + (jerk / SMOOTH_JERK) ** 1.5) / (1.0 + twitch_rate / SMOOTH_TWITCH)
    pedals = 100.0 / (1.0 + (pedal_rate / 90.0) ** 1.2)
    return {
        "wheel": round(wheel), "pedals": round(pedals), "overall": round(0.7 * wheel + 0.3 * pedals),
        "steer_jerk": round(jerk, 4), "twitches_per_s": round(twitch_rate, 2), "pedal_changes_per_min": round(pedal_rate, 1),
    }


# ------------------------------------------------------------------ one run, all of it

def analyze(samples: list[dict], bob: bool = False) -> dict:
    """Landings, wall-rides (bank rides on a bobsleigh map) and smoothness for one run (used for the player and for the ghost)."""
    if len(samples) < 20:
        return {"oriented": False, "landings": [], "inverted": [], "smoothness": None}
    dist = signals._cumulative_distance(samples)
    fl = signals.flights(samples, dist)
    air = signals._in_flight(len(samples), fl)
    return {
        "oriented": has_orientation(samples),
        "landings": landings(samples, dist, fl, bob),
        "inverted": inverted(samples, dist, air, bob),
        "smoothness": smoothness(samples),
    }


def driving_text(subject: dict, reference: dict) -> str:
    """Prompt lines for the coach: landings, wall-rides and smoothness, player against ghost."""
    lines: list[str] = []
    if subject["oriented"] and subject["landings"]:
        lines.append("LANDINGS (from the car's recorded orientation; nose-down is measured against the slope it lands on):")
        if any(land.get("sideways_ok") for land in subject["landings"]):
            lines.append("- NOTE: on a bobsleigh track landing sideways onto the bank is normal and often exactly right; judge a landing by the speed it kept and by whether the ghost lands the same way, never by the sideways tilt alone.")
        for land in subject["landings"]:
            mate = min(reference["landings"], key=lambda g: abs(g["dist_m"] - land["dist_m"]), default=None)
            ghost = f"; ghost there: {landing_word(mate)}" if mate and abs(mate["dist_m"] - land["dist_m"]) < 60 else ""
            lines.append(f"- at ~{land['dist_m']:.0f}m ({land['duration_s']:.1f}s in the air): player {landing_word(land)}{ghost}")
    if subject["oriented"] and subject["inverted"]:
        banks = any(w["kind"] == "bank ride" for w in subject["inverted"])
        lines.append("BANK RIDES (the banked turns of the bobsleigh track itself, not a trick; judge them by line and speed) / UPSIDE-DOWN STRETCHES (player):" if banks
                     else "WALL-RIDES / UPSIDE-DOWN STRETCHES (player):")
        for w in subject["inverted"]:
            lines.append(f"- {w['kind']} from {w['start_m']:.0f}m to {w['end_m']:.0f}m ({w['duration_s']:.1f}s at {w['speed']:.0f} km/h)")
    s, g = subject.get("smoothness"), reference.get("smoothness")
    if s and g:
        lines.append(
            f"INPUT SMOOTHNESS (0-100, higher is calmer): player wheel {s['wheel']} / pedals {s['pedals']}; "
            f"ghost wheel {g['wheel']} / pedals {g['pedals']}. Steering twitches per second: player {s['twitches_per_s']}, "
            f"ghost {g['twitches_per_s']}; pedal changes per minute: player {s['pedal_changes_per_min']}, ghost {g['pedal_changes_per_min']}."
        )
    return "\n".join(lines)


def landing_findings(subject: dict, reference: dict) -> list[dict]:
    """Technique findings for rough landings, in the shape signals.find_techniques returns."""
    out = []
    if not subject["oriented"]:
        return out
    for land in subject["landings"]:
        if land["duration_s"] < 0.5 or (land["clean"] and land["speed_lost"] < 12):
            continue
        mate = min(reference["landings"], key=lambda g: abs(g["dist_m"] - land["dist_m"]), default=None)
        mate = mate if mate and abs(mate["dist_m"] - land["dist_m"]) < 60 else None
        if land["clean"]:
            worse = mate is not None and land["speed_lost"] - mate["speed_lost"] >= 8   # a flat landing only matters if it cost more than the ghost's
        else:
            worse = mate is None or mate["clean"] or land["speed_lost"] - mate["speed_lost"] >= 4
        if not worse:
            continue
        ghost = f"; the ghost {landing_word(mate)}" if mate else ""
        out.append({
            "technique": "Landing angle", "where_m": land["dist_m"], "level": "measured",
            "summary": f"at ~{land['dist_m']:.0f}m the player {landing_word(land)}{ghost}",
            "how": "level the car in the air with a short brake or steer tap so the wheels meet the slope together; "
                   "a nose-first or sideways landing scrubs speed",
            "score": 75 + max(0.0, land["speed_lost"]) + abs(land["nose_down_deg"]),
        })
    return out


# ------------------------------------------------------------------ what the top ghosts share

CUT_DEV_M = 5.5
CUT_MIN_M = 25.0
CUT_MIN_GAIN_MS = 25
CLUSTER_M = 40.0


def _cuts(points: list[dict]) -> list[dict]:
    """Stretches where this ghost's line leaves the player's by several metres and gains time."""
    dev = [math.hypot(p["x"] - p["reference_x"], p["z"] - p["reference_z"]) for p in points]
    flags = [d >= CUT_DEV_M for d in dev]
    out = []
    for a, b in signals._runs(flags, 3, gap=2):
        length = points[b]["distance_m"] - points[a]["distance_m"]
        gain = points[b]["delta_ms"] - points[a]["delta_ms"]  # positive: the player lost this much against the ghost here
        if length < CUT_MIN_M or gain < CUT_MIN_GAIN_MS:
            continue
        mid = (a + b) // 2
        out.append({
            "kind": "cut", "dist_m": round(points[mid]["distance_m"], 1), "start_m": round(points[a]["distance_m"], 1),
            "end_m": round(points[b]["distance_m"], 1), "x": points[mid]["x"], "z": points[mid]["z"],
            "gain_ms": int(gain), "dev_m": round(max(dev[a:b + 1]), 1),
        })
    return out


def _flight_moves(points: list[dict], subject_flights: list[dict], ref_flights: list[dict]) -> list[dict]:
    """Jumps and air-brakes the ghost does and the player doesn't."""
    def near_point(x: float, y: float, z: float) -> dict:
        return min(points, key=lambda p: (p["reference_x"] - x) ** 2 + (p["reference_y"] - y) ** 2 + (p["reference_z"] - z) ** 2)

    out = []
    for f in ref_flights:
        if f["duration_s"] < 0.45 and f["length_m"] < 25:
            continue
        here = near_point(f["x"], f["y"], f["z"])
        mate = next((s for s in subject_flights if math.hypot(s["x"] - here["x"], s["z"] - here["z"]) < 45), None)
        if mate is None:
            out.append({
                "kind": "jump", "dist_m": round(here["distance_m"], 1), "x": here["x"], "z": here["z"],
                "duration_s": f["duration_s"], "length_m": f["length_m"], "height_m": f["height_m"],
            })
        elif f["brake_s"] >= 0.1 and mate["brake_s"] < 0.05:
            out.append({
                "kind": "airbrake", "dist_m": round(here["distance_m"], 1), "x": here["x"], "z": here["z"],
                "brake_s": f["brake_s"], "duration_s": f["duration_s"],
            })
    return out


def field_moves(points_by_ref: dict[str, list[dict]], subject_flights: list[dict], flights_by_ref: dict[str, list[dict]]) -> list[dict]:
    """What the references share and the player doesn't: different lines, jump lines and air-brake spots.
    With three or more ghosts a move needs at least half of them to count."""
    n = len(points_by_ref)
    raw: list[tuple[str, dict]] = []
    for rid, pts in points_by_ref.items():
        if len(pts) < 20:
            continue
        for m in _cuts(pts):
            raw.append((rid, m))
        for m in _flight_moves(pts, subject_flights, flights_by_ref.get(rid, [])):
            raw.append((rid, m))
    clusters: list[dict] = []
    for rid, m in sorted(raw, key=lambda t: t[1]["dist_m"]):
        for c in clusters:
            if c["kind"] == m["kind"] and abs(c["dist_m"] - m["dist_m"]) <= CLUSTER_M:
                c["refs"].add(rid)
                c["items"].append(m)
                break
        else:
            clusters.append({"kind": m["kind"], "dist_m": m["dist_m"], "refs": {rid}, "items": [m]})
    need = 1 if n < 3 else math.ceil(n / 2)
    out = []
    for c in clusters:
        if len(c["refs"]) < need:
            continue
        items = c["items"]
        first = items[0]
        agree = len(c["refs"])
        who = f"{agree} of {n} ghosts" if n > 1 else "the ghost"
        if c["kind"] == "cut":
            gain = int(sum(i["gain_ms"] for i in items) / len(items))
            dev = max(i["dev_m"] for i in items)
            text = f"{who} take a different line here (up to {dev:.0f} m from yours) and gain about {gain} ms"
            score = 100 + agree * 30 + gain / 4
            extra = {"gain_ms": gain, "dev_m": dev, "start_m": first["start_m"], "end_m": first["end_m"]}
        elif c["kind"] == "jump":
            text = f"{who} leave the ground here ({first['duration_s']:.1f}s, {first['length_m']:.0f} m) and you stay on it"
            score = 90 + agree * 30
            extra = {"duration_s": first["duration_s"], "length_m": first["length_m"]}
        else:
            text = f"{who} brake in the air here ({first['brake_s']:.2f}s) and you don't"
            score = 80 + agree * 30
            extra = {"brake_s": first["brake_s"]}
        out.append({
            "kind": c["kind"], "dist_m": round(sum(i["dist_m"] for i in items) / len(items), 1),
            "x": first["x"], "z": first["z"], "agree": agree, "of": n, "text": text, "score": round(score, 1), **extra,
        })
    out.sort(key=lambda m: -m["score"])
    return sorted(out[:8], key=lambda m: m["dist_m"])
