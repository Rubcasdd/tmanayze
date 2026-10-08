"use strict";

// The track view: the whole track with both runs drawn on it, in 3D (orbit it,
// heights included) or as a flat map. It lives in two places: the "Track" tab of
// the map workspace, and a full page (#/map/<uid>/track). Select a corner to fly
// in and see exactly where to brake, turn in, hit the apex and get back on the
// throttle; replay both runs side by side; see the elevation profile and jumps.
//
// Relies on app.js for shared state and helpers (state, $, $$, esc, tmName...).

const TRACK_KINDS = [
  { key: "brake", label: "Brake", color: "#f0b429" },
  { key: "turn_in", label: "Turn in", color: "#3dd68c" },
  { key: "apex", label: "Apex", color: "#f0ede6" },
  { key: "exit", label: "Back on throttle", color: "#4aa3ff" },
];

const TV_TEMPLATE = `
<div class="tv-bar">
  <a class="btn quiet tv-back" hidden>&larr; Back to analysis</a>
  <h2 class="tv-title" hidden></h2>
  <div class="seg tv-dim" role="group" aria-label="View"><button type="button" class="on" data-dim="3d">3D</button><button type="button" data-dim="2d">2D map</button></div>
  <div class="seg tv-color" role="group" aria-label="Colour your line by"><button type="button" class="on" data-mode="time">Time</button><button type="button" data-mode="speed">Speed</button><button type="button" data-mode="pedals">Pedals</button></div>
  <label class="tv-check"><input type="checkbox" class="tv-ghost" checked /> Ghost lines</label>
  <label class="tv-check"><input type="checkbox" class="tv-markers" checked /> Markers</label>
  <label class="tv-check"><input type="checkbox" class="tv-ticks" checked /> Distances</label>
  <label class="tv-check"><input type="checkbox" class="tv-jumps" checked /> Jumps</label>
  <label class="tv-check tv-height">Height <select class="tv-yex"><option value="1">×1</option><option value="2" selected>×2</option><option value="4">×4</option></select></label>
  <span class="tv-spacer"></span>
  <button type="button" class="btn quiet tv-zoom-out" aria-label="Zoom out">&minus;</button>
  <button type="button" class="btn quiet tv-zoom-in" aria-label="Zoom in">+</button>
  <button type="button" class="btn quiet tv-fit">Fit</button>
  <a class="btn quiet tv-open" hidden>Full page &#8599;</a>
  <button type="button" class="btn quiet tv-fs">Full screen</button>
</div>
<div class="tv-body">
  <div class="tv-stage">
    <canvas class="tv-canvas"></canvas>
    <div class="tv-empty" hidden><h2>Nothing to draw yet</h2><p>Pick your run and a ghost in the list on the left first, then come back.</p></div>
    <div class="tv-legend"></div>
    <div class="tv-play">
      <button type="button" class="btn tv-playbtn" aria-label="Play">&#9654;</button>
      <input type="range" class="tv-scrub" min="0" max="1000" value="0" aria-label="Replay position" />
      <span class="tv-clock">0.0 s</span>
      <span class="tv-gap"></span>
      <select class="tv-speed" aria-label="Replay speed"><option value="0.25">×0.25</option><option value="0.5">×0.5</option><option value="1" selected>×1</option><option value="2">×2</option><option value="4">×4</option></select>
      <label class="tv-check"><input type="checkbox" class="tv-follow" /> Follow</label>
    </div>
    <div class="tv-help">Drag to rotate (right-drag to move), scroll to zoom, double-click to fit. Select a corner on the right.</div>
  </div>
  <aside class="tv-panel"></aside>
</div>
<div class="tv-tip" hidden></div>`;

class TrackView {
  constructor(root, { embedded }) {
    this.root = root;
    this.embedded = embedded;
    root.classList.add("tv");
    root.classList.toggle("tv-embedded", embedded);
    root.innerHTML = TV_TEMPLATE;
    this.q = (sel) => root.querySelector(sel);
    this.canvas = this.q(".tv-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.W = 0;
    this.H = 0;
    this.dim = "3d";
    this.mode = "time";
    this.opt = { ghosts: true, markers: true, ticks: true, jumps: true, yex: 2, follow: false };
    this.sel = null;
    this.view2 = { cx: 0, cz: 0, scale: 1 };
    this.cam = { tx: 0, ty: 0, tz: 0, yaw: 0.5, pitch: 0.7, dist: 1500 };
    this.anim = 0;
    this.drag = null;
    this.hoverDist = null;
    this.colors = [];
    this.play = { on: false, t: 0, speed: 1, last: 0, raf: 0 };
    this.data = null;
    this.bind();
  }

  // ------------------------------------------------------------------ data

  load() {
    const c = state.compare;
    if (!c) return (this.data = null);
    const pid = c.ids.includes(state.primaryRefId) ? state.primaryRefId : c.ids[0];
    const d = c.data[pid];
    if (!d || !d.stats.telemetry || !d.points.length) return (this.data = null);
    const pts = d.points;
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      minY = Math.min(minY, p.y, p.reference_y);
      maxY = Math.max(maxY, p.y, p.reference_y);
    }
    let up = 0, down = 0;
    for (let i = 4; i < pts.length; i += 4) {
      const dy = pts[i].y - pts[i - 4].y;
      if (dy > 0.3) up += dy;
      else if (dy < -0.3) down -= dy;
    }
    const refPath = d.reference_path || [];
    this.data = {
      all: c.data, ids: c.ids.filter((id) => c.data[id].stats.telemetry), pid, primary: d, pts,
      corners: d.corners, minY, maxY, up, down,
      subjectPath: pts.map((p) => [p.t_ms, p.x, p.y, p.z]),
      refPath,
      tMax: Math.max(pts[pts.length - 1].t_ms, refPath.length ? refPath[refPath.length - 1][0] : 0),
      flights: { you: d.subject_flights || [], ghost: d.reference_flights || [] },
    };
    return this.data;
  }

  box() {
    const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const p of this.data.pts) {
      b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
      b.minZ = Math.min(b.minZ, p.z); b.maxZ = Math.max(b.maxZ, p.z);
    }
    return b;
  }

  cornerBox(c) {
    const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const add = (x, z) => {
      b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
      b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z);
    };
    for (const p of this.data.pts) if (p.distance_m >= c.distance_start - 90 && p.distance_m <= c.distance_end + 40) add(p.x, p.z);
    if (c.phases) for (const side of ["subject", "reference"]) for (const k of TRACK_KINDS) {
      const ph = c.phases[side][k.key];
      if (ph) add(ph.x, ph.z);
    }
    return b;
  }

  // -------------------------------------------------------------- projection

  setup() {
    if (this.dim === "2d") return;
    const c = this.cam, cp = Math.cos(c.pitch), sp = Math.sin(c.pitch), sy = Math.sin(c.yaw), cy = Math.cos(c.yaw);
    this.cb = {
      C: [c.tx + c.dist * sy * cp, c.ty + c.dist * sp, c.tz + c.dist * cy * cp],
      f: [-sy * cp, -sp, -cy * cp],
      r: [cy, 0, -sy],
      u: [-sy * sp, cp, -cy * sp],
      focal: (this.H / 2) / Math.tan(0.4),
    };
  }

  // -> [screenX, screenY, pixelsPerMetre, depth], or null when behind the camera
  P(x, y, z) {
    if (this.dim === "2d") {
      const v = this.view2;
      return [(x - v.cx) * v.scale + this.W / 2, (z - v.cz) * v.scale + this.H / 2, v.scale, 0];
    }
    const { C, f, r, u, focal } = this.cb;
    const vx = x - C[0], vy = y * this.opt.yex - C[1], vz = z - C[2];
    const zc = vx * f[0] + vy * f[1] + vz * f[2];
    if (zc < 2) return null;
    const xc = vx * r[0] + vz * r[2];
    const yc = vx * u[0] + vy * u[1] + vz * u[2];
    return [this.W / 2 + (xc / zc) * focal, this.H / 2 - (yc / zc) * focal, focal / zc, zc];
  }

  fitView() {
    const b = this.box();
    const dx = Math.max(10, b.maxX - b.minX), dz = Math.max(10, b.maxZ - b.minZ);
    if (this.dim === "2d") {
      return { cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2, scale: Math.min(this.W / (dx * 1.25), this.H / (dz * 1.25)) };
    }
    const cy = ((this.data.minY + this.data.maxY) / 2) * this.opt.yex;
    const radius = Math.hypot(dx, dz, (this.data.maxY - this.data.minY) * this.opt.yex) / 2;
    return { tx: (b.minX + b.maxX) / 2, ty: cy, tz: (b.minZ + b.maxZ) / 2, yaw: 0.45, pitch: 0.75, dist: Math.max(80, (radius * 0.95) / Math.sin(0.4)) };
  }

  cornerView(c) {
    const b = this.cornerBox(c);
    const dx = Math.max(10, b.maxX - b.minX), dz = Math.max(10, b.maxZ - b.minZ);
    if (this.dim === "2d") {
      return { cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2, scale: Math.min(this.W / (dx * 1.7), this.H / (dz * 1.7)) };
    }
    const ap = c.phases ? c.phases.reference.apex : null;
    const y = ap ? ap.y : this.data.minY;
    // look from behind, along the direction of travel into the corner
    const pts = this.data.pts;
    const i = Math.max(1, pts.findIndex((p) => p.distance_m >= c.distance_start - 10));
    const tx = pts[i].x - pts[Math.max(0, i - 3)].x, tz = pts[i].z - pts[Math.max(0, i - 3)].z;
    const radius = Math.hypot(dx, dz) / 2;
    return {
      tx: (b.minX + b.maxX) / 2, ty: y * this.opt.yex, tz: (b.minZ + b.maxZ) / 2,
      yaw: Math.atan2(-tx, -tz), pitch: 0.55, dist: Math.max(60, radius * 3.2),
    };
  }

  goTo(v, ms = 550) {
    cancelAnimationFrame(this.anim);
    const is2d = this.dim === "2d";
    const cur = is2d ? this.view2 : this.cam;
    const from = { ...cur };
    const keys = is2d ? ["cx", "cz"] : ["tx", "ty", "tz"];
    const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      for (const key of keys) cur[key] = from[key] + (v[key] - from[key]) * e;
      if (is2d) {
        cur.scale = from.scale * Math.pow(v.scale / from.scale, e);
      } else {
        cur.dist = from.dist * Math.pow(v.dist / from.dist, e);
        cur.pitch = from.pitch + (v.pitch - from.pitch) * e;
        cur.yaw = from.yaw + wrap(v.yaw - from.yaw) * e;
      }
      this.draw();
      if (k < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  // --------------------------------------------------------------- colouring

  buildColors() {
    const d = this.data;
    if (!d) return;
    const pts = d.pts, n = pts.length;
    const mix = (a, b, t) => {
      const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16)), pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
      return `rgb(${pa.map((v, k) => Math.round(v + (pb[k] - v) * t)).join(",")})`;
    };
    const cols = new Array(n).fill("#888");
    let legend = "";
    if (this.mode === "time") {
      const slope = pts.map((_, i) => {
        const a = Math.max(0, i - 4), b = Math.min(n - 1, i + 4);
        const dd = pts[b].distance_m - pts[a].distance_m;
        return dd > 0 ? ((pts[b].delta_ms - pts[a].delta_ms) / dd) * 100 : 0;
      });
      const sorted = slope.map(Math.abs).sort((x, y) => x - y);
      const scale = Math.max(5, sorted[Math.floor(sorted.length * 0.95)] || 5);
      slope.forEach((v, i) => {
        const t = Math.max(-1, Math.min(1, v / scale));
        cols[i] = t >= 0 ? mix("6b675f", "ff6252", t) : mix("6b675f", "3dd68c", -t);
      });
      legend = `<span>gaining time</span><span class="ramp" style="background:linear-gradient(90deg,#3dd68c,#6b675f,#ff6252)"></span><span>losing time</span>`;
    } else if (this.mode === "speed") {
      const v = pts.map((p) => p.subject_speed);
      const lo = Math.min(...v), hi = Math.max(...v);
      v.forEach((s, i) => (cols[i] = mix("27405f", "8fc2ff", (s - lo) / Math.max(1, hi - lo))));
      legend = `<span>${Math.round(lo)} km/h</span><span class="ramp" style="background:linear-gradient(90deg,#27405f,#8fc2ff)"></span><span>${Math.round(hi)} km/h</span>`;
    } else {
      pts.forEach((p, i) => (cols[i] = p.subject_brake > 0.1 ? "#ff6252" : p.subject_gas < 0.9 ? "#f0b429" : "#3dd68c"));
      legend = `<span><i style="background:#3dd68c"></i>full throttle</span><span><i style="background:#f0b429"></i>throttle lifted</span><span><i style="background:#ff6252"></i>braking</span>`;
    }
    this.colors = cols;
    this.q(".tv-legend").innerHTML = legend;
  }

  // ----------------------------------------------------------------- drawing

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.W = this.canvas.clientWidth;
    this.H = this.canvas.clientHeight;
    if (!this.W || !this.H) return false;
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  text(t, x, y, color = "#f0ede6", size = 12, align = "left") {
    const c = this.ctx;
    c.font = `600 ${size}px "Barlow", system-ui, sans-serif`;
    c.textAlign = align;
    c.textBaseline = "middle";
    c.lineWidth = 3;
    c.strokeStyle = "rgba(18,18,17,0.85)";
    c.strokeText(t, x, y);
    c.fillStyle = color;
    c.fillText(t, x, y);
  }

  pointAtDistance(d) {
    const pts = this.data.pts;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].distance_m < d) lo = m + 1; else hi = m; }
    return Math.max(1, lo);
  }

  draw() {
    const d = this.data;
    if (!d || !this.W) return;
    this.setup();
    const c = this.ctx, { pts, corners } = d, n = pts.length, is3d = this.dim === "3d";
    c.clearRect(0, 0, this.W, this.H);
    c.lineCap = "round";
    c.lineJoin = "round";
    const sel = this.sel !== null ? corners.find((x) => x.corner_index === this.sel) : null;
    const pp = pts.map((p) => this.P(p.x, p.y, p.z));

    if (is3d) this.drawGround(pp);

    // the ghosts' lines, under yours
    if (this.opt.ghosts) {
      d.ids.forEach((id) => {
        const gp = d.all[id].points;
        c.setLineDash([9, 6]);
        c.strokeStyle = ghostColor(id);
        c.lineWidth = id === d.pid ? 2.4 : 1.6;
        c.beginPath();
        let pen = false;
        for (const p of gp) {
          const s = this.P(p.reference_x, p.reference_y, p.reference_z);
          if (!s) { pen = false; continue; }
          if (pen) c.lineTo(s[0], s[1]); else c.moveTo(s[0], s[1]);
          pen = true;
        }
        c.stroke();
      });
      c.setLineDash([]);
    }

    // halo under the selected corner
    if (sel) {
      const i0 = this.pointAtDistance(sel.distance_start), i1 = this.pointAtDistance(sel.distance_end);
      c.strokeStyle = "rgba(240,237,230,0.22)";
      c.lineWidth = 22;
      c.beginPath();
      let pen = false;
      for (let i = i0; i <= i1; i++) {
        if (!pp[i]) { pen = false; continue; }
        if (pen) c.lineTo(pp[i][0], pp[i][1]); else c.moveTo(pp[i][0], pp[i][1]);
        pen = true;
      }
      c.stroke();
    }

    // your line, far to near so nearer parts overdraw
    const order = [];
    for (let i = 1; i < n; i++) if (pp[i] && pp[i - 1]) order.push(i);
    if (is3d) order.sort((a, b) => pp[b][3] + pp[b - 1][3] - (pp[a][3] + pp[a - 1][3]));
    for (const i of order) {
      const a = pp[i - 1], b = pp[i];
      c.strokeStyle = this.colors[i] || "#888";
      c.lineWidth = Math.max(2.5, Math.min(is3d ? 15 : 8, 2.6 * ((a[2] + b[2]) / 2)));
      c.beginPath();
      c.moveTo(a[0], a[1]);
      c.lineTo(b[0], b[1]);
      c.stroke();
    }

    if (this.opt.jumps) this.drawJumps();

    // direction arrows
    c.fillStyle = "rgba(240,237,230,0.55)";
    for (let i = 12; i < n - 1; i += 28) {
      if (!pp[i] || !pp[i + 1]) continue;
      const a = Math.atan2(pp[i + 1][1] - pp[i][1], pp[i + 1][0] - pp[i][0]);
      c.save();
      c.translate(pp[i][0], pp[i][1]);
      c.rotate(a);
      c.beginPath(); c.moveTo(5, 0); c.lineTo(-4, -4); c.lineTo(-4, 4); c.closePath(); c.fill();
      c.restore();
    }

    if (sel && this.opt.ticks) this.drawTicks(sel, pp);
    this.drawBadges(sel);

    const s0 = pp[0], s1 = pp[n - 1];
    if (s0) { c.fillStyle = "#f0ede6"; c.beginPath(); c.arc(s0[0], s0[1], 6, 0, 6.3); c.fill(); this.text("START", s0[0] + 10, s0[1]); }
    if (s1) { c.strokeStyle = "#d4f03c"; c.lineWidth = 3; c.strokeRect(s1[0] - 6, s1[1] - 6, 12, 12); this.text("FINISH", s1[0] + 10, s1[1], "#d4f03c"); }

    if (sel && sel.phases && this.opt.markers) this.drawMarkers(sel);
    this.drawReplay();

    if (this.hoverDist !== null) {
      const i = this.pointAtDistance(this.hoverDist);
      if (pp[i]) {
        c.beginPath(); c.arc(pp[i][0], pp[i][1], 7, 0, 6.3); c.fillStyle = "#f0ede6"; c.fill();
        c.lineWidth = 2; c.strokeStyle = "#121211"; c.stroke();
      }
    }
    if (!is3d) this.drawScaleBar();
    this.drawProfile();
  }

  // the ground grid, the track's shadow and posts down to it: the cues that make 3D readable
  drawGround(pp) {
    const c = this.ctx, d = this.data, b = this.box();
    const y0 = d.minY - 2;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const step = span > 2400 ? 400 : span > 1000 ? 200 : 100;
    const x0 = Math.floor((b.minX - span * 0.08) / step) * step, x1 = Math.ceil((b.maxX + span * 0.08) / step) * step;
    const z0 = Math.floor((b.minZ - span * 0.08) / step) * step, z1 = Math.ceil((b.maxZ + span * 0.08) / step) * step;
    c.lineWidth = 1;
    c.strokeStyle = "rgba(240,237,230,0.07)";
    c.beginPath();
    for (let x = x0; x <= x1; x += step) {
      const a = this.P(x, y0, z0), e = this.P(x, y0, z1);
      if (a && e) { c.moveTo(a[0], a[1]); c.lineTo(e[0], e[1]); }
    }
    for (let z = z0; z <= z1; z += step) {
      const a = this.P(x0, y0, z), e = this.P(x1, y0, z);
      if (a && e) { c.moveTo(a[0], a[1]); c.lineTo(e[0], e[1]); }
    }
    c.stroke();
    const pts = d.pts;
    c.strokeStyle = "rgba(0,0,0,0.5)";
    c.lineWidth = 2;
    c.beginPath();
    let pen = false;
    for (const p of pts) {
      const s = this.P(p.x, y0, p.z);
      if (!s) { pen = false; continue; }
      if (pen) c.lineTo(s[0], s[1]); else c.moveTo(s[0], s[1]);
      pen = true;
    }
    c.stroke();
    c.strokeStyle = "rgba(240,237,230,0.1)";
    c.beginPath();
    for (let i = 0; i < pts.length; i += 7) {
      const a = pp[i], g = this.P(pts[i].x, y0, pts[i].z);
      if (a && g) { c.moveTo(a[0], a[1]); c.lineTo(g[0], g[1]); }
    }
    c.stroke();
  }

  drawTicks(sel, pp) {
    const c = this.ctx, pts = this.data.pts;
    for (const k of [1, 2, 3, 4, 6, 8]) {
      const dist = sel.distance_start - 25 * k;
      if (dist < 0) break;
      const i = this.pointAtDistance(dist), j = Math.min(pts.length - 1, i + 2);
      const a = pp[i], b = pp[j];
      if (!a || !b) continue;
      const vx = b[0] - a[0], vy = b[1] - a[1], len = Math.hypot(vx, vy) || 1, nx = -vy / len, ny = vx / len;
      c.strokeStyle = "rgba(240,237,230,0.8)";
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(a[0] - nx * 12, a[1] - ny * 12); c.lineTo(a[0] + nx * 12, a[1] + ny * 12); c.stroke();
      if ([1, 2, 4, 8].includes(k)) this.text(`${25 * k} m before`, a[0] + nx * 16, a[1] + ny * 16, "#bdb9af", 11);
    }
  }

  drawBadges(sel) {
    const c = this.ctx;
    this.data.corners.forEach((cor) => {
      const ap = cor.phases && cor.phases.reference.apex;
      if (!ap) return;
      const s = this.P(ap.x, ap.y, ap.z);
      if (!s) return;
      const on = sel && sel.corner_index === cor.corner_index, r = on ? 14 : 11, yy = s[1] - (on ? 28 : 20);
      c.beginPath(); c.arc(s[0], yy, r, 0, 6.3);
      c.fillStyle = on ? "#d4f03c" : "rgba(18,18,17,0.88)";
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = on ? "#d4f03c" : "rgba(240,237,230,0.6)";
      c.stroke();
      this.text(String(cor.corner_index), s[0], yy, on ? "#151a00" : "#f0ede6", on ? 14 : 11, "center");
    });
  }

  drawMarkers(sel) {
    const c = this.ctx;
    for (const k of TRACK_KINDS) {
      const g = sel.phases.reference[k.key], s = sel.phases.subject[k.key];
      if (!g || !s) continue;
      const a = this.P(g.x, g.y, g.z), b = this.P(s.x, s.y, s.z);
      if (!a || !b) continue;
      c.strokeStyle = k.color;
      c.globalAlpha = 0.55;
      c.lineWidth = 2;
      c.setLineDash([4, 4]);
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
    }
    TRACK_KINDS.forEach((k, idx) => {
      const g = sel.phases.reference[k.key], s = sel.phases.subject[k.key];
      if (g) {
        const a = this.P(g.x, g.y, g.z);
        if (a) {
          c.beginPath(); c.arc(a[0], a[1], 9, 0, 6.3); c.fillStyle = "rgba(18,18,17,0.7)"; c.fill();
          c.lineWidth = 3; c.strokeStyle = k.color; c.stroke();
          const ly = a[1] - 46 + idx * 17;
          c.strokeStyle = k.color; c.globalAlpha = 0.5; c.lineWidth = 1;
          c.beginPath(); c.moveTo(a[0] + 7, a[1] - 7); c.lineTo(a[0] + 22, ly); c.stroke();
          c.globalAlpha = 1;
          this.text(`${k.label.toUpperCase()}  ${Math.round(g.speed)} km/h`, a[0] + 26, ly, k.color, 12);
        }
      }
      if (s) {
        const b = this.P(s.x, s.y, s.z);
        if (b) {
          c.beginPath(); c.arc(b[0], b[1], 6, 0, 6.3); c.fillStyle = k.color; c.fill();
          c.lineWidth = 2; c.strokeStyle = "#121211"; c.stroke();
        }
      }
    });
  }

  // jumps: an arc from take-off to landing, white for you and blue for the ghost
  drawJumps() {
    const c = this.ctx, d = this.data;
    const arc = (f, color, label) => {
      const a = this.P(f.x, f.y, f.z), b = this.P(f.end_x, f.end_y, f.end_z);
      const mid = this.P((f.x + f.end_x) / 2, Math.max(f.y, f.end_y) + Math.max(2, f.height_m), (f.z + f.end_z) / 2);
      if (!a || !b || !mid) return;
      c.strokeStyle = color;
      c.lineWidth = 3;
      c.setLineDash([2, 5]);
      c.beginPath();
      c.moveTo(a[0], a[1]);
      c.quadraticCurveTo(mid[0] * 2 - (a[0] + b[0]) / 2, mid[1] * 2 - (a[1] + b[1]) / 2, b[0], b[1]);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = color;
      c.beginPath(); c.moveTo(a[0], a[1] - 9); c.lineTo(a[0] - 5, a[1] - 1); c.lineTo(a[0] + 5, a[1] - 1); c.closePath(); c.fill();
      if (label) this.text(label, mid[0], mid[1] - 10, color, 11, "center");
    };
    d.flights.ghost.forEach((f) => arc(f, "#4aa3ff", ""));
    d.flights.you.forEach((f) => arc(f, "#f0ede6", `${f.duration_s.toFixed(1)} s air`));
  }

  // replay: both cars at the same moment of the race
  posAt(arr, t) {
    if (!arr.length) return null;
    if (t <= arr[0][0]) return arr[0];
    if (t >= arr[arr.length - 1][0]) return arr[arr.length - 1];
    let lo = 0, hi = arr.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m][0] <= t) lo = m; else hi = m; }
    const a = arr[lo], b = arr[hi], k = (t - a[0]) / Math.max(1, b[0] - a[0]);
    return [t, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
  }

  drawReplay() {
    const d = this.data, c = this.ctx;
    if (!this.play.on && this.play.t === 0) return;
    const t = this.play.t;
    const you = this.posAt(d.subjectPath, t), ghost = this.posAt(d.refPath, t);
    const dot = (p, color, r, ring) => {
      if (!p) return;
      const s = this.P(p[1], p[2], p[3]);
      if (!s) return;
      c.beginPath(); c.arc(s[0], s[1], r + 3, 0, 6.3); c.fillStyle = "rgba(18,18,17,0.85)"; c.fill();
      c.beginPath(); c.arc(s[0], s[1], r, 0, 6.3);
      if (ring) { c.lineWidth = 3; c.strokeStyle = color; c.stroke(); } else { c.fillStyle = color; c.fill(); }
    };
    for (const [arr, color] of [[d.subjectPath, "#f0ede6"], [d.refPath, "#4aa3ff"]]) {
      c.strokeStyle = color;
      c.globalAlpha = 0.55;
      c.lineWidth = 3;
      c.beginPath();
      let pen = false;
      for (let k = 0; k <= 8; k++) {
        const p = this.posAt(arr, Math.max(0, t - (8 - k) * 160));
        const s = p && this.P(p[1], p[2], p[3]);
        if (!s) { pen = false; continue; }
        if (pen) c.lineTo(s[0], s[1]); else c.moveTo(s[0], s[1]);
        pen = true;
      }
      c.stroke();
      c.globalAlpha = 1;
    }
    dot(ghost, "#4aa3ff", 8, true);
    dot(you, "#f0ede6", 7, false);
    if (you) {
      let lo = 0, hi = d.pts.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (d.pts[m].t_ms < t) lo = m + 1; else hi = m; }
      const p = d.pts[lo], gap = p.delta_ms, el = this.q(".tv-gap");
      el.textContent = `${gap > 0 ? "+" : gap < 0 ? "−" : ""}${(Math.abs(gap) / 1000).toFixed(3)} s · ${Math.round(p.subject_speed)} km/h`;
      el.className = `tv-gap ${gap > 0 ? "loss" : "gain"}`;
      if (this.opt.follow) this.followYou(you, d.pts[Math.max(0, lo - 2)], p);
    }
  }

  followYou(you, a, b) {
    if (this.dim === "2d") { this.view2.cx = you[1]; this.view2.cz = you[3]; return; }
    const cam = this.cam;
    cam.tx = you[1];
    cam.ty = you[2] * this.opt.yex;
    cam.tz = you[3];
    const tx = b.x - a.x, tz = b.z - a.z;
    if (Math.hypot(tx, tz) > 0.05) {
      let diff = Math.atan2(-tx, -tz) - cam.yaw;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      cam.yaw += diff * 0.08;
    }
  }

  drawScaleBar() {
    const c = this.ctx, scale = this.view2.scale, target = 120 / scale;
    const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((v) => v >= target) || 1000;
    const px = nice * scale, x = 20, y = this.H - 24;
    c.strokeStyle = "#f0ede6";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x, y); c.lineTo(x + px, y);
    c.moveTo(x, y - 5); c.lineTo(x, y + 5);
    c.moveTo(x + px, y - 5); c.lineTo(x + px, y + 5);
    c.stroke();
    this.text(`${nice} m`, x + px / 2, y - 12, "#f0ede6", 12, "center");
  }

  // ---------------------------------------------------------------- the panel

  corName(c) {
    const deg = c.turn_deg, span = c.distance_end - c.distance_start, side = c.direction;
    if (deg >= 120) return "hairpin";
    if (deg < 25) return `gentle ${side} bend`;
    if (span >= 60 && deg < 90) return `${side} sweeper`;
    return `${side} turn`;
  }

  fmtSec(ms) { return `${ms > 0 ? "+" : ms < 0 ? "−" : ""}${(Math.abs(ms) / 1000).toFixed(2)}s`; }
  fmtM(v) { return `${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : 1)} m`; }
  fmtKm(v) { return `${Math.round(v)} km/h`; }

  when(delta) {
    if (delta === null || delta === undefined) return "–";
    if (Math.abs(delta) < 1.5) return "about the same spot";
    return `${this.fmtM(delta)} ${delta > 0 ? "later" : "earlier"}`;
  }

  offsetText(o) {
    if (o === null || o === undefined || Math.abs(o) < 0.4) return "on the ghost's line";
    return `${this.fmtM(o)} ${o > 0 ? "tighter" : "wider"}`;
  }

  along(m) {
    if (Math.abs(m) < 1) return "at the corner start";
    return m > 0 ? `${m.toFixed(0)} m into the corner` : `${(-m).toFixed(0)} m before the corner`;
  }

  slopeText(c) {
    const g = c.grade_pct;
    if (g === undefined) return "";
    if (Math.abs(g) < 1) return "flat";
    return `${g > 0 ? "uphill" : "downhill"} ${Math.abs(g).toFixed(1)}% (${c.elevation_change_m > 0 ? "+" : "−"}${Math.abs(c.elevation_change_m).toFixed(0)} m)`;
  }

  cornerRows(c) {
    const p = c.phases;
    if (!p) return "";
    const g = p.reference, s = p.subject, gStart = c.reference_distance_start ?? 0;
    const rows = [
      ["Brake", g.brake ? `${this.fmtM(g.brake.metres_before)} before · ${this.fmtKm(g.brake.speed)}` : "doesn't brake", s.brake ? `${this.fmtM(s.brake.metres_before)} before · ${this.fmtKm(s.brake.speed)}` : "doesn't brake",
        g.brake && s.brake ? this.when(p.delta_m.brake) : g.brake ? "you don't brake" : s.brake ? "you brake, ghost doesn't" : "–"],
      ["Turn in", `${this.along(g.turn_in.distance_m - gStart)} · ${this.fmtKm(g.turn_in.speed)}`, `${this.along(s.turn_in.distance_m - c.distance_start)} · ${this.fmtKm(s.turn_in.speed)}`,
        `${this.when(p.delta_m.turn_in)}, ${this.offsetText(p.offset_m.turn_in)}`],
      ["Apex", this.fmtKm(g.apex.speed), this.fmtKm(s.apex.speed), `${this.when(p.delta_m.apex)}, ${this.offsetText(p.offset_m.apex)}`],
      ["Back on throttle", `${this.along(g.exit.distance_m - gStart)} · ${this.fmtKm(g.exit.speed)}`, `${this.along(s.exit.distance_m - c.distance_start)} · ${this.fmtKm(s.exit.speed)}`,
        `${this.when(p.delta_m.exit)}, ${this.offsetText(p.offset_m.exit)}`],
    ];
    return rows.map((r, i) => `<tr><td><i style="background:${TRACK_KINDS[i].color}"></i>${r[0]}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join("");
  }

  advice(c) {
    const p = c.phases;
    if (!p) return { how: [], diffs: [] };
    const g = p.reference, s = p.subject, gStart = c.reference_distance_start ?? 0, dm = p.delta_m, how = [], diffs = [];
    how.push(g.brake ? `Approach: the ghost brakes ${this.fmtM(g.brake.metres_before)} before the corner at ${this.fmtKm(g.brake.speed)}.` : `Approach: the ghost doesn't brake for this corner (${this.fmtKm(g.turn_in.speed)} at turn-in).`);
    how.push(`Turn in ${this.along(g.turn_in.distance_m - gStart)}, at ${this.fmtKm(g.turn_in.speed)}.`);
    how.push(`Apex: ${this.fmtKm(g.apex.speed)} at the tightest point.`);
    how.push(`Exit: the ghost is straight and back on full throttle ${this.along(g.exit.distance_m - gStart)}, at ${this.fmtKm(g.exit.speed)}.`);
    if (dm.brake !== null && Math.abs(dm.brake) >= 4) diffs.push([Math.abs(dm.brake) * 1.2, `You start braking ${this.fmtM(dm.brake)} ${dm.brake > 0 ? "later" : "earlier"} than the ghost.`]);
    if (g.brake && !s.brake) diffs.push([30, "The ghost brakes here and you don't: check you aren't arriving too fast for its line."]);
    if (!g.brake && s.brake) diffs.push([30, "You brake here but the ghost doesn't: lift earlier or enter wider instead of braking."]);
    if (Math.abs(dm.turn_in) >= 4) diffs.push([Math.abs(dm.turn_in), `You turn in ${this.fmtM(dm.turn_in)} ${dm.turn_in > 0 ? "later" : "earlier"} than the ghost.`]);
    if (Math.abs(p.offset_m.apex) >= 1) diffs.push([Math.abs(p.offset_m.apex) * 6, `At the apex you are ${this.fmtM(p.offset_m.apex)} ${p.offset_m.apex > 0 ? "tighter (closer to the inside)" : "wider (further from the inside)"} than the ghost.`]);
    if (dm.exit >= 4) diffs.push([dm.exit * 1.5, `You are back on full throttle ${this.fmtM(dm.exit)} later than the ghost: straighten the car earlier so the throttle is fully available.`]);
    if (dm.exit <= -4) diffs.push([Math.abs(dm.exit), `You are back on the throttle ${this.fmtM(dm.exit)} earlier than the ghost, which is working for you.`]);
    if (s.apex.speed < g.apex.speed - 3) diffs.push([(g.apex.speed - s.apex.speed) * 1.5, `Your apex speed is ${Math.round(g.apex.speed - s.apex.speed)} km/h lower (${this.fmtKm(s.apex.speed)} vs ${this.fmtKm(g.apex.speed)}).`]);
    diffs.sort((a, b) => b[0] - a[0]);
    return { how, diffs: diffs.slice(0, 3).map((x) => x[1]) };
  }

  infoHtml() {
    const d = this.data, last = d.pts[d.pts.length - 1];
    const top = Math.max(...d.pts.map((p) => p.subject_speed));
    const tile = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
    return `<dl class="tv-info">
      ${tile("Length", `${(last.distance_m / 1000).toFixed(2)} km`)}
      ${tile("Corners", d.corners.length)}
      ${tile("Height", `${Math.round(d.minY)}–${Math.round(d.maxY)} m`)}
      ${tile("Climb / drop", `+${Math.round(d.up)} / −${Math.round(d.down)} m`)}
      ${tile("Jumps", `${d.flights.you.length} (ghost ${d.flights.ghost.length})`)}
      ${tile("Top speed", `${Math.round(top)} km/h`)}
    </dl>`;
  }

  distAt(tMs) {
    const pts = this.data.pts;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].t_ms < tMs) lo = m + 1; else hi = m; }
    return Math.round(pts[lo].distance_m);
  }

  // your jumps paired with the ghost's by where they happen, then the ghost-only ones
  jumpRows() {
    const d = this.data, near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) < 45, used = new Set(), rows = [];
    const lost = (f) => f.speed_in - f.speed_out;
    const desc = (f) => `${f.duration_s.toFixed(1)} s air, ${lost(f) >= 1 ? `lost ${lost(f).toFixed(0)}` : lost(f) <= -1 ? `gained ${(-lost(f)).toFixed(0)}` : "no change in"} km/h${f.brake_s >= 0.05 ? `, air-braked ${f.brake_s.toFixed(2)} s` : ""}`;
    d.flights.you.forEach((y) => {
      const gi = d.flights.ghost.findIndex((g, i) => !used.has(i) && near(y, g));
      if (gi >= 0) used.add(gi);
      rows.push({ f: y, label: `at ${this.distAt(y.t_ms)} m`, text: `you ${desc(y)}${gi >= 0 ? ` · ghost ${desc(d.flights.ghost[gi])}` : " · the ghost stayed on the ground"}` });
    });
    d.flights.ghost.forEach((g, i) => {
      if (!used.has(i)) rows.push({ f: g, label: "ghost", text: `ghost ${desc(g)} · you stayed on the ground` });
    });
    return rows;
  }

  jumpsHtml() {
    const rows = this.jumpRows();
    if (!rows.length) return "";
    return `<h3 class="tv-h">Jumps</h3>` + rows.map((r, i) => `<button type="button" class="tv-jump" data-i="${i}"><b>${esc(r.label)}</b> ${esc(r.text)}</button>`).join("");
  }

  renderPanel() {
    const panel = this.q(".tv-panel"), d = this.data;
    if (!d) { panel.innerHTML = ""; return; }
    const rows = d.corners.map((c) => {
      const on = this.sel === c.corner_index, t = c.time_change_ms;
      let detail = "";
      if (on) {
        const adv = this.advice(c), slope = this.slopeText(c);
        detail = `<div class="tv-detail">
          ${slope ? `<p class="tv-slope">The track here is ${esc(slope)}.</p>` : ""}
          <table class="tv-table"><thead><tr><th></th><th>Ghost (ring)</th><th>You (dot)</th><th>Difference</th></tr></thead><tbody>${this.cornerRows(c)}</tbody></table>
          ${adv.how.length ? `<h4>How to take it</h4><ol>${adv.how.map((l) => `<li>${esc(l)}</li>`).join("")}</ol>` : ""}
          ${adv.diffs.length ? `<h4>Where you differ</h4><ul>${adv.diffs.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
        </div>`;
      }
      const slope = c.grade_pct !== undefined && Math.abs(c.grade_pct) >= 1 ? ` · ${c.grade_pct > 0 ? "uphill" : "downhill"}` : "";
      return `<div class="tv-corner ${on ? "on" : ""}">
        <button type="button" class="tv-corner-head" data-corner="${c.corner_index}">
          <span class="tv-num">${c.corner_index}</span>
          <span class="tv-name">${esc(this.corName(c))} ${c.turn_deg}°<small>${Math.round(c.distance_start)}–${Math.round(c.distance_end)} m${slope}</small></span>
          <span class="tv-time ${t > 0 ? "loss" : t < 0 ? "gain" : ""}">${t === 0 ? "even" : this.fmtSec(t)}</span>
        </button>${detail}</div>`;
    }).join("");
    panel.innerHTML = `${this.infoHtml()}
      <h3 class="tv-h">Height along the lap</h3><canvas class="tv-profile"></canvas>
      <h3 class="tv-h">Corners</h3>
      <div class="tv-hint">Select one to fly in and see exactly where to brake, turn in and get back on the throttle. <kbd>←</kbd> <kbd>→</kbd> step through them.</div>${rows}
      ${this.jumpsHtml()}`;
    $$(".tv-corner-head", panel).forEach((b) => b.addEventListener("click", () => this.select(+b.dataset.corner)));
    $$(".tv-jump", panel).forEach((b) => b.addEventListener("click", () => this.focusJump(+b.dataset.i)));
    const prof = panel.querySelector(".tv-profile");
    prof.addEventListener("mousemove", (e) => { this.hoverDist = this.profileDist(e); this.draw(); });
    prof.addEventListener("mouseleave", () => { this.hoverDist = null; this.draw(); });
    prof.addEventListener("click", (e) => this.seek(this.data.pts[this.pointAtDistance(this.profileDist(e))].t_ms));
    const open = $(".tv-corner.on", panel);
    if (open) open.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  focusJump(i) {
    const row = this.jumpRows()[i];
    if (!row) return;
    const f = row.f;
    this.sel = null;
    this.renderPanel();
    if (this.dim === "2d") this.goTo({ cx: f.x, cz: f.z, scale: Math.min(this.W, this.H) / 160 });
    else this.goTo({ tx: f.x, ty: f.y * this.opt.yex, tz: f.z, yaw: this.cam.yaw, pitch: 0.5, dist: 120 });
  }

  // ----------------------------------------------------------- elevation profile

  drawProfile() {
    const cv = this.q(".tv-profile");
    if (!cv || !this.data) return;
    const d = this.data, dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = 120;
    if (!w) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    cv.style.height = `${h}px`;
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const pts = d.pts, total = pts[pts.length - 1].distance_m;
    const lo = d.minY - 2, hi = d.maxY + 2;
    const X = (dist) => 4 + (dist / total) * (w - 8);
    const Y = (y) => h - 14 - ((y - lo) / Math.max(1, hi - lo)) * (h - 26);
    d.corners.forEach((cor) => {
      c.fillStyle = cor.time_change_ms > 0 ? "rgba(255,98,82,0.15)" : cor.time_change_ms < 0 ? "rgba(61,214,140,0.13)" : "rgba(138,134,125,0.1)";
      c.fillRect(X(cor.distance_start), 4, Math.max(1, X(cor.distance_end) - X(cor.distance_start)), h - 18);
    });
    c.strokeStyle = "#4aa3ff";
    c.lineWidth = 1.5;
    c.setLineDash([5, 4]);
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(X(p.distance_m), Y(p.reference_y)) : c.moveTo(X(p.distance_m), Y(p.reference_y))));
    c.stroke();
    c.setLineDash([]);
    c.beginPath();
    c.moveTo(X(0), h - 14);
    pts.forEach((p) => c.lineTo(X(p.distance_m), Y(p.y)));
    c.lineTo(X(total), h - 14);
    c.closePath();
    c.fillStyle = "rgba(240,237,230,0.1)";
    c.fill();
    c.strokeStyle = "#f0ede6";
    c.lineWidth = 2;
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(X(p.distance_m), Y(p.y)) : c.moveTo(X(p.distance_m), Y(p.y))));
    c.stroke();
    c.fillStyle = "#f0b429";
    d.flights.you.forEach((f) => c.fillRect(X(this.distAt(f.t_ms)) - 1, 4, 3, 7));
    c.fillStyle = "#8a867d";
    c.font = '11px "Barlow", sans-serif';
    c.textBaseline = "alphabetic";
    c.textAlign = "left";
    c.fillText(`${Math.round(hi)} m`, 4, 12);
    c.fillText(`${Math.round(lo)} m`, 4, h - 16);
    c.textAlign = "right";
    c.fillText(`${(total / 1000).toFixed(1)} km`, w - 4, h - 2);
    const mark = (dist, color) => {
      const x = X(dist);
      c.strokeStyle = color; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, 4); c.lineTo(x, h - 14); c.stroke();
    };
    if (this.hoverDist !== null) {
      mark(this.hoverDist, "rgba(240,237,230,0.7)");
      const p = pts[this.pointAtDistance(this.hoverDist)], right = this.hoverDist > total / 2;
      c.fillStyle = "#f0ede6";
      c.textAlign = right ? "right" : "left";
      c.fillText(`${Math.round(p.distance_m)} m · height ${Math.round(p.y)} m`, X(this.hoverDist) + (right ? -6 : 6), 24);
    }
    if (this.play.t > 0) {
      const idx = pts.findIndex((p) => p.t_ms >= this.play.t);
      mark(pts[idx < 0 ? pts.length - 1 : idx].distance_m, "#d4f03c");
    }
  }

  profileDist(e) {
    const r = this.q(".tv-profile").getBoundingClientRect();
    const total = this.data.pts[this.data.pts.length - 1].distance_m;
    return Math.max(0, Math.min(total, ((e.clientX - r.left - 4) / (r.width - 8)) * total));
  }

  // ------------------------------------------------------------------ actions

  select(index) {
    if (!this.data) return;
    if (this.sel === index) {
      this.sel = null;
      this.renderPanel();
      this.goTo(this.fitView());
      return;
    }
    this.sel = index;
    const c = this.data.corners.find((x) => x.corner_index === index);
    this.renderPanel();
    if (c) this.goTo(this.cornerView(c), 650);
  }

  step(dir) {
    const d = this.data;
    if (!d || !d.corners.length) return;
    const idx = d.corners.findIndex((c) => c.corner_index === this.sel);
    const next = idx < 0 ? (dir > 0 ? 0 : d.corners.length - 1) : (idx + dir + d.corners.length) % d.corners.length;
    this.sel = null;
    this.select(d.corners[next].corner_index);
  }

  fit() {
    if (!this.data) return;
    this.sel = null;
    this.renderPanel();
    this.goTo(this.fitView());
  }

  zoom(k) {
    cancelAnimationFrame(this.anim);
    if (this.dim === "2d") this.view2.scale = Math.max(0.05, Math.min(60, this.view2.scale * k));
    else this.cam.dist = Math.max(15, Math.min(12000, this.cam.dist / k));
    this.draw();
  }

  setDim(dim) {
    if (dim === this.dim) return;
    this.dim = dim;
    $$(".tv-dim button", this.root).forEach((b) => b.classList.toggle("on", b.dataset.dim === dim));
    this.q(".tv-height").hidden = dim === "2d";
    if (this.data) {
      const c = this.sel !== null ? this.data.corners.find((x) => x.corner_index === this.sel) : null;
      Object.assign(dim === "2d" ? this.view2 : this.cam, c ? this.cornerView(c) : this.fitView());
      this.draw();
    }
  }

  seek(t) {
    this.play.t = Math.max(0, Math.min(this.data.tMax, t));
    this.q(".tv-scrub").value = Math.round((this.play.t / this.data.tMax) * 1000);
    this.q(".tv-clock").textContent = `${(this.play.t / 1000).toFixed(1)} s`;
    this.draw();
  }

  toggle() {
    const p = this.play;
    p.on = !p.on;
    this.q(".tv-playbtn").innerHTML = p.on ? "&#10074;&#10074;" : "&#9654;";
    if (!p.on) return;
    if (p.t >= this.data.tMax - 50) p.t = 0;
    p.last = performance.now();
    const tick = (now) => {
      if (!p.on) return;
      p.t += (now - p.last) * p.speed;
      p.last = now;
      if (p.t >= this.data.tMax) { p.t = this.data.tMax; p.on = false; this.q(".tv-playbtn").innerHTML = "&#9654;"; }
      this.q(".tv-scrub").value = Math.round((p.t / this.data.tMax) * 1000);
      this.q(".tv-clock").textContent = `${(p.t / 1000).toFixed(1)} s`;
      this.draw();
      if (p.on) p.raf = requestAnimationFrame(tick);
    };
    p.raf = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------- events

  bind() {
    const cv = this.canvas;
    cv.addEventListener("wheel", (e) => { e.preventDefault(); this.zoomAt(e); }, { passive: false });
    cv.addEventListener("pointerdown", (e) => this.onDown(e));
    cv.addEventListener("pointermove", (e) => this.onMove(e));
    cv.addEventListener("pointerup", (e) => this.onUp(e));
    cv.addEventListener("pointerleave", () => { this.hoverDist = null; this.q(".tv-tip").hidden = true; this.draw(); });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("dblclick", () => this.fit());
    document.addEventListener("keydown", (e) => this.onKey(e));
    new ResizeObserver(() => { if (this.resize()) this.draw(); }).observe(this.q(".tv-stage"));
    document.addEventListener("fullscreenchange", () => {
      this.q(".tv-fs").textContent = document.fullscreenElement === this.root ? "Exit full screen" : "Full screen";
    });
    $$(".tv-dim button", this.root).forEach((b) => b.addEventListener("click", () => this.setDim(b.dataset.dim)));
    $$(".tv-color button", this.root).forEach((b) => b.addEventListener("click", () => {
      $$(".tv-color button", this.root).forEach((x) => x.classList.toggle("on", x === b));
      this.mode = b.dataset.mode;
      this.buildColors();
      this.draw();
    }));
    const opt = (cls, key) => this.q(cls).addEventListener("change", (e) => { this.opt[key] = e.target.checked; this.draw(); });
    opt(".tv-ghost", "ghosts"); opt(".tv-markers", "markers"); opt(".tv-ticks", "ticks"); opt(".tv-jumps", "jumps"); opt(".tv-follow", "follow");
    this.q(".tv-yex").addEventListener("change", (e) => {
      const old = this.opt.yex;
      this.opt.yex = +e.target.value;
      this.cam.ty = (this.cam.ty / old) * this.opt.yex;
      this.draw();
    });
    this.q(".tv-fit").addEventListener("click", () => this.fit());
    this.q(".tv-zoom-in").addEventListener("click", () => this.zoom(1.35));
    this.q(".tv-zoom-out").addEventListener("click", () => this.zoom(1 / 1.35));
    this.q(".tv-fs").addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else this.root.requestFullscreen().catch(() => {});
    });
    this.q(".tv-playbtn").addEventListener("click", () => this.data && this.toggle());
    this.q(".tv-scrub").addEventListener("input", (e) => this.data && this.seek((e.target.value / 1000) * this.data.tMax));
    this.q(".tv-speed").addEventListener("change", (e) => { this.play.speed = +e.target.value; });
  }

  visible() { return this.root.offsetParent !== null; }

  onKey(e) {
    if (!this.visible() || e.target.matches("input, textarea, select")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); this.step(1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); this.step(-1); }
    else if (e.key === " ") { e.preventDefault(); if (this.data) this.toggle(); }
    else if (e.key === "Escape") {
      if (this.sel !== null) this.fit();
      else if (!this.embedded && !document.fullscreenElement) location.hash = `#/map/${state.map.map_uid}`;
    }
    else if (e.key === "f" || e.key === "F") this.q(".tv-fs").click();
    else if (e.key === "d" || e.key === "D") this.setDim(this.dim === "3d" ? "2d" : "3d");
    else if (e.key === "+" || e.key === "=") this.zoom(1.3);
    else if (e.key === "-") this.zoom(1 / 1.3);
  }

  zoomAt(e) {
    cancelAnimationFrame(this.anim);
    const k = Math.exp(-e.deltaY * 0.0015);
    if (this.dim === "3d") { this.zoom(k); return; }
    const r = this.canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, v = this.view2;
    const wx = (sx - this.W / 2) / v.scale + v.cx, wz = (sy - this.H / 2) / v.scale + v.cz;
    v.scale = Math.max(0.05, Math.min(60, v.scale * k));
    v.cx = wx - (sx - this.W / 2) / v.scale;
    v.cz = wz - (sy - this.H / 2) / v.scale;
    this.draw();
  }

  onDown(e) {
    cancelAnimationFrame(this.anim);
    this.drag = { x: e.clientX, y: e.clientY, cam: { ...this.cam }, v2: { ...this.view2 }, pan: e.button === 2 || e.shiftKey || this.dim === "2d", moved: false };
    this.canvas.setPointerCapture(e.pointerId);
  }

  onMove(e) {
    const r = this.canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (!this.drag) { this.hoverAt(sx, sy, e.clientX, e.clientY); return; }
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
    if (this.dim === "2d") {
      this.view2.cx = this.drag.v2.cx - dx / this.view2.scale;
      this.view2.cz = this.drag.v2.cz - dy / this.view2.scale;
    } else if (this.drag.pan) {
      const c0 = this.drag.cam, m = c0.dist / this.cb.focal;
      const rx = Math.cos(c0.yaw), rz = -Math.sin(c0.yaw), fx = -Math.sin(c0.yaw), fz = -Math.cos(c0.yaw);
      this.cam.tx = c0.tx - rx * dx * m + fx * dy * m;
      this.cam.tz = c0.tz - rz * dx * m + fz * dy * m;
    } else {
      this.cam.yaw = this.drag.cam.yaw - dx * 0.006;
      this.cam.pitch = Math.max(0.12, Math.min(1.55, this.drag.cam.pitch + dy * 0.005));
    }
    this.draw();
  }

  onUp(e) {
    const click = this.drag && !this.drag.moved;
    this.drag = null;
    if (!click || !this.data) return;
    const r = this.canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    for (const c of this.data.corners) {
      const ap = c.phases && c.phases.reference.apex;
      if (!ap) continue;
      const s = this.P(ap.x, ap.y, ap.z);
      if (!s) continue;
      const on = this.sel === c.corner_index;
      if (Math.hypot(sx - s[0], sy - (s[1] - (on ? 28 : 20))) <= 18) { this.select(c.corner_index); return; }
    }
  }

  hoverAt(sx, sy, cx, cy) {
    const d = this.data, tip = this.q(".tv-tip");
    if (!d) return;
    this.setup();
    let best = -1, bd = 20 * 20;
    d.pts.forEach((p, i) => {
      const s = this.P(p.x, p.y, p.z);
      if (!s) return;
      const dd = (s[0] - sx) ** 2 + (s[1] - sy) ** 2;
      if (dd < bd) { bd = dd; best = i; }
    });
    if (best >= 0) {
      const p = d.pts[best], q = d.pts[Math.min(d.pts.length - 1, best + 3)], o = d.pts[Math.max(0, best - 3)];
      const run = Math.max(1, q.distance_m - o.distance_m), grade = ((q.y - o.y) / run) * 100;
      const cor = d.corners.find((c) => p.distance_m >= c.distance_start && p.distance_m <= c.distance_end);
      const gap = p.delta_ms;
      this.hoverDist = p.distance_m;
      tip.hidden = false;
      tip.style.left = `${cx + 14}px`;
      tip.style.top = `${cy + 14}px`;
      tip.innerHTML = `<b>${Math.round(p.distance_m)} m</b>${cor ? ` · corner ${cor.corner_index}` : ""}<br>` +
        `you ${Math.round(p.subject_speed)} km/h · ghost ${Math.round(p.reference_speed)} km/h<br>` +
        `steer ${p.subject_steer >= 0 ? "+" : ""}${p.subject_steer.toFixed(2)} · throttle ${Math.round(p.subject_gas * 100)}% · brake ${Math.round(p.subject_brake * 100)}%<br>` +
        `height ${Math.round(p.y)} m · ${Math.abs(grade) < 1 ? "flat" : `${grade > 0 ? "uphill" : "downhill"} ${Math.abs(grade).toFixed(0)}%`}<br>` +
        `<span class="${gap > 0 ? "loss" : "gain"}">${gap > 0 ? "+" : gap < 0 ? "−" : ""}${(Math.abs(gap) / 1000).toFixed(3)} s</span> to the ghost`;
    } else {
      this.hoverDist = null;
      tip.hidden = true;
    }
    this.draw();
  }

  // ---------------------------------------------------------------- lifecycle

  refresh() {
    const d = this.load();
    this.q(".tv-empty").hidden = !!d;
    this.canvas.hidden = !d;
    this.q(".tv-play").hidden = !d;
    this.q(".tv-height").hidden = this.dim === "2d";
    if (this.embedded) {
      const uid = state.map && state.map.map_uid, open = this.q(".tv-open");
      open.hidden = !uid;
      if (uid) open.href = `#/map/${uid}/track`;
    } else {
      this.q(".tv-back").hidden = false;
      this.q(".tv-back").href = state.map ? `#/map/${state.map.map_uid}` : "#/";
      this.q(".tv-title").hidden = false;
      this.q(".tv-title").textContent = (state.map && state.map.name) || "Track";
    }
    if (!this.resize() && d) { requestAnimationFrame(() => this.refresh()); return; }
    this.renderPanel();
    if (!d) return;
    this.buildColors();
    this.play.t = 0;
    this.play.on = false;
    this.q(".tv-playbtn").innerHTML = "&#9654;";
    this.q(".tv-scrub").value = 0;
    this.q(".tv-clock").textContent = "0.0 s";
    this.q(".tv-gap").textContent = "";
    if (this.sel !== null && !d.corners.some((c) => c.corner_index === this.sel)) this.sel = null;
    const c = this.sel !== null ? d.corners.find((x) => x.corner_index === this.sel) : null;
    Object.assign(this.dim === "2d" ? this.view2 : this.cam, c ? this.cornerView(c) : this.fitView());
    this.draw();
  }
}

// Two homes for the same view: the workspace tab and the full page.
const TrackPage = (() => {
  let tab = null, page = null;
  return {
    // the "Track" tab of the map workspace
    showTab() {
      if (!tab) tab = new TrackView($("#track-tab-root"), { embedded: true });
      tab.refresh();
    },
    // the full page at #/map/<uid>/track
    refresh() {
      if (!page) page = new TrackView($("#track-page-root"), { embedded: false });
      page.refresh();
    },
    // the comparison changed: redraw whichever view is showing
    onCompare() {
      if (state.view === "track") this.refresh();
      else if (tab && tab.visible()) tab.refresh();
    },
  };
})();
