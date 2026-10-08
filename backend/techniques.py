"""Trackmania technique knowledge for the AI coach.

TECHNIQUE_CORE is sent with every analysis; the style guides are added only for
the map styles detected for the run (from ManiaExchange tags, or from the
ghost's own telemetry when there are no useful tags). Each technique lists the
telemetry signal that points to it (see signals.py), so the coach connects
what was measured to what a Trackmania coach would call it.
"""

from __future__ import annotations

TECHNIQUE_CORE = """\
TRACKMANIA TECHNIQUES (use these exact terms; the telemetry signals that point to each are listed)
- Speed drift / speedslide: on a grippy surface (asphalt, concrete) and above about
  180 km/h, steer into the corner and hold the brake for roughly half a second to
  start a slide; the car then slides sideways and keeps its speed far better than
  turning with plain steering. If speed falls below ~180 km/h it stops working. A
  brake-initiated speedslide is often called an S4D. It does NOT work on dirt, grass
  or ice. It can also be started over banking changes or short airtime gaps.
  Signal: "BRAKE TAPS WHILE STEERING HARD AT 180+ km/h" - a ghost-only tap at a
  corner means the ghost probably slid it. A long brake hold, or one below 180
  km/h, is ordinary braking, not a drift.
- Airbrake: pressing the brake while airborne stops the car's rotation so it
  lands flat on all four wheels, which cushions the landing and keeps speed. Use
  it when the car would otherwise land nose-first, tail-first or on one side.
  Signal: JUMPS - compare "braked N s in the air" and the km/h lost across the
  flight. A bigger loss than the ghost's, with the ghost air-braking, is the tell.
- Landing: land flat and in line with the slope, steering in the air only enough
  to line up the landing. A rough landing scrubs speed and can bounce or start an
  unwanted slide. Easing off before a steep rise or wall avoids catching air at
  the top; a flight the ghost does not have usually costs time.
- Diagonal driving on downslopes keeps the wheels on the surface and is faster
  than driving straight down; staying centred on sausage/curved blocks avoids
  floating between their tops.
- Gear shifts (automatic, roughly at 100, 160, 235 and 341 km/h): a shift costs a
  little momentum, so hold a steady steering input through it, especially on
  dirt, grass and ice. Treat it as a small, speculative gain.
- Wallrides: treat the wall as a turn and take the straightest line; steering up
  the wall or a large slide angle slows the car, and speedslides do not work on
  walls.
- Bugslide: sliding into a hairpin at close to 90 degrees to lose little speed.
  Advanced; offer it only for hairpins and strong players.
- Nosebug and uberbug are exotic tricks for specific blocks and Kacky-style maps.
  Telemetry cannot show them. Mention only as a last-resort hypothesis.
- Throttle: on full-speed maps the throttle stays down, so a lift the ghost does
  not make is a loss. Braking mostly scrubs speed; strong players brake only to
  rotate the car, start a slide or hit a precise line.
- Boosters, turbos and reactors give sudden speed jumps; hitting them earlier or
  more squarely is a measurable gain.
- Lines: cutting inside shortens the distance, going wide keeps more speed. Exit
  speed beats entry speed because it carries down the next straight.

SIGNAL -> LIKELY CAUSE -> WHAT TO TRY
- Ghost's minimum speed in a corner is higher, it does not brake there, steering is
  similar: an earlier, straighter, wider entry so the apex is less sharp; stay off
  the brake.
- Ghost's minimum speed is higher AND it tapped the brake while steering hard above
  180 km/h: a speed drift (grippy surface only). Try the brake tap at the same spot.
- Player steers more, with more reversals, and exits slower: an over-steered,
  corrected arc. Fewer, larger, earlier inputs (keyboard: commit to the hold).
- Player brakes where the ghost does not: it is scrubbing speed; lift earlier or
  take a wider entry instead.
- A flight where the player lost much more speed than the ghost: airbrake and a
  flatter landing; check the take-off speed and angle.
- A flight only the player has: an earlier lift or a different line before the
  rise keeps the car on the ground.
- Player lifted off the throttle where the ghost did not (full-speed maps): hold
  the throttle; the corner needs a different line, not a lift.
- Same minimum speed but a slower exit: throttle or steering applied too late;
  straighten the car earlier so the throttle is fully available out of the corner.
"""

STYLE_GUIDES = {
    "fullspeed": """\
THIS IS A FULL-SPEED (FS) STYLE MAP
- The throttle is held for the whole map; braking is rare and mostly used to start
  a speed drift. Time is won with precision: tiny steering inputs, clean speed
  drifts and wallrides taken on the straightest line, and flat landings.
- Judge the player by how much steering and braking they use compared with the
  ghost. Any throttle lift or long brake is almost certainly a loss here.
""",
    "tech": """\
THIS IS A TECH STYLE MAP
- Braking, rotation and precision decide it: brake point, how well the car is
  rotated into the corner, and exit speed. A lower speed in the middle of a corner
  is fine if the exit is faster. Compare brake points (metres before the corner)
  and where the ghost starts steering.
""",
    "ice": """\
THIS IS AN ICE STYLE MAP
- Ice has very little grip: steering inputs build a slide slowly, braking does
  little and can unsettle the car, and speed drifts do not work. Win with early,
  small, steady inputs and long committed arcs; reversals and corrections cost a
  lot. Compare steering amount and reversals first.
""",
    "bobsleigh": """\
THIS IS A BOBSLEIGH STYLE MAP (the Bobsleigh tag is used for maps built from ice road blocks)
- Treat it like ice: very low grip, so plan far ahead, steer early and gently, hold
  a line instead of correcting, and avoid braking. Use the banking and walls of the
  run to turn rather than the steering. Smooth, repeatable lines beat late
  corrections; the best sign of progress is fewer steering reversals at the same
  speed.
""",
    "dirt": """\
THIS IS A DIRT STYLE MAP
- Dirt grips moderately and the car slides on its own; speed drifts do not work.
  Keep the throttle down, steer smoothly, avoid braking (it scrubs more here), and
  keep the steering steady through gear shifts. Compare how much the ghost steers
  and where it lifts.
""",
    "grass": """\
THIS IS A GRASS STYLE MAP
- Grass has little grip and slows the car; speed drifts do not work. Keep inputs
  small and smooth, avoid scrubbing speed with big steering, and hold steering
  steady through gear shifts.
""",
    "rpg": """\
THIS IS AN RPG / TRIAL STYLE MAP
- Precision, landings and consistency matter more than raw speed. Jumps and
  obstacles dominate: judge by the flights and landings, and favour a clean,
  repeatable line over a risky fast one.
""",
}

# (style, tag words). A long word matches inside a tag ("fullspeed" in "FullSpeed
# Tech"); a short one must match the whole tag so "ice" doesn't match "police".
_TAG_STYLES = (
    ("fullspeed", ("fullspeed", "full speed", "speedfun", "speed fun")),
    ("tech", ("tech", "speedtech")),
    ("ice", ("ice",)),
    ("bobsleigh", ("bobsleigh", "bob")),
    ("dirt", ("dirt",)),
    ("grass", ("grass",)),
    ("rpg", ("rpg", "trial", "kacky", "lol", "obstacle")),
)


def detect_styles(tags: list[str] | None, features: dict | None) -> list[tuple[str, str]]:
    """Map styles for this run as (style, why). Tags from ManiaExchange come
    first; with no useful tags the ghost's own telemetry decides."""
    found: list[tuple[str, str]] = []
    seen: set[str] = set()
    lowered = [t.lower() for t in (tags or [])]
    for style, needles in _TAG_STYLES:
        for t in lowered:
            if any(n == t or (len(n) > 4 and n in t) for n in needles):
                if style not in seen:
                    found.append((style, f"tag '{t}'"))
                    seen.add(style)
                break
    if "bobsleigh" in seen and "ice" not in seen:
        found.append(("ice", "Bobsleigh maps are ice"))
        seen.add("ice")
    f = features or {}
    if not seen and f:
        brake_pct = f.get("brake_pct", 0.0)
        avg = f.get("avg_speed", 0.0)
        if brake_pct < 1.0 and avg > 250:
            found.append(("fullspeed", f"no useful tags; the ghost almost never brakes ({brake_pct:.1f}%) and averages {avg:.0f} km/h"))
        elif brake_pct > 6.0 or avg < 130:
            found.append(("tech", f"no useful tags; the ghost brakes {brake_pct:.1f}% of the run and averages {avg:.0f} km/h"))
    return found


def style_text(styles: list[tuple[str, str]]) -> str:
    if not styles:
        return "DETECTED MAP STYLE: unknown (no useful tags and the telemetry doesn't settle it) - don't assume a surface."
    return "DETECTED MAP STYLE: " + "; ".join(f"{s} ({why})" for s, why in styles) + "."


def technique_guide(styles: list[tuple[str, str]] | None = None) -> str:
    """The technique knowledge relevant to this map."""
    parts = [TECHNIQUE_CORE]
    for style, _why in styles or []:
        guide = STYLE_GUIDES.get(style)
        if guide:
            parts.append(guide)
    return "\n\n".join(parts)
