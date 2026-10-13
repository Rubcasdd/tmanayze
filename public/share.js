"use strict";

// Share cards: a 1200x630 picture of a lap or a corner (the size Discord, X and most chat apps preview well),
// drawn on a canvas from the comparison data. The preview window offers Save, Copy and, where the browser
// supports it, the system share sheet.

const Share = (() => {
  const W = 1200, H = 630;
  const BG0 = "#131b2e", BG1 = "#080b13", INK = "#eef2fb", MUTED = "#7d8aa6", ACCENT = "#8f7bff", LOSS = "#ff5a73", GAIN = "#2fe3a2";
  const FONT = `"Barlow", system-ui, -apple-system, "Segoe UI", sans-serif`;

  const secs = (ms) => `${ms > 0 ? "+" : ms < 0 ? "−" : ""}${(Math.abs(ms) / 1000).toFixed(3)}s`;
  const mix = (a, b, t) => {
    const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16)), pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
    return `rgb(${pa.map((v, k) => Math.round(v + (pb[k] - v) * t)).join(",")})`;
  };

  function base(ctx) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, BG0);
    g.addColorStop(1, BG1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ACCENT;
    ctx.fillRect(0, 0, 10, H);
    ctx.fillStyle = MUTED;
    ctx.font = `600 18px ${FONT}`;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillText("TRACKMANIA AI ANALYZER", 50, 52);
  }

  function fit(ctx, text, maxW, size, weight = 700) {
    let s = size;
    ctx.font = `${weight} ${s}px ${FONT}`;
    while (ctx.measureText(text).width > maxW && s > 20) { s -= 2; ctx.font = `${weight} ${s}px ${FONT}`; }
    return s;
  }

  function wrap(ctx, text, x, y, maxW, lineH, maxLines = 4) {
    const words = text.split(" ");
    let line = "";
    let lines = 0;
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, y);
        y += lineH;
        line = w;
        if (++lines >= maxLines) return y;
      } else line = test;
    }
    if (line) ctx.fillText(line, x, y);
    return y + lineH;
  }

  // the track outline, coloured by where time was gained or lost
  function drawMap(ctx, pts, box) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    const dx = Math.max(10, maxX - minX), dz = Math.max(10, maxZ - minZ);
    const k = Math.min((box.w - 40) / dx, (box.h - 40) / dz);
    const ox = box.x + (box.w - dx * k) / 2, oz = box.y + (box.h - dz * k) / 2;
    const P = (p) => [ox + (p.x - minX) * k, oz + (p.z - minZ) * k];
    const n = pts.length;
    const slope = pts.map((_, i) => {
      const a = Math.max(0, i - 4), b = Math.min(n - 1, i + 4), dd = pts[b].distance_m - pts[a].distance_m;
      return dd > 0 ? ((pts[b].delta_ms - pts[a].delta_ms) / dd) * 100 : 0;
    });
    const sorted = slope.map(Math.abs).sort((a, b) => a - b);
    const scale = Math.max(5, sorted[Math.floor(n * 0.95)] || 5);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 12;
    ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = P(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.lineWidth = 7;
    for (let i = 1; i < n; i++) {
      const t = Math.max(-1, Math.min(1, slope[i] / scale));
      ctx.strokeStyle = t >= 0 ? mix("59668a", "ff5a73", t) : mix("59668a", "2fe3a2", -t);
      const [x0, y0] = P(pts[i - 1]), [x1, y1] = P(pts[i]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    const [sx, sy] = P(pts[0]), [fx, fy] = P(pts[n - 1]);
    ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(sx, sy, 8, 0, 6.3); ctx.fill();
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 4; ctx.strokeRect(fx - 8, fy - 8, 16, 16);
    // legend
    const ly = box.y + box.h - 6;
    ctx.font = `500 15px ${FONT}`;
    ctx.fillStyle = GAIN; ctx.textAlign = "left"; ctx.fillText("● gaining time", box.x + 6, ly);
    ctx.fillStyle = LOSS; ctx.textAlign = "right"; ctx.fillText("losing time ●", box.x + box.w - 6, ly);
  }

  function lapCard(o) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    base(ctx);
    const d = o.data, s = d.stats;
    ctx.fillStyle = INK;
    fit(ctx, o.mapName, 560, 56);
    ctx.fillText(o.mapName, 50, 128);
    ctx.fillStyle = MUTED;
    ctx.font = `500 26px ${FONT}`;
    fit(ctx, `${o.subject} vs ${o.reference}`, 560, 26, 500);
    ctx.fillText(`${o.subject} vs ${o.reference}`, 50, 168);
    const gap = s.final_delta_ms;
    ctx.fillStyle = gap > 0 ? LOSS : GAIN;
    ctx.font = `800 118px ${FONT}`;
    ctx.fillText(secs(gap), 46, 300);
    ctx.fillStyle = MUTED;
    ctx.font = `500 24px ${FONT}`;
    ctx.fillText(gap > 0 ? "behind the ghost" : "ahead of the ghost", 52, 340);
    const rows = [];
    if (s.telemetry) {
      rows.push(["In corners", secs(s.corner_time_change_ms), s.corner_time_change_ms]);
      rows.push(["Between corners", secs(s.straight_time_change_ms), s.straight_time_change_ms]);
      rows.push(["Top speed", `${Math.round(s.subject_top_speed)} vs ${Math.round(s.reference_top_speed)} km/h`, null]);
      rows.push(["Average speed", `${Math.round(s.subject_avg_speed)} vs ${Math.round(s.reference_avg_speed)} km/h`, null]);
    }
    rows.forEach(([k, v, ms], i) => {
      const y = 410 + i * 46;
      ctx.fillStyle = MUTED; ctx.font = `500 24px ${FONT}`; ctx.textAlign = "left"; ctx.fillText(k, 52, y);
      ctx.fillStyle = ms === null ? INK : ms > 0 ? LOSS : GAIN; ctx.font = `700 28px ${FONT}`; ctx.textAlign = "right"; ctx.fillText(v, 560, y);
    });
    ctx.textAlign = "left";
    if (d.points && d.points.length > 3) drawMap(ctx, d.points, { x: 620, y: 60, w: 540, h: 510 });
    return cv;
  }

  async function svgImage(svg) {
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  }

  async function cornerCard(o) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    base(ctx);
    const c = o.corner, d = o.data;
    const svg = Figures.cornerFigure(c, d, o.surf, 640);
    if (svg) {
      const img = await svgImage(svg);
      const iw = 660, ih = (img.height / img.width) * iw;
      ctx.drawImage(img, 40, Math.max(70, (H - ih) / 2 + 20), iw, ih);
    }
    const x = 740, right = W - 50;
    ctx.fillStyle = INK;
    ctx.font = `700 40px ${FONT}`;
    fit(ctx, o.mapName, right - x, 40);
    ctx.fillText(o.mapName, x, 130);
    ctx.fillStyle = MUTED;
    ctx.font = `500 22px ${FONT}`;
    ctx.fillText(`${o.subject} vs ${o.reference}`, x, 164);
    ctx.fillStyle = INK;
    ctx.font = `700 30px ${FONT}`;
    ctx.fillText(`Corner ${c.corner_index} · ${Figures.name(c)} ${c.turn_deg}°`, x, 232);
    ctx.fillStyle = c.time_change_ms > 0 ? LOSS : GAIN;
    ctx.font = `800 96px ${FONT}`;
    ctx.fillText(secs(c.time_change_ms), x - 4, 330);
    ctx.fillStyle = MUTED;
    ctx.font = `500 22px ${FONT}`;
    ctx.fillText(c.time_change_ms > 0 ? "lost in this corner" : "gained in this corner", x, 362);
    ctx.fillStyle = INK;
    ctx.font = `500 24px ${FONT}`;
    ctx.fillText(`Slowest point: ${Math.round(c.subject_min_speed)} vs ${Math.round(c.reference_min_speed)} km/h`, x, 412);
    const tips = (Figures.tips(c) || []).slice(1, 3);
    ctx.fillStyle = MUTED;
    ctx.font = `500 22px ${FONT}`;
    let y = 462;
    for (const t of tips) y = wrap(ctx, `• ${t}`, x, y, right - x, 30, 2);
    return cv;
  }

  // the preview window with Save / Copy / Share
  function showModal(canvas, filename) {
    const el = document.createElement("div");
    el.className = "fig-modal";
    el.innerHTML = `<div class="fig-modal-box share-box"><div class="share-preview"></div>
      <div class="share-actions"><button type="button" class="btn share-save">Save image</button>
      <button type="button" class="btn share-copy">Copy image</button>
      <button type="button" class="btn share-native" hidden>Share…</button>
      <span class="hint share-note"></span>
      <button type="button" class="btn tiny share-close">Close</button></div></div>`;
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    canvas.style.borderRadius = "8px";
    el.querySelector(".share-preview").appendChild(canvas);
    const note = el.querySelector(".share-note");
    const close = () => { el.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
    el.querySelector(".share-close").addEventListener("click", close);
    const blob = () => new Promise((res) => canvas.toBlob(res, "image/png"));
    el.querySelector(".share-save").addEventListener("click", async () => {
      const a = document.createElement("a");
      a.download = filename;
      a.href = URL.createObjectURL(await blob());
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    el.querySelector(".share-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": await blob() })]);
        note.textContent = "Copied. Paste it into Discord or a message.";
      } catch {
        note.textContent = "Your browser blocked copying: use Save image instead.";
      }
    });
    const native = el.querySelector(".share-native");
    if (navigator.share && navigator.canShare) {
      blob().then((b) => {
        const file = new File([b], filename, { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          native.hidden = false;
          native.addEventListener("click", () => navigator.share({ files: [file], title: filename }).catch(() => {}));
        }
      });
    }
    document.body.appendChild(el);
  }

  // kind: "lap" or "corner" (with corner = the corner object)
  async function open(kind, o) {
    const cv = kind === "corner" ? await cornerCard(o) : lapCard(o);
    const safe = (o.mapName || "trackmania").replace(/[^\w-]+/g, "-").toLowerCase();
    showModal(cv, kind === "corner" ? `${safe}-corner-${o.corner.corner_index}.png` : `${safe}-lap.png`);
  }

  return { open, lapCard, cornerCard };
})();
