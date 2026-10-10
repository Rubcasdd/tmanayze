"use strict";

// Pictures of a corner, drawn as SVG from the comparison data: both lines from
// above with the brake / turn-in / apex / exit points, the surface under the
// road, distance ticks, and below it the input timeline (steering, braking and
// lifting for the ghost and for you). The coach can place one in its report with
// {{figure:corner=N}}; the track view uses the input timeline too.
//
// Relies on app.js for state, esc, ghostColor.

const Figures = (() => {
  const INK = "#f0ede6", MUTED = "#8a867d", PANEL = "#1a1a19", LINE = "#2e2d2a";
  const GHOST = "#4aa3ff";
  const KINDS = [
    { key: "brake", label: "BRAKE", color: "#f0b429" },
    { key: "turn_in", label: "TURN IN", color: "#3dd68c" },
    { key: "apex", label: "APEX", color: "#f0ede6" },
    { key: "exit", label: "BACK ON THROTTLE", color: "#4aa3ff" },
  ];

  const SURFACE_COLORS = {
    tech: "#8fa3ad", bump: "#b08968", plastic: "#2fd1b0", dirt: "#a1662f",
    grass: "#5fb04a", ice: "#9be7ff", water: "#3a6ea5", unknown: "#555555",
  };
  const SURFACE_NAMES = {
    tech: "tech", bump: "bumpy road", plastic: "plastic", dirt: "dirt", grass: "grass", ice: "ice", water: "water", unknown: "unknown",
  };

  const name = (c) => {
    const deg = c.turn_deg, span = c.distance_end - c.distance_start, side = c.direction;
    if (deg >= 120) return "hairpin";
    if (deg < 25) return `gentle ${side} bend`;
    if (span >= 60 && deg < 90) return `${side} sweeper`;
    return `${side} turn`;
  };

  const f1 = (v) => (Math.round(v * 10) / 10).toString();
  const km = (v) => `${Math.round(v)} km/h`;
  const secs = (ms) => `${ms > 0 ? "+" : ms < 0 ? "−" : ""}${(Math.abs(ms) / 1000).toFixed(2)}s`;
  const text = (t, x, y, o = {}) =>
    `<text x="${f1(x)}" y="${f1(y)}" fill="${o.fill || INK}" font-size="${o.size || 12}" font-weight="${o.weight || 600}" text-anchor="${o.anchor || "start"}" ` +
    `dominant-baseline="${o.base || "middle"}" stroke="${PANEL}" stroke-width="${o.halo === 0 ? 0 : 3}" paint-order="stroke" stroke-linejoin="round">${esc(t)}</text>`;

  // ------------------------------------------------------------------- wording

  const metres = (v) => `${Math.round(Math.abs(v))} m`;
  const along = (m) => (Math.abs(m) < 1 ? "at the corner start" : m < 0 ? `${metres(m)} before the corner` : `${metres(m)} into the corner`);

  // How you differ from the ghost at one of the four points.
  function pointDiff(p, key) {
    const g = p.reference[key], y = p.subject[key];
    if (key === "brake") {
      if (g && y) {
        const dm = p.delta_m.brake;
        return dm === null || Math.abs(dm) < 2 ? "braking at the same place" : `you brake ${metres(dm)} ${dm > 0 ? "later" : "earlier"}`;
      }
      return g ? "you don't brake" : y ? "ghost doesn't brake" : "";
    }
    const dm = p.delta_m[key], off = p.offset_m[key], parts = [];
    parts.push(Math.abs(dm) < 2 ? "same place" : `you are ${metres(dm)} ${dm > 0 ? "later" : "earlier"}`);
    if (Math.abs(off) >= 1) parts.push(`${metres(off)} ${off > 0 ? "tighter" : "wider"}`);
    return parts.join(", ");
  }

  // A short script: how the ghost takes the corner, then the three things that cost you most.
  function tips(c) {
    const p = c.phases;
    if (!p || !p.reference.turn_in || !p.reference.apex || !p.reference.exit) return [];
    const g = p.reference, s = p.subject, gs = c.reference_distance_start ?? c.distance_start, dm = p.delta_m, off = p.offset_m;
    const way = [
      g.brake ? `brake ${metres(g.brake.metres_before)} before the corner (from ${km(g.brake.speed)})` : "no braking",
      `turn in ${along(g.turn_in.distance_m - gs)} at ${km(g.turn_in.speed)}`,
      `apex at ${km(g.apex.speed)}`,
      `full throttle ${along(g.exit.distance_m - gs)} at ${km(g.exit.speed)}`,
    ];
    const out = [`The ghost: ${way.join(" → ")}.`];
    const diffs = [];
    if (dm.brake !== null && Math.abs(dm.brake) >= 4) diffs.push([Math.abs(dm.brake) * 1.2, `You start braking ${metres(dm.brake)} ${dm.brake > 0 ? "later" : "earlier"}.`]);
    if (g.brake && !s.brake) diffs.push([30, "The ghost brakes here and you don't: check you aren't arriving too fast for its line."]);
    if (!g.brake && s.brake) diffs.push([30, "You brake here and the ghost doesn't: lift earlier or enter wider instead."]);
    if (Math.abs(dm.turn_in) >= 4) diffs.push([Math.abs(dm.turn_in), `You turn in ${metres(dm.turn_in)} ${dm.turn_in > 0 ? "later" : "earlier"}.`]);
    if (Math.abs(off.apex) >= 1) diffs.push([Math.abs(off.apex) * 6, `At the apex you are ${metres(off.apex)} ${off.apex > 0 ? "tighter" : "wider"} than the ghost.`]);
    if (dm.exit >= 4) diffs.push([dm.exit * 1.5, `You are back on full throttle ${metres(dm.exit)} later: straighten the car earlier.`]);
    if (s.apex && s.apex.speed < g.apex.speed - 3) diffs.push([(g.apex.speed - s.apex.speed) * 1.5, `Your apex speed is ${Math.round(g.apex.speed - s.apex.speed)} km/h lower.`]);
    diffs.sort((a, b) => b[0] - a[0]);
    return out.concat(diffs.slice(0, 3).map((d) => d[1]));
  }

  // ------------------------------------------------------------------- input chart

  // The wheel and the pedals through the corner, you against the ghost, along metres from the corner's start.
  function inputsStrip(c, W = 640, opts = {}) {
    const tr = c.phases && c.phases.inputs && c.phases.inputs.trace;
    if (!tr || !tr.subject.length || !tr.reference.length) return "";
    const left = 54, right = 14, top = 30, plotW = W - left - right;
    const all = [...tr.reference, ...tr.subject];
    const span = c.distance_end - c.distance_start;
    const lo = Math.min(...all.map((r) => r[0])), hi = Math.max(span + 10, ...all.map((r) => r[0]));
    const X = (m) => left + ((m - lo) / (hi - lo)) * plotW;
    const panels = [
      { key: "steer", label: "Steering", h: 88, col: 1 },
      { key: "gas", label: "Throttle", h: 46, col: 3 },
      { key: "brake", label: "Brake", h: 40, col: 2 },
    ];
    const GAP = 10;
    let y = top;
    panels.forEach((p) => { p.y = y; y += p.h + GAP; });
    const H = y + 18;
    const step = hi - lo > 420 ? 100 : hi - lo > 200 ? 50 : 25;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Wheel and pedals through corner ${c.corner_index}" font-family="Barlow, system-ui, sans-serif">`;
    if (!opts.bare) s += `<rect width="${W}" height="${H}" fill="${PANEL}" rx="8"/>`;
    s += text("What each of you pressed", 12, 12, { size: 13, weight: 700, halo: 0 });
    s += `<line x1="${W - 150}" y1="12" x2="${W - 128}" y2="12" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>` + text("you", W - 122, 12, { size: 11, fill: MUTED, weight: 500, halo: 0 });
    s += `<line x1="${W - 84}" y1="12" x2="${W - 62}" y2="12" stroke="${GHOST}" stroke-width="2.6" stroke-linecap="round"/>` + text("ghost", W - 56, 12, { size: 11, fill: MUTED, weight: 500, halo: 0 });

    const phases = c.phases, gStart = c.reference_distance_start ?? c.distance_start;
    const marks = [];
    let n = 0;
    for (const kd of KINDS) {
      const g = phases.reference[kd.key], me = phases.subject[kd.key];
      if (!g && !me) continue;
      n += 1;
      marks.push({ n, kd, g: g ? g.distance_m - gStart : null, y: me ? me.distance_m - c.distance_start : null });
    }

    panels.forEach((p) => {
      const mid = p.y + p.h / 2;
      s += `<rect x="${left}" y="${p.y}" width="${plotW}" height="${p.h}" rx="4" fill="rgba(255,255,255,0.025)"/>`;
      s += `<rect x="${f1(X(0))}" y="${p.y}" width="${f1(Math.max(0, X(span) - X(0)))}" height="${p.h}" fill="rgba(240,237,230,0.06)"/>`;
      for (let m = Math.ceil(lo / step) * step; m <= hi; m += step) s += `<line x1="${f1(X(m))}" y1="${p.y}" x2="${f1(X(m))}" y2="${p.y + p.h}" stroke="${LINE}"/>`;
      s += text(p.label, 8, mid, { size: 11, fill: MUTED, weight: 500, halo: 0 });
      if (p.key === "steer") {
        s += `<line x1="${left}" y1="${mid}" x2="${W - right}" y2="${mid}" stroke="#555249" stroke-dasharray="3 4"/>`;
        s += text("right", left + 4, p.y + 9, { size: 9, fill: MUTED, weight: 500, halo: 0 });
        s += text("left", left + 4, p.y + p.h - 8, { size: 9, fill: MUTED, weight: 500, halo: 0 });
      } else {
        s += text("full", left + 4, p.y + 8, { size: 9, fill: MUTED, weight: 500, halo: 0 });
      }
      const Y = (v) => (p.key === "steer" ? mid - v * (p.h / 2 - 4) : p.y + p.h - 3 - v * (p.h - 8));
      const path = (rows) => rows.map((r, i) => `${i ? "L" : "M"}${f1(X(r[0]))} ${f1(Y(r[p.col]))}`).join(" ");
      s += `<path d="${path(tr.reference)}" fill="none" stroke="${GHOST}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/>`;
      s += `<path d="${path(tr.subject)}" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
    });

    // the four points, numbered like the map: ring = ghost, dot = you
    const base = panels[panels.length - 1].y + panels[panels.length - 1].h;
    marks.forEach((mk) => {
      if (mk.g !== null) {
        s += `<line x1="${f1(X(mk.g))}" y1="${top}" x2="${f1(X(mk.g))}" y2="${base}" stroke="${mk.kd.color}" stroke-opacity="0.55" stroke-dasharray="3 3"/>`;
        s += `<circle cx="${f1(X(mk.g))}" cy="${top - 1}" r="8" fill="${PANEL}" stroke="${mk.kd.color}" stroke-width="2"/>` + text(String(mk.n), X(mk.g), top, { size: 10, fill: mk.kd.color, anchor: "middle", halo: 0, weight: 700 });
      }
      if (mk.y !== null) s += `<circle cx="${f1(X(mk.y))}" cy="${base + 5}" r="4" fill="${mk.kd.color}" stroke="${PANEL}" stroke-width="1.5"/>`;
    });
    for (let m = Math.ceil(lo / step) * step; m <= hi; m += step) s += text(`${m} m`, X(m), base + 15, { size: 10, fill: MUTED, anchor: "middle", weight: 400, halo: 0 });
    s += `</svg>`;
    return s;
  }

  // ------------------------------------------------------------------- the corner picture

  function cornerFigure(c, data, surf, W = 640) {
    const pts = data.points, ph = c.phases;
    // look back far enough to contain every brake and turn-in point (fast maps need much more than 90 m)
    let dLo = c.distance_start - 90, dHi = c.distance_end + 50;
    if (ph) for (const side of ["subject", "reference"]) {
      for (const key of ["brake", "turn_in"]) if (ph[side][key]) dLo = Math.min(dLo, ph[side][key].distance_m - 25);
      if (ph[side].exit) dHi = Math.max(dHi, ph[side].exit.distance_m + 20);
    }
    dLo = Math.max(dLo, c.distance_start - 420);
    const i0 = Math.max(0, pts.findIndex((p) => p.distance_m >= dLo));
    let i1 = pts.length - 1;
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i].distance_m <= dHi) { i1 = i; break; }
    const seg = pts.slice(i0, i1 + 1);
    if (seg.length < 3) return "";

    const present = ph ? KINDS.filter((kd) => ph.reference[kd.key] || ph.subject[kd.key]) : [];
    const ROWH = 24, mapH = 372, top = 58, pad = 30;
    const H = mapH + (present.length ? 10 + present.length * ROWH : 0);
    // fit everything we draw into the picture, z down
    const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const add = (x, z) => { box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x); box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z); };
    seg.forEach((p) => { add(p.x, p.z); add(p.reference_x, p.reference_z); });
    if (ph) for (const side of ["subject", "reference"]) for (const k of KINDS) { const q = ph[side][k.key]; if (q) add(q.x, q.z); }
    const dx = Math.max(10, box.maxX - box.minX), dz = Math.max(10, box.maxZ - box.minZ);
    const k = Math.min((W - pad * 2) / dx, (mapH - top - pad) / dz);
    const ox = (W - dx * k) / 2, oz = top + (mapH - top - pad - dz * k) / 2;
    const P = (x, z) => [ox + (x - box.minX) * k, oz + (z - box.minZ) * k];
    const line = (arr, xk, zk) => arr.map((p, i) => { const [x, y] = P(p[xk], p[zk]); return `${i ? "L" : "M"}${f1(x)} ${f1(y)}`; }).join(" ");

    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Corner ${c.corner_index}, your line against the ghost's" font-family="Barlow, system-ui, sans-serif">`;
    s += `<rect width="${W}" height="${H}" fill="${PANEL}" rx="8"/>`;

    // surface under the road: one soft band per stretch of the same surface
    if (surf && surf.length === pts.length) {
      const used = [], runs = [];
      let cur = null;
      for (let i = i0; i <= i1; i++) {
        const sfc = surf[i] || "unknown";
        if (!used.includes(sfc)) used.push(sfc);
        const xy = P(pts[i].x, pts[i].z);
        if (!cur || cur.sfc !== sfc) {
          const prev = cur ? cur.pts[cur.pts.length - 1] : null;
          cur = { sfc, pts: prev ? [prev] : [] };
          runs.push(cur);
        }
        cur.pts.push(xy);
      }
      for (const r of runs) {
        if (r.pts.length < 2) continue;
        s += `<path d="${r.pts.map((q, i) => `${i ? "L" : "M"}${f1(q[0])} ${f1(q[1])}`).join(" ")}" fill="none" stroke="${SURFACE_COLORS[r.sfc] || "#555"}" stroke-opacity="0.3" stroke-width="24" stroke-linecap="butt" stroke-linejoin="round"/>`;
      }
      let lx = W - 14;
      [...used].reverse().forEach((u) => {
        const label = SURFACE_NAMES[u] || u;
        s += text(label, lx, 16, { size: 11, fill: MUTED, anchor: "end", weight: 500, halo: 0 });
        lx -= label.length * 6.2 + 20;
        s += `<circle cx="${f1(lx + 8)}" cy="16" r="5" fill="${SURFACE_COLORS[u] || "#555"}"/>`;
        lx -= 10;
      });
    }

    // the ghost's line is a blue road under yours, so where you agree you see a white line with a blue edge
    s += `<path d="${line(seg, "reference_x", "reference_z")}" fill="none" stroke="${GHOST}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
    s += `<path d="${line(seg, "x", "z")}" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    // direction arrows along your line
    for (let i = 3; i < seg.length - 3; i += Math.max(4, Math.floor(seg.length / 6))) {
      const [x, y] = P(seg[i].x, seg[i].z), [x2, y2] = P(seg[i + 2].x, seg[i + 2].z);
      const a = (Math.atan2(y2 - y, x2 - x) * 180) / Math.PI;
      s += `<polygon points="6,0 -5,-5 -5,5" transform="translate(${f1(x)} ${f1(y)}) rotate(${f1(a)})" fill="${PANEL}" stroke="${INK}" stroke-width="1.2"/>`;
    }

    // distance ticks leading into the corner, every 25 / 50 / 100 m depending on the speed of the map
    const lead = c.distance_start - dLo, stepM = lead > 230 ? 100 : lead > 110 ? 50 : 25;
    for (let m = stepM; m <= lead; m += stepM) {
      const d = c.distance_start - m;
      const idx = pts.findIndex((p) => p.distance_m >= d);
      if (idx < i0 || d < 0) continue;
      const [x, y] = P(pts[idx].x, pts[idx].z), j = Math.min(pts.length - 1, idx + 2);
      const [x2, y2] = P(pts[j].x, pts[j].z);
      const len = Math.hypot(x2 - x, y2 - y) || 1, nx = -(y2 - y) / len, ny = (x2 - x) / len;
      s += `<line x1="${f1(x - nx * 12)}" y1="${f1(y - ny * 12)}" x2="${f1(x + nx * 12)}" y2="${f1(y + ny * 12)}" stroke="${INK}" stroke-opacity="0.8" stroke-width="2"/>`;
      const lyy = y + ny * 18, lxx = Math.min(W - 40, Math.max(40, x + nx * 18));
      if (lyy > top + 4 && lyy < mapH - 8) s += text(`${m} m`, lxx, lyy, { size: 10, fill: "#bdb9af", anchor: "middle", weight: 500 });
    }

    // the points, numbered: ring = ghost, dot = you, joined by a dashed line
    if (ph) {
      let n = 0;
      for (const kd of KINDS) {
        const g = ph.reference[kd.key], y = ph.subject[kd.key];
        if (!g && !y) continue;
        n += 1;
        if (g && y) {
          const [gx, gy] = P(g.x, g.z), [px, py] = P(y.x, y.z);
          s += `<line x1="${f1(gx)}" y1="${f1(gy)}" x2="${f1(px)}" y2="${f1(py)}" stroke="${kd.color}" stroke-opacity="0.7" stroke-width="2" stroke-dasharray="4 3"/>`;
        }
        if (y) {
          const [px, py] = P(y.x, y.z);
          s += `<circle cx="${f1(px)}" cy="${f1(py)}" r="5" fill="${kd.color}" stroke="${PANEL}" stroke-width="2"/>`;
        }
        if (g) {
          const [gx, gy] = P(g.x, g.z);
          s += `<circle cx="${f1(gx)}" cy="${f1(gy)}" r="11" fill="${PANEL}" fill-opacity="0.85" stroke="${kd.color}" stroke-width="3"/>`;
          s += text(String(n), gx, gy + 0.5, { size: 12, fill: kd.color, anchor: "middle", halo: 0, weight: 800 });
        }
      }
    }

    // title
    s += text(`Corner ${c.corner_index}  ·  ${name(c)} ${c.turn_deg}°  ·  ${Math.round(c.distance_start)}–${Math.round(c.distance_end)} m`, 14, 16, { size: 15, weight: 700, halo: 0 });
    s += text(`${secs(c.time_change_ms)} in this corner  ·  slowest ${km(c.subject_min_speed)} (you) vs ${km(c.reference_min_speed)} (ghost)`, 14, 38, { size: 12, fill: c.time_change_ms > 0 ? "#ff6252" : "#3dd68c", weight: 500, halo: 0 });
    // legend and scale
    const ly = mapH - 16;
    s += `<line x1="14" y1="${ly}" x2="40" y2="${ly}" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>` + text("you", 46, ly, { size: 11, fill: MUTED, weight: 500, halo: 0 });
    s += `<line x1="86" y1="${ly}" x2="112" y2="${ly}" stroke="${GHOST}" stroke-width="6" stroke-linecap="round"/>` + text("ghost", 118, ly, { size: 11, fill: MUTED, weight: 500, halo: 0 });
    s += text("ring = ghost, dot = you", 176, ly, { size: 11, fill: MUTED, weight: 500, halo: 0 });
    const bar = [10, 20, 25, 50, 100, 200, 400].find((v) => v * k >= 70) || 400;
    s += `<line x1="${W - 14 - bar * k}" y1="${ly}" x2="${W - 14}" y2="${ly}" stroke="${INK}" stroke-width="2"/>` + text(`${bar} m`, W - 14 - (bar * k) / 2, ly - 12, { size: 11, anchor: "middle", fill: MUTED, weight: 500, halo: 0 });

    // the numbered key under the map: where each point is for both of you and how you differ
    if (present.length) {
      s += `<line x1="14" y1="${mapH}" x2="${W - 14}" y2="${mapH}" stroke="${LINE}"/>`;
      present.forEach((kd, i) => {
        const g = ph.reference[kd.key], y = ph.subject[kd.key], ry = mapH + 10 + i * ROWH + ROWH / 2;
        s += `<circle cx="26" cy="${ry}" r="9" fill="${PANEL}" stroke="${kd.color}" stroke-width="2.5"/>` + text(String(i + 1), 26, ry + 0.5, { size: 11, fill: kd.color, anchor: "middle", halo: 0, weight: 800 });
        s += text(kd.label, 44, ry, { size: 12, fill: kd.color, weight: 700, halo: 0 });
        const speeds = `ghost ${g ? km(g.speed) : "–"}  ·  you ${y ? km(y.speed) : "–"}`;
        s += text(`${speeds}  ·  ${pointDiff(ph, kd.key)}`, 192, ry, { size: 12, fill: INK, weight: 500, halo: 0 });
      });
    }
    s += `</svg>`;
    return s;
  }

  // A figure card: the corner picture, the wheel and pedals under it, and what to take from it.
  function cornerCard(c, data, surf) {
    const pic = cornerFigure(c, data, surf);
    if (!pic) return "";
    const list = tips(c);
    return `<figure class="fig" data-corner="${c.corner_index}">${pic}${inputsStrip(c, 640)}
      ${list.length ? `<ul class="fig-tips">${list.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      <figcaption><span>Corner ${c.corner_index}: your line against the ghost's, and what each of you pressed.</span>
      <button type="button" class="btn tiny fig-save">Save image</button></figcaption></figure>`;
  }

  // The whole card in a window over the page (used from the track view's corner list).
  function modal(c, data, surf) {
    const card = cornerCard(c, data, surf);
    if (!card) return;
    const el = document.createElement("div");
    el.className = "fig-modal";
    el.innerHTML = `<div class="fig-modal-box"><button type="button" class="fig-close btn tiny" aria-label="Close">Close</button>${card}</div>`;
    const close = () => { el.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
    el.querySelector(".fig-close").addEventListener("click", close);
    el.querySelector(".fig-save").addEventListener("click", () => savePng(el.querySelector(".fig")));
    document.addEventListener("keydown", onKey);
    document.body.appendChild(el);
  }

  // Download a figure card as one PNG.
  function savePng(figure) {
    const svgs = [...figure.querySelectorAll("svg")];
    const width = 640, heights = svgs.map((s) => (s.viewBox.baseVal.height * width) / s.viewBox.baseVal.width);
    const total = heights.reduce((a, b) => a + b, 0) + 8 * (svgs.length - 1);
    const scale = 2, canvas = document.createElement("canvas");
    canvas.width = width * scale; canvas.height = Math.round(total * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#121211"; ctx.fillRect(0, 0, width, total);
    let y = 0, done = 0;
    svgs.forEach((svg, i) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, y0(i), width, heights[i]);
        if (++done === svgs.length) {
          const a = document.createElement("a");
          a.download = `corner-${figure.dataset.corner}.png`;
          a.href = canvas.toDataURL("image/png");
          a.click();
        }
      };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.outerHTML);
    });
    function y0(i) { return heights.slice(0, i).reduce((a, b) => a + b + 8, 0); }
  }

  return { cornerCard, cornerFigure, inputsStrip, modal, tips, savePng, name, SURFACE_COLORS, SURFACE_NAMES };
})();
