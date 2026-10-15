"use strict";

// The overview's "lap at a glance": the ground you drive on, the corners, the checkpoints and every trick on
// one strip, plus the ground breakdown card and the ground strip along the lap charts.
// Relies on app.js for state, esc, fmtGap, setHighlight, setHover, hoverGroup and nearestIndex.

const GROUND_TIPS = {
  tech: "Full grip. Braking works and a speed drift is possible above ~180 km/h.",
  bump: "Grippy, but the bumps unsettle the car: keep steering small on them.",
  plastic: "Slippery. Smooth early inputs; don't count on speed drifts.",
  dirt: "The car slides by itself. No speed drifts; steady steering.",
  grass: "Little grip and it slows you. Keep inputs small.",
  ice: "Very little grip. No speed drifts; steer early and gently.",
  water: "Slows the car a lot. Keep it straight, throttle down.",
  unknown: "The map file doesn't say what this stretch is made of.",
};

const TRICK_STYLE = {
  cut: { glyph: "↗", color: "#ffc247", title: "Different line" },
  jump: { glyph: "⤴", color: "#8f7bff", title: "Jump line" },
  airbrake: { glyph: "✈", color: "#38d6ff", title: "Air-brake spot" },
  wall: { glyph: "◐", color: "#b9a8ff", title: "Wall ride" },
  flip: { glyph: "⟳", color: "#ff8a3d", title: "Flip" },
};

const groundColor = (s) => (typeof Figures !== "undefined" && Figures.SURFACE_COLORS[s]) || "#59668a";
const groundName = (s) => (typeof Figures !== "undefined" && Figures.SURFACE_NAMES[s]) || s;

// the surface of every point of the primary comparison, once the server has sent it
function groundLabels(primary) {
  const sf = state.surface;
  return primary && sf && sf.labels && sf.labels.length === primary.points.length ? sf.labels : null;
}

function currentPrimary() {
  const c = state.compare;
  return c && c.data[state.primaryRefId] ? c.data[state.primaryRefId] : null;
}

// stretches of the same ground as {from, to, surf} in metres
function groundRuns(primary) {
  const labels = groundLabels(primary);
  if (!labels) return [];
  const pts = primary.points, runs = [];
  let start = 0;
  for (let i = 1; i <= pts.length; i++) {
    if (i === pts.length || labels[i] !== labels[start]) {
      runs.push({ from: pts[start].distance_m, to: pts[Math.min(i, pts.length - 1)].distance_m, surf: labels[start] });
      start = i;
    }
  }
  return runs;
}

// for the chart plugin: a thin strip of ground colour along the bottom of a chart
function surfaceBands(from, to) {
  const p = currentPrimary();
  return groundRuns(p).filter((r) => r.to >= from && r.from <= to).map((r) => ({ from: r.from, to: r.to, color: groundColor(r.surf) }));
}

// every trick worth showing, along the lap
function collectTricks(primary) {
  const out = [];
  if (!primary || !primary.stats.telemetry) return out;
  for (const m of primary.field_moves || []) {
    const st = TRICK_STYLE[m.kind] || TRICK_STYLE.cut;
    out.push({ at: m.dist_m, from: m.start_m ?? m.dist_m - 25, to: m.end_m ?? m.dist_m + 25, kind: m.kind, ...st, text: m.text, tag: m.of > 1 ? `${m.agree} of ${m.of} ghosts` : "ghost" });
  }
  const dr = primary.driving, mine = dr && dr.subject;
  if (mine && mine.oriented) {
    for (const l of mine.landings) {
      if (l.duration_s < 0.5) continue;
      const st = l.flip ? TRICK_STYLE.flip : { glyph: "⤓", title: "Landing", color: l.clean && l.speed_lost < 12 ? "#2fe3a2" : "#ff5a73" };
      out.push({ at: l.dist_m, from: l.dist_m - 25, to: l.dist_m + 25, kind: l.flip ? "flip" : "landing", ...st, text: `You ${l.text}.`, tag: `${l.duration_s.toFixed(1)} s air` });
    }
    for (const w of mine.inverted) {
      out.push({ at: w.dist_m, from: w.start_m, to: w.end_m, kind: "wall", ...TRICK_STYLE.wall, title: w.kind === "upside down" ? "Upside down" : "Wall ride", text: `You ${w.text}.`, tag: `${w.start_m.toFixed(0)}–${w.end_m.toFixed(0)} m` });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------- the ribbon

const RIBBON = { L: 74, R: 24, rows: { checkpoints: 8, ground: 30, corners: 66, tricks: 104 } };

function renderRibbon(primary) {
  const area = $("#ribbon-area");
  const has = primary && primary.stats.telemetry && primary.points.length > 5;
  area.hidden = !has;
  if (!has) { state.ribbon = null; return; }
  const canvas = $("#ribbon");
  const prev = state.ribbon;
  state.ribbon = {
    canvas, pts: primary.points, total: primary.points[primary.points.length - 1].distance_m, corners: primary.corners || [],
    cps: (primary.checkpoints || []).filter((r) => r.label !== "Finish"), items: collectTricks(primary), runs: groundRuns(primary),
    hoverX: prev ? prev.hoverX : null, hit: [],
  };
  if (!canvas.dataset.bound) {
    canvas.dataset.bound = "1";
    canvas.addEventListener("mousemove", ribbonMove);
    canvas.addEventListener("mouseleave", () => { $("#ribbon-tip").hidden = true; setHover("lap", null); });
    canvas.addEventListener("click", ribbonClick);
    new ResizeObserver(() => drawRibbon()).observe(canvas);
    hoverGroup("lap").listeners.add((x) => { if (state.ribbon) { state.ribbon.hoverX = x; drawRibbon(); } });
  }
  drawRibbon();
}

const ribbonX = (r, d, w) => RIBBON.L + (d / Math.max(1, r.total)) * (w - RIBBON.L - RIBBON.R);

function drawRibbon() {
  const r = state.ribbon;
  if (!r || !r.canvas.isConnected || r.canvas.offsetParent === null) return;
  const { canvas } = r;
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const X = (d) => ribbonX(r, d, w);
  const { rows, L, R } = RIBBON;
  r.hit = [];

  // row labels
  ctx.font = '600 11px "Barlow", system-ui, sans-serif';
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = "#7d8aa6";
  ctx.fillText("GROUND", 8, rows.ground + 12);
  ctx.fillText("CORNERS", 8, rows.corners + 11);
  ctx.fillText("TRICKS", 8, rows.tricks + 11);

  // highlighted stretch
  const hl = state.highlight;
  if (hl) {
    ctx.fillStyle = "rgba(238,242,251,0.08)";
    ctx.fillRect(X(hl.from), 0, X(hl.to) - X(hl.from), h);
  }

  // ground
  const gy = rows.ground, gh = 24;
  if (r.runs.length) {
    r.runs.forEach((run) => {
      const x1 = X(run.from), x2 = X(run.to);
      ctx.fillStyle = groundColor(run.surf);
      ctx.fillRect(x1, gy, Math.max(1, x2 - x1), gh);
      if (x2 - x1 > 54) {
        ctx.fillStyle = "rgba(8,11,19,0.82)";
        ctx.font = '700 11px "Barlow", system-ui, sans-serif';
        ctx.textAlign = "center";
        ctx.fillText(groundName(run.surf).toUpperCase(), (x1 + x2) / 2, gy + gh / 2 + 1);
      }
    });
  } else {
    ctx.fillStyle = "#172033";
    ctx.fillRect(L, gy, w - L - R, gh);
    ctx.fillStyle = "#7d8aa6";
    ctx.font = '500 12px "Barlow", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.fillText(state.surface && state.surface.pending ? "Reading the map's blocks…" : "The ground isn't available for this map", (L + w - R) / 2, gy + gh / 2 + 1);
  }

  // corners, coloured by the time gained or lost there
  const maxAbs = Math.max(1, ...r.corners.map((c) => Math.abs(c.time_change_ms)));
  ctx.textAlign = "center";
  r.corners.forEach((c) => {
    const x1 = X(c.distance_start), x2 = Math.max(x1 + 14, X(c.distance_end)), k = Math.min(1, Math.abs(c.time_change_ms) / maxAbs);
    ctx.fillStyle = c.time_change_ms > 0 ? `rgba(255,90,115,${0.25 + k * 0.6})` : c.time_change_ms < 0 ? `rgba(47,227,162,${0.25 + k * 0.6})` : "rgba(125,138,166,0.3)";
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x1, rows.corners, x2 - x1, 22, 5) : ctx.rect(x1, rows.corners, x2 - x1, 22);
    ctx.fill();
    ctx.fillStyle = "#eef2fb";
    ctx.font = '700 11px "IBM Plex Mono", monospace';
    ctx.fillText(String(c.corner_index), (x1 + x2) / 2, rows.corners + 12);
    r.hit.push({ x1, x2, y1: rows.corners, y2: rows.corners + 22, from: c.distance_start, to: c.distance_end, title: `Corner ${c.corner_index}`, text: `${c.direction} ${c.turn_deg}° · ${c.time_change_ms > 0 ? "lost" : "gained"} ${Math.abs(c.time_change_ms / 1000).toFixed(3)}s` });
  });

  // tricks
  r.items.forEach((it) => {
    const x = X(it.at);
    if (it.to - it.from > 8 && it.kind === "wall") {
      ctx.fillStyle = "rgba(185,168,255,0.35)";
      ctx.fillRect(X(it.from), rows.tricks + 6, Math.max(3, X(it.to) - X(it.from)), 10);
    }
    ctx.beginPath(); ctx.arc(x, rows.tricks + 11, 11, 0, 6.3); ctx.fillStyle = "#0a0e17"; ctx.fill();
    ctx.lineWidth = 2.2; ctx.strokeStyle = it.color; ctx.stroke();
    ctx.fillStyle = it.color;
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.fillText(it.glyph, x, rows.tricks + 12);
    r.hit.push({ x1: x - 12, x2: x + 12, y1: rows.tricks, y2: rows.tricks + 24, from: Math.max(0, it.from), to: it.to, title: `${it.title} · ${Math.round(it.at)} m`, text: it.text, tag: it.tag, priority: 1 });
  });

  // checkpoints
  ctx.font = '600 10px "Barlow", system-ui, sans-serif';
  r.cps.forEach((cp) => {
    const x = X(cp.dist_m);
    ctx.strokeStyle = "rgba(238,242,251,0.28)";
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, rows.checkpoints + 8); ctx.lineTo(x, h - 4); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = cp.delta_ms > 20 ? "#ff5a73" : cp.delta_ms < -20 ? "#2fe3a2" : "#b4bfd6";
    ctx.textAlign = "center";
    ctx.fillText(cp.label, x, rows.checkpoints + 2);
  });

  // start / finish
  ctx.fillStyle = "#7d8aa6";
  ctx.font = '500 10px "IBM Plex Mono", monospace';
  ctx.textAlign = "left";
  ctx.fillText("0 m", L, h - 6);
  ctx.textAlign = "right";
  ctx.fillText(`${Math.round(r.total).toLocaleString()} m`, w - R, h - 6);

  // the shared crosshair
  if (r.hoverX != null) {
    const x = X(r.hoverX);
    ctx.strokeStyle = "rgba(238,242,251,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 14); ctx.lineTo(x, h - 16); ctx.stroke();
  }
}

function ribbonDistance(e) {
  const r = state.ribbon, rect = r.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, w = rect.width;
  return Math.max(0, Math.min(r.total, ((x - RIBBON.L) / Math.max(1, w - RIBBON.L - RIBBON.R)) * r.total));
}

function ribbonMove(e) {
  const r = state.ribbon;
  if (!r) return;
  const rect = r.canvas.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const d = ribbonDistance(e);
  setHover("lap", mx >= RIBBON.L ? d : null);
  const tip = $("#ribbon-tip");
  if (mx < RIBBON.L) { tip.hidden = true; return; }
  const hits = r.hit.filter((h) => mx >= h.x1 && mx <= h.x2 && my >= h.y1 && my <= h.y2).sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const ground = r.runs.find((g) => d >= g.from && d <= g.to);
  const lines = [`<b>${Math.round(d).toLocaleString()} m</b>${ground ? ` · on ${esc(groundName(ground.surf))}` : ""}`];
  if (ground) lines.push(`<span class="muted">${esc(GROUND_TIPS[ground.surf] || "")}</span>`);
  hits.slice(0, 2).forEach((h) => lines.push(`<b>${esc(h.title)}</b>${h.tag ? ` <span class="muted">${esc(h.tag)}</span>` : ""}<br>${esc(h.text)}`));
  tip.innerHTML = lines.join("<br>");
  tip.hidden = false;
  const box = r.canvas.parentElement.getBoundingClientRect();
  tip.style.left = `${Math.min(box.width - tip.offsetWidth - 8, Math.max(8, mx + 14))}px`;
  tip.style.top = `${my > 60 ? my - tip.offsetHeight - 10 : my + 18}px`;
  r.canvas.style.cursor = hits.length ? "pointer" : "default";
}

function ribbonClick(e) {
  const r = state.ribbon;
  if (!r) return;
  const rect = r.canvas.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const h = r.hit.filter((x) => mx >= x.x1 && mx <= x.x2 && my >= x.y1 && my <= x.y2).sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
  let sel = null;
  if (h) sel = { from: h.from, to: h.to, title: h.title };
  else {
    const d = ribbonDistance(e), g = r.runs.find((x) => d >= x.from && d <= x.to);
    if (g && my >= RIBBON.rows.ground && my <= RIBBON.rows.ground + 24) sel = { from: g.from, to: g.to, title: `On ${groundName(g.surf)}` };
  }
  if (!sel) return;
  const same = state.highlight && state.highlight.from === sel.from && state.highlight.to === sel.to;
  setHighlight(same ? null : { ...sel, section: null });
  drawRibbon();
}

// ---------------------------------------------------------------- the ground card

function renderGround(primary) {
  const area = $("#ground-area"), body = $("#ground-body");
  const has = primary && primary.stats.telemetry && primary.points.length > 5;
  area.hidden = !has;
  if (!has) return;
  const labels = groundLabels(primary);
  if (!labels) {
    body.innerHTML = `<div class="hint">${state.surface && state.surface.pending ? "Reading the map's blocks…" : "The map file couldn't be read, so the ground under the car isn't known here."}</div>`;
    return;
  }
  const pts = primary.points, by = {};
  for (let i = 1; i < pts.length; i++) {
    const s = labels[i];
    const e = by[s] || (by[s] = { dist: 0, ms: 0, you: 0, ghost: 0, n: 0 });
    e.dist += Math.max(0, pts[i].distance_m - pts[i - 1].distance_m);
    e.ms += pts[i].delta_ms - pts[i - 1].delta_ms;
    e.you += pts[i].subject_speed;
    e.ghost += pts[i].reference_speed;
    e.n += 1;
  }
  const total = Object.values(by).reduce((a, e) => a + e.dist, 0) || 1;
  const rows = Object.entries(by).sort((a, b) => b[1].dist - a[1].dist);
  const bar = rows.map(([s, e]) => `<i style="flex:${e.dist};background:${groundColor(s)}" title="${esc(groundName(s))} ${Math.round((e.dist / total) * 100)}%"></i>`).join("");
  body.innerHTML = `<div class="ground-bar">${bar}</div>
    <div class="ground-rows">${rows.map(([s, e]) => {
      const share = Math.round((e.dist / total) * 100);
      const cls = e.ms > 5 ? "loss" : e.ms < -5 ? "gain" : "";
      return `<div class="ground-row">
        <span class="g-dot" style="background:${groundColor(s)}"></span>
        <span class="g-name">${esc(groundName(s))}</span><span class="g-share">${share}%</span>
        <span class="g-speed">${Math.round(e.you / e.n)} <small>vs ${Math.round(e.ghost / e.n)} km/h</small></span>
        <span class="g-gap ${cls}">${fmtGap(Math.round(e.ms))}</span>
        <span class="g-tip">${esc(GROUND_TIPS[s] || "")}</span></div>`;
    }).join("")}</div>`;
}

// the ground under a corner, as a small coloured chip for the corner table
function groundChip(c, primary) {
  const labels = groundLabels(primary);
  if (!labels) return "";
  const count = {};
  primary.points.forEach((p, i) => { if (p.distance_m >= c.distance_start && p.distance_m <= c.distance_end) count[labels[i]] = (count[labels[i]] || 0) + 1; });
  const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return best ? ` <span class="ground-chip"><i style="background:${groundColor(best[0])}"></i>${esc(groundName(best[0]))}</span>` : "";
}

// the ground arrived (or the comparison changed): redraw everything that shows it
function refreshGround() {
  const p = currentPrimary();
  renderRibbon(p);
  renderGround(p);
  renderSkills(p);
  renderGallery(p);
  if (state.compare) renderCorners(state.compare.data);
  state.charts.forEach((c) => c.update("none"));
}


// ---------------------------------------------------------------- corner by corner

const GALLERY = { sort: "loss", limit: 12 };

// the tricks that happen in or just around a corner
function cornerTricks(primary, c) {
  return collectTricks(primary).filter((it) => it.to >= c.distance_start - 40 && it.from <= c.distance_end + 40);
}

function cornerGround(primary, c) {
  const labels = groundLabels(primary);
  if (!labels) return null;
  const count = {};
  primary.points.forEach((p, i) => { if (p.distance_m >= c.distance_start && p.distance_m <= c.distance_end) count[labels[i]] = (count[labels[i]] || 0) + 1; });
  const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

function speedCell(label, you, ghost) {
  const d = Math.round(you - ghost);
  const cls = d > 1 ? "gain" : d < -1 ? "loss" : "";
  return `<div class="spd"><small>${label}</small><b>${Math.round(you)}</b><span class="vs">vs ${Math.round(ghost)}</span><i class="${cls}">${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d)}</i></div>`;
}

function cornerCardHtml(primary, c, surf) {
  const pic = Figures.cornerFigure(c, primary, surf, 420, { compact: true });
  const g = cornerGround(primary, c);
  const t = c.time_change_ms;
  const tricks = cornerTricks(primary, c);
  const ghost = g ? `<span class="ground-chip"><i style="background:${groundColor(g)}"></i>${esc(groundName(g))}</span>` : "";
  return `<article class="corner-card" data-corner="${c.corner_index}">
    <header>
      <span class="cc-num">${c.corner_index}</span>
      <div class="cc-title"><b>${esc(c.direction)} ${c.turn_deg}°</b>${ghost}<small>${Math.round(c.distance_start)}–${Math.round(c.distance_end)} m</small></div>
      <span class="cc-time ${t > 0 ? "loss" : t < 0 ? "gain" : ""}">${t === 0 ? "even" : `${t > 0 ? "+" : "−"}${(Math.abs(t) / 1000).toFixed(3)} s`}</span>
    </header>
    <button type="button" class="cc-pic" data-act="open" title="Open the full picture">${pic}</button>
    <div class="cc-speeds">
      ${speedCell("Entry", c.subject_entry_speed, c.reference_entry_speed)}
      ${speedCell("Slowest", c.subject_min_speed, c.reference_min_speed)}
      ${speedCell("Exit", c.subject_exit_speed, c.reference_exit_speed)}
    </div>
    <div class="cc-note">${brakeCell(c)}</div>
    ${tricks.length ? `<div class="cc-tricks">${tricks.map((it) => `<div class="trick-line" style="--c:${it.color}"><b>${it.glyph} ${esc(it.title)}</b> ${esc(it.text)}</div>`).join("")}</div>` : ""}
    <footer>
      <button type="button" class="btn tiny" data-act="open">Full picture</button>
      <button type="button" class="btn tiny" data-act="graphs">On the graphs</button>
      <button type="button" class="btn tiny" data-act="share">Share card</button>
    </footer>
  </article>`;
}

function renderGallery(primary) {
  const area = $("#gallery-area"), box = $("#gallery");
  const corners = primary && primary.stats.telemetry ? (primary.corners || []).filter((c) => c.phases) : [];
  area.hidden = !corners.length;
  if (!corners.length) return;
  const surf = groundLabels(primary);
  const sorted = [...corners].sort(GALLERY.sort === "order" ? (a, b) => a.corner_index - b.corner_index : (a, b) => b.time_change_ms - a.time_change_ms);
  const shown = sorted.slice(0, GALLERY.limit);
  box.innerHTML = shown.map((c) => cornerCardHtml(primary, c, surf)).join("") +
    (sorted.length > shown.length ? `<button type="button" class="btn gallery-more" id="gallery-more">Show all ${sorted.length} corners</button>` : "");
  const more = $("#gallery-more");
  if (more) more.addEventListener("click", () => { GALLERY.limit = 999; renderGallery(currentPrimary()); });
  $$(".corner-card", box).forEach((card) => {
    const c = corners.find((x) => x.corner_index === +card.dataset.corner);
    $$("[data-act]", card).forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.act === "open") Figures.modal(c, primary, groundLabels(primary));
      else if (b.dataset.act === "share") shareCorner(c.corner_index);
      else {
        setHighlight({ from: c.distance_start, to: c.distance_end, title: `Corner ${c.corner_index}`, section: null });
        $("#lap-area").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }));
  });
  $$("#gallery-sort button").forEach((b) => b.classList.toggle("on", b.dataset.sort === GALLERY.sort));
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("#gallery-sort button");
  if (!b) return;
  GALLERY.sort = b.dataset.sort;
  renderGallery(currentPrimary());
});


// ---------------------------------------------------------------- the steering plan

function planDirWord(d) { return d === "left" ? "left" : d === "right" ? "right" : "straight"; }

function renderPlan(primary) {
  const area = $("#plan-area");
  const bp = primary && primary.blueprint;
  area.hidden = !(bp && bp.series && primary.stats.telemetry);
  if (area.hidden) return;
  const tags = ((state.map && state.map.tags) || []).map((t) => String(t).toLowerCase());
  const bob = tags.some((t) => t.includes("bob"));
  $("#plan-hint").textContent = `${bob ? "Bobsleigh map: the wheel is the whole lap. " : ""}Built from ${bp.refs} reference ghost${bp.refs === 1 ? "" : "s"}; ${bp.style === "digital" ? "keyboard-style steering, so holds are given in seconds" : "analog steering"}.`;

  const s = bp.series;
  const xy = (arr) => s.d.map((x, i) => ({ x, y: arr[i] }));
  const ds = [
    { label: "lowest", data: xy(s.lo), borderWidth: 0, pointRadius: 0, fill: false, order: 3 },
    { label: "references", data: xy(s.hi), borderWidth: 0, pointRadius: 0, fill: "-1", backgroundColor: "rgba(91,141,239,0.20)", order: 3 },
    dashed("median of the references", xy(s.median), "#5b8def", 2),
    solid("you", xy(s.you), YOU, 2.4),
  ];
  const canvas = $("#plan-chart");
  const chart = lineChart(canvas, ds, { xMin: 0, xMax: s.d[s.d.length - 1], yMin: -1.1, yMax: 1.1, yTitle: "steer", zeroLine: true, bands: [], group: "plan" });
  state.charts.push(chart);

  const z = $("#plan-zones");
  z.innerHTML = bp.zones.length
    ? [...bp.zones].sort((a, b) => b.score - a.score).map((zone, i) => `<button type="button" class="plan-zone" data-from="${zone.from_m}" data-to="${zone.to_m}">
        <span class="pz-rank">${i + 1}</span>
        <span class="pz-where">${Math.round(zone.from_m)}–${Math.round(zone.to_m)} m</span>
        <span class="pz-time ${zone.time_ms > 5 ? "loss" : zone.time_ms < -5 ? "gain" : ""}">${fmtGap(zone.time_ms)}</span>
        <span class="pz-text">${esc(zone.text.replace(/^[0-9-]+ m: /, ""))}</span></button>`).join("")
    : `<div class="hint">Your steering follows the references' everywhere within the limits. Nothing to change in the wheel.</div>`;
  $$(".plan-zone", z).forEach((b) => b.addEventListener("click", () => {
    const from = +b.dataset.from, to = +b.dataset.to;
    const same = state.highlight && state.highlight.from === from && state.highlight.to === to;
    setHighlight(same ? null : { from, to, title: `Steering ${Math.round(from)}–${Math.round(to)} m`, section: null });
  }));

  const analog = bp.style === "analog";
  $("#plan-script-body").innerHTML = `<table class="data plan-table"><thead><tr><th>Where</th><th>Wheel</th>${analog ? "<th>Average</th><th>Peak</th>" : ""}<th>For</th><th>They agree</th></tr></thead><tbody>${bp.script.map((r) => `<tr>
    <td class="mono">${Math.round(r.from_m)}–${Math.round(r.to_m)} m</td><td>${planDirWord(r.dir)}</td>${analog ? `<td class="mono">${r.avg.toFixed(2)}</td><td class="mono">${r.peak.toFixed(2)}</td>` : ""}
    <td class="mono">${r.dur_s.toFixed(1)} s</td><td class="mono">±${r.agree.toFixed(2)}</td></tr>`).join("")}</tbody></table>`;
}
