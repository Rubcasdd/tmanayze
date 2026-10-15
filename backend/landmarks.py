"""Places a player can actually recognise.

Nobody driving can see how many metres they are into a lap, so advice like "start at 3450 m" is useless in the
game. What is visible: the checkpoints (the game flashes the split), the corners, and time. This turns a distance
along the lap into those landmarks: "in corner 6", "1.2 s before corner 7", "0.8 s after CP 3", and says which
checkpoint-to-checkpoint stretch it falls in and how much time the player loses in that stretch.
"""

from __future__ import annotations

import bisect


class Landmarks:
    def __init__(self, cp_info: dict | None, corners: list[dict], points: list[dict], rows: list[dict] | None = None):
        passes = (cp_info or {}).get("passes") or []
        self.cps = [(p["dist_m"], f"CP {p['index']}") for p in passes]
        self.total = (cp_info or {}).get("total_m") or (points[-1]["distance_m"] if points else 0.0)
        self.names = ["the start"] + [n for _, n in self.cps] + ["the finish"]
        self.bounds = [0.0] + [d for d, _ in self.cps] + [self.total]
        self.corners = sorted(corners or [], key=lambda c: c["distance_start"])
        self.ds = [p["distance_m"] for p in points]
        self.vs = [max(5.0, p["subject_speed"]) for p in points]
        self.rows = rows or []

    def speed(self, d: float) -> float:
        """The player's speed (km/h) at a distance."""
        if not self.ds:
            return 100.0
        i = bisect.bisect_left(self.ds, d)
        if i <= 0:
            return self.vs[0]
        if i >= len(self.ds):
            return self.vs[-1]
        span = self.ds[i] - self.ds[i - 1]
        k = 0.0 if span <= 0 else (d - self.ds[i - 1]) / span
        return self.vs[i - 1] + k * (self.vs[i] - self.vs[i - 1])

    def secs(self, d0: float, d1: float) -> float:
        """The time to drive from d0 to d1 at the player's speed (seconds)."""
        if d1 <= d0:
            return 0.0
        n = max(2, int((d1 - d0) // 10))
        step = (d1 - d0) / n
        return sum(step / (self.speed(d0 + (i + 0.5) * step) / 3.6) for i in range(n))

    # ------------------------------------------------------------- checkpoints

    def segment(self, d: float) -> tuple[int, str]:
        """(index, label) of the checkpoint-to-checkpoint stretch a distance falls in."""
        k = max(0, min(len(self.bounds) - 2, bisect.bisect_right(self.bounds, d) - 1))
        a = "Start" if k == 0 else self.names[k]
        b = "Finish" if k == len(self.bounds) - 2 else self.names[k + 1]
        return k, f"{a} → {b}"

    def seg_gap(self, k: int) -> int | None:
        """How much the player loses (+) or gains (-) in a stretch, in ms, from the checkpoint splits."""
        return self.rows[k]["split_delta_ms"] if 0 <= k < len(self.rows) else None

    # ------------------------------------------------------------------- places

    def where(self, d: float) -> str:
        c = next((c for c in self.corners if c["distance_start"] - 5 <= d <= c["distance_end"] + 5), None)
        if c:
            return f"in corner {c['corner_index']}"
        nxt = next((c for c in self.corners if c["distance_start"] > d), None)
        if nxt:
            t = self.secs(d, nxt["distance_start"])
            if t <= 2.5:
                return f"{t:.1f} s before corner {nxt['corner_index']}" if t >= 0.15 else f"at corner {nxt['corner_index']}"
        prev_cp = [(dd, n) for dd, n in self.cps if dd <= d]
        next_cp = [(dd, n) for dd, n in self.cps if dd > d]
        after = self.secs(prev_cp[-1][0], d) if prev_cp else self.secs(0, d)
        after_name = prev_cp[-1][1] if prev_cp else "the start"
        if next_cp:
            before = self.secs(d, next_cp[0][0])
            if before < after:
                return f"{before:.1f} s before {next_cp[0][1]}" if before >= 0.15 else f"at {next_cp[0][1]}"
        return f"{after:.1f} s after {after_name}" if after >= 0.15 else f"at {after_name}"

    def span(self, d0: float, d1: float) -> str:
        """A stretch in words: 'in corner 6', 'the approach to corner 7', 'from corner 5 to 0.6 s before corner 6', 'from 1.1 s after CP 3 to CP 4'."""
        a, b = self.where(d0), self.where(d1)
        if a == b:
            return a
        if a.startswith("in corner ") and b.startswith("in corner "):
            return f"from corner {a[len('in corner '):]} to corner {b[len('in corner '):]}"
        if a.endswith(tuple(f"before corner {c['corner_index']}" for c in self.corners)) and b.startswith("in corner "):
            return f"the approach to corner {b[len('in corner '):]}, starting {a}"
        if a.startswith("in corner "):
            return f"from corner {a[len('in corner '):]} to {b}"
        return f"from {a} to {b}"
