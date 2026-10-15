"use strict";

// Coach captions: the moments of a lap worth a word, written from the measured numbers (the same ones behind the
// coach report: corner phases and speeds, the steering plan's zones, the playbook's tricks and the checkpoint splits).
// No AI call is made here. build(primary) returns a list sorted by time:
//   { t0, t1, kind: "loss" | "gain" | "note", title, tag, lines: [string], pri, src }
// with t0/t1 in race milliseconds, so the replay can show each one while it happens.

const Captions = (() => {
  const secs = (x) => (Math.abs(x) / 1000).toFixed(2);

  function tAtDist(pts, d) {
    let lo = 0, hi = pts.length - 1;
    if (d <= pts[0].distance_m) return pts[0].t_ms;
    if (d >= pts[hi].distance_m) return pts[hi].t_ms;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].distance_m <= d) lo = m; else hi = m; }
    const span = pts[hi].distance_m - pts[lo].distance_m;
    return pts[lo].t_ms + (span > 0 ? (d - pts[lo].distance_m) / span : 0) * (pts[hi].t_ms - pts[lo].t_ms);
  }

  function speedAt(pts, d) {
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].distance_m <= d) lo = m; else hi = m; }
    return Math.max(60, pts[lo].subject_speed || 150);
  }

  // what differs in one corner, most telling first
  function cornerFacts(c) {
    const f = [], ph = c.phases && c.phases.delta_m, v = Math.max(60, c.subject_entry_speed || 150) / 3.6;
    const when = (m) => (Math.abs(m) / v).toFixed(2);
    if (ph) {
      if (ph.brake != null && Math.abs(ph.brake) >= 6) f.push([Math.abs(ph.brake) / v * 1.4, `you brake ${when(ph.brake)} s ${ph.brake < 0 ? "earlier" : "later"} than the ghost`]);
      if (ph.turn_in != null && Math.abs(ph.turn_in) >= 6) f.push([Math.abs(ph.turn_in) / v, `you turn in ${when(ph.turn_in)} s ${ph.turn_in < 0 ? "earlier" : "later"}`]);
      if (ph.exit != null && Math.abs(ph.exit) >= 6) f.push([Math.abs(ph.exit) / v * 1.2, `you are back on the throttle ${when(ph.exit)} s ${ph.exit < 0 ? "earlier" : "later"}`]);
      else if (ph.apex != null && Math.abs(ph.apex) >= 8) f.push([Math.abs(ph.apex) / v * 0.8, `you reach the apex ${when(ph.apex)} s ${ph.apex < 0 ? "earlier" : "later"}`]);
    }
    if (c.subject_min_speed != null && c.reference_min_speed != null && Math.abs(c.subject_min_speed - c.reference_min_speed) >= 3)
      f.push([Math.abs(c.subject_min_speed - c.reference_min_speed) / 12, `your slowest point is ${Math.round(c.subject_min_speed)} km/h, the ghost's ${Math.round(c.reference_min_speed)}`]);
    if (c.subject_exit_speed != null && c.reference_exit_speed != null && Math.abs(c.subject_exit_speed - c.reference_exit_speed) >= 3)
      f.push([Math.abs(c.subject_exit_speed - c.reference_exit_speed) / 14, `you leave it at ${Math.round(c.subject_exit_speed)} km/h against ${Math.round(c.reference_exit_speed)}`]);
    if (c.subject_avg_steer != null && c.reference_avg_steer != null && Math.abs(c.subject_avg_steer - c.reference_avg_steer) >= 0.08)
      f.push([Math.abs(c.subject_avg_steer - c.reference_avg_steer) * 2.5, `the ghost holds ${c.reference_avg_steer.toFixed(2)} of lock, you ${c.subject_avg_steer.toFixed(2)}`]);
    if (c.subject_steer_reversals != null && c.reference_steer_reversals != null && c.subject_steer_reversals - c.reference_steer_reversals >= 2)
      f.push([(c.subject_steer_reversals - c.reference_steer_reversals) * 0.12, `${c.subject_steer_reversals - c.reference_steer_reversals} more wheel corrections than the ghost`]);
    return f.sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  }

  function build(primary) {
    const pts = primary && primary.points;
    if (!pts || pts.length < 4) return [];
    const cands = [];

    // 1. corners that cost or gained time
    let gains = 0;
    for (const c of [...(primary.corners || [])].sort((a, b) => Math.abs(b.time_change_ms) - Math.abs(a.time_change_ms))) {
      const ms = c.time_change_ms;
      if (Math.abs(ms) < 12) continue;
      if (ms < 0 && ++gains > 2) continue;
      const lines = cornerFacts(c).slice(0, 3);
      if (!lines.length) lines.push(ms > 0 ? "no single input stands out; the time is lost across the corner" : "you carry it better than the ghost here");
      const t0 = tAtDist(pts, c.distance_start) - 1300;
      cands.push({ t0: Math.max(0, t0), t1: Math.max(t0 + 4200, tAtDist(pts, c.distance_end)), kind: ms > 0 ? "loss" : "gain", title: `Corner ${c.corner_index}: ${c.direction} ${c.turn_deg}°`, tag: `${ms > 0 ? "−" : "+"}${secs(ms)} s`, lines, pri: Math.abs(ms) * (ms > 0 ? 1.5 : 0.8), src: "corner" });
    }

    // 2. the steering plan's zones
    const bp = primary.blueprint;
    for (const z of ((bp && bp.zones) || []).slice(0, 6)) {
      const lines = [];
      if (z.ref_dir && z.you_dir) {
        const word = (d) => (d === "straight" ? "near straight" : d);
        lines.push(z.ref_dir === "straight" ? `the references keep the wheel near straight (${Math.abs(z.ref_avg).toFixed(2)}), you steer ${word(z.you_dir)} ${Math.abs(z.you_avg).toFixed(2)}`
          : `the references steer ${z.ref_dir} ${Math.abs(z.ref_avg).toFixed(2)} (peak ${Math.abs(z.ref_peak).toFixed(2)}), you ${word(z.you_dir)} ${Math.abs(z.you_avg).toFixed(2)}`);
      }
      if (z.ref_onset_m != null && z.you_onset_m != null && Math.abs(z.you_onset_m - z.ref_onset_m) >= 5) {
        const dm = z.you_onset_m - z.ref_onset_m, v = speedAt(pts, z.ref_onset_m) / 3.6;
        lines.push(`start steering ${(Math.abs(dm) / v).toFixed(2)} s ${dm > 0 ? "earlier" : "later"}`);
      }
      if (z.ref_wig_hz != null && z.you_wig_hz != null && Math.abs(z.you_wig_hz - z.ref_wig_hz) >= 1.5) lines.push(`wheel flicks: the references ${z.ref_wig_hz.toFixed(1)} a second, you ${z.you_wig_hz.toFixed(1)}`);
      if (!lines.length) continue;
      if (z.segment && z.seg_gap_ms != null) lines.push(`${z.segment}: ${z.seg_gap_ms > 0 ? "+" : "−"}${secs(z.seg_gap_ms)} s against the references`);
      const t0 = tAtDist(pts, z.from_m) - 700;
      cands.push({ t0: Math.max(0, t0), t1: Math.max(0, t0) + 4600, kind: "note", title: `Steering: ${z.where}`, tag: z.time_ms ? `${z.time_ms > 0 ? "−" : "+"}${secs(z.time_ms)} s` : "", lines: lines.slice(0, 3), pri: Math.max(20, (z.score || 10) * 2.2), src: "zone" });
    }

    // 3. the tricks of this map, where they apply
    const skip = new Set(["gearshift", "wallride", "bankride"]);
    for (const card of (primary.playbook || [])) {
      if (!card.applies || skip.has(card.id) || /^bob_/.test(card.id)) continue;
      for (const p of (card.places || []).slice(0, 2)) {
        const t0 = tAtDist(pts, p.from_m) - 800;
        cands.push({ t0: Math.max(0, t0), t1: Math.max(0, t0) + 4200, kind: "note", title: card.name, tag: "", lines: [p.where.charAt(0).toUpperCase() + p.where.slice(1), String(p.detail).replace(/\s*\[[^\]]*\]\s*$/, "")], pri: 14, src: "trick" });
      }
    }

    // 4. the checkpoint stretches that cost the most (and the one that gained the most)
    const rows = primary.checkpoints || [];
    rows.filter((r) => r.split_delta_ms >= 30).sort((a, b) => b.split_delta_ms - a.split_delta_ms).slice(0, 2).forEach((r, i) => {
      const prev = rows[r.index - 2], t0 = Math.max(0, r.subject_ms - 700);
      cands.push({ t0, t1: t0 + 4200, kind: "loss", title: `${prev ? prev.label : "Start"} → ${r.label}`, tag: `−${secs(r.split_delta_ms)} s`, lines: [i === 0 ? "the costliest stretch of the lap against the ghost" : "the second costliest stretch of the lap"], pri: r.split_delta_ms * 1.4, src: "split" });
    });
    const best = rows.filter((r) => r.split_delta_ms <= -30).sort((a, b) => a.split_delta_ms - b.split_delta_ms)[0];
    if (best) { const prev = rows[best.index - 2], t0 = Math.max(0, best.subject_ms - 700); cands.push({ t0, t1: t0 + 4000, kind: "gain", title: `${prev ? prev.label : "Start"} → ${best.label}`, tag: `+${secs(best.split_delta_ms)} s`, lines: ["your best stretch against the ghost"], pri: Math.abs(best.split_delta_ms), src: "split" }); }

    // keep the most useful, never more than two on screen at once
    const kept = [];
    for (const c of cands.sort((a, b) => b.pri - a.pri)) {
      if (kept.length >= 16) break;
      if (kept.filter((k) => k.t0 < c.t1 && c.t0 < k.t1).length >= 2) continue;
      kept.push(c);
    }
    return kept.sort((a, b) => a.t0 - b.t0);
  }

  return { build };
})();

if (typeof module !== "undefined") module.exports = Captions;
