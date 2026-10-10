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

  // ------------------------------------------------------------------- input timeline

  // The runs a driver pressed through a corner, drawn along metres from the corner's start.
  function inputsStrip(c, W = 640, opts = {}) {
    const inputs = c.phases && c.phases.inputs;
    if (!inputs) return "";
    const ROW = 20, top = 26, left = 112, right = 12, plotW = W - left - right;
    const rows = [
      ["Steering, ghost", inputs.reference, "steer"], ["Steering, you", inputs.subject, "steer"],
      ["Brake, ghost", inputs.reference, "brake"], ["Brake, you", inputs.subject, "brake"],
      ["Lift, ghost", inputs.reference, "lift"], ["Lift, you", inputs.subject, "lift"],
    ];
    const all = [...inputs.reference, ...inputs.subject];
    const lo = Math.min(-60, ...all.map((r) => r.from_m));
    const hi = Math.max(c.distance_end - c.distance_start + 10, ...all.map((r) => r.to_m)) + 4;
    const X = (m) => left + ((m - lo) / (hi - lo)) * plotW;
    const H = top + rows.length * ROW + 24;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Inputs through corner ${c.corner_index}" font-family="Barlow, system-ui, sans-serif">`;
    if (!opts.bare) s += `<rect width="${W}" height="${H}" fill="${PANEL}" rx="8"/>`;
    s += text("Inputs (metres from the corner's start)", 12, 13, { size: 12, fill: MUTED, weight: 500, halo: 0 });
    // corner span and ticks
    s += `<rect x="${f1(X(0))}" y="${top - 2}" width="${f1(X(c.distance_end - c.distance_start) - X(0))}" height="${rows.length * ROW + 4}" fill="rgba(240,237,230,0.06)"/>`;
    for (let m = Math.ceil(lo / 25) * 25; m <= hi; m += 25) {
      s += `<line x1="${f1(X(m))}" y1="${top - 2}" x2="${f1(X(m))}" y2="${top + rows.length * ROW + 2}" stroke="${LINE}"/>`;
      s += text(`${m} m`, X(m), top + rows.length * ROW + 14, { size: 10, fill: MUTED, anchor: "middle", weight: 400, halo: 0 });
    }
    rows.forEach(([label, list, kind], i) => {
      const y = top + i * ROW;
      s += text(label, 8, y + ROW / 2, { size: 11, fill: i % 2 ? INK : "#9ec8ff", weight: 500, halo: 0 });
      s += `<line x1="${left}" y1="${y + ROW - 1}" x2="${W - right}" y2="${y + ROW - 1}" stroke="${LINE}"/>`;
      for (const r of list.filter((x) => x.kind === kind)) {
        const x0 = X(r.from_m), w = Math.max(2, X(r.to_m) - x0);
        if (kind === "steer") {
          const h = 4 + Math.min(1, r.avg) * (ROW - 8);
          const col = r.dir === "right" ? "#f4a259" : "#7dd3c0";
          s += `<rect x="${f1(x0)}" y="${f1(y + (ROW - h) / 2)}" width="${f1(w)}" height="${f1(h)}" rx="2" fill="${col}"/>`;
          if (w > 26) s += text(`${r.dir === "right" ? "R" : "L"} ${r.avg.toFixed(2)}`, x0 + w / 2, y + ROW / 2, { size: 9, fill: "#151a00", anchor: "middle", halo: 0 });
        } else if (kind === "brake") {
          s += `<rect x="${f1(x0)}" y="${y + 3}" width="${f1(w)}" height="${ROW - 7}" rx="2" fill="#ff6252"/>`;
          if (w > 30) s += text(`${r.dur_s.toFixed(2)}s`, x0 + w / 2, y + ROW / 2, { size: 9, fill: "#2a0a07", anchor: "middle", halo: 0 });
        } else {
          s += `<rect x="${f1(x0)}" y="${y + 3}" width="${f1(w)}" height="${ROW - 7}" rx="2" fill="#f0b429"/>`;
        }
      }
    });
    s += `</svg>`;
    return s;
  }

  // ------------------------------------------------------------------- the corner picture

  function cornerFigure(c, data, surf, W = 640) {
    const pts = data.points;
    const i0 = Math.max(0, pts.findIndex((p) => p.distance_m >= c.distance_start - 90));
    let i1 = pts.length - 1;
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i].distance_m <= c.distance_end + 50) { i1 = i; break; }
    const seg = pts.slice(i0, i1 + 1);
    if (seg.length < 3) return "";
    const H = 360, pad = 34, top = 56;
    // fit everything we draw into the picture, z down
    const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const add = (x, z) => { box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x); box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z); };
    seg.forEach((p) => { add(p.x, p.z); add(p.reference_x, p.reference_z); });
    if (c.phases) for (const side of ["subject", "reference"]) for (const k of KINDS) { const ph = c.phases[side][k.key]; if (ph) add(ph.x, ph.z); }
    const dx = Math.max(10, box.maxX - box.minX), dz = Math.max(10, box.maxZ - box.minZ);
    const k = Math.min((W - pad * 2) / dx, (H - top - pad) / dz);
    const ox = (W - dx * k) / 2, oz = top + (H - top - pad - dz * k) / 2;
    const P = (x, z) => [ox + (x - box.minX) * k, oz + (z - box.minZ) * k];
    const line = (arr, xk, zk) => arr.map((p, i) => { const [x, y] = P(p[xk], p[zk]); return `${i ? "L" : "M"}${f1(x)} ${f1(y)}`; }).join(" ");

    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Corner ${c.corner_index}, your line against the ghost's" font-family="Barlow, system-ui, sans-serif">`;
    s += `<rect width="${W}" height="${H}" fill="${PANEL}" rx="8"/>`;

    // surface under the road, as a wide soft band
    if (surf && surf.length === pts.length) {
      const used = new Set();
      for (let i = Math.max(1, i0); i <= i1; i++) {
        const a = pts[i - 1], b = pts[i], sfc = surf[i] || "unknown";
        used.add(sfc);
        const [x0, y0] = P(a.x, a.z), [x1, y1] = P(b.x, b.z);
        s += `<line x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(x1)}" y2="${f1(y1)}" stroke="${SURFACE_COLORS[sfc] || "#555"}" stroke-opacity="0.32" stroke-width="22" stroke-linecap="round"/>`;
      }
      let lx = W - 12;
      [...used].reverse().forEach((u) => {
        const label = SURFACE_NAMES[u] || u;
        s += text(label, lx, 30, { size: 11, fill: MUTED, anchor: "end", weight: 500, halo: 0 });
        lx -= label.length * 6.4 + 22;
        s += `<circle cx="${f1(lx + 8)}" cy="30" r="5" fill="${SURFACE_COLORS[u] || "#555"}"/>`;
      });
    }

    // the ghost's line (dashed) and yours
    s += `<path d="${line(seg, "reference_x", "reference_z")}" fill="none" stroke="${GHOST}" stroke-width="3" stroke-dasharray="9 6" stroke-linecap="round" stroke-linejoin="round"/>`;
    s += `<path d="${line(seg, "x", "z")}" fill="none" stroke="${INK}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    // direction arrows along your line
    for (let i = 3; i < seg.length - 3; i += Math.max(4, Math.floor(seg.length / 6))) {
      const [x, y] = P(seg[i].x, seg[i].z), [x2, y2] = P(seg[i + 2].x, seg[i + 2].z);
      const a = (Math.atan2(y2 - y, x2 - x) * 180) / Math.PI;
      s += `<polygon points="6,0 -5,-5 -5,5" transform="translate(${f1(x)} ${f1(y)}) rotate(${f1(a)})" fill="${PANEL}" stroke="${INK}" stroke-width="1.2"/>`;
    }

    // distance ticks leading into the corner
    for (const m of [25, 50, 75, 100]) {
      const d = c.distance_start - m;
      let idx = pts.findIndex((p) => p.distance_m >= d);
      if (idx < 1 || d < 0) continue;
      const [x, y] = P(pts[idx].x, pts[idx].z), [x2, y2] = P(pts[Math.min(pts.length - 1, idx + 2)].x, pts[Math.min(pts.length - 1, idx + 2)].z);
      const len = Math.hypot(x2 - x, y2 - y) || 1, nx = -(y2 - y) / len, ny = (x2 - x) / len;
      s += `<line x1="${f1(x - nx * 11)}" y1="${f1(y - ny * 11)}" x2="${f1(x + nx * 11)}" y2="${f1(y + ny * 11)}" stroke="${INK}" stroke-opacity="0.75" stroke-width="2"/>`;
      if ((m === 25 || m === 50 || m === 100) && y + ny * 15 > top + 16) s += text(`${m} m before`, x + nx * 15, y + ny * 15, { size: 10, fill: "#bdb9af", anchor: nx >= 0 ? "start" : "end", weight: 500 });
    }

    // the four points: ring = ghost, dot = you, joined, labelled in a staggered column
    if (c.phases) {
      for (const kd of KINDS) {
        const g = c.phases.reference[kd.key], y = c.phases.subject[kd.key];
        if (g && y) {
          const [gx, gy] = P(g.x, g.z), [px, py] = P(y.x, y.z);
          s += `<line x1="${f1(gx)}" y1="${f1(gy)}" x2="${f1(px)}" y2="${f1(py)}" stroke="${kd.color}" stroke-opacity="0.6" stroke-width="2" stroke-dasharray="4 4"/>`;
        }
      }
      KINDS.forEach((kd, idx) => {
        const g = c.phases.reference[kd.key], y = c.phases.subject[kd.key];
        if (g) {
          const [gx, gy] = P(g.x, g.z);
          const ly = gy - 44 + idx * 16;
          s += `<line x1="${f1(gx + 6)}" y1="${f1(gy - 6)}" x2="${f1(gx + 22)}" y2="${f1(ly)}" stroke="${kd.color}" stroke-opacity="0.55"/>`;
          s += `<circle cx="${f1(gx)}" cy="${f1(gy)}" r="8" fill="${PANEL}" fill-opacity="0.75" stroke="${kd.color}" stroke-width="3"/>`;
          s += text(`${kd.label}  ${km(g.speed)}`, gx + 26, ly, { size: 11, fill: kd.color });
        }
        if (y) {
          const [px, py] = P(y.x, y.z);
          s += `<circle cx="${f1(px)}" cy="${f1(py)}" r="5" fill="${kd.color}" stroke="${PANEL}" stroke-width="2"/>`;
        }
      });
    }

    // title
    const sub = c.phases ? c.phases.subject : null;
    s += text(`Corner ${c.corner_index}  ·  ${name(c)} ${c.turn_deg}°  ·  ${Math.round(c.distance_start)}–${Math.round(c.distance_end)} m`, 14, 16, { size: 15, weight: 700, halo: 0 });
    s += text(`${secs(c.time_change_ms)} in this corner  ·  slowest ${km(c.subject_min_speed)} (you) vs ${km(c.reference_min_speed)} (ghost)`, 14, 36, { size: 12, fill: c.time_change_ms > 0 ? "#ff6252" : "#3dd68c", weight: 500, halo: 0 });
    // legend
    s += `<line x1="14" y1="${H - 16}" x2="40" y2="${H - 16}" stroke="${INK}" stroke-width="4.5" stroke-linecap="round"/>` + text("you", 46, H - 16, { size: 11, fill: MUTED, weight: 500, halo: 0 });
    s += `<line x1="86" y1="${H - 16}" x2="112" y2="${H - 16}" stroke="${GHOST}" stroke-width="3" stroke-dasharray="7 5"/>` + text("ghost", 118, H - 16, { size: 11, fill: MUTED, weight: 500, halo: 0 });
    s += text("ring = ghost, dot = you", 176, H - 16, { size: 11, fill: MUTED, weight: 500, halo: 0 });
    // scale bar
    const bar = [10, 20, 25, 50, 100, 200].find((v) => v * k >= 70) || 200;
    s += `<line x1="${W - 14 - bar * k}" y1="${H - 16}" x2="${W - 14}" y2="${H - 16}" stroke="${INK}" stroke-width="2"/>` + text(`${bar} m`, W - 14 - (bar * k) / 2, H - 28, { size: 11, anchor: "middle", fill: MUTED, weight: 500, halo: 0 });
    s += `</svg>`;
    return s;
  }

  // A figure card: the corner picture on top, the input timeline under it.
  function cornerCard(c, data, surf) {
    const pic = cornerFigure(c, data, surf);
    if (!pic) return "";
    return `<figure class="fig" data-corner="${c.corner_index}">${pic}${inputsStrip(c, 640)}
      <figcaption><span>Corner ${c.corner_index}: your line against the ghost's, and what each of you pressed.</span>
      <button type="button" class="btn tiny fig-save">Save image</button></figcaption></figure>`;
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

  return { cornerCard, cornerFigure, inputsStrip, savePng, name, SURFACE_COLORS, SURFACE_NAMES };
})();
