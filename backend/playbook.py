"""The trick playbook: for every map, the techniques that apply to it, prepared, with exactly how to do each one and
where on THIS map to use it.

It does not wait for the ghost to be seen doing a trick. From the map (its ground, its corners and how fast they are
entered, its jumps, its walls) it lists what is worth learning, step by step, and marks the places in things a player
can see: a corner, a checkpoint, a number of seconds after a checkpoint. Where the data shows the ghosts doing it,
that is added as the evidence ("the ghost tapped the brake for 0.4 s at 212 km/h here").

The how-to steps are the general technique knowledge of the coach (techniques.py / skills.py); the places and numbers
are measured from the runs.
"""

from __future__ import annotations

GRIP = {"tech", "bump"}                  # ground a speed drift can work on
LOOSE = {"dirt", "grass", "ice", "water"}
SHIFTS = (100, 160, 235, 341)            # automatic gear changes, km/h (approximate)
MAX_PLACES = 6


def _place(lm, d0: float, d1: float, detail: str) -> dict:
    k, label = lm.segment((d0 + d1) / 2) if lm is not None else (0, "")
    return {
        "where": lm.span(d0, d1) if lm is not None else f"{d0:.0f}-{d1:.0f} m", "detail": detail,
        "from_m": round(d0), "to_m": round(d1), "segment": label or None, "seg_gap_ms": lm.seg_gap(k) if lm is not None else None,
    }


def _card(id_: str, name: str, group: str, why: str, steps: list[str], feel: str, mistakes: list[str], drill: str,
          places: list[dict], applies: bool, you: int | None = None, ghost: int | None = None, advanced: bool = False) -> dict:
    seen, uniq = set(), []
    for p in places:  # the same spot in the same words twice adds nothing
        key = (p["where"], p["detail"])
        if key not in seen:
            seen.add(key)
            uniq.append(p)
    return {
        "id": id_, "name": name, "group": group, "why": why, "steps": steps, "feel": feel, "mistakes": mistakes, "drill": drill,
        "places": uniq[:MAX_PLACES], "applies": applies, "you": you, "ghost": ghost, "advanced": advanced,
    }


def build(*, styles: list[str], corners: list[dict], corner_ground: dict[int, str], ground_share: dict[str, float],
          flights_you: list[dict], flights_ref: list[dict], landings: list[dict], walls: list[dict],
          ghost_taps: list[dict], player_lifts: list[dict], points: list[dict], lm, blueprint: dict | None,
          skills_report: dict | None = None) -> list[dict]:
    cards: list[dict] = []
    icy = "ice" in styles or "bobsleigh" in styles or ground_share.get("ice", 0.0) >= 0.2
    loose_share = sum(ground_share.get(k, 0.0) for k in LOOSE)

    def entry(c: dict) -> float:
        return float(c.get("subject_entry_speed") or 0.0)

    # ---------------------------------------------------------------- speed drift
    cand = [c for c in corners if corner_ground.get(c["corner_index"]) in GRIP and entry(c) >= 180 and 25 <= c["turn_deg"] <= 150]
    cand.sort(key=lambda c: -entry(c))
    places = []
    for c in cand:
        tap = next((t for t in ghost_taps if c["distance_start"] - 60 <= t["dist_m"] <= c["distance_end"]), None)
        extra = f"; the ghost tapped the brake for {tap['duration_s']:.2f} s at {tap['speed']:.0f} km/h here" if tap else ""
        places.append(_place(lm, c["distance_start"], c["distance_end"],
                             f"corner {c['corner_index']} ({c['direction']} {c['turn_deg']}°), entered at {entry(c):.0f} km/h on {corner_ground.get(c['corner_index'])}{extra}"))
    cards.append(_card(
        "speed_drift", "Speed drift (speedslide)", "Cornering",
        "On grippy ground a short brake tap while the wheel is turned throws the car into a slide that keeps far more speed than plain steering."
        + ("" if cand else " No corner on this map is entered fast enough on grippy ground for it, so it is not worth practising here."),
        ["Arrive above about 180 km/h on grippy ground (the 'tech' or 'bumpy road' kind). Below that the car will not slide.",
         "Turn in as normal, then press and hold the brake while the wheel is turned, for about half a second.",
         "Let go of the brake. Keep the throttle down and the wheel turned: the car now slides sideways and keeps most of its speed.",
         "When the exit opens up, straighten the wheel and let the car come back round."],
        "The back end steps out and the car rotates faster than with steering alone, while the speed falls much less than in a normal turn.",
        ["Holding the brake much longer than half a second only scrubs speed.", "Trying it below ~180 km/h, or on dirt, grass, ice or water: it will not slide.", "Straightening too early: the car snaps back and loses the slide."],
        "Take the first place below, practise the tap at the same spot until your speed at the exit matches or beats the ghost's." if cand else "Nothing to drill here.",
        places, bool(cand), ghost=len(ghost_taps) or None))

    # ---------------------------------------------------------------- air-brake and landing
    places = []
    for f in flights_you:
        if f["duration_s"] < 0.45 and f["length_m"] < 25:
            continue
        d = _dist_of(points, f)
        mate = next((g for g in flights_ref if abs(g["x"] - f["x"]) + abs(g["z"] - f["z"]) < 60), None)
        land = next((l for l in landings if abs(l["x"] - f["end_x"]) + abs(l["z"] - f["end_z"]) < 40), None)
        bits = [f"{f['duration_s']:.1f} s in the air over {f['length_m']:.0f} m"]
        if land:
            bits.append(f"you {land['text']}")
        if mate:
            bits.append(f"the ghost {'air-braked ' + format(mate['brake_s'], '.2f') + ' s' if mate['brake_s'] >= 0.05 else 'did not brake'} and lost {mate['speed_in'] - mate['speed_out']:.0f} km/h")
        else:
            bits.append("the ghost stayed on the ground")
        places.append(_place(lm, d, d + max(8.0, f["length_m"]), "; ".join(bits)))
    cards.append(_card(
        "airbrake", "Air-brake and a flat landing", "In the air",
        "A tap of the brake in the air stops the car rotating, so it lands flat on all four wheels and keeps its speed. A rough landing scrubs speed or bounces.",
        ["Leave the ground as flat as you can; a clean take-off matters more than anything done in the air.",
         "If the nose starts to drop or the car tilts sideways, tap the brake briefly. It stops the rotation; it does not need a long press.",
         "Steer only enough in the air to line the car up with the landing.",
         "Touch down on all four wheels, in line with the slope, and keep the throttle down."],
        "The car stops tumbling and settles level; the speed after the landing is close to the speed before the jump.",
        ["Holding the brake the whole flight: the car loses speed for nothing.", "Landing nose-first or tail-first and then braking on the ground: too late.", "Taking off by accident: an unplanned jump nearly always costs time."],
        "Replay the first place below and compare your speed in and out of the jump with the ghost's." if places else "Nothing to drill here.",
        places, bool(places), you=sum(1 for l in landings if not l.get("clean")) or None))

    # ---------------------------------------------------------------- walls
    wplaces = [_place(lm, w["start_m"], w["end_m"], f"{w['text']}") for w in walls]
    cards.append(_card(
        "wallride", "Wall rides", "Walls and banks",
        "A wall or steep bank is a turn: the straightest line along it keeps the speed.",
        ["Approach it at the angle that lets the car climb without steering up the wall.",
         "Treat the wall like a normal corner: pick one line and hold it.",
         "Do not steer up the wall and do not try a speed drift on it: neither works on a wall.",
         "Come off at the exit and straighten the wheel."],
        "The car follows the surface and the speed holds steady all the way along.",
        ["Steering up the wall or a big slide angle: both slow the car.", "Hitting the wall at a sharp angle: a sudden drop of 20 km/h or more."],
        "Ride it again focusing only on one clean, straight line along the wall." if wplaces else "Nothing to drill here.",
        wplaces, bool(wplaces)))

    # ---------------------------------------------------------------- gear shifts
    gplaces = []
    for i in range(1, len(points)):
        a, b = points[i - 1], points[i]
        for sp in SHIFTS:
            if a["subject_speed"] < sp <= b["subject_speed"] and abs(b["subject_steer"]) >= 0.4:
                gplaces.append(_place(lm, b["distance_m"] - 5, b["distance_m"] + 15, f"you pass about {sp} km/h with the wheel turned ({abs(b['subject_steer']):.2f})"))
    cards.append(_card(
        "gearshift", "A steady wheel through gear shifts", "Every map",
        "Each automatic gear change costs a little momentum; a wheel that is moving at that moment turns it into a wobble, most of all on dirt, grass and ice.",
        ["Know the shift speeds: about 100, 160, 235 and 341 km/h.",
         "As the speed goes through one of them in a turn, hold the wheel still for a moment instead of correcting.",
         "Make the correction just before or just after, not during."],
        "A smoother car through the shift, with no small twitch in the line.",
        ["Treating it as a big gain: it is small, and speculative on grippy ground.", "Freezing the wheel for too long: only the moment of the shift."],
        "On the first place below, count the shift as it happens and keep the wheel still through it." if gplaces else "Nothing to drill here.",
        gplaces, bool(gplaces) and (loose_share >= 0.15 or icy or True)))

    # ---------------------------------------------------------------- ice and bobsleigh
    if icy and blueprint:
        for l in blueprint.get("lessons") or []:
            pl = []
            for z in sorted(blueprint["zones"], key=lambda z: -z["score"])[:MAX_PLACES]:
                if l["id"] == "line" and not (z.get("line_off_m") and abs(z["line_off_m"]) >= 1.5):
                    continue
                if l["id"] == "wiggle" and not (z.get("ref_wig_hz") and z["ref_wig_hz"] >= 1.0):
                    continue
                pl.append({"where": z["where"], "detail": z["text"].split(": ", 1)[-1], "from_m": z["from_m"], "to_m": z["to_m"], "segment": z.get("segment"), "seg_gap_ms": z.get("seg_gap_ms")})
            cards.append(_card(
                "bob_" + l["id"], l["title"], "Ice and bobsleigh", l["why"], l["steps"],
                "The car keeps its speed through the section and comes out pointing where you want.",
                ["Correcting after the fact: on ice the car has already committed.", "Copying a number without the timing: the start mark matters as much as the value."],
                l["drill"], pl, True))

    # ---------------------------------------------------------------- throttle discipline
    if player_lifts:
        lp = [_place(lm, t["dist_m"], t["dist_m"] + max(5.0, t["duration_s"] * t["speed"] / 3.6), f"you lift the throttle for {t['duration_s']:.2f} s at {t['speed']:.0f} km/h; the ghost keeps it down") for t in player_lifts]
        cards.append(_card(
            "throttle", "Keep the throttle down", "Every map",
            "A lift the ghost does not make is lost speed; on a full-speed map it is almost always a line problem, not a throttle problem.",
            ["Find the place below and look at what comes just before it: a late turn-in or a line that is too tight is what makes you lift.",
             "Take a wider, earlier entry so the corner no longer needs a lift.",
             "Keep the throttle fully down through the corner and judge the entry by the exit speed."],
            "The speed through the corner stays level instead of dipping.", ["Lifting 'to be safe': it costs speed every time.", "Fixing the lift with a brake: that scrubs even more."],
            "Drive the stretch with the throttle glued down and only change where you turn in.", lp, True))

    # ---------------------------------------------------------------- brake points
    bplaces = []
    for c in corners:
        rb = c.get("reference_brake_point_m")
        if rb is None:
            continue
        sb = c.get("subject_brake_point_m")
        secs = abs(rb) / max(5.0, entry(c) / 3.6)
        detail = f"the ghost brakes about {abs(rb):.0f} m ({secs:.1f} s) before corner {c['corner_index']}" + (f"; you brake {abs(sb):.0f} m before" if sb is not None else "; you do not brake there")
        bplaces.append(_place(lm, c["distance_start"] + rb, c["distance_start"], detail))
    cards.append(_card(
        "brakepoint", "Hit the ghost's braking point", "Tech and braking",
        "On a corner the ghost brakes for, the braking point decides how late and how hard the turn-in can be.",
        ["Pick the landmark: the place below tells you how many seconds before the corner the ghost starts braking.",
         "Brake there, firmly and in one go, then release as you turn in.",
         "Look at the exit speed, not the entry: a later brake that costs exit speed is slower overall."],
        "A calm, single braking phase and a car that is already pointing at the exit when you get back on the throttle.",
        ["Braking too early and creeping: costs time all the way down the next straight.", "Braking while steering hard on a slippery surface: the car slides wide."],
        "Drive the first corner below repeatedly, moving the brake point by a few metres until the exit speed stops improving.", bplaces, bool(bplaces)))

    # ---------------------------------------------------------------- hairpins and slides
    hair = [c for c in corners if c["turn_deg"] >= 120 and entry(c) >= 100]
    hplaces = [_place(lm, c["distance_start"], c["distance_end"], f"corner {c['corner_index']}: {c['direction']} hairpin {c['turn_deg']}°, entered at {entry(c):.0f} km/h on {corner_ground.get(c['corner_index'], 'unknown ground')}") for c in hair]
    cards.append(_card(
        "bugslide", "Bug slide into a hairpin", "Advanced cornering",
        "Sliding through a hairpin with the car turned about sideways to its path loses less speed than driving round it.",
        ["Come in fast and early with the wheel already turned.", "Throw the car sideways and hold the angle with the wheel.", "Straighten when the exit opens up and get back on the throttle."],
        "The car travels sideways through the whole turn, then snaps straight on the exit.",
        ["A sloppy one scrubs more speed than a normal turn: only worth it once the normal line is solid.", "Holding the angle too long: the exit is lost."],
        "Try it on the first hairpin below and compare your exit speed with a normal line.", hplaces, bool(hair), advanced=True))
    return cards


def _dist_of(points: list[dict], f: dict) -> float:
    """The distance along the player's lap at a flight's take-off (nearest point)."""
    best = min(points, key=lambda p: (p["x"] - f["x"]) ** 2 + (p["z"] - f["z"]) ** 2) if points else None
    return best["distance_m"] if best else 0.0


def playbook_text(cards: list[dict]) -> str:
    """Prompt lines for the coach: each applicable trick, how to do it, and where on this map."""
    live = [c for c in cards if c["applies"]]
    if not live:
        return ""
    lines = ["TRICK PLAYBOOK FOR THIS MAP (prepared from the map itself: each trick with how to do it and where to use it; explain these to the player step by step, with the places named as given):"]
    for c in live:
        lines.append(f"- {c['name']} ({c['group']}{', advanced' if c['advanced'] else ''}): {c['why']}")
        lines.extend(f"    {i}. {s}" for i, s in enumerate(c["steps"], start=1))
        lines.append(f"    Mistakes: {'; '.join(c['mistakes'])}")
        for p in c["places"][:4]:
            gap = f" [{p['segment']}: {p['seg_gap_ms'] / 1000:+.3f}s against the ghost]" if p.get("segment") and p.get("seg_gap_ms") is not None else ""
            lines.append(f"    Place: {p['where']}: {p['detail']}{gap}")
    return "\n".join(lines)


def how_to_markdown(lessons: list[dict], cards: list[dict]) -> str:
    """The `## How to do it` section, written from the measured lessons and the map's tricks (no model involved)."""
    out: list[str] = []
    for it in lessons or []:
        out.append(f"### {it['title']}")
        out.append(it["why"])
        out.extend(f"{i}. {s}" for i, s in enumerate(it["steps"], start=1))
        if it.get("yours") or it.get("theirs"):
            out.append(f"- **Numbers:** {'; '.join(x for x in (it.get('yours'), it.get('theirs')) if x)}")
        out.append(f"- **Drill:** {it['drill']}")
        out.append("")
    for c in cards or []:
        if not c.get("applies"):
            continue
        out.append(f"### {c['name']}" + (" (advanced)" if c.get("advanced") else ""))
        out.append(c["why"])
        out.extend(f"{i}. {s}" for i, s in enumerate(c["steps"], start=1))
        out.append(f"- **What it feels like:** {c['feel']}")
        out.append(f"- **Common mistakes:** {' · '.join(c['mistakes'])}")
        out.append(f"- **Drill:** {c['drill']}")
        for p in (c.get("places") or [])[:4]:
            seg = ""
            if p.get("segment"):
                seg = f" ({p['segment']}" + (f", {p['seg_gap_ms'] / 1000:+.2f} s for you" if p.get("seg_gap_ms") is not None else "") + ")"
            out.append(f"- **Use it:** {p['where']}{seg}. {p['detail']}")
        out.append("")
    return "\n".join(out).strip()


def with_how_to(text: str, lessons: list[dict], cards: list[dict]) -> str:
    """Put the prepared `## How to do it` section into the report (replacing any the model wrote), before Techniques to try."""
    import re

    body = how_to_markdown(lessons, cards)
    if not body:
        return text
    text = re.sub(r"(?ms)^##[ \t]*How to do it[ \t]*\n.*?(?=^##[ \t]|\Z)", "", text).rstrip() + "\n"
    section = "## How to do it\n" + body + "\n\n"
    m = re.search(r"(?m)^##[ \t]*Techniques to try", text)
    if m:
        return text[:m.start()] + section + text[m.start():]
    m = re.search(r"(?m)^##[ \t]*Map character", text)
    if m:
        return text[:m.start()] + section + text[m.start():]
    return text.rstrip() + "\n\n" + section.rstrip() + "\n"
