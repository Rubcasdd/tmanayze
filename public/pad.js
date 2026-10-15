"use strict";

// The arrow input display, like the game's: the left and right arrows fill with how far the wheel is turned, the up
// arrow fills with the throttle and the down arrow with the brake, and the exact percentages are written underneath.
// Used by the Replay and the Cockpit. draw() paints it with its top-left corner at (x, y); `s` scales it.

const InputPad = (() => {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function draw(c, x, y, v, color, s = 1) {
    const L = clamp(-v.steer, 0, 1), Rt = clamp(v.steer, 0, 1), up = clamp(v.gas, 0, 1), dn = clamp(v.brake, 0, 1);
    const tw = 38 * s, th = 46 * s, bw = 22 * s, bh = 22 * s, gap = 5 * s;
    const base = "rgba(78,80,88,0.78)", line = "rgba(255,255,255,0.95)", cy = y + th / 2;
    c.save();
    c.lineJoin = "round"; c.lineCap = "round"; c.lineWidth = Math.max(1.5, 2 * s);
    // left arrow: tip on the left, base on the right; it fills from the base outwards
    const lx1 = x + tw;
    c.beginPath(); c.moveTo(x, cy); c.lineTo(lx1, y); c.lineTo(lx1, y + th); c.closePath();
    c.fillStyle = base; c.fill();
    if (L > 0.001) { c.save(); c.clip(); c.fillStyle = color; c.fillRect(lx1 - tw * L, y, tw * L + 1, th); c.restore(); }
    c.strokeStyle = line; c.stroke();
    // right arrow: base on the left, tip on the right
    const rx0 = x + tw + bw + 2 * gap;
    c.beginPath(); c.moveTo(rx0 + tw, cy); c.lineTo(rx0, y); c.lineTo(rx0, y + th); c.closePath();
    c.fillStyle = base; c.fill();
    if (Rt > 0.001) { c.save(); c.clip(); c.fillStyle = color; c.fillRect(rx0 - 1, y, tw * Rt + 1, th); c.restore(); }
    c.strokeStyle = line; c.stroke();
    // up (throttle) and down (brake)
    const bx = x + tw + gap;
    const box = (by, k, col, isUp) => {
      c.beginPath(); c.roundRect(bx, by, bw, bh, 4 * s); c.fillStyle = base; c.fill();
      if (k > 0.001) { c.save(); c.clip(); c.fillStyle = col; const fh = bh * k; c.fillRect(bx, isUp ? by + bh - fh : by, bw, fh); c.restore(); }
      c.strokeStyle = line; c.beginPath(); c.roundRect(bx, by, bw, bh, 4 * s); c.stroke();
      c.strokeStyle = "rgba(255,255,255,0.9)"; c.beginPath();
      const mx = bx + bw / 2, my = by + bh / 2, a = 5 * s;
      if (isUp) { c.moveTo(mx - a, my + 2 * s); c.lineTo(mx, my - 3 * s); c.lineTo(mx + a, my + 2 * s); } else { c.moveTo(mx - a, my - 2 * s); c.lineTo(mx, my + 3 * s); c.lineTo(mx + a, my - 2 * s); }
      c.stroke();
    };
    box(y, up, "#2fe3a2", true); box(y + th - bh, dn, "#ff5a73", false);
    c.restore();
    // the exact numbers
    const pct = (k) => `${Math.round(k * 100)}%`;
    c.save(); c.textAlign = "left"; c.textBaseline = "alphabetic";
    c.font = `700 ${Math.round(15 * s)}px "IBM Plex Mono", monospace`; c.fillStyle = "#eef2fb";
    c.fillText(`STEER ${v.steer < -0.005 ? "L " + pct(L) : v.steer > 0.005 ? "R " + pct(Rt) : "0%"}`, x, y + th + 22 * s);
    c.font = `600 ${Math.round(11 * s)}px "IBM Plex Mono", monospace`;
    c.fillStyle = "#2fe3a2"; c.fillText(`GAS ${pct(up)}`, x, y + th + 38 * s);
    c.fillStyle = "#ff5a73"; c.fillText(`BRAKE ${pct(dn)}`, x + 66 * s, y + th + 38 * s);
    c.restore();
    return { w: Math.max(tw * 2 + bw + 2 * gap, 134 * s), h: th + 42 * s };
  }

  return { draw };
})();
