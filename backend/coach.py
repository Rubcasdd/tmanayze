"""Builds the AI coach's prompt from a comparison, and the small "memory"
record the browser keeps between sessions so the coach can say whether the
player improved on what it flagged last time.

Nothing here is stored server-side (the server is stateless); the memory
travels with the request and comes back in the response.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone


_TM_CODES = [
    (re.compile(r"\$[lh]\[[^\]]*\]", re.I), ""),
    (re.compile(r"\$[0-9a-f]{3}", re.I), ""),
    (re.compile(r"\$[lhoiswntgz<>]", re.I), ""),
    (re.compile(r"\$\$"), "$"),
]


def _clean(name: str | None) -> str:
    """Strip Trackmania's in-game formatting codes ($FFF, $O, ...) from a name."""
    text = name or ""
    for pattern, repl in _TM_CODES:
        text = pattern.sub(repl, text)
    return text.strip()


def _more_less(player: float, ghost: float, rel: float = 0.15, floor: float = 0.0) -> str:
    """Word for how the player's value compares with the ghost's, so the model
    never has to work out the direction (and get it backwards)."""
    margin = max(abs(ghost) * rel, floor)
    if player > ghost + margin:
        return "player more"
    if player < ghost - margin:
        return "player less"
    return "similar"


def _speed_word(player: float, ghost: float) -> str:
    diff = player - ghost
    if abs(diff) < 2:
        return "same"
    return f"player {abs(diff):.0f} km/h {'faster' if diff > 0 else 'slower'}"


# How much the AI is asked for, and how much room it gets to think and write.
DEPTHS = {
    "concise": {"label": "Concise", "max_tokens": 5000, "reasoning_budget": 1000, "focus_count": 3, "walkthrough": None, "plan": False},
    "detailed": {"label": "Detailed", "max_tokens": 9000, "reasoning_budget": 1500, "focus_count": 5, "walkthrough": 3, "plan": True},
    "deep": {"label": "Very detailed", "max_tokens": 12000, "reasoning_budget": 2000, "focus_count": 6, "walkthrough": "all", "plan": True},
}
DEFAULT_DEPTH = "detailed"


def depth_config(depth: str | None) -> dict:
    return DEPTHS.get(depth or "", DEPTHS[DEFAULT_DEPTH])


def _secs(ms) -> str:
    return f"{ms / 1000:.2f}s" if isinstance(ms, (int, float)) else "n/a"


def _signed_secs(ms) -> str:
    if not isinstance(ms, (int, float)):
        return "n/a"
    return "0.00s" if abs(ms) < 5 else f"{ms / 1000:+.2f}s"


def _verb(ms: float) -> str:
    return "lost" if ms > 0 else ("gained" if ms < 0 else "even")


def _brake_text(c: dict) -> str:
    sb, rb = c.get("subject_brake_point_m"), c.get("reference_brake_point_m")
    if sb is None and rb is None:
        return "neither braked"
    if sb is None:
        return f"ghost braked {abs(rb):.0f}m before it, player did not brake"
    if rb is None:
        return f"player braked {abs(sb):.0f}m before it, ghost did not brake"
    off = sb - rb
    if abs(off) < 2:
        return "both began braking at about the same point"
    return f"player began braking {abs(off):.0f}m {'later' if off > 0 else 'earlier'} than the ghost"


def _corner_line(c: dict) -> str:
    return (
        f"Corner {c['corner_index']} - {c['direction']}, {c['turn_deg']} deg turn, "
        f"{c['distance_start']:.0f}-{c['distance_end']:.0f}m: {_verb(c['time_change_ms'])} "
        f"{abs(c['time_change_ms'])}ms | speed in/min/out player "
        f"{c['subject_entry_speed']:.0f}/{c['subject_min_speed']:.0f}/{c['subject_exit_speed']:.0f} vs ghost "
        f"{c['reference_entry_speed']:.0f}/{c['reference_min_speed']:.0f}/{c['reference_exit_speed']:.0f} km/h "
        f"(min speed: {_speed_word(c['subject_min_speed'], c['reference_min_speed'])}) | "
        f"{_brake_text(c)} | steering avg {c['subject_avg_steer']:.2f} vs {c['reference_avg_steer']:.2f} "
        f"({_more_less(c['subject_avg_steer'], c['reference_avg_steer'], 0.15, 0.03)}), reversals "
        f"{c['subject_steer_reversals']} vs {c['reference_steer_reversals']} "
        f"({_more_less(c['subject_steer_reversals'], c['reference_steer_reversals'], 0.0, 0.5)})"
    )


def _section_line(s: dict) -> str:
    corners = ", ".join(str(i) for i in s["corner_indices"]) or "none"
    return (
        f"Section {s['index']} ({s['distance_start']:.0f}-{s['distance_end']:.0f}m): "
        f"{_verb(s['time_change_ms'])} {abs(s['time_change_ms'])}ms | avg speed "
        f"{s['subject_avg_speed']:.0f} vs {s['reference_avg_speed']:.0f} km/h "
        f"({_speed_word(s['subject_avg_speed'], s['reference_avg_speed'])}), slowest point "
        f"{s['subject_min_speed']:.0f} vs {s['reference_min_speed']:.0f} | steering avg "
        f"{s['subject_avg_steer']:.2f} vs {s['reference_avg_steer']:.2f} "
        f"({_more_less(s['subject_avg_steer'], s['reference_avg_steer'], 0.15, 0.03)}), reversals "
        f"{s['subject_steer_reversals']} vs {s['reference_steer_reversals']} "
        f"({_more_less(s['subject_steer_reversals'], s['reference_steer_reversals'], 0.0, 0.5)}) | brake events "
        f"{s['subject_brake_events']} vs {s['reference_brake_events']} | contains corners: {corners}"
    )


def _world_text(insights: dict | None, player_time_ms, ref_time_ms, ref_world_position) -> str:
    lines = []
    if ref_world_position:
        lines.append(
            f"The reference ghost is the #{ref_world_position} time on the world leaderboard"
            + (f" ({_secs(ref_time_ms)})." if ref_time_ms else ".")
        )
    if not insights:
        return "\n".join(lines)
    m = insights.get("map")
    if m:
        lines.append(
            f"Map (ManiaExchange): tags {', '.join(m.get('tags') or []) or 'none'}, difficulty rating "
            f"{m.get('difficulty')}, authors {', '.join(_clean(a) for a in m.get('authors') or [])}, {m.get('award_count')} awards."
        )
    top = insights.get("world_leaderboard_top") or []
    if top and top[0].get("time_ms") and player_time_ms:
        wr = top[0]["time_ms"]
        pct = (player_time_ms - wr) / wr * 100
        lines.append(
            f"World record: {_secs(wr)} by {_clean(top[0].get('player_name'))}. The player's time is "
            f"{abs(pct):.1f}% {'slower' if pct > 0 else 'faster'} than the world record, i.e. "
            f"{abs(player_time_ms - wr) / 1000:.2f}s {'BEHIND' if pct > 0 else 'AHEAD OF'} it."
        )
    pos = insights.get("player_world_position")
    if pos:
        if pos.get("exact"):
            lines.append(f"World leaderboard position for the player's time: #{pos['position']}.")
        else:
            lines.append(
                f"The player's time is outside the top {pos.get('nth_place')} of the world leaderboard "
                f"({_secs(pos.get('gap_to_nth_ms'))} behind #{pos.get('nth_place')})."
            )
    zone = insights.get("player_zone")
    if zone:
        ranks = "; ".join(f"{z['name']} #{z['rank']}" for z in zone.get("zones", []) if z.get("rank") is not None)
        points = f", {zone['trophy_points']:,} trophy points" if zone.get("trophy_points") is not None else ""
        lines.append(f"Player profile: {_clean(zone.get('name'))}{points}. Trophy-based standing: {ranks}.")
    return "\n".join(lines)


def describe_previous(previous: dict | None) -> str:
    if not previous:
        return ""
    when = "earlier"
    try:
        saved = datetime.fromisoformat(previous["saved_at"].replace("Z", "+00:00"))
        days = (datetime.now(timezone.utc) - saved).days
        when = "earlier today" if days <= 0 else f"{days} day{'s' if days != 1 else ''} ago"
    except (KeyError, ValueError, AttributeError):
        pass

    lines = [
        f"PREVIOUS COACHING SESSION ({when}) on this map: the player finished in "
        f"{_secs(previous.get('subject_time_ms'))}, {_signed_secs(previous.get('final_delta_ms'))} vs "
        f"{previous.get('reference_label') or 'the ghost'} ({_secs(previous.get('reference_time_ms'))})."
    ]
    worst = previous.get("worst_corners") or []
    if worst:
        lines.append("Corners that cost the most then (distances are approximate, corner numbers may have shifted):")
        for c in worst:
            lines.append(
                f"- {c['direction']} corner at {c['distance_start']:.0f}-{c['distance_end']:.0f}m: "
                f"{_verb(c['time_change_ms'])} {abs(c['time_change_ms'])}ms"
            )
    if previous.get("tips"):
        lines.append("Advice given then:")
        lines.extend(f"- {t}" for t in previous["tips"])
    return "\n".join(lines)


def focus_text(focus: dict | None) -> str:
    if not focus:
        return ""
    lines = []
    items = focus.get("focus") or []
    if items:
        lines.append(
            "PRE-RANKED FOCUS CANDIDATES (measured by the app, most time first - build your focus areas from these):"
        )
        for it in items:
            lines.append(f"{it['rank']}. {it['title']} - " + "; ".join(it["evidence"]))
    else:
        lines.append(
            "PRE-RANKED FOCUS CANDIDATES: no single stretch loses a meaningful amount of time, so the player is "
            "already very close to the ghost - say so, and focus on where the remaining hundredths are."
        )
    strengths = focus.get("strengths") or []
    if strengths:
        lines.append("ALREADY WORKING (mention these so the player keeps doing them):")
        lines.extend(f"- {it['title']} - " + "; ".join(it["evidence"]) for it in strengths)
    return "\n".join(lines)


def corner_context_text(corners: list[dict], surfaces: dict[int, str] | None) -> str:
    """For each corner: what it is driven on, how fast it is entered, and what that allows."""
    from . import surface as surf

    if not corners:
        return ""
    lines = [
        "CORNER CONTEXT (surface measured from the map's blocks, so approximate; entry speed is the player's):"
    ]
    for c in corners:
        s = (surfaces or {}).get(c["corner_index"], "unknown")
        entry = c["subject_entry_speed"]
        drift = s in surf.DRIFT_SURFACES and entry >= 180
        if s == "unknown":
            verdict = "surface unknown"
        elif drift:
            verdict = "a speed drift is possible here"
        elif s not in surf.DRIFT_SURFACES:
            verdict = "no speed drift on this surface"
        else:
            verdict = "too slow for a speed drift"
        lines.append(
            f"- Corner {c['corner_index']} ({c['direction']} {c['turn_deg']} deg, {c['distance_start']:.0f}-{c['distance_end']:.0f}m): "
            f"{surf.LABELS.get(s, s)}; entered at {entry:.0f} km/h ({surf.band(entry)}); {surf.GRIP.get(s, '')}; {verdict}."
        )
    return "\n".join(lines)


def input_scripts_text(corners: list[dict], wanted: list[int]) -> str:
    """The steering/brake/lift script of the player and the ghost through the corners that matter."""
    from . import inputs as inp

    by_index = {c["corner_index"]: c for c in corners}
    lines = ["INPUT SCRIPTS (what was pressed, in metres from each corner's start; steering positive = right):"]
    n = 0
    for idx in wanted:
        c = by_index.get(idx)
        if not c or "phases" not in c or "inputs" not in c["phases"]:
            continue
        i = c["phases"]["inputs"]
        lines.append(f"- Corner {idx}: ghost: {inp.describe(i['reference'])}. Player: {inp.describe(i['subject'])}.")
        n += 1
    return "\n".join(lines) if n else ""


def figures_text(corners: list[dict]) -> str:
    """The pictures the report can include."""
    lines = [
        "FIGURES YOU CAN INCLUDE (each is a picture of that corner showing the player's line and the ghost's, the brake / "
        "turn-in / apex / exit points, distance ticks, the surface and the input timeline). Put "
        "{{figure:corner=N}} on its own line right after the bullets of the focus area it illustrates, for the corners "
        "that matter most (two to four) and nowhere else; each at most once:"
    ]
    for c in corners:
        lines.append(f"- {{{{figure:corner={c['corner_index']}}}}}: corner {c['corner_index']}, {c['direction']} {c['turn_deg']} deg at "
                     f"{c['distance_start']:.0f}-{c['distance_end']:.0f}m, {_signed_secs(c['time_change_ms'])}")
    return "\n".join(lines)


def _format_instructions(insights: dict | None, previous: dict | None, telemetry: bool, depth: str, figures: bool = False) -> str:
    cfg = depth_config(depth)
    has_world = bool(insights and (insights.get("player_world_position") or insights.get("player_zone") or insights.get("world_leaderboard_top")))

    headings = ["Top focus areas"]
    if telemetry:
        headings.append("Steering comparison")
        headings.append("Techniques to try")
    headings.append("Map character")
    if telemetry and cfg["walkthrough"]:
        headings.append("Section-by-section")
    if telemetry and cfg["plan"]:
        headings.append("Practice plan")
    headings.append("Skill assessment")
    if has_world:
        headings.append("Where they stand")
    if previous:
        headings.append("Progress since last time")
    listed = ", ".join(f"`## {h}`" for h in headings)

    n = cfg["focus_count"]
    detail = {
        "concise": "Keep every bullet to one tight sentence.",
        "detailed": "Be thorough: two to four sentences per bullet where the data supports it.",
        "deep": "Be exhaustive: explain the reasoning behind each recommendation and use the data generously.",
    }.get(depth if depth in DEPTHS else DEFAULT_DEPTH)

    parts = [
        f"\nWrite the coaching report now using exactly these markdown headings, in this order, and no others: {listed}.",
        "What each section must contain:",
        f"- `## Top focus areas`: up to {n} ranked focus areas, most time first"
        + (", built from the PRE-RANKED FOCUS CANDIDATES above: one focus area per candidate, in their order, never more areas "
           "than there are candidates, and never repeat, merge or invent one (if there are only two candidates, write two). "
           "The ALREADY WORKING items are not focus areas: mention them as strengths elsewhere." if telemetry else
           ", kept general because there is no per-tick data - say so.")
        + " Each is a `### ` heading with a short imperative title (for example \"Carry more speed through the hairpin at 1882-2032 m\"), "
        "followed by three bullets: **Evidence** (the measured numbers), **What to change** (one or two concrete, testable things "
        "to try, suited to the player's input device; name the technique or mechanism, never just \"go faster\"; a speed drift, "
        "airbrake or landing fix only where the TECHNIQUE FINDINGS list one at that place) and "
        "**Expected payoff** (the time at stake - call it an upper bound; also say what number to look for in the next replay). "
        "If the player is already ahead of the ghost, focus on where they could extend the lead.",
    ]
    if figures:
        parts.append(
            "Pictures are part of the report: whenever a focus area is about a corner listed under FIGURES YOU CAN INCLUDE, "
            "finish it with that corner's tag, e.g. {{figure:corner=10}}, alone on the line after the **Expected payoff** bullet "
            "(write the tag exactly, with the double curly braces). Use the corner number from the list, include a picture for every focus area that is a corner "
            "(two to four in total), and never a tag for a focus area that is a straight or section with no listed corner."
        )
    if telemetry:
        parts.append(
            "- `## Steering comparison`: how the player's steering differs from the ghost's overall and in the key sections "
            "(amount, full-lock time, reversals, smoothness, input device) and what it costs or gains."
        )
    if telemetry:
        parts.append(
            "- `## Techniques to try`: built ONLY from the TECHNIQUE FINDINGS above, one `### ` sub-heading per finding (the "
            "technique's name), each with bullets for **Where** (distance), **Signal** (quote the finding's numbers exactly; "
            "do not mix up different jumps or corners), **How to practise** and **Certainty** (measured, or hypothesis when the "
            "technique is inferred). Never recommend a technique that is not in the findings, and never put a speed drift on a "
            "straight. If the findings say there are none, write two sentences saying the time is in the line and the inputs."
        )
    parts.append("- `## Map character`: what kind of map this is, from the tags and the telemetry, and what matters most on it.")
    if telemetry and cfg["walkthrough"]:
        which = "every section" if cfg["walkthrough"] == "all" else f"the {cfg['walkthrough']} sections that matter most"
        parts.append(
            f"- `## Section-by-section`: for {which}, two or three sentences on what the ghost does differently there "
            "(from the numbers) and what to do about it."
        )
    if telemetry and cfg["plan"]:
        parts.append(
            "- `## Practice plan`: three short drills for the next session, each tied to a focus area, with exactly what to "
            "watch for in the next replay."
        )
    parts.append("- `## Skill assessment`: a skill level with confidence and reasons.")
    if has_world:
        parts.append("- `## Where they stand`: how the time compares to the world record, the leaderboard and the zone.")
    if previous:
        parts.append("- `## Progress since last time`: whether the earlier problem stretches improved, plainly, including if they did not.")
    parts.append(detail)
    return "\n".join(parts)


def build_user_prompt(
    *,
    map_name: str | None,
    subject_label: str,
    reference_label: str,
    stats: dict,
    sample_points: list[dict],
    corners: list[dict],
    sections: list[dict],
    history: dict,
    insights: dict | None,
    previous: dict | None,
    reference_world_position: int | None = None,
    focus: dict | None = None,
    depth: str = DEFAULT_DEPTH,
    signals: str = "",
    style_line: str = "",
    surface_text: str = "",
    inputs_text: str = "",
    figures: str = "",
) -> str:
    subject_label, reference_label = _clean(subject_label), _clean(reference_label)
    out: list[str] = []
    out.append(f"MAP: {map_name or 'unknown'}")
    if style_line:
        out.append(style_line)
    out.append(f'PLAYER RUN: "{subject_label}"   REFERENCE GHOST: "{reference_label}"')
    gap = stats.get("final_delta_ms")
    out.append(
        f"RESULT: player {_secs(stats.get('subject_race_time_ms'))} vs ghost "
        f"{_secs(stats.get('reference_race_time_ms'))} - "
        + (f"{_secs(abs(gap))} {'behind' if gap > 0 else 'ahead'} at the finish." if gap is not None else "gap unknown.")
    )
    out.append(
        f"PLAYER HISTORY ON THIS MAP: {history.get('num_runs', 0)} recorded run(s); best {_secs(history.get('best_ms'))}, "
        f"latest {_secs(history.get('latest_ms'))}, slowest {_secs(history.get('worst_ms'))}."
    )
    world = _world_text(
        insights, stats.get("subject_race_time_ms"), stats.get("reference_race_time_ms"), reference_world_position,
    )
    if world:
        out.append(world)
    prev = describe_previous(previous)
    if prev:
        out.append("\n" + prev)

    if not stats.get("telemetry"):
        out.append(
            "\nNo per-tick telemetry is available for this comparison, so there is no steering, corner or "
            "section data. Base the analysis on the time gap and the context above, say plainly that it is "
            "general rather than location-specific, and do not invent corner details."
        )
        out.append(_format_instructions(insights, previous, False, depth))
        return "\n".join(out)

    if stats.get("alignment_poor"):
        out.append(
            f"\nWARNING: the two runs follow noticeably different routes (path length ratio "
            f"{stats['path_length_ratio']}, 90th-percentile distance between matched points "
            f"{stats['alignment_p90_m']}m) - likely a different map version or a big detour. Section and corner "
            "numbers are unreliable; say so and keep to high-level advice."
        )

    out.append(
        "\nWHOLE-RUN MEASUREMENTS (player vs ghost):\n"
        f"- Average / top speed: {stats['subject_avg_speed']:.0f} / {stats['subject_top_speed']:.0f} vs "
        f"{stats['reference_avg_speed']:.0f} / {stats['reference_top_speed']:.0f} km/h\n"
        f"- Steering: average {stats['subject_avg_abs_steer']:.2f} vs {stats['reference_avg_abs_steer']:.2f}, "
        f"left/right reversals {stats['subject_steer_reversals']} vs {stats['reference_steer_reversals']}, "
        f"time at full lock {stats['subject_full_lock_fraction'] * 100:.0f}% vs {stats['reference_full_lock_fraction'] * 100:.0f}%\n"
        f"- Estimated input device: player {stats['subject_input_style']}, ghost {stats['reference_input_style']}\n"
        f"- Brake events: {stats['subject_brake_events']} vs {stats['reference_brake_events']}; "
        f"full-throttle time {stats['subject_full_throttle_fraction'] * 100:.0f}% vs {stats['reference_full_throttle_fraction'] * 100:.0f}%\n"
        f"- {stats['corner_count']} corners detected, covering {stats['corner_track_pct']}% of the track. "
        f"Of the {_signed_secs(gap)} total gap, {_signed_secs(stats['corner_time_change_ms'])} came inside corners "
        f"and {_signed_secs(stats['straight_time_change_ms'])} on the stretches between them.\n"
        f"- Biggest single deficit: {_signed_secs(stats['max_time_lost_ms'])} at {stats['max_time_lost_at_pct']}% of the run; "
        f"biggest single lead: {_signed_secs(stats['max_time_gained_ms'])} at {stats['max_time_gained_at_pct']}%"
    )

    if surface_text:
        out.append("\n" + surface_text)
    if inputs_text:
        out.append("\n" + inputs_text)
    if figures:
        out.append("\n" + figures)

    if signals:
        out.append(
            "\nTECHNIQUE SIGNALS (measured from the raw telemetry; they say what each run DID, "
            "the technique behind it is your interpretation - see the technique reference):\n" + signals
        )

    focus_block = focus_text(focus)
    if focus_block:
        out.append("\n" + focus_block)

    if sections:
        out.append("\nTRACK SECTIONS (equal-distance slices, track order):")
        out.extend(_section_line(s) for s in sections)

    if corners:
        ranked = sorted(corners, key=lambda c: -abs(c["time_change_ms"]))[:6]
        out.append(
            "\nBIGGEST CORNER TIME SWINGS: "
            + "; ".join(
                f"corner {c['corner_index']} ({c['direction']}, {c['distance_start']:.0f}-{c['distance_end']:.0f}m) "
                f"{_verb(c['time_change_ms'])} {abs(c['time_change_ms'])}ms"
                for c in ranked
            )
        )
        out.append("\nALL CORNERS (track order):")
        out.extend(_corner_line(c) for c in corners)

    if sample_points:
        out.append("\nSAMPLED TRACE (distance | gap vs ghost | speed player vs ghost | steering player vs ghost):")
        for p in sample_points:
            out.append(
                f"{p['distance_m']:6.0f}m | {p['delta_ms']:+6d}ms | {p['subject_speed']:5.0f} vs {p['reference_speed']:5.0f} km/h | "
                f"{p['subject_steer']:+.2f} vs {p['reference_steer']:+.2f}"
            )

    out.append(_format_instructions(insights, previous, True, depth, figures=bool(figures)))
    return "\n".join(out)


def build_memory(
    *, stats: dict, corners: list[dict], sections: list[dict], analysis_text: str,
    reference_label: str, now: datetime | None = None,
) -> dict:
    """What to remember about this session: enough to tell next time whether
    the flagged stretches improved, without keeping the whole report."""
    worst = sorted(corners, key=lambda c: -c["time_change_ms"])[:4]
    worst = [c for c in worst if c["time_change_ms"] > 0]
    tips: list[str] = []
    in_focus = False
    for line in analysis_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("##") and not stripped.startswith("###"):
            in_focus = "focus" in stripped.lower()
            continue
        if in_focus and stripped.startswith("###") and len(tips) < 4:
            tips.append(re.sub(r"\*\*|__", "", stripped.lstrip("#").strip())[:200])
    return {
        "saved_at": (now or datetime.now(timezone.utc)).isoformat(),
        "subject_time_ms": stats.get("subject_race_time_ms"),
        "reference_label": reference_label,
        "reference_time_ms": stats.get("reference_race_time_ms"),
        "final_delta_ms": stats.get("final_delta_ms"),
        "worst_corners": [
            {k: c[k] for k in ("direction", "distance_start", "distance_end", "time_change_ms")} for c in worst
        ],
        "tips": tips,
    }


# The heading must be alone on its line: the model's leaked reasoning often
# mentions a heading name mid-sentence ("## Skill assessment`: skill level...").
_FIRST_HEADING = re.compile(
    r"##[ \t]*(?:Top focus areas|Steering comparison|Map character|Skill assessment)[ \t]*:?[ \t]*(?:\r?\n|$)",
    re.I,
)


def clean_report(text: str) -> str:
    """Reasoning models sometimes emit their working before the answer. The
    report always starts at one of its required headings, so drop anything
    before the earliest one."""
    m = _FIRST_HEADING.search(text)
    if not m:
        return text.strip()
    return text[m.start():].strip()
