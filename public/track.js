"use strict";

// The fullscreen track page (#/map/<uid>/track): the whole track at full size
// with both runs drawn on it. Select a corner to zoom in and see exactly where
// to brake, turn in, hit the apex and get back on the throttle, with the
// ghost's marker and yours side by side and how far apart they are.
//
// Relies on app.js for shared state and helpers (state, $, esc, fmtTime, tmName...).

const TrackPage = (() => {
  const KINDS = [
    { key: "brake", label: "Brake", color: "#f0b429" },
    { key: "turn_in", label: "Turn in", color: "#3dd68c" },
    { key: "apex", label: "Apex", color: "#f0ede6" },
    { key: "exit", label: "Back on throttle", color: "#4aa3ff" },
  ];

  const T = {
    sel: null, // selected corner index (1-based) or null
    view: { cx: 0, cz: 0, scale: 1 }, // world centre and pixels per metre
    mode: "time",
    ghosts: true,
    markers: true,
    ticks: true,
    anim: 0,
    drag: null,
    hover: null,
    colors: [],
    ready: false,
  };

  let canvas, ctx, W = 0, H = 0;

  const ctxData = () => {
    const c = state.compare;
    if (!c) return null;
    const pid = c.ids.includes(state.primaryRefId) ? state.primaryRefId : c.ids[0];
    const d = c.data[pid];
    if (!d || !d.stats.telemetry || !d.points.length) return null;
    return { all: c.data, ids: c.ids.filter((id) => c.data[id].stats.telemetry), pid, primary: d, pts: d.points, corners: d.corners };
  };

  // ---------------------------------------------------------------- coordinates

  // Top-down: x to the right, z down the screen (with this handedness a rightward
  // steer is a clockwise turn on screen, so the track isn't mirrored).
  const w2s = (x, z) => [(x - T.view.cx) * T.view.scale + W / 2, (z - T.view.cz) * T.view.scale + H / 2];
  const s2w = (sx, sy) => [(sx - W / 2) / T.view.scale + T.view.cx, (sy - H / 2) / T.view.scale + T.view.cz];

  function fitBox(box, pad = 0.12) {
    const dx = Math.max(10, box.maxX - box.minX), dz = Math.max(10, box.maxZ - box.minZ);
    const scale = Math.min(W / (dx * (1 + pad * 2)), H / (dz * (1 + pad * 2)));
    return { cx: (box.minX + box.maxX) / 2, cz: (box.minZ + box.maxZ) / 2, scale };
  }

  function trackBox() {
    const { pts } = ctxData();
    const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const p of pts) {
      b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
      b.minZ = Math.min(b.minZ, p.z); b.maxZ = Math.max(b.maxZ, p.z);
    }
    return b;
  }

  function cornerBox(c) {
    const { pts } = ctxData();
    const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const add = (x, z) => {
      b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
      b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z);
    };
    // the approach (so the braking zone is in frame), the corner and a little exit
    for (const p of pts) if (p.distance_m >= c.distance_start - 90 && p.distance_m <= c.distance_end + 40) add(p.x, p.z);
    if (c.phases) for (const side of ["subject", "reference"]) for (const k of KINDS) {
      const ph = c.phases[side][k.key];
      if (ph) add(ph.x, ph.z);
    }
    return b;
  }

  function animateTo(target, ms = 450) {
    cancelAnimationFrame(T.anim);
    const from = { ...T.view };
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      T.view.cx = from.cx + (target.cx - from.cx) * e;
      T.view.cz = from.cz + (target.cz - from.cz) * e;
      T.view.scale = from.scale * Math.pow(target.scale / from.scale, e);
      draw();
      if (k < 1) T.anim = requestAnimationFrame(step);
    };
    T.anim = requestAnimationFrame(step);
  }

  // -------------------------------------------------------------- path colouring

  function buildColors() {
    const d = ctxData();
    if (!d) return;
    const pts = d.pts, n = pts.length;
    const mix = (a, b, t) => {
      const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16)), pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
      return `rgb(${pa.map((v, k) => Math.round(v + (pb[k] - v) * t)).join(",")})`;
    };
    const cols = new Array(n).fill("#888");
    if (T.mode === "time") {
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
      T.legend = ["gaining time", "losing time", "linear-gradient(90deg,#3dd68c,#6b675f,#ff6252)"];
    } else if (T.mode === "speed") {
      const v = pts.map((p) => p.subject_speed);
      const lo = Math.min(...v), hi = Math.max(...v);
      v.forEach((s, i) => (cols[i] = mix("27405f", "8fc2ff", (s - lo) / Math.max(1, hi - lo))));
      T.legend = [`${Math.round(lo)} km/h`, `${Math.round(hi)} km/h`, "linear-gradient(90deg,#27405f,#8fc2ff)"];
    } else {
      pts.forEach((p, i) => (cols[i] = p.subject_brake > 0.1 ? "#ff6252" : p.subject_gas < 0.9 ? "#f0b429" : "#3dd68c"));
      T.legend = ["full throttle", "braking", "linear-gradient(90deg,#3dd68c 0 33%,#f0b429 33% 66%,#ff6252 66%)"];
    }
    T.colors = cols;
    const lg = $("#tp-legend");
    if (lg) {
      lg.innerHTML = T.mode === "pedals"
        ? `<span><i style="background:#3dd68c"></i>full throttle</span><span><i style="background:#f0b429"></i>throttle lifted</span><span><i style="background:#ff6252"></i>braking</span>`
        : `<span>${esc(T.legend[0])}</span><span class="ramp" style="background:${T.legend[2]}"></span><span>${esc(T.legend[1])}</span>`;
    }
  }

  // --------------------------------------------------------------------- drawing

  function resize() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function pathLine(points, xKey, zKey, from = 0, to = points.length - 1) {
    ctx.beginPath();
    for (let i = from; i <= to; i++) {
      const [x, y] = w2s(points[i][xKey], points[i][zKey]);
      if (i === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }

  const label = (text, x, y, color = "#f0ede6", size = 12, align = "left") => {
    ctx.font = `600 ${size}px "Barlow", system-ui, sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(18,18,17,0.85)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };

  function pointAtDistance(pts, d) {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].distance_m < d) lo = m + 1; else hi = m; }
    const a = pts[Math.max(0, lo - 1)], b = pts[lo];
    return { x: b.x, z: b.z, tx: b.x - a.x, tz: b.z - a.z };
  }

  function draw() {
    const d = ctxData();
    if (!canvas || !d || !W) return;
    ctx.clearRect(0, 0, W, H);
    const { pts, corners } = d;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const sel = T.sel ? corners.find((c) => c.corner_index === T.sel) : null;

    // the ghosts' lines, under yours
    if (T.ghosts) {
      d.ids.forEach((id) => {
        const gp = d.all[id].points;
        ctx.setLineDash([9, 6]);
        ctx.lineWidth = id === d.pid ? 2.4 : 1.6;
        ctx.strokeStyle = ghostColor(id);
        pathLine(gp, "reference_x", "reference_z");
        ctx.stroke();
      });
      ctx.setLineDash([]);
    }

    // the selected corner's stretch gets a halo
    if (sel) {
      ctx.strokeStyle = "rgba(240,237,230,0.22)";
      ctx.lineWidth = 22;
      const i0 = pts.findIndex((p) => p.distance_m >= sel.distance_start);
      let i1 = pts.findIndex((p) => p.distance_m >= sel.distance_end);
      if (i1 < 0) i1 = pts.length - 1;
      if (i0 >= 0) { pathLine(pts, "x", "z", i0, i1); ctx.stroke(); }
    }

    // your line, coloured
    ctx.lineWidth = Math.max(3, Math.min(8, T.view.scale * 1.6));
    for (let i = 1; i < pts.length; i++) {
      ctx.strokeStyle = T.colors[i] || "#888";
      ctx.beginPath();
      const [x0, y0] = w2s(pts[i - 1].x, pts[i - 1].z), [x1, y1] = w2s(pts[i].x, pts[i].z);
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }

    // direction arrows along your line
    ctx.fillStyle = "rgba(240,237,230,0.55)";
    for (let i = 12; i < pts.length - 1; i += 28) {
      const [x, y] = w2s(pts[i].x, pts[i].z), [x2, y2] = w2s(pts[i + 1].x, pts[i + 1].z);
      const a = Math.atan2(y2 - y, x2 - x);
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(5, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // distance ticks leading into the selected corner: where exactly you are in the approach
    if (sel && T.ticks) {
      for (const k of [1, 2, 3, 4, 6, 8]) {
        const dist = sel.distance_start - 25 * k;
        if (dist < 0) break;
        const p = pointAtDistance(pts, dist);
        const [x, y] = w2s(p.x, p.z);
        const len = Math.hypot(p.tx, p.tz) || 1;
        const nx = -p.tz / len, nz = p.tx / len;
        ctx.strokeStyle = "rgba(240,237,230,0.8)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - nx * 12, y - nz * 12); ctx.lineTo(x + nx * 12, y + nz * 12); ctx.stroke();
        if ([1, 2, 4, 8].includes(k)) label(`${25 * k} m before`, x + nx * 16, y + nz * 16, "#bdb9af", 11);
      }
    }

    // corner numbers
    corners.forEach((c) => {
      const ap = c.phases && c.phases.reference.apex;
      if (!ap) return;
      const [x, y] = w2s(ap.x, ap.z);
      const on = sel && sel.corner_index === c.corner_index;
      const r = on ? 14 : 11;
      ctx.beginPath(); ctx.arc(x, y - (on ? 26 : 20), r, 0, Math.PI * 2);
      ctx.fillStyle = on ? "#d4f03c" : "rgba(18,18,17,0.88)";
      ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = on ? "#d4f03c" : "rgba(240,237,230,0.6)"; ctx.stroke();
      label(String(c.corner_index), x, y - (on ? 26 : 20), on ? "#151a00" : "#f0ede6", on ? 14 : 11, "center");
    });

    // start and finish
    const [sx, sy] = w2s(pts[0].x, pts[0].z), [fx, fy] = w2s(pts[pts.length - 1].x, pts[pts.length - 1].z);
    ctx.fillStyle = "#f0ede6"; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2); ctx.fill();
    label("START", sx + 10, sy, "#f0ede6", 11);
    ctx.strokeStyle = "#d4f03c"; ctx.lineWidth = 3; ctx.strokeRect(fx - 6, fy - 6, 12, 12);
    label("FINISH", fx + 10, fy, "#d4f03c", 11);

    // the selected corner's markers: ghost = ring, you = dot, joined so the gap is visible
    if (sel && sel.phases && T.markers) {
      for (const k of KINDS) {
        const g = sel.phases.reference[k.key], s = sel.phases.subject[k.key];
        if (g && s) {
          const [gx, gy] = w2s(g.x, g.z), [px, py] = w2s(s.x, s.z);
          ctx.strokeStyle = k.color; ctx.globalAlpha = 0.55; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(px, py); ctx.stroke();
          ctx.setLineDash([]); ctx.globalAlpha = 1;
        }
      }
      KINDS.forEach((k, idx) => {
        const g = sel.phases.reference[k.key], s = sel.phases.subject[k.key];
        if (g) {
          const [x, y] = w2s(g.x, g.z);
          ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(18,18,17,0.7)"; ctx.fill();
          ctx.lineWidth = 3; ctx.strokeStyle = k.color; ctx.stroke();
          // labels sit in a staggered column so close-together markers don't overprint each other
          const ly = y - 46 + idx * 17;
          ctx.strokeStyle = k.color; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x + 7, y - 7); ctx.lineTo(x + 22, ly); ctx.stroke(); ctx.globalAlpha = 1;
          label(`${k.label.toUpperCase()}  ${Math.round(g.speed)} km/h`, x + 26, ly, k.color, 12);
        }
        if (s) {
          const [x, y] = w2s(s.x, s.z);
          ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fillStyle = k.color; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = "#121211"; ctx.stroke();
        }
      });
    }

    // hover readout dot
    if (T.hover) {
      const [x, y] = w2s(T.hover.p.x, T.hover.p.z);
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = "#f0ede6"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#121211"; ctx.stroke();
    }

    drawScaleBar();
  }

  function drawScaleBar() {
    const target = 120 / T.view.scale; // metres for ~120 px
    const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((v) => v >= target) || 1000;
    const px = nice * T.view.scale;
    const x = 20, y = H - 24;
    ctx.strokeStyle = "#f0ede6"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.moveTo(x + px, y - 5); ctx.lineTo(x + px, y + 5); ctx.stroke();
    label(`${nice} m`, x + px / 2, y - 12, "#f0ede6", 12, "center");
  }

  // ------------------------------------------------------------------ the panel

  const corName = (c) => {
    const deg = c.turn_deg, span = c.distance_end - c.distance_start;
    const side = c.direction;
    if (deg >= 120) return "hairpin";
    if (deg < 25) return `gentle ${side} bend`;
    if (span >= 60 && deg < 90) return `${side} sweeper`;
    return `${side} turn`;
  };

  const sec = (ms) => `${ms > 0 ? "+" : ms < 0 ? "−" : ""}${(Math.abs(ms) / 1000).toFixed(2)}s`;
  const m1 = (v) => `${Math.abs(v).toFixed(v >= 10 || v <= -10 ? 0 : 1)} m`;
  const km = (v) => `${Math.round(v)} km/h`;

  function when(delta, early = "earlier", late = "later") {
    if (delta === null || delta === undefined) return "–";
    if (Math.abs(delta) < 1.5) return "about the same spot";
    return `${m1(delta)} ${delta > 0 ? late : early}`;
  }

  // metres along the corner: negative means before its detected start
  function alongCorner(m) {
    if (Math.abs(m) < 1) return "at the corner start";
    return m > 0 ? `${m.toFixed(0)} m into the corner` : `${(-m).toFixed(0)} m before the corner`;
  }

  function offsetText(o) {
    if (o === null || o === undefined || Math.abs(o) < 0.4) return "on the ghost's line";
    return `${m1(o)} ${o > 0 ? "tighter" : "wider"}`;
  }

  function cornerRows(c) {
    const p = c.phases;
    if (!p) return "";
    const g = p.reference, s = p.subject;
    const gStart = c.reference_distance_start ?? 0;
    const into = (ph, start) => alongCorner(ph.distance_m - start);
    const rows = [];
    rows.push(["Brake", g.brake ? `${m1(g.brake.metres_before)} before · ${km(g.brake.speed)}` : "doesn't brake", s.brake ? `${m1(s.brake.metres_before)} before · ${km(s.brake.speed)}` : "doesn't brake",
      g.brake && s.brake ? when(p.delta_m.brake) : g.brake ? "you don't brake" : s.brake ? "you brake, ghost doesn't" : "–"]);
    rows.push(["Turn in", `${into(g.turn_in, gStart)} · ${km(g.turn_in.speed)}`, `${into(s.turn_in, c.distance_start)} · ${km(s.turn_in.speed)}`,
      `${when(p.delta_m.turn_in)}, ${offsetText(p.offset_m.turn_in)}`]);
    rows.push(["Apex", `${km(g.apex.speed)}`, `${km(s.apex.speed)}`, `${when(p.delta_m.apex)}, ${offsetText(p.offset_m.apex)}`]);
    rows.push(["Back on throttle", `${into(g.exit, gStart)} · ${km(g.exit.speed)}`, `${into(s.exit, c.distance_start)} · ${km(s.exit.speed)}`,
      `${when(p.delta_m.exit)}, ${offsetText(p.offset_m.exit)}`]);
    return rows.map((r, i) => `<tr><td><i style="background:${KINDS[i].color}"></i>${r[0]}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join("");
  }

  // Plain-English "how to take it" from the ghost's numbers, then the biggest difference.
  function advice(c) {
    const p = c.phases;
    if (!p) return [];
    const g = p.reference, s = p.subject, lines = [];
    const gStart = c.reference_distance_start ?? 0;
    lines.push(g.brake
      ? `Approach: the ghost brakes ${m1(g.brake.metres_before)} before the corner at ${km(g.brake.speed)}.`
      : `Approach: the ghost doesn't brake for this corner (${km(g.turn_in.speed)} at turn-in).`);
    lines.push(`Turn in ${alongCorner(g.turn_in.distance_m - gStart)}, at ${km(g.turn_in.speed)}.`);
    lines.push(`Apex: ${km(g.apex.speed)} at the tightest point.`);
    lines.push(`Exit: the ghost is straight and back on full throttle ${alongCorner(g.exit.distance_m - gStart)}, at ${km(g.exit.speed)}.`);

    const diffs = [];
    if (p.delta_m.brake !== null && Math.abs(p.delta_m.brake) >= 4)
      diffs.push([Math.abs(p.delta_m.brake) * 1.2, `You start braking ${m1(p.delta_m.brake)} ${p.delta_m.brake > 0 ? "later" : "earlier"} than the ghost.`]);
    if (g.brake && !s.brake) diffs.push([30, "The ghost brakes here and you don't: check you aren't arriving too fast for its line."]);
    if (!g.brake && s.brake) diffs.push([30, "You brake here but the ghost doesn't: lift earlier or enter wider instead of braking."]);
    if (Math.abs(p.delta_m.turn_in) >= 4) diffs.push([Math.abs(p.delta_m.turn_in), `You turn in ${m1(p.delta_m.turn_in)} ${p.delta_m.turn_in > 0 ? "later" : "earlier"} than the ghost.`]);
    if (Math.abs(p.offset_m.apex) >= 1) diffs.push([Math.abs(p.offset_m.apex) * 6, `At the apex you are ${m1(p.offset_m.apex)} ${p.offset_m.apex > 0 ? "tighter (closer to the inside)" : "wider (further from the inside)"} than the ghost.`]);
    if (p.delta_m.exit >= 4) diffs.push([p.delta_m.exit * 1.5, `You are back on full throttle ${m1(p.delta_m.exit)} later than the ghost: straighten the car earlier so the throttle is fully available.`]);
    if (p.delta_m.exit <= -4) diffs.push([Math.abs(p.delta_m.exit), `You are back on the throttle ${m1(p.delta_m.exit)} earlier than the ghost, which is working for you.`]);
    if (s.apex.speed < g.apex.speed - 3) diffs.push([(g.apex.speed - s.apex.speed) * 1.5, `Your apex speed is ${Math.round(g.apex.speed - s.apex.speed)} km/h lower (${km(s.apex.speed)} vs ${km(g.apex.speed)}).`]);
    diffs.sort((a, b) => b[0] - a[0]);
    return { how: lines, diffs: diffs.slice(0, 3).map((d) => d[1]) };
  }

  function renderPanel() {
    const d = ctxData();
    const panel = $("#tp-panel");
    if (!d) {
      panel.innerHTML = `<div class="tp-empty"><h2>Nothing to draw yet</h2><p>Pick your run and a ghost on the analysis page first, then come back.</p></div>`;
      return;
    }
    const rows = d.corners.map((c) => {
      const on = T.sel === c.corner_index;
      const t = c.time_change_ms;
      let detail = "";
      if (on) {
        const adv = advice(c);
        detail = `<div class="tp-detail">
          <table class="tp-table"><thead><tr><th></th><th>Ghost (ring)</th><th>You (dot)</th><th>Difference</th></tr></thead><tbody>${cornerRows(c)}</tbody></table>
          ${adv.how ? `<h4>How to take it</h4><ol>${adv.how.map((l) => `<li>${esc(l)}</li>`).join("")}</ol>` : ""}
          ${adv.diffs && adv.diffs.length ? `<h4>Where you differ</h4><ul>${adv.diffs.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
        </div>`;
      }
      return `<div class="tp-corner ${on ? "on" : ""}">
        <button type="button" class="tp-corner-head" data-corner="${c.corner_index}">
          <span class="tp-num">${c.corner_index}</span>
          <span class="tp-name">${esc(corName(c))} ${c.turn_deg}°<small>${Math.round(c.distance_start)}–${Math.round(c.distance_end)} m</small></span>
          <span class="tp-time ${t > 0 ? "loss" : t < 0 ? "gain" : ""}">${t === 0 ? "even" : sec(t)}</span>
        </button>${detail}</div>`;
    }).join("");
    panel.innerHTML = `<div class="tp-hint">${d.corners.length} corners. Select one to zoom in and see exactly where to brake, turn in and get back on the throttle. <kbd>←</kbd> <kbd>→</kbd> step through them.</div>${rows}`;
    $$(".tp-corner-head", panel).forEach((b) => b.addEventListener("click", () => select(+b.dataset.corner)));
    const open = $(".tp-corner.on", panel);
    if (open) open.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // -------------------------------------------------------------------- actions

  function select(index) {
    const d = ctxData();
    if (!d) return;
    if (T.sel === index) {
      T.sel = null;
      renderPanel();
      animateTo(fitBox(trackBox()));
      return;
    }
    T.sel = index;
    const c = d.corners.find((x) => x.corner_index === index);
    renderPanel();
    if (c) animateTo(fitBox(cornerBox(c), 0.35), 500);
  }

  function step(dir) {
    const d = ctxData();
    if (!d || !d.corners.length) return;
    const idx = d.corners.findIndex((c) => c.corner_index === T.sel);
    const next = idx < 0 ? (dir > 0 ? 0 : d.corners.length - 1) : (idx + dir + d.corners.length) % d.corners.length;
    T.sel = null;
    select(d.corners[next].corner_index);
  }

  function fit() {
    T.sel = null;
    renderPanel();
    animateTo(fitBox(trackBox()));
  }

  // ----------------------------------------------------------------- events

  function onWheel(e) {
    e.preventDefault();
    cancelAnimationFrame(T.anim);
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [wx, wz] = s2w(sx, sy);
    const k = Math.exp(-e.deltaY * 0.0015);
    T.view.scale = Math.max(0.05, Math.min(60, T.view.scale * k));
    // keep the point under the cursor fixed
    T.view.cx = wx - (sx - W / 2) / T.view.scale;
    T.view.cz = wz - (sy - H / 2) / T.view.scale;
    draw();
  }

  function onDown(e) {
    cancelAnimationFrame(T.anim);
    T.drag = { x: e.clientX, y: e.clientY, cx: T.view.cx, cz: T.view.cz, moved: false };
    canvas.setPointerCapture(e.pointerId);
  }

  function onMove(e) {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (T.drag) {
      const dx = e.clientX - T.drag.x, dy = e.clientY - T.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) T.drag.moved = true;
      T.view.cx = T.drag.cx - dx / T.view.scale;
      T.view.cz = T.drag.cz - dy / T.view.scale;
      draw();
      return;
    }
    hoverAt(sx, sy, e.clientX, e.clientY);
  }

  function onUp(e) {
    const wasClick = T.drag && !T.drag.moved;
    T.drag = null;
    if (!wasClick) return;
    // a click on a corner badge selects it
    const d = ctxData();
    if (!d) return;
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    for (const c of d.corners) {
      const ap = c.phases && c.phases.reference.apex;
      if (!ap) continue;
      const on = T.sel === c.corner_index;
      const [x, y] = w2s(ap.x, ap.z);
      if (Math.hypot(sx - x, sy - (y - (on ? 26 : 20))) <= 18) return select(c.corner_index);
    }
  }

  function hoverAt(sx, sy, cx, cy) {
    const d = ctxData();
    const tip = $("#tp-tip");
    if (!d) return;
    let best = null, bd = 18 * 18;
    for (const p of d.pts) {
      const [x, y] = w2s(p.x, p.z);
      const dd = (x - sx) ** 2 + (y - sy) ** 2;
      if (dd < bd) { bd = dd; best = p; }
    }
    T.hover = best ? { p: best } : null;
    if (best) {
      const gap = best.delta_ms;
      tip.hidden = false;
      tip.style.left = `${cx + 14}px`;
      tip.style.top = `${cy + 14}px`;
      tip.innerHTML = `<b>${Math.round(best.distance_m)} m</b><br>you ${Math.round(best.subject_speed)} km/h · ghost ${Math.round(best.reference_speed)} km/h<br>` +
        `<span class="${gap > 0 ? "loss" : "gain"}">${gap > 0 ? "+" : gap < 0 ? "−" : ""}${(Math.abs(gap) / 1000).toFixed(3)} s</span>`;
    } else {
      tip.hidden = true;
    }
    draw();
  }

  function onKey(e) {
    if ($("#view-track").hidden || e.target.matches("input, textarea, select")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); step(-1); }
    else if (e.key === "Escape") { if (T.sel !== null) fit(); else if (!document.fullscreenElement) location.hash = `#/map/${state.map.map_uid}`; }
    else if (e.key === "f" || e.key === "F") toggleFullscreen();
    else if (e.key === "+" || e.key === "=") { T.view.scale *= 1.3; draw(); }
    else if (e.key === "-") { T.view.scale /= 1.3; draw(); }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else $("#view-track").requestFullscreen().catch(() => {});
  }

  // ------------------------------------------------------------------- lifecycle

  function init() {
    canvas = $("#tp-canvas");
    ctx = canvas.getContext("2d");
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", () => { T.hover = null; $("#tp-tip").hidden = true; draw(); });
    canvas.addEventListener("dblclick", fit);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", () => { if (!$("#view-track").hidden) { resize(); draw(); } });
    document.addEventListener("fullscreenchange", () => {
      $("#tp-fs").textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
      setTimeout(() => { resize(); draw(); }, 80);
    });
    $$("#tp-color button").forEach((b) => b.addEventListener("click", () => {
      $$("#tp-color button").forEach((x) => x.classList.toggle("on", x === b));
      T.mode = b.dataset.mode;
      buildColors();
      draw();
    }));
    $("#tp-ghost").addEventListener("change", (e) => { T.ghosts = e.target.checked; draw(); });
    $("#tp-markers").addEventListener("change", (e) => { T.markers = e.target.checked; draw(); });
    $("#tp-ticks").addEventListener("change", (e) => { T.ticks = e.target.checked; draw(); });
    $("#tp-fit").addEventListener("click", fit);
    $("#tp-fs").addEventListener("click", toggleFullscreen);
    T.ready = true;
  }

  // Called when the page is shown and whenever the comparison changes.
  function refresh() {
    if (!T.ready) init();
    const uid = state.map && state.map.map_uid;
    if (uid) $("#tp-back").href = `#/map/${uid}`;
    $("#tp-title").textContent = (state.map && state.map.name) || "Track";
    const d = ctxData();
    $("#tp-empty").hidden = !!d;
    canvas.hidden = !d;
    renderPanel();
    if (!d) return;
    resize();
    buildColors();
    if (T.sel !== null && !d.corners.some((c) => c.corner_index === T.sel)) T.sel = null;
    const c = T.sel !== null ? d.corners.find((x) => x.corner_index === T.sel) : null;
    Object.assign(T.view, fitBox(c ? cornerBox(c) : trackBox(), c ? 0.35 : 0.12));
    draw();
  }

  return { refresh };
})();
