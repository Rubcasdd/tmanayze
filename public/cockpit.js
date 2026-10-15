"use strict";

// The Cockpit tab: watch both runs' inputs live. A steering wheel, pedals and speed gauge for you and for the
// ghost, a scrolling input tape (what each driver did in the last and next seconds), the gap to the ghost as a
// curve you can scrub, a mini-map, the moments that cost the most, an optional co-driver voice, and a "driver DNA"
// radar of how you compare. Everything is drawn from the comparison's points, so it needs no extra data.
//
// Relies on app.js for shared helpers ($, $$, esc, fmtGap, fmtTime).

const Cockpit = (() => {
  const GHOST = "#5b8def";
  const YOU = "#eef2fb";
  const GAIN = "#2fe3a2";
  const LOSS = "#ff5a73";
  const WARN = "#ffc247";
  const TAPE_S = 3.2;                       // seconds shown each side of "now" on the input tape
  const WHEEL_RAD = 1.9;                    // how far the drawn wheel turns at full lock (radians)

  const S = {
    primary: null, pts: [], rt: [], tEnd: 0, t: 0, playing: false, last: 0, raf: 0, speed: 1, mode: "position",
    voice: false, spoken: new Set(), notes: [], radar: null, maxSpeed: 400, bbox: null, moments: [], dirty: true,
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ------------------------------------------------------------------ data

  function prepare(primary) {
    S.primary = primary;
    S.pts = (primary && primary.points) || [];
    S.rt = [];
    let run = 0;
    for (const p of S.pts) {          // the ghost's clock at each point: your time minus the gap
      run = Math.max(run, p.t_ms - p.delta_ms);
      S.rt.push(run);
    }
    S.ts = S.pts.map((p) => p.t_ms);
    S.tEnd = S.pts.length ? S.pts[S.pts.length - 1].t_ms : 0;
    S.t = 0;
    S.playing = false;
    S.spoken = new Set();
    S.maxSpeed = Math.max(300, Math.ceil(Math.max(0, ...S.pts.map((p) => Math.max(p.subject_speed, p.reference_speed))) / 100) * 100);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of S.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    S.bbox = { x0, x1, z0, z1 };
    S.moments = buildMoments(primary);
    S.notes = buildNotes(primary);
    S.splits = null;
    S.loop = null;
  }

  // index and fraction of the first point at or after time t in a sorted array
  function locate(arr, t) {
    let lo = 0, hi = arr.length - 1;
    if (t <= arr[0]) return [0, 0];
    if (t >= arr[hi]) return [hi, 0];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= t) lo = m; else hi = m; }
    const span = arr[hi] - arr[lo];
    return [lo, span > 0 ? (t - arr[lo]) / span : 0];
  }

  const lerp = (a, b, f) => a + (b - a) * f;

  // everything the dashboard shows at the cursor, for both drivers
  function frame(t) {
    const pts = S.pts;
    const [i, f] = locate(S.ts, t);
    const j0 = S.mode === "race" ? locate(S.rt, t) : [i, f];
    const [j, g] = j0;
    const at = (k, key) => pts[Math.min(pts.length - 1, k)][key];
    const you = (key) => lerp(at(i, key), at(i + 1, key), f);
    const ghost = (key) => lerp(at(j, key), at(j + 1, key), g);
    return {
      i, j,
      delta: you("delta_ms"),
      y: { speed: you("subject_speed"), steer: you("subject_steer"), gas: you("subject_gas"), brake: you("subject_brake"), x: you("x"), z: you("z") },
      g: { speed: ghost("reference_speed"), steer: ghost("reference_steer"), gas: ghost("reference_gas"), brake: ghost("reference_brake"), x: ghost("reference_x"), z: ghost("reference_z") },
    };
  }

  function timeAtDistance(d) {
    const pts = S.pts;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].distance_m <= d) lo = m; else hi = m; }
    return pts[lo].t_ms;
  }

  function buildMoments(primary) {
    const corners = (primary && primary.corners) || [];
    return [...corners]
      .filter((c) => Math.abs(c.time_change_ms) >= 15)
      .sort((a, b) => Math.abs(b.time_change_ms) - Math.abs(a.time_change_ms))
      .slice(0, 7)
      .map((c) => ({
        c,
        t: Math.max(0, timeAtDistance(c.distance_start) - 1400),
        label: `Corner ${c.corner_index}`,
        sub: `${c.direction} ${c.turn_deg}° · ${c.subject_min_speed != null ? Math.round(c.subject_min_speed) : "?"} vs ${c.reference_min_speed != null ? Math.round(c.reference_min_speed) : "?"} km/h at the slowest`,
        ms: c.time_change_ms,
      }));
  }

  // pace notes for the co-driver, one per corner
  function buildNotes(primary) {
    const corners = (primary && primary.corners) || [];
    return corners.map((c) => {
      const kind = c.turn_deg >= 140 ? "hairpin" : c.turn_deg >= 95 ? "tight" : c.turn_deg >= 55 ? "medium" : "easy";
      const dir = /left/i.test(c.direction) ? "left" : /right/i.test(c.direction) ? "right" : String(c.direction || "");
      const brake = c.reference_brake_point_m != null && c.reference_brake_point_m > 3 ? ". Brake." : "";
      const lead = Math.max(900, Math.min(2200, 1300 + (c.subject_entry_speed || 150) * 2));
      return { id: c.corner_index, t: Math.max(0, timeAtDistance(c.distance_start) - lead), text: `${kind} ${dir}${brake}` };
    });
  }

  // ------------------------------------------------------------------ DOM

  function template() {
    return `
    <div class="ck">
      <div class="ck-transport">
        <button type="button" class="btn ck-play" aria-label="Play">&#9654;</button>
        <span class="ck-clock mono">0.00 s</span>
        <select class="ck-speed" aria-label="Playback speed">
          <option value="0.25">×0.25</option><option value="0.5">×0.5</option><option value="1" selected>×1</option><option value="2">×2</option><option value="4">×4</option>
        </select>
        <div class="seg ck-mode" role="group" aria-label="Line the drivers up by">
          <button type="button" class="on" data-mode="position" title="Both at the same spot on the track: compare what each did there">Same spot</button>
          <button type="button" data-mode="race" title="Both at the same moment of the race: the ghost really is ahead or behind">Race clock</button>
        </div>
        <label class="tv-check"><input type="checkbox" class="ck-voice" /> Co-driver voice</label>
        <label class="tv-check"><input type="checkbox" class="ck-engine" /> Engine sound</label>
        <label class="tv-check" title="Play a moment on repeat so you can study it"><input type="checkbox" class="ck-loop" /> Loop a moment</label>
        <button type="button" class="btn quiet ck-rec" title="Record the replay as a video you can share">&#9679; Record clip</button>
        <span class="ck-keys">space play · ← → 1 s (shift 5 s) · , . one frame</span>
      </div>
      <div class="ck-stripwrap"><canvas class="ck-strip" aria-label="Gap to the ghost over the lap. Click or drag to scrub."></canvas><span class="ck-striphint">gap to the ghost &mdash; red: you are losing, green: gaining</span></div>
      <div class="ck-stage">
        <div class="ck-card ck-you"><h3>You</h3><canvas class="ck-dash"></canvas></div>
        <div class="ck-mid">
          <div class="ck-gap mono">0.000</div>
          <div class="ck-gaplabel">behind the ghost</div>
          <canvas class="ck-map" aria-label="Where both cars are on the track"></canvas>
          <div class="ck-cues"><h4>Ghost, next</h4><ul class="ck-cuelist"></ul></div>
          <div class="ck-splits"><h4>Splits</h4><div class="ck-splitlist"></div></div>
        </div>
        <div class="ck-card ck-ghost"><h3>Ghost</h3><canvas class="ck-dash"></canvas></div>
      </div>
      <div class="ck-tapewrap"><canvas class="ck-tape" aria-label="Inputs of both drivers around now"></canvas>
        <div class="ck-tapekey"><span><i style="background:${YOU}"></i>you</span><span><i style="background:${GHOST}"></i>ghost</span><span><i style="background:${GAIN}"></i>throttle</span><span><i style="background:${LOSS}"></i>brake</span></div></div>
      <section class="ck-ultimate"><h3>Ultimate lap <small>the best stretch between checkpoints from every run on this map</small></h3><div class="ck-ubody"></div></section>
      <div class="ck-lower">
        <section class="ck-moments"><h3>Moments that cost the most</h3><div class="ck-mlist"></div></section>
        <section class="ck-dna"><h3>Driver DNA <small>100 = matches the ghost</small></h3><div class="ck-radarbox"><canvas class="ck-radar"></canvas></div><p class="ck-dnanote"></p></section>
      </div>
    </div>`;
  }

  let root = null;

  function render(primary) {
    root = document.getElementById("cockpit-body");
    if (!root) return;
    if (S.radar) { S.radar.destroy(); S.radar = null; }
    stopRecord();
    pause();
    if (!primary || !primary.points || primary.points.length < 4) {
      root.innerHTML = `<div class="hint">The cockpit needs two runs with driving data. Pick your run and a ghost first.</div>`;
      S.pts = [];
      return;
    }
    prepare(primary);
    root.innerHTML = template();
    wire();
    renderMoments();
    renderRadar();
    renderUltimate();
    S.dirty = true;
    if (!root.closest("[hidden]")) draw();
  }

  function wire() {
    const q = (s) => root.querySelector(s);
    q(".ck-play").addEventListener("click", () => (S.playing ? pause() : play()));
    q(".ck-speed").addEventListener("change", (e) => (S.speed = +e.target.value));
    q(".ck-voice").addEventListener("change", (e) => {
      S.voice = e.target.checked;
      S.spoken = new Set();
      if (!S.voice && window.speechSynthesis) window.speechSynthesis.cancel();
      else say("Co-driver on");
    });
    root.querySelectorAll(".ck-mode button").forEach((b) => b.addEventListener("click", () => {
      S.mode = b.dataset.mode;
      root.querySelectorAll(".ck-mode button").forEach((x) => x.classList.toggle("on", x === b));
      q(".ck-gaplabel").hidden = false;
      draw();
    }));
    q(".ck-engine").addEventListener("change", (e) => Engine.toggle(e.target.checked));
    q(".ck-rec").addEventListener("click", () => (S.rec ? stopRecord() : startRecord()));
    const strip = q(".ck-strip");
    const seek = (ev) => {
      const r = strip.getBoundingClientRect();
      S.loop = null;
      S.t = clamp((ev.clientX - r.left) / r.width, 0, 1) * S.tEnd;
      S.spoken = new Set([...S.notes].filter((n) => n.t < S.t).map((n) => n.id));
      draw();
    };
    let drag = false;
    strip.addEventListener("pointerdown", (ev) => { drag = true; strip.setPointerCapture(ev.pointerId); seek(ev); });
    strip.addEventListener("pointermove", (ev) => { if (drag) seek(ev); });
    strip.addEventListener("pointerup", () => (drag = false));
    root.querySelectorAll(".ck-moment").forEach((b) => b.addEventListener("click", () => {
      const m = S.moments[+b.dataset.i];
      S.t = m.t;
      S.spoken = new Set([...S.notes].filter((n) => n.t < S.t).map((n) => n.id));
      draw();
      play();
    }));
  }

  function renderMoments() {
    const box = root.querySelector(".ck-mlist");
    if (!S.moments.length) { box.innerHTML = `<p class="hint">No single corner stands out: the time is lost evenly.</p>`; return; }
    box.innerHTML = S.moments.map((m, i) => `<button type="button" class="ck-moment" data-i="${i}">
      <span class="ck-mt ${m.ms > 0 ? "loss" : "gain"}">${fmtGap(m.ms)}</span>
      <span class="ck-ml"><b>${esc(m.label)}</b><small>${esc(m.sub)}</small></span><span class="ck-go">&#9654;</span></button>`).join("");
    box.querySelectorAll(".ck-moment").forEach((b) => b.addEventListener("click", () => {
      const m = S.moments[+b.dataset.i];
      S.loop = root.querySelector(".ck-loop").checked ? { a: m.t, b: Math.min(S.tEnd, m.t + 6000) } : null;
      S.t = m.t;
      S.spoken = new Set(S.notes.filter((n) => n.t < S.t).map((n) => n.id));
      draw();
      play();
    }));
  }

  // ------------------------------------------------------------------ transport

  function play() {
    if (!S.pts.length) return;
    if (S.t >= S.tEnd - 50) S.t = 0;
    S.playing = true;
    S.last = performance.now();
    root.querySelector(".ck-play").innerHTML = "&#10074;&#10074;";
    cancelAnimationFrame(S.raf);
    const tick = (now) => {
      if (!S.playing) return;
      S.t = Math.min(S.tEnd, S.t + (now - S.last) * S.speed);
      S.last = now;
      if (S.loop && root.querySelector(".ck-loop").checked && S.t >= S.loop.b) {   // round again
        S.t = S.loop.a;
        S.spoken = new Set(S.notes.filter((n) => n.t < S.t).map((n) => n.id));
      }
      draw();
      if (S.t >= S.tEnd) { stopRecord(); return pause(); }
      S.raf = requestAnimationFrame(tick);
    };
    S.raf = requestAnimationFrame(tick);
  }

  function pause() {
    S.playing = false;
    cancelAnimationFrame(S.raf);
    Engine.update(null, null);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    const b = root && root.querySelector(".ck-play");
    if (b) b.innerHTML = "&#9654;";
  }

  function say(text) {
    if (!S.voice || !window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.25;
      window.speechSynthesis.speak(u);
    } catch (e) { /* speech is a bonus */ }
  }

  // ------------------------------------------------------------------ drawing

  function fit(canvas) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    return { c, w, h };
  }

  function draw() {
    if (!root || !S.pts.length) return;
    const fr = frame(S.t);
    root.querySelector(".ck-clock").textContent = `${(S.t / 1000).toFixed(2)} s`;
    const gapEl = root.querySelector(".ck-gap");
    const d = fr.delta;
    gapEl.textContent = `${d > 0 ? "+" : d < 0 ? "−" : ""}${(Math.abs(d) / 1000).toFixed(3)}`;
    gapEl.style.color = d > 8 ? LOSS : d < -8 ? GAIN : YOU;
    const back = frame(Math.max(0, S.t - 1000)).delta;
    const rate = (d - back) / Math.max(0.2, Math.min(1, S.t / 1000));        // ms lost per second of driving
    const trend = Math.abs(rate) < 6 ? "holding the gap" : rate > 0 ? `losing ${(rate / 1000).toFixed(2)} s every second` : `gaining ${(-rate / 1000).toFixed(2)} s every second`;
    root.querySelector(".ck-gaplabel").innerHTML = `${d > 8 ? "behind the ghost" : d < -8 ? "ahead of the ghost" : "level with the ghost"}<br><span class="${Math.abs(rate) < 6 ? "" : rate > 0 ? "loss" : "gain"}">${trend}</span>`;
    const dashes = root.querySelectorAll(".ck-dash");
    drawDash(dashes[0], fr.y, YOU, "you");
    drawDash(dashes[1], fr.g, GHOST, "ghost");
    drawStrip();
    drawMap(fr);
    drawTape();
    drawCues(fr);
    drawSplits(S.t);
    if (S.playing) Engine.update(fr.y, fr.g);
    if (S.rec) compose(d, gapEl.style.color);
    if (S.voice && S.playing) {
      for (const n of S.notes) {
        if (!S.spoken.has(n.id) && S.t >= n.t && S.t < n.t + 1200) { S.spoken.add(n.id); say(n.text); }
      }
    }
  }

  // speed gauge, wheel and pedals for one driver
  function drawDash(canvas, v, color) {
    const f = fit(canvas);
    if (!f) return;
    const { c, w, h } = f;
    const R = Math.min(h * 0.36, w * 0.2), cx = R + 22, cy = h * 0.52;
    // gauge
    const a0 = Math.PI * 0.78, a1 = Math.PI * 2.22;
    c.lineCap = "round";
    c.lineWidth = 11;
    c.strokeStyle = "#223049";
    c.beginPath(); c.arc(cx, cy, R, a0, a1); c.stroke();
    const frac = clamp(v.speed / S.maxSpeed, 0, 1);
    c.strokeStyle = color;
    c.shadowColor = color; c.shadowBlur = 14;
    c.beginPath(); c.arc(cx, cy, R, a0, a0 + (a1 - a0) * frac); c.stroke();
    c.shadowBlur = 0;
    c.lineWidth = 2; c.strokeStyle = "#34476a";
    for (let s = 0; s <= S.maxSpeed; s += 100) {
      const a = a0 + (a1 - a0) * (s / S.maxSpeed);
      c.beginPath(); c.moveTo(cx + Math.cos(a) * (R + 10), cy + Math.sin(a) * (R + 10)); c.lineTo(cx + Math.cos(a) * (R + 17), cy + Math.sin(a) * (R + 17)); c.stroke();
    }
    c.fillStyle = "#eef2fb"; c.textAlign = "center";
    c.font = `700 ${Math.round(R * 0.7)}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    c.fillText(String(Math.round(v.speed)), cx, cy + R * 0.22);
    c.fillStyle = "#7d8aa6"; c.font = `600 ${Math.round(R * 0.2)}px Barlow, sans-serif`;
    c.fillText("km/h", cx, cy + R * 0.58);
    // the wheel, turning with the input
    const wr = Math.min(w * 0.1, h * 0.2), wx = cx + R + 22 + wr + 14, wy = h * 0.42;
    c.save(); c.translate(wx, wy); c.rotate(v.steer * WHEEL_RAD);
    c.lineWidth = 6; c.strokeStyle = color; c.shadowColor = color; c.shadowBlur = 8;
    c.beginPath(); c.arc(0, 0, wr, 0, Math.PI * 2); c.stroke();
    c.shadowBlur = 0; c.lineWidth = 5;
    c.beginPath(); c.moveTo(-wr, 0); c.lineTo(wr, 0); c.moveTo(0, 0); c.lineTo(0, wr); c.stroke();
    c.fillStyle = WARN; c.fillRect(-3.5, -wr - 3, 7, 9);
    c.restore();
    c.fillStyle = "#b4bfd6"; c.font = `600 13px "IBM Plex Mono", monospace`;
    c.fillText(`${v.steer >= 0 ? "R" : "L"} ${Math.abs(v.steer).toFixed(2)}`, wx, wy + wr + 24);
    // what the driver is doing right now
    const st = v.brake > 0.1 ? ["BRAKING", LOSS] : Math.abs(v.steer) > 0.95 ? ["FULL LOCK", WARN] : v.gas < 0.1 ? ["COASTING", WARN] : v.gas > 0.95 ? ["FULL THROTTLE", GAIN] : ["PART THROTTLE", "#b4bfd6"];
    c.font = `700 11px Barlow, sans-serif`;
    const tw = c.measureText(st[0]).width + 18;
    c.fillStyle = "rgba(10,14,23,0.8)"; c.strokeStyle = st[1]; c.lineWidth = 1.5;
    c.beginPath(); c.roundRect(w - tw - 6, 4, tw, 20, 10); c.fill(); c.stroke();
    c.fillStyle = st[1]; c.textAlign = "center"; c.fillText(st[0], w - tw / 2 - 6, 18);
    // pedals on the right
    const pw = Math.min(26, w * 0.07), px = w - pw * 2 - 22, ph = h * 0.62, py = h * 0.2;
    const pedal = (x, val, col, label) => {
      c.fillStyle = "#172033"; c.fillRect(x, py, pw, ph);
      c.fillStyle = col; c.shadowColor = col; c.shadowBlur = val > 0.05 ? 10 : 0;
      c.fillRect(x, py + ph * (1 - val), pw, ph * val);
      c.shadowBlur = 0;
      c.fillStyle = "#7d8aa6"; c.font = `600 11px Barlow, sans-serif`; c.fillText(label, x + pw / 2, py + ph + 16);
    };
    pedal(px, clamp(v.brake, 0, 1), LOSS, "BRAKE");
    pedal(px + pw + 10, clamp(v.gas, 0, 1), GAIN, "GAS");
  }

  // the gap over the whole lap: a scrubber
  function drawStrip() {
    const canvas = root.querySelector(".ck-strip");
    const f = fit(canvas);
    if (!f) return;
    const { c, w, h } = f;
    const pts = S.pts;
    let m = 100;
    for (const p of pts) m = Math.max(m, Math.abs(p.delta_ms));
    const X = (t) => (t / S.tEnd) * w, Y = (d) => h / 2 - (d / m) * (h / 2 - 8);
    c.fillStyle = "rgba(255,90,115,0.16)";
    c.beginPath(); c.moveTo(0, h / 2);
    pts.forEach((p) => c.lineTo(X(p.t_ms), Y(Math.max(0, p.delta_ms))));
    c.lineTo(w, h / 2); c.closePath(); c.fill();
    c.fillStyle = "rgba(47,227,162,0.16)";
    c.beginPath(); c.moveTo(0, h / 2);
    pts.forEach((p) => c.lineTo(X(p.t_ms), Y(Math.min(0, p.delta_ms))));
    c.lineTo(w, h / 2); c.closePath(); c.fill();
    c.strokeStyle = "#34476a"; c.lineWidth = 1; c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.stroke();
    // coloured by whether you are gaining or losing right there
    c.lineWidth = 2.5;
    for (let i = 1; i < pts.length; i++) {
      const slope = pts[i].delta_ms - pts[Math.max(0, i - 4)].delta_ms;
      c.strokeStyle = slope > 6 ? LOSS : slope < -6 ? GAIN : "#7d8aa6";
      c.beginPath(); c.moveTo(X(pts[i - 1].t_ms), Y(pts[i - 1].delta_ms)); c.lineTo(X(pts[i].t_ms), Y(pts[i].delta_ms)); c.stroke();
    }
    // corner ticks and the moments
    c.font = `600 10px "IBM Plex Mono", monospace`; c.textAlign = "center";
    for (const k of ((S.primary && S.primary.corners) || [])) {
      const x = X(timeAtDistance(k.distance_start));
      c.fillStyle = "#34476a"; c.fillRect(x - 0.5, h - 12, 1, 6);
      c.fillStyle = "#7d8aa6"; c.fillText(String(k.corner_index), x, h - 1);
    }
    for (const mo of S.moments) {
      c.fillStyle = mo.ms > 0 ? LOSS : GAIN;
      c.beginPath(); const x = X(mo.t + 1400); c.moveTo(x - 4, 2); c.lineTo(x + 4, 2); c.lineTo(x, 9); c.fill();
    }
    // the cursor
    const cx = X(S.t);
    c.strokeStyle = "#eef2fb"; c.lineWidth = 2;
    c.beginPath(); c.moveTo(cx, 0); c.lineTo(cx, h); c.stroke();
  }

  function drawMap(fr) {
    const canvas = root.querySelector(".ck-map");
    const f = fit(canvas);
    if (!f) return;
    const { c, w, h } = f;
    const b = S.bbox, pad = 12;
    const sx = (w - pad * 2) / Math.max(1, b.x1 - b.x0), sz = (h - pad * 2) / Math.max(1, b.z1 - b.z0);
    const sc = Math.min(sx, sz);
    const ox = (w - (b.x1 - b.x0) * sc) / 2, oz = (h - (b.z1 - b.z0) * sc) / 2;
    const P = (x, z) => [ox + (x - b.x0) * sc, oz + (z - b.z0) * sc];
    c.lineWidth = 2; c.strokeStyle = "#223049"; c.lineJoin = "round";
    c.beginPath();
    S.pts.forEach((p, i) => { const [x, y] = P(p.x, p.z); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
    c.stroke();
    // what has been driven, in the colour of the gap
    c.lineWidth = 3;
    c.strokeStyle = "rgba(238,242,251,0.55)";
    c.beginPath();
    for (let i = 0; i <= fr.i; i++) { const [x, y] = P(S.pts[i].x, S.pts[i].z); if (i) c.lineTo(x, y); else c.moveTo(x, y); }
    c.stroke();
    const dot = (p, col, r) => {
      const [x, y] = P(p.x, p.z);
      c.fillStyle = col; c.shadowColor = col; c.shadowBlur = 12;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.shadowBlur = 0;
    };
    dot(fr.g, GHOST, 5);
    dot(fr.y, YOU, 6);
  }

  // the input tape: steering and pedals either side of "now"
  function drawTape() {
    const canvas = root.querySelector(".ck-tape");
    const f = fit(canvas);
    if (!f) return;
    const { c, w, h } = f;
    const nowX = w * 0.42;
    const pxs = (w - nowX) / (TAPE_S * 1000) * 0.9;           // px per ms, same each side so the "future" is shorter
    const steerH = h * 0.5, pedY = steerH + 14, pedH = h - pedY - 6;
    const pts = S.pts;
    const T = (i) => pts[i].t_ms;
    c.fillStyle = "rgba(23,32,51,0.6)"; c.fillRect(0, 0, w, steerH);
    c.fillStyle = "rgba(23,32,51,0.6)"; c.fillRect(0, pedY, w, pedH);
    c.strokeStyle = "#223049"; c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, steerH / 2); c.lineTo(w, steerH / 2); c.stroke();
    // time ticks each second
    c.fillStyle = "#7d8aa6"; c.font = `600 10px "IBM Plex Mono", monospace`; c.textAlign = "center";
    const baseT = S.t, tMin = baseT - nowX / pxs, tMax = baseT + (w - nowX) / pxs;
    for (let s = Math.ceil(tMin / 1000); s * 1000 <= tMax; s++) {
      const x = nowX + (s * 1000 - baseT) * pxs;
      c.fillStyle = "#223049"; c.fillRect(x, 0, 1, h);
      c.fillStyle = "#7d8aa6"; c.fillText(`${s}s`, x, h - 3);
    }
    const series = (key, tfn, col, width, dash) => {
      c.strokeStyle = col; c.lineWidth = width; c.setLineDash(dash || []); c.beginPath();
      let started = false;
      for (let i = 0; i < pts.length; i++) {
        const t = tfn(i);
        if (t < tMin - 400) continue;
        if (t > tMax + 400) break;
        const x = nowX + (t - baseT) * pxs, y = steerH / 2 - pts[i][key] * (steerH / 2 - 6);
        if (started) c.lineTo(x, y); else { c.moveTo(x, y); started = true; }
      }
      c.stroke(); c.setLineDash([]);
    };
    series("reference_steer", S.mode === "race" ? (i) => S.rt[i] : T, GHOST, 2, [5, 4]);
    series("subject_steer", T, YOU, 2.5);
    // pedals: you on top (filled), the ghost as a thin line below
    const lane = (key, col, y0, hh, tfn, fill) => {
      const xs = [], ys = [];
      for (let i = 0; i < pts.length; i++) {
        const t = tfn(i);
        if (t < tMin - 400) continue;
        if (t > tMax + 400) break;
        xs.push(nowX + (t - baseT) * pxs); ys.push(clamp(pts[i][key], 0, 1));
      }
      if (!xs.length) return;
      if (fill) {
        c.beginPath(); c.moveTo(xs[0], y0 + hh);
        xs.forEach((x, k) => c.lineTo(x, y0 + hh * (1 - ys[k])));
        c.lineTo(xs[xs.length - 1], y0 + hh); c.closePath();
        c.fillStyle = col; c.globalAlpha = 0.5; c.fill(); c.globalAlpha = 1;
      }
      c.strokeStyle = col; c.lineWidth = 1.6; c.beginPath();
      let pen = false;
      xs.forEach((x, k) => {            // draw the line only while something is pressed
        if (ys[k] < 0.03) { pen = false; return; }
        const y = y0 + hh * (1 - ys[k]);
        if (pen) c.lineTo(x, y); else { c.moveTo(x, y); pen = true; }
      });
      c.stroke();
    };
    const half = pedH / 2 - 2;
    lane("subject_gas", GAIN, pedY, half, T, true);
    lane("subject_brake", LOSS, pedY, half, T, true);
    const rT = S.mode === "race" ? (i) => S.rt[i] : T;
    c.globalAlpha = 0.9;
    lane("reference_gas", GAIN, pedY + half + 4, half, rT, false);
    lane("reference_brake", LOSS, pedY + half + 4, half, rT, false);
    c.globalAlpha = 1;
    c.fillStyle = "#7d8aa6"; c.textAlign = "left"; c.font = `600 10px Barlow, sans-serif`;
    c.fillText("STEERING  ← left · right →", 6, 12);
    c.fillText("YOU: gas / brake", 6, pedY + 11);
    c.fillText("GHOST: gas / brake", 6, pedY + half + 15);
    // now
    c.strokeStyle = "#ffc247"; c.lineWidth = 2;
    c.beginPath(); c.moveTo(nowX, 0); c.lineTo(nowX, h); c.stroke();
    c.fillStyle = "#ffc247"; c.textAlign = "center"; c.font = `700 10px Barlow, sans-serif`; c.fillText("NOW", nowX, 10);
  }

  // ------------------------------------------------------------------ the radar

  function renderRadar() {
    const d = S.primary && S.primary.driving;
    const corners = (S.primary && S.primary.corners) || [];
    const last = S.pts[S.pts.length - 1];
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const ratio = (a, b) => corners.filter((k) => k[a] && k[b]).map((k) => (100 * k[a]) / k[b]);
    const subj = d && d.subject, ref = d && d.reference;
    const clean = (side) => {
      const l = ((side && side.landings) || []).filter((x) => x.duration_s >= 0.5);
      return l.length ? (100 * l.filter((x) => x.clean && x.speed_lost < 12).length) / l.length : null;
    };
    const axes = [
      ["Pace", 100 * (last.t_ms - last.delta_ms) / last.t_ms, 100],
      ["Corner entry", mean(ratio("subject_entry_speed", "reference_entry_speed")), 100],
      ["Corner speed", mean(ratio("subject_min_speed", "reference_min_speed")), 100],
      ["Corner exit", mean(ratio("subject_exit_speed", "reference_exit_speed")), 100],
      ["Wheel smoothness", subj && subj.smoothness ? subj.smoothness.wheel : null, ref && ref.smoothness ? ref.smoothness.wheel : null],
      ["Pedal smoothness", subj && subj.smoothness ? subj.smoothness.pedals : null, ref && ref.smoothness ? ref.smoothness.pedals : null],
      ["Landings", clean(subj), clean(ref)],
    ].filter((a) => a[1] != null && a[2] != null);
    const canvas = root.querySelector(".ck-radar");
    if (axes.length < 3 || typeof Chart === "undefined") {
      root.querySelector(".ck-dna").hidden = true;
      return;
    }
    root.querySelector(".ck-dna").hidden = false;
    const cap = (v) => Math.round(clamp(v, 40, 112));
    S.radar = new Chart(canvas, {
      type: "radar",
      data: {
        labels: axes.map((a) => a[0]),
        datasets: [
          { label: "Ghost", data: axes.map((a) => cap(a[2])), borderColor: GHOST, backgroundColor: "rgba(91,141,239,0.10)", borderDash: [5, 4], pointRadius: 2 },
          { label: "You", data: axes.map((a) => cap(a[1])), borderColor: "#8f7bff", backgroundColor: "rgba(143,123,255,0.28)", borderWidth: 2.5, pointRadius: 3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 700 },
        scales: { r: { min: 40, max: 112, ticks: { display: false, stepSize: 20 }, grid: { color: "#223049" }, angleLines: { color: "#223049" }, pointLabels: { color: "#b4bfd6", font: { size: 12 } } } },
        plugins: { legend: { labels: { color: "#b4bfd6" } } },
      },
    });
    const weakest = [...axes].map((a) => [a[0], a[1] - a[2]]).sort((p, q) => p[1] - q[1])[0];
    root.querySelector(".ck-dnanote").textContent =
      `Each corner is your speed against the ghost's at the same corner, 100 meaning the same. Weakest against this ghost: ${weakest[0].toLowerCase()}.`;
  }

  // ------------------------------------------------------------------ what the ghost does next

  function drawCues(fr) {
    const list = root.querySelector(".ck-cuelist");
    const pts = S.pts, rt = S.rt, j = fr.j, now = rt[j], horizon = 1800;
    const cues = [];
    const brakingNow = fr.g.brake > 0.1;
    let brakeAt = null, liftAt = null, peak = 0, peakAt = null;
    for (let k = j + 1; k < pts.length && rt[k] - now <= horizon; k++) {
      const dt = (rt[k] - now) / 1000;
      if (brakeAt == null && !brakingNow && pts[k].reference_brake > 0.15) brakeAt = dt;
      if (liftAt == null && fr.g.gas > 0.5 && pts[k].reference_gas < 0.1 && pts[k].reference_brake < 0.1) liftAt = dt;
      if (Math.abs(pts[k].reference_steer) > Math.abs(peak) + 0.001) { peak = pts[k].reference_steer; peakAt = dt; }
    }
    if (brakeAt != null) cues.push(["brake", `Brakes in ${brakeAt.toFixed(1)} s`, LOSS]);
    if (liftAt != null) cues.push(["lift", `Lifts the throttle in ${liftAt.toFixed(1)} s`, WARN]);
    if (Math.abs(peak) >= 0.45 && Math.abs(peak) - Math.abs(fr.g.steer) > 0.2) cues.push(["steer", `Steers ${peak > 0 ? "right" : "left"} ${Math.abs(peak).toFixed(2)} in ${peakAt.toFixed(1)} s`, GHOST]);
    else if (Math.abs(fr.g.steer) > 0.45) cues.push(["steer", `Holding ${fr.g.steer > 0 ? "right" : "left"} ${Math.abs(fr.g.steer).toFixed(2)}`, GHOST]);
    if (!cues.length) cues.push(["flat", "Straight on, throttle down", GAIN]);
    const html = cues.slice(0, 3).map((q) => `<li style="border-left-color:${q[2]}">${esc(q[1])}</li>`).join("");
    if (list.dataset.h !== html) { list.innerHTML = html; list.dataset.h = html; }
  }

  // ------------------------------------------------------------------ splits as the replay passes each checkpoint

  function splitData() {
    const me = state.runs.find((r) => r.id === state.subjectId);
    const ref = state.runs.find((r) => r.id === state.primaryRefId);
    if (!me || !ref || !Array.isArray(me.checkpoints) || !Array.isArray(ref.checkpoints) || me.checkpoints.length !== ref.checkpoints.length) return null;
    return me.checkpoints.map((t, i) => ({ t, d: t - ref.checkpoints[i], name: i === me.checkpoints.length - 1 ? "Finish" : `CP ${i + 1}` }));
  }

  function drawSplits(t) {
    const box = root.querySelector(".ck-splitlist");
    const data = S.splits || (S.splits = splitData());
    if (!data) { box.parentElement.hidden = true; return; }
    const done = data.filter((x) => x.t <= t);
    const key = String(done.length);
    if (box.dataset.k === key) return;
    const fresh = box.dataset.k != null && done.length > +box.dataset.k;
    box.dataset.k = key;
    box.innerHTML = data.map((x, i) => {
      const on = x.t <= t;
      return `<div class="ck-split${on ? " on" : ""}${on && i === done.length - 1 && fresh ? " flash" : ""}"><span>${x.name}</span><b class="mono ${on ? (x.d > 4 ? "loss" : x.d < -4 ? "gain" : "") : ""}">${on ? fmtGap(x.d) : "–"}</b></div>`;
    }).join("");
    if (fresh && S.voice && S.playing) {
      const x = done[done.length - 1];
      say(`${x.name}, ${x.d > 0 ? "plus" : "minus"} ${(Math.abs(x.d) / 1000).toFixed(2)}`);
    }
  }

  // ------------------------------------------------------------------ the ultimate lap

  // segment times from a run's cumulative checkpoint times
  const segs = (cps) => cps.map((t, i) => t - (i ? cps[i - 1] : 0));

  function renderUltimate() {
    const box = root.querySelector(".ck-ubody"), sec = root.querySelector(".ck-ultimate");
    const me = state.runs.find((r) => r.id === state.subjectId);
    const pool = state.runs.filter((r) => r.map_uid === (me && me.map_uid) && Array.isArray(r.checkpoints) && me && r.checkpoints.length === me.checkpoints.length && r.checkpoints.length > 1);
    if (!me || !Array.isArray(me.checkpoints) || me.checkpoints.length < 2 || pool.length < 2) { sec.hidden = true; return; }
    sec.hidden = false;
    const n = me.checkpoints.length;
    const mine = segs(me.checkpoints);
    const best = mine.map((_, i) => pool.reduce((b, r) => { const v = segs(r.checkpoints)[i]; return !b || v < b.v ? { v, who: r } : b; }, null));
    const own = pool.filter((r) => r.kind === "run");
    const ownBest = mine.map((_, i) => own.reduce((m, r) => Math.min(m, segs(r.checkpoints)[i]), Infinity));
    const ultimate = best.reduce((a, b) => a + b.v, 0), wr = Math.min(...pool.map((r) => r.race_time_ms || Infinity));
    const mineTotal = me.checkpoints[n - 1];
    const ownUlt = own.length >= 2 ? ownBest.reduce((a, b) => a + b, 0) : null;
    const maxSeg = Math.max(...mine, ...best.map((b) => b.v));
    const name = (r) => (typeof tmName === "function" ? tmName(r.player_nickname) : r.player_nickname) || "run";
    const label = (i) => `${i === 0 ? "Start" : "CP " + i} → ${i === n - 1 ? "Finish" : "CP " + (i + 1)}`;
    const f = (ms) => (ms / 1000).toFixed(3);
    const rows = mine.map((v, i) => {
      const gap = v - best[i].v;
      return `<div class="ck-urow"><span class="ck-ul">${label(i)}</span>
        <span class="ck-ubar"><i class="you" style="width:${(v / maxSeg) * 100}%"></i><i class="best" style="width:${(best[i].v / maxSeg) * 100}%"></i></span>
        <span class="mono">${f(v)}</span><span class="mono ${gap > 4 ? "loss" : "gain"}">${gap > 4 ? "+" + f(gap) : "best"}</span>
        <span class="ck-uw">${gap > 4 ? esc(name(best[i].who)) : ""}</span></div>`;
    }).join("");
    box.innerHTML = `<div class="ck-uhead">
        <div><b class="mono">${fmtTime(Math.round(ultimate))}</b><small>ultimate lap, never driven</small></div>
        <div><b class="mono gain">−${f(mineTotal - ultimate)}s</b><small>against this run</small></div>
        <div><b class="mono ${ultimate < wr ? "gain" : ""}">${ultimate < wr ? "−" : "+"}${f(Math.abs(wr - ultimate))}s</b><small>against the fastest run here</small></div>
        ${ownUlt != null ? `<div><b class="mono">${fmtTime(Math.round(ownUlt))}</b><small>your own best segments</small></div>` : ""}
      </div>
      <div class="ck-ukey"><span><i class="you"></i>this run</span><span><i class="best"></i>best stretch</span></div>${rows}`;
  }

  // ------------------------------------------------------------------ engine sound

  // a synthesised engine: the pitch follows your speed and steps down at the real gear shifts (about 100, 160, 235, 341 km/h);
  // the ghost is a softer, higher note on the right.
  const Engine = (() => {
    const SHIFTS = [0, 100, 160, 235, 341, 600];
    let ctx = null, on = false, voices = null;
    const make = (pan, type) => {
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner();
      o.type = type; o2.type = "square"; lp.type = "lowpass"; lp.frequency.value = 900; g.gain.value = 0; p.pan.value = pan;
      const g2 = ctx.createGain(); g2.gain.value = 0.35;
      o.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(p); p.connect(ctx.destination);
      o.start(); o2.start();
      return { o, o2, g, lp };
    };
    const drive = (v, gain, speed, gas) => {
      let k = 0; while (k < SHIFTS.length - 2 && speed >= SHIFTS[k + 1]) k++;
      const rpm = clamp((speed - SHIFTS[k]) / (SHIFTS[k + 1] - SHIFTS[k]), 0, 1);
      const f = 52 + k * 7 + rpm * (95 - k * 6);
      const now = ctx.currentTime;
      v.o.frequency.setTargetAtTime(f * gain.pitch, now, 0.03);
      v.o2.frequency.setTargetAtTime(f * gain.pitch * 2.01, now, 0.03);
      v.lp.frequency.setTargetAtTime(500 + rpm * 1400 + gas * 600, now, 0.05);
      v.g.gain.setTargetAtTime(gain.vol * (0.35 + 0.65 * gas), now, 0.05);
    };
    return {
      toggle(enable) {
        on = enable;
        if (!on) { this.update(null, null); return; }
        try {
          if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
          if (ctx.state === "suspended") ctx.resume();
          if (!voices) voices = { you: make(-0.45, "sawtooth"), ghost: make(0.45, "triangle") };
        } catch (e) { on = false; }
      },
      update(you, ghost) {
        if (!ctx || !voices) return;
        if (!on || !you) { for (const v of Object.values(voices)) v.g.gain.setTargetAtTime(0, ctx.currentTime, 0.05); return; }
        drive(voices.you, { pitch: 1, vol: 0.05 }, you.speed, you.gas);
        drive(voices.ghost, { pitch: 1.5, vol: 0.022 }, ghost.speed, ghost.gas);
      },
    };
  })();

  // ------------------------------------------------------------------ recording a clip

  const REC_W = 1280, REC_H = 720;

  function startRecord() {
    if (!S.pts.length || typeof MediaRecorder === "undefined") { alert("This browser can't record video."); return; }
    const out = document.createElement("canvas");
    out.width = REC_W; out.height = REC_H;
    const stream = out.captureStream(30);
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 6000000 } : {});
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      S.lastClipBytes = blob.size;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const nm = (state.map && state.map.name) || "replay";
      a.download = `cockpit-${String(nm).replace(/[^\w]+/g, "-").toLowerCase()}.webm`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    };
    S.rec = { out, ctx: out.getContext("2d"), rec, started: performance.now() };
    const btn = root.querySelector(".ck-rec");
    btn.textContent = "■ Stop and save";
    btn.classList.add("rec-on");
    rec.start(250);
    S.t = Math.max(0, S.t);
    play();
  }

  function stopRecord() {
    if (!S.rec) return;
    const r = S.rec;
    S.rec = null;
    try { r.rec.stop(); } catch (e) { /* already stopped */ }
    const btn = root && root.querySelector(".ck-rec");
    if (btn) { btn.innerHTML = "&#9679; Record clip"; btn.classList.remove("rec-on"); }
  }

  // one frame of the clip: the dashboard laid out on a 16:9 canvas
  function compose(delta, gapColor) {
    const { ctx: c } = S.rec;
    const g = c.createLinearGradient(0, 0, REC_W, REC_H);
    g.addColorStop(0, "#131b2e"); g.addColorStop(1, "#080b13");
    c.fillStyle = g; c.fillRect(0, 0, REC_W, REC_H);
    c.fillStyle = "#8f7bff"; c.fillRect(0, 0, 8, REC_H);
    const q = (s) => root.querySelector(s);
    const img = (cv, x, y, w, h) => { if (cv.width) c.drawImage(cv, x, y, w, h || (w * cv.height) / cv.width); };
    c.textBaseline = "alphabetic"; c.textAlign = "left";
    c.fillStyle = "#7d8aa6"; c.font = `600 15px Barlow, sans-serif`; c.fillText("TRACKMANIA AI ANALYZER", 28, 34);
    c.fillStyle = "#eef2fb"; c.font = `700 30px "Barlow Condensed", "Arial Narrow", sans-serif`;
    c.fillText(`${((state.map && state.map.name) || "").toUpperCase()}   ·   ${S.mode === "race" ? "RACE CLOCK" : "SAME SPOT"}`, 28, 66);
    c.textAlign = "right"; c.font = `600 26px "IBM Plex Mono", monospace`; c.fillText(`${(S.t / 1000).toFixed(2)} s`, REC_W - 28, 60);
    img(q(".ck-strip"), 24, 80, REC_W - 48, 92);
    const dashes = root.querySelectorAll(".ck-dash");
    const dh = (cv) => (460 * cv.height) / cv.width;
    c.fillStyle = "#eef2fb"; c.textAlign = "left"; c.font = `700 16px Barlow, sans-serif`; c.fillText("YOU", 28, 200);
    img(dashes[0], 24, 208, 460);
    c.fillStyle = "#5b8def"; c.textAlign = "right"; c.fillText("GHOST", REC_W - 28, 200);
    img(dashes[1], REC_W - 484, 208, 460);
    c.textAlign = "center"; c.fillStyle = gapColor || "#eef2fb"; c.font = `700 60px "IBM Plex Mono", monospace`;
    c.fillText(`${delta > 0 ? "+" : delta < 0 ? "−" : ""}${(Math.abs(delta) / 1000).toFixed(3)}`, REC_W / 2, 250);
    c.fillStyle = "#7d8aa6"; c.font = `600 15px Barlow, sans-serif`;
    c.fillText(delta > 8 ? "BEHIND THE GHOST" : delta < -8 ? "AHEAD OF THE GHOST" : "LEVEL WITH THE GHOST", REC_W / 2, 276);
    const mp = q(".ck-map");
    img(mp, REC_W / 2 - 110, 284, 220, (220 * mp.height) / Math.max(1, mp.width));
    const tp = q(".ck-tape");
    img(tp, 24, 214 + Math.max(dh(dashes[0]), 210) + 8, REC_W - 48, REC_H - (214 + Math.max(dh(dashes[0]), 210) + 8) - 14);
  }

  // ------------------------------------------------------------------ tab hooks

  function show() {
    if (!root) return;
    requestAnimationFrame(() => { draw(); if (S.radar) S.radar.resize(); });
  }

  window.addEventListener("keydown", (e) => {
    if (!root || root.closest("[hidden]") || !S.pts.length || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target.tagName || ""))) return;
    if (e.key === " ") { e.preventDefault(); S.playing ? pause() : play(); }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      S.t = clamp(S.t + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 5000 : 1000), 0, S.tEnd);
      draw();
    } else if (e.key === "." || e.key === ",") {                        // frame by frame
      S.t = clamp(S.t + (e.key === "." ? 1 : -1) * 50, 0, S.tEnd);
      draw();
    }
  });

  window.addEventListener("resize", () => { if (root && !root.closest("[hidden]")) draw(); });

  return { render, show, pause, stats: () => ({ clipBytes: S.lastClipBytes || 0, rec: !!S.rec }), stopRecord };
})();

function renderCockpit(primary) { Cockpit.render(primary); }
