"""What the car is driving on, from the map's own blocks.

A replay records where the car was but not what was under it. The map file
lists every block placed on the grid (see mapblocks.py), and a block's name says
what it is made of ("RoadIce...", "PlatformDirt...", "GrassHill..."). Putting
the two together labels each stretch of a lap with a surface.

The match is approximate on purpose. A block is stored by the grid cell of one
corner, not its footprint, and the height scale differs between maps, so for
each point of the lap we vote among the driving blocks nearby, weighted by how
close they are across and up, and then smooth the result along the lap.
"""

from __future__ import annotations

import collections
import threading
import time

from . import mapblocks, net, tmio_client

CELL = 32.0       # metres per grid cell, across
LEVEL = 8.0       # metres per grid cell, up

SURFACES = ("tech", "bump", "plastic", "dirt", "grass", "ice", "water", "unknown")

LABELS = {
    "tech": "tech (asphalt-like)",
    "bump": "bumpy road",
    "plastic": "plastic",
    "dirt": "dirt",
    "grass": "grass",
    "ice": "ice",
    "water": "water",
    "unknown": "unknown",
}

# How each surface drives, and what that means for technique. The coach is told
# this next to the measured surface of each corner.
GRIP = {
    "tech": "high grip: braking works, speed drifts work above ~180 km/h",
    "bump": "grippy but bumpy: bumps unsettle the car at speed, so avoid big steering on them and expect small hops",
    "plastic": "reduced grip compared with tech and quite slippery: smooth, early inputs; treat speed drifts as unproven here",
    "dirt": "medium grip and the car slides on its own: no speed drifts, braking scrubs more, keep steering steady through gear shifts",
    "grass": "low grip and it slows the car: no speed drifts, keep inputs small, steady steering through gear shifts",
    "ice": "very low grip: no speed drifts, braking does little, steer early, small and steady",
    "water": "water slows the car a lot: keep it straight and keep the throttle down",
    "unknown": "surface not known",
}

# Surfaces where a speed drift (brake-initiated slide) can work at all.
DRIFT_SURFACES = {"tech", "bump"}


def classify(name: str) -> str | None:
    """The surface a block name drives like, or None for blocks you don't drive on."""
    n = name
    if n.startswith(("Deco", "Structure", "Stage", "Stand", "Lake", "Item", "Obstacle", "Slope2Start", "Sign")):
        return None
    low = n.lower()
    if "ice" in low and not low.startswith(("office", "service")):
        return "ice"
    if "dirt" in low:
        return "dirt"
    if "grass" in low:
        return "grass"
    if "plastic" in low:
        return "plastic"
    if "water" in low:
        return "water"
    if "bump" in low:
        return "bump"
    if low.startswith(("road", "platform", "track", "tech", "open", "gate", "special")):
        return "tech"
    return None


class SurfaceMap:
    """The driving blocks of one map, indexed by grid cell."""

    def __init__(self, size: tuple[int, int, int], blocks: list[mapblocks.Block]):
        self.size = size
        self.cells: dict[tuple[int, int], list[tuple[int, str]]] = collections.defaultdict(list)
        self.count = 0
        for b in blocks:
            s = classify(b.name)
            if s is None:
                continue
            self.cells[(b.x, b.z)].append((b.y, s))
            self.count += 1
        self.y_offset: float | None = None   # metres: world height of block level 0

    # ----------------------------------------------------------- calibration

    def _candidates(self, x: float, z: float, reach: float = 1.6):
        cx, cz = x / CELL, z / CELL
        r = int(reach + 1)
        for gx in range(int(cx) - r, int(cx) + r + 1):
            for gz in range(int(cz) - r, int(cz) + r + 1):
                if abs(gx + 0.5 - cx) > reach or abs(gz + 0.5 - cz) > reach:
                    continue
                for y, s in self.cells.get((gx, gz), ()):
                    yield gx, gz, y, s

    def calibrate(self, points: list[tuple[float, float, float]]) -> float | None:
        """Find the height offset between the map's levels and world metres by
        trying offsets and keeping the one where the car sits closest to the
        top of the blocks around it."""
        sample = points[:: max(1, len(points) // 150)]
        best, best_score = None, None
        for off in range(-224, 40, 2):
            errs = []
            for x, y, z in sample:
                near = min((abs((y - (LEVEL * by + off)) - 4.0) for _, _, by, _ in self._candidates(x, z)), default=None)
                if near is not None:
                    errs.append(near)
            if len(errs) < max(10, len(sample) // 4):
                continue
            errs.sort()
            score = errs[len(errs) // 2]
            if best_score is None or score < best_score:
                best, best_score = off, score
        self.y_offset = float(best) if best is not None else None
        return self.y_offset

    # ------------------------------------------------------------- labelling

    def label(self, points: list[tuple[float, float, float]]) -> list[str]:
        if self.y_offset is None:
            self.calibrate(points)
        off = self.y_offset
        raw: list[str] = []
        for x, y, z in points:
            cx, cz = x / CELL, z / CELL
            pick = collections.Counter()
            # a block is stored by one corner's cell, so a wide piece can sit a few cells away: widen the search if needed
            for reach in (1.6, 3.2):
                votes: collections.Counter = collections.Counter()
                loose: collections.Counter = collections.Counter()
                for gx, gz, by, s in self._candidates(x, z, reach):
                    dh = ((gx + 0.5 - cx) ** 2 + (gz + 0.5 - cz) ** 2) ** 0.5
                    loose[s] += 1.0 / (0.4 + dh)
                    if off is None:
                        continue
                    dv = abs((y - (LEVEL * by + off)) - 4.0)
                    if dv <= 14.0:
                        votes[s] += 1.0 / ((0.4 + dh) * (1.0 + dv / 4.0))
                pick = votes if off is not None else loose   # without a height offset we can only go by position
                if pick:
                    break
            raw.append(pick.most_common(1)[0][0] if pick else "unknown")
        return _smooth(raw, 9)


def _smooth(labels: list[str], half: int) -> list[str]:
    """The most common label in a window, so a single odd block doesn't flicker the line."""
    out = []
    n = len(labels)
    for i in range(n):
        window = labels[max(0, i - half): min(n, i + half + 1)]
        known = [w for w in window if w != "unknown"]
        out.append(collections.Counter(known or window).most_common(1)[0][0])
    return out


# ------------------------------------------------------------ fetching maps

_cache: dict[str, tuple[float, SurfaceMap | None]] = {}
_lock = threading.Lock()
_TTL_S = 24 * 3600
_FAIL_TTL_S = 300
MAX_MAP_BYTES = 16 * 1024 * 1024


def get_surface_map(map_uid: str) -> SurfaceMap | None:
    """The surface map for a Trackmania map, downloaded from Nadeo's public file
    store (the link comes from trackmania.io) and cached. None if it can't be had."""
    net.valid_map_uid(map_uid)
    with _lock:
        hit = _cache.get(map_uid)
    if hit and time.time() - hit[0] < (_TTL_S if hit[1] else _FAIL_TTL_S):
        return hit[1]
    result: SurfaceMap | None = None
    try:
        info = tmio_client.get_map_info(map_uid)
        url = info.get("fileUrl") or ""
        if url.startswith("https://core.trackmania.nadeo.live/"):
            data = net.download_limited(url, {"User-Agent": net.user_agent()}, timeout=40.0, limit=MAX_MAP_BYTES)
            mb = mapblocks.parse_map_blocks(data)
            if mb.blocks:
                result = SurfaceMap(mb.size, mb.blocks)
    except Exception:  # a map we can't read just means "surface unknown"
        result = None
    with _lock:
        _cache[map_uid] = (time.time(), result)
        if len(_cache) > 40:
            _cache.pop(next(iter(_cache)))
    return result


def surfaces_for_samples(map_uid: str, samples: list[dict]) -> list[str] | None:
    """A surface label for every sample of a run, or None when the map is unavailable."""
    sm = get_surface_map(map_uid)
    if sm is None or not samples:
        return None
    return sm.label([(s["x"], s["y"], s["z"]) for s in samples])


def band(kmh: float) -> str:
    """Speed bands that matter for technique."""
    if kmh < 100:
        return "slow, under 100 km/h"
    if kmh < 180:
        return "100-180 km/h, below speed-drift speed"
    if kmh < 340:
        return "180-340 km/h, the speed-drift window"
    return "340+ km/h, very fast"


def label_at(labels: list[str], dist: list[float], d: float) -> str:
    """The surface at distance `d` along a run."""
    if not labels:
        return "unknown"
    lo, hi = 0, len(dist) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if dist[mid] < d:
            lo = mid + 1
        else:
            hi = mid
    return labels[min(lo, len(labels) - 1)]


def corner_surfaces(labels: list[str], dist: list[float], corners: list[dict]) -> dict[int, str]:
    """The surface of each corner: the most common label between its start and end."""
    out: dict[int, str] = {}
    for c in corners:
        seg = [labels[i] for i, d in enumerate(dist) if c["distance_start"] <= d <= c["distance_end"] and i < len(labels)]
        known = [s for s in seg if s != "unknown"]
        out[c["corner_index"]] = collections.Counter(known or seg or ["unknown"]).most_common(1)[0][0]
    return out


def summarize(labels: list[str]) -> dict[str, float]:
    """Share of the lap on each surface (0..1)."""
    if not labels:
        return {}
    c = collections.Counter(labels)
    return {k: v / len(labels) for k, v in c.most_common()}
