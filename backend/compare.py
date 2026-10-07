"""Compare two parsed runs on the same map.

The runs are aligned by nearest position along the track (not by raw time
index, since total lap times differ). From that alignment this derives:

* a downsampled whole-track trace (speed, steering, time delta),
* corner-by-corner stats (where the reference actually turns), and
* equal-distance track sections with full-resolution traces,

plus aggregate stats. Charts, the corner table and the AI prompt are all
built from these, so they always agree with each other.

Speeds are km/h (the parser converts from m/s). Steering is -1..1 where
positive is right. The horizontal plane is (x, z); y is up.
"""

from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field

DOWNSAMPLE_POINTS = 700
SECTION_POINTS = 320
SECTION_TARGET_M = 450.0

# Corner detection. A corner is a stretch of the *reference's own path* where
# its heading changes by more than CORNER_ENTER_CURVATURE degrees per metre
# (roughly a radius under ~95 m), measured over a +/-CURVATURE_WINDOW_M
# window and computed from the path itself rather than from steering input —
# steering is noisy (physics corrections, keyboard on/off) even on a straight.
# Hysteresis (ENTER vs EXIT) keeps one corner from being chopped into several
# at the threshold; MIN_SPAN_M drops flicks; MERGE_GAP_M joins chicanes.
# Tuned on a twisty ice map (~16 corners) and a mostly straight fullspeed map
# (~5), checking that steering is clearly higher inside detected corners.
CORNER_ENTER_CURVATURE = 0.6  # deg/m
CORNER_EXIT_CURVATURE = 0.3   # deg/m
CURVATURE_WINDOW_M = 3.0
HEADING_BASELINE_M = 1.5
CORNER_MIN_SPAN_M = 4.0
CORNER_MERGE_GAP_M = 8.0
BRAKE_LOOKBACK_M = 40.0
STEER_DEADZONE = 0.08
DIGITAL_INTERMEDIATE_MAX = 0.06


@dataclass
class ComparisonResult:
    points: list[dict]
    stats: dict
    corners: list[dict] = field(default_factory=list)
    sections: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------- geometry

def _dist3(a: dict, b: dict) -> float:
    return math.dist((a["x"], a["y"], a["z"]), (b["x"], b["y"], b["z"]))


def _cumulative_distance(samples: list[dict]) -> list[float]:
    cum = [0.0] * len(samples)
    for i in range(1, len(samples)):
        cum[i] = cum[i - 1] + _dist3(samples[i - 1], samples[i])
    return cum


def _wrap180(angle_deg: float) -> float:
    while angle_deg > 180:
        angle_deg -= 360
    while angle_deg < -180:
        angle_deg += 360
    return angle_deg


def _nearest_forward(subject: list[dict], reference: list[dict]) -> list[int]:
    """For each subject sample, the index of the nearest reference sample.

    Both lists are time-ordered and a driver never really goes backwards
    along the route, so a pointer into `reference` only moves forward —
    O(n+m) instead of O(n*m), and it handles runs of different lengths.
    The result is therefore non-decreasing.
    """
    matches: list[int] = []
    j = 0
    n = len(reference)
    for s in subject:
        best_j = j
        best_d = _dist3(s, reference[j])
        k = j
        while k + 1 < n:
            d = _dist3(s, reference[k + 1])
            if d <= best_d:
                best_d = d
                best_j = k + 1
                k += 1
            elif k - j > 200:
                break
            else:
                k += 1
                if d > best_d * 3 and k - best_j > 30:
                    break
        j = best_j
        matches.append(best_j)
    return matches


def _interpolate_on_reference(point: dict, ref: list[dict], j: int) -> tuple[float, float, float]:
    """Refine a nearest-sample match to a position *between* reference
    samples: project the point onto the two segments touching sample j and
    take the closer one. Returns (reference_time_ms, reference_speed,
    distance_to_path_m). Without this the time delta only moves in whole
    sample steps (50 ms), which draws as a staircase."""
    best = None
    for a, b in ((j - 1, j), (j, j + 1)):
        if a < 0 or b >= len(ref):
            continue
        A, B = ref[a], ref[b]
        abx, aby, abz = B["x"] - A["x"], B["y"] - A["y"], B["z"] - A["z"]
        denom = abx * abx + aby * aby + abz * abz
        if denom < 1e-9:
            continue
        t = ((point["x"] - A["x"]) * abx + (point["y"] - A["y"]) * aby + (point["z"] - A["z"]) * abz) / denom
        t = max(0.0, min(1.0, t))
        px, py, pz = A["x"] + t * abx, A["y"] + t * aby, A["z"] + t * abz
        d2 = (point["x"] - px) ** 2 + (point["y"] - py) ** 2 + (point["z"] - pz) ** 2
        if best is None or d2 < best[0]:
            best = (d2, A["time_ms"] + t * (B["time_ms"] - A["time_ms"]), A["speed"] + t * (B["speed"] - A["speed"]))
    if best is None:
        r = ref[j]
        return float(r["time_ms"]), r["speed"], _dist3(point, r)
    return best[1], best[2], math.sqrt(best[0])


def _heading_and_curvature(samples: list[dict]) -> tuple[list[float], list[float], list[float]]:
    """Horizontal cumulative distance, path heading (deg) and absolute path
    curvature (deg per metre) for each sample."""
    n = len(samples)
    dist = [0.0] * n
    for i in range(1, n):
        dist[i] = dist[i - 1] + math.hypot(samples[i]["x"] - samples[i - 1]["x"],
                                           samples[i]["z"] - samples[i - 1]["z"])

    heading = [0.0] * n
    j = 0
    for i in range(n):
        while j < i and dist[i] - dist[j] > HEADING_BASELINE_M:
            j += 1
        jj = max(0, j - 1)
        dx = samples[i]["x"] - samples[jj]["x"]
        dz = samples[i]["z"] - samples[jj]["z"]
        if abs(dx) + abs(dz) > 1e-6:
            heading[i] = math.degrees(math.atan2(dz, dx))
        elif i:
            heading[i] = heading[i - 1]  # stationary: keep the last heading

    curvature = [0.0] * n
    m = k = 0
    for i in range(n):
        while m < n - 1 and dist[i] - dist[m] > CURVATURE_WINDOW_M:
            m += 1
        while k < n - 1 and dist[k + 1] - dist[i] <= CURVATURE_WINDOW_M:
            k += 1
        span = dist[k] - dist[m]
        if span > 1.0:
            curvature[i] = abs(_wrap180(heading[k] - heading[m])) / span
    return dist, heading, curvature


def _detect_corner_segments(ref_samples: list[dict]) -> list[tuple[int, int, float]]:
    """Corners as (start_idx, end_idx, signed_net_turn_deg) into the
    reference's samples. Negative net turn is a right turn."""
    n = len(ref_samples)
    if n < 10:
        return []
    dist, heading, curvature = _heading_and_curvature(ref_samples)

    raw: list[tuple[int, int]] = []
    inside = False
    start = 0
    for i, c in enumerate(curvature):
        if not inside and c >= CORNER_ENTER_CURVATURE:
            inside, start = True, i
        elif inside and c < CORNER_EXIT_CURVATURE:
            inside = False
            raw.append((start, i))
    if inside:
        raw.append((start, n - 1))

    segments: list[tuple[int, int]] = []
    for a, b in raw:
        if dist[b] - dist[a] < CORNER_MIN_SPAN_M:
            continue
        if segments and dist[a] - dist[segments[-1][1]] < CORNER_MERGE_GAP_M:
            segments[-1] = (segments[-1][0], b)
        else:
            segments.append((a, b))

    out = []
    for a, b in segments:
        net = sum(_wrap180(heading[i] - heading[i - 1]) for i in range(a + 1, b + 1))
        out.append((a, b, net))
    return out


# ---------------------------------------------------------------- metrics

def _steer_metrics(steers: list[float]) -> dict:
    """Summarise a steering trace: how much, how busy, how digital."""
    if not steers:
        return {"avg_abs": 0.0, "reversals": 0, "full_lock_frac": 0.0, "peak": 0.0}
    reversals = 0
    prev_sign = 0
    for s in steers:
        sign = 1 if s > STEER_DEADZONE else (-1 if s < -STEER_DEADZONE else 0)
        if sign and prev_sign and sign != prev_sign:
            reversals += 1
        if sign:
            prev_sign = sign
    n = len(steers)
    return {
        "avg_abs": sum(abs(s) for s in steers) / n,
        "reversals": reversals,
        "full_lock_frac": sum(1 for s in steers if abs(s) >= 0.95) / n,
        "peak": max(abs(s) for s in steers),
    }


def _input_style(steers: list[float]) -> str:
    """Keyboard steering only ever sits at -1, 0 or +1; a pad or wheel
    produces lots of in-between values."""
    if not steers:
        return "unknown"
    intermediate = sum(1 for s in steers if 0.05 < abs(s) < 0.95) / len(steers)
    return "digital (keyboard-like)" if intermediate < DIGITAL_INTERMEDIATE_MAX else "analog (pad/wheel-like)"


def _brake_events(brakes: list[float]) -> int:
    events = 0
    was = False
    for b in brakes:
        braking = b > 0.1
        if braking and not was:
            events += 1
        was = braking
    return events


def _find_brake_point(raw_points: list[dict], corner_start_idx: int, field_name: str) -> float | None:
    """Where braking began, searching back from a corner's start within
    BRAKE_LOOKBACK_M. Distance is relative to the corner start (negative =
    before it); None if there was no braking in that window."""
    d_start = raw_points[corner_start_idx]["distance_m"]
    earliest = None
    i = corner_start_idx
    while i >= 0 and d_start - raw_points[i]["distance_m"] <= BRAKE_LOOKBACK_M:
        if raw_points[i][field_name] > 0.1:
            earliest = i
        i -= 1
    if earliest is None:
        return None
    return round(raw_points[earliest]["distance_m"] - d_start, 1)


def _r(value: float, digits: int) -> float:
    return round(value, digits)


# ---------------------------------------------------------------- builders

def _build_corners(raw_points, matches, subj_samples, ref_samples, segments) -> list[dict]:
    corners = []
    for ref_i0, ref_i1, net_turn in segments:
        i0 = bisect_left(matches, ref_i0)
        i1 = bisect_right(matches, ref_i1) - 1
        if i1 < i0:
            continue  # the subject never passed through this stretch
        seg = raw_points[i0:i1 + 1]
        subj_steer = [p["subject_steer"] for p in seg]
        ref_steer = [s["steer"] for s in ref_samples[ref_i0:ref_i1 + 1]]
        sm, rm = _steer_metrics(subj_steer), _steer_metrics(ref_steer)
        corners.append({
            "corner_index": len(corners) + 1,
            "direction": "right" if net_turn < 0 else "left",
            "turn_deg": round(abs(net_turn)),
            "distance_start": _r(seg[0]["distance_m"], 1),
            "distance_end": _r(seg[-1]["distance_m"], 1),
            "time_change_ms": round(seg[-1]["delta_ms"] - seg[0]["delta_ms"]),
            "subject_entry_speed": _r(seg[0]["subject_speed"], 1),
            "reference_entry_speed": _r(seg[0]["reference_speed"], 1),
            "subject_min_speed": _r(min(p["subject_speed"] for p in seg), 1),
            "reference_min_speed": _r(min(p["reference_speed"] for p in seg), 1),
            "subject_exit_speed": _r(seg[-1]["subject_speed"], 1),
            "reference_exit_speed": _r(seg[-1]["reference_speed"], 1),
            "subject_brake_point_m": _find_brake_point(raw_points, i0, "subject_brake"),
            "reference_brake_point_m": _find_brake_point(raw_points, i0, "reference_brake"),
            "subject_avg_steer": _r(sm["avg_abs"], 2),
            "reference_avg_steer": _r(rm["avg_abs"], 2),
            "subject_steer_reversals": sm["reversals"],
            "reference_steer_reversals": rm["reversals"],
        })
    return corners


def _public_point(p: dict) -> dict:
    return {
        "distance_m": _r(p["distance_m"], 1),
        "delta_ms": round(p["delta_ms"]),
        "subject_speed": _r(p["subject_speed"], 1),
        "reference_speed": _r(p["reference_speed"], 1),
        "subject_steer": _r(p["subject_steer"], 2),
        "reference_steer": _r(p["reference_steer"], 2),
        "subject_gas": _r(p["subject_gas"], 2),
        "subject_brake": _r(p["subject_brake"], 2),
        "reference_brake": _r(p["reference_brake"], 2),
        "reference_gas": _r(p["reference_gas"], 2),
        "x": _r(p["x"], 1),
        "z": _r(p["z"], 1),
    }


def _section_point(p: dict) -> dict:
    """Leaner than _public_point: section charts only plot speed and steering."""
    return {
        "distance_m": _r(p["distance_m"], 1),
        "delta_ms": round(p["delta_ms"]),
        "subject_speed": _r(p["subject_speed"], 1),
        "reference_speed": _r(p["reference_speed"], 1),
        "subject_steer": _r(p["subject_steer"], 2),
        "reference_steer": _r(p["reference_steer"], 2),
    }


def _downsample(points: list[dict], target: int) -> list[dict]:
    if len(points) <= target:
        return list(points)
    step = len(points) / target
    return [points[int(i * step)] for i in range(target)]


def _build_sections(raw_points, matches, ref_samples, corners) -> list[dict]:
    """Equal-distance slices of the track. Each carries its own summary and
    a full-resolution trace so a chart can show that stretch in detail."""
    total = raw_points[-1]["distance_m"]
    if total <= 0:
        return []
    count = max(3, min(8, round(total / SECTION_TARGET_M)))
    distances = [p["distance_m"] for p in raw_points]

    sections = []
    for k in range(count):
        d0, d1 = total * k / count, total * (k + 1) / count
        i0 = bisect_left(distances, d0)
        i1 = min(len(raw_points) - 1, bisect_right(distances, d1) - 1 if k < count - 1 else len(raw_points) - 1)
        if i1 <= i0:
            continue
        seg = raw_points[i0:i1 + 1]
        ref_slice = ref_samples[matches[i0]:matches[i1] + 1] or ref_samples[matches[i0]:matches[i0] + 1]
        sm = _steer_metrics([p["subject_steer"] for p in seg])
        rm = _steer_metrics([s["steer"] for s in ref_slice])
        sections.append({
            "index": len(sections) + 1,
            "distance_start": _r(seg[0]["distance_m"], 1),
            "distance_end": _r(seg[-1]["distance_m"], 1),
            "time_change_ms": round(seg[-1]["delta_ms"] - seg[0]["delta_ms"]),
            "subject_avg_speed": _r(sum(p["subject_speed"] for p in seg) / len(seg), 1),
            "reference_avg_speed": _r(sum(p["reference_speed"] for p in seg) / len(seg), 1),
            "subject_min_speed": _r(min(p["subject_speed"] for p in seg), 1),
            "reference_min_speed": _r(min(p["reference_speed"] for p in seg), 1),
            "subject_avg_steer": _r(sm["avg_abs"], 2),
            "reference_avg_steer": _r(rm["avg_abs"], 2),
            "subject_steer_reversals": sm["reversals"],
            "reference_steer_reversals": rm["reversals"],
            "subject_brake_events": _brake_events([p["subject_brake"] for p in seg]),
            "reference_brake_events": _brake_events([s["brake"] for s in ref_slice]),
            "corner_indices": [
                c["corner_index"] for c in corners
                if c["distance_end"] >= seg[0]["distance_m"] and c["distance_start"] <= seg[-1]["distance_m"]
            ],
            "points": [_section_point(p) for p in _downsample(seg, SECTION_POINTS)],
        })
    return sections


def _aggregate_stats(subj_samples, ref_samples, raw_points, corners, subject, reference) -> dict:
    deltas = [p["delta_ms"] for p in raw_points]
    max_lost = max(raw_points, key=lambda p: p["delta_ms"])
    max_gained = min(raw_points, key=lambda p: p["delta_ms"])
    total_dist = raw_points[-1]["distance_m"]

    subj_speeds = [s["speed"] for s in subj_samples]
    ref_speeds = [s["speed"] for s in ref_samples]
    subj_steer = [s["steer"] for s in subj_samples]
    ref_steer = [s["steer"] for s in ref_samples]
    sm, rm = _steer_metrics(subj_steer), _steer_metrics(ref_steer)

    corner_time = sum(c["time_change_ms"] for c in corners)
    corner_len = sum(c["distance_end"] - c["distance_start"] for c in corners)
    final_delta = round(deltas[-1])

    return {
        "telemetry": True,
        "final_delta_ms": final_delta,
        "max_time_lost_ms": round(max_lost["delta_ms"]),
        "max_time_lost_at_pct": _r(100 * max_lost["distance_m"] / total_dist, 1) if total_dist else None,
        "max_time_gained_ms": round(max_gained["delta_ms"]),
        "max_time_gained_at_pct": _r(100 * max_gained["distance_m"] / total_dist, 1) if total_dist else None,
        "subject_avg_speed": sum(subj_speeds) / len(subj_speeds),
        "reference_avg_speed": sum(ref_speeds) / len(ref_speeds),
        "subject_top_speed": max(subj_speeds),
        "reference_top_speed": max(ref_speeds),
        "subject_steer_reversals": sm["reversals"],
        "reference_steer_reversals": rm["reversals"],
        "subject_avg_abs_steer": _r(sm["avg_abs"], 3),
        "reference_avg_abs_steer": _r(rm["avg_abs"], 3),
        "subject_full_lock_fraction": _r(sm["full_lock_frac"], 3),
        "reference_full_lock_fraction": _r(rm["full_lock_frac"], 3),
        "subject_input_style": _input_style(subj_steer),
        "reference_input_style": _input_style(ref_steer),
        "subject_brake_events": _brake_events([s["brake"] for s in subj_samples]),
        "reference_brake_events": _brake_events([s["brake"] for s in ref_samples]),
        "subject_full_throttle_fraction": _r(sum(1 for s in subj_samples if s["gas"] >= 0.95) / len(subj_samples), 3),
        "reference_full_throttle_fraction": _r(sum(1 for s in ref_samples if s["gas"] >= 0.95) / len(ref_samples), 3),
        "corner_count": len(corners),
        "corner_track_pct": _r(100 * corner_len / total_dist, 1) if total_dist else 0.0,
        "corner_time_change_ms": corner_time,
        "straight_time_change_ms": final_delta - corner_time,
        "subject_race_time_ms": subject.get("race_time_ms"),
        "reference_race_time_ms": reference.get("race_time_ms"),
    }


def _alignment_quality(deviations: list[float], subject_length: float, reference_length: float) -> dict:
    """How well the two runs follow the same route. Large deviations or very
    different path lengths mean a different map version or a big detour, and
    then per-section/corner comparisons shouldn't be trusted blindly."""
    ordered = sorted(deviations)
    median = ordered[len(ordered) // 2]
    p90 = ordered[int(len(ordered) * 0.9)]
    ratio = subject_length / reference_length if reference_length else 1.0
    poor = p90 > 25.0 or not 0.8 <= ratio <= 1.25
    return {
        "alignment_median_m": _r(median, 1),
        "alignment_p90_m": _r(p90, 1),
        "path_length_ratio": _r(ratio, 2),
        "alignment_poor": poor,
    }


def compare_runs(subject: dict, reference: dict) -> ComparisonResult:
    subj_samples = subject.get("samples") or []
    ref_samples = reference.get("samples") or []

    if not subj_samples or not ref_samples:
        # Without per-tick telemetry on both sides we can still compare by
        # finish time (and still brief the AI); the frontend skips charts.
        subj_t = subject.get("race_time_ms")
        ref_t = reference.get("race_time_ms")
        return ComparisonResult(points=[], stats={
            "telemetry": False,
            "subject_race_time_ms": subj_t,
            "reference_race_time_ms": ref_t,
            "final_delta_ms": (subj_t - ref_t) if subj_t is not None and ref_t is not None else None,
        })

    subj_dist = _cumulative_distance(subj_samples)
    matches = _nearest_forward(subj_samples, ref_samples)

    raw_points = []
    deviations = []
    for i, s in enumerate(subj_samples):
        r = ref_samples[matches[i]]
        ref_time, ref_speed, deviation = _interpolate_on_reference(s, ref_samples, matches[i])
        deviations.append(deviation)
        raw_points.append({
            "distance_m": subj_dist[i],
            "delta_ms": s["time_ms"] - ref_time,
            "subject_speed": s["speed"],
            "reference_speed": ref_speed,
            "subject_steer": s["steer"],
            "reference_steer": r["steer"],
            "subject_gas": s["gas"],
            "subject_brake": s["brake"],
            "reference_brake": r["brake"],
            "reference_gas": r["gas"],
            "x": s["x"],
            "z": s["z"],
        })

    segments = _detect_corner_segments(ref_samples)
    corners = _build_corners(raw_points, matches, subj_samples, ref_samples, segments)
    sections = _build_sections(raw_points, matches, ref_samples, corners)
    points = [_public_point(p) for p in _downsample(raw_points, DOWNSAMPLE_POINTS)]
    stats = _aggregate_stats(subj_samples, ref_samples, raw_points, corners, subject, reference)
    stats.update(_alignment_quality(deviations, subj_dist[-1], _cumulative_distance(ref_samples)[-1]))
    return ComparisonResult(points=points, stats=stats, corners=corners, sections=sections)
