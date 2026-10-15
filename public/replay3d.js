"use strict";

// The Replay tab: a real 3D replay of both runs on the same race clock, like the game's own replay. Your car and the
// ghost (see-through, as in the game) drive the line they actually drove, with the car turned the way it was
// recorded (banks, jumps, slides), under a dusk sky over a terrain with trees and the pillars the track stands on.
// Tyre spray on slides, sparks under braking, dust on landings, speed streaks, jump arcs with an AIR badge and a
// landing verdict, headlights and underglow, shadows, a mini-map, the game-style timer and checkpoint flash, and the
// wheel and pedals of both drivers. Slow it to a twentieth, step one frame, grab the camera, cut between shots with
// an editable shot list, replay any jump in slow motion, and record the result as a video.
//
// Needs three.js (loaded from the CDN in index.html) and app.js helpers ($, esc, fmtGap, Store, state).

const Replay3D = (() => {
  const WHEEL_RAD = 1.9;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const GROUND = { tech: 0x3a4258, bump: 0x424a60, plastic: 0x5163a8, dirt: 0x7a5a3a, grass: 0x3f7a3f, ice: 0xa6dcf4, water: 0x2a6aa8, unknown: 0x3d4559 };
  const SPRAY = { ice: [0.55, 0.72, 0.95], dirt: [0.5, 0.36, 0.22], grass: [0.34, 0.55, 0.28], water: [0.7, 0.85, 1], tech: [0.72, 0.72, 0.78], bump: [0.72, 0.72, 0.78], plastic: [0.8, 0.8, 0.9], unknown: [0.72, 0.72, 0.78] };
  const MODES = [
    ["chase", "Chase you", "Behind your car, like the game"],
    ["duel", "Both cars", "Frames you and the ghost together"],
    ["ghost", "Chase ghost", "Behind the ghost"],
    ["hood", "Hood", "From the front of your car"],
    ["orbit", "Orbit", "Circle your car: drag to look around"],
    ["side", "Trackside", "A camera that waits ahead and watches the cars go past"],
    ["top", "Top down", "From above, heading up"],
    ["free", "Free camera", "Fly it yourself: W A S D, Q and E for down and up, drag to look, + and - for speed, shift to boost"],
  ];
  const DEFAULT_CAM = { mode: "chase", dist: 6.8, height: 2.3, fov: 72, look: 14, smooth: 7, speedFov: true, bank: 0.6, yaw: 0, pitch: 0, orbR: 11, fixed: null, pinned: false };
  const SUN_DIR = [0.5, 0.62, -0.6];

  const R = {
    primary: null, key: null, loaded: false, loading: false, visible: false, THREE: null,
    t: 0, tEnd: 0, rate: 1, playing: false, last: 0, raf: 0, prevT: 0, clip: null,
    cam: { ...DEFAULT_CAM }, shots: [], shotIdx: -1, cuts: true,
    hudSize: 1, show: { blocks: true, captions: true, timer: true, inputs: true, mini: true, tower: true, ghost: true, trails: true, gates: true, fx: true, arcs: true, shake: true, bars: false, shadows: true, pad: true },
    rec: null, root: null, shake: 0, others: [], keys: {}, free: null, captions: [], spoken: new Set(), speak: false, ghostName: "ghost", flights: { you: [], ghost: [] }, landings: [],
  };

  // ------------------------------------------------------------------ samples

  // sample arrays; the replay's coordinates are right-handed like three.js, so they go in as they are
  function prep(samples) {
    const n = samples.length;
    const A = { n, t: new Float32Array(n), p: new Float32Array(n * 3), f: new Float32Array(n * 3), u: new Float32Array(n * 3), sp: new Float32Array(n), st: new Float32Array(n), ga: new Float32Array(n), br: new Float32Array(n), cd: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      A.t[i] = s.time_ms;
      A.p.set([s.x, s.y, s.z], i * 3);
      if (s.fx != null && s.ux != null) { A.f.set([s.fx, s.fy, s.fz], i * 3); A.u.set([s.ux, s.uy, s.uz], i * 3); }
      else {                                             // no orientation recorded: point along the motion, level
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        const dx = samples[b].x - samples[a].x, dz = samples[b].z - samples[a].z, dy = samples[b].y - samples[a].y, l = Math.hypot(dx, dy, dz) || 1;
        A.f.set([dx / l, dy / l, dz / l], i * 3); A.u.set([0, 1, 0], i * 3);
      }
      A.sp[i] = s.speed; A.st[i] = s.steer; A.ga[i] = s.gas; A.br[i] = s.brake;
      A.cd[i] = i ? A.cd[i - 1] + Math.hypot(s.x - samples[i - 1].x, s.y - samples[i - 1].y, s.z - samples[i - 1].z) : 0;
    }
    return A;
  }

  function mk(T) { return { p: new T.Vector3(), f: new T.Vector3(), u: new T.Vector3(), l: new T.Vector3(), speed: 0, steer: 0, gas: 0, brake: 0, cd: 0 }; }

  // the car's state at a race time (ms), interpolated between the 50 ms samples
  function at(A, t, out, T) {
    let lo = 0, hi = A.n - 1;
    if (t <= A.t[0]) hi = lo = 0;
    else if (t >= A.t[hi]) lo = hi;
    else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A.t[m] <= t) lo = m; else hi = m; }
    const span = A.t[hi] - A.t[lo], k = span > 0 ? (t - A.t[lo]) / span : 0;
    const L = (arr, j) => arr[lo * 3 + j] + (arr[hi * 3 + j] - arr[lo * 3 + j]) * k;
    out.p.set(L(A.p, 0), L(A.p, 1), L(A.p, 2));
    out.f.set(L(A.f, 0), L(A.f, 1), L(A.f, 2)).normalize();
    out.u.set(L(A.u, 0), L(A.u, 1), L(A.u, 2));
    out.u.addScaledVector(out.f, -out.u.dot(out.f)).normalize();        // keep it square with the heading
    out.l.crossVectors(out.u, out.f).normalize();                        // the car's left (right = forward x up)
    const S = (arr) => arr[lo] + (arr[hi] - arr[lo]) * k;
    out.speed = S(A.sp); out.steer = S(A.st); out.gas = S(A.ga); out.brake = S(A.br); out.cd = S(A.cd);
    return out;
  }

  const inFlight = (list, t) => list.find((f) => t >= f.t_ms && t <= f.end_t_ms) || null;

  // ------------------------------------------------------------------ terrain noise (also used to stand the pillars on the ground)

  const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const vnoise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const terrainH = (x, z) => (vnoise(x / 260, z / 260) * 2 - 1) * 26 + (vnoise(x / 70, z / 70) * 2 - 1) * 5 + (vnoise(x / 900 + 7, z / 900) * 2 - 1) * 40;

  // ------------------------------------------------------------------ the cars

  function buildCar(T, color, ghost) {
    const g = new T.Group();
    const m = (c, extra) => new T.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.32, metalness: 0.45 }, ghost ? { transparent: true, opacity: 0.45, depthWrite: false } : {}, extra || {}));
    const box = (w, h, d, x, y, z, mat, cast) => { const b = new T.Mesh(new T.BoxGeometry(w, h, d), mat); b.position.set(x, y, z); b.castShadow = !!cast && !ghost; g.add(b); return b; };
    box(1.9, 0.42, 4.1, 0, 0.12, 0, m(color), true);
    box(1.6, 0.3, 1.3, 0, 0.34, 1.3, m(color), true);                       // bonnet
    box(1.15, 0.26, 1.5, 0, 0.0, 2.55, m(color), true);                    // nose
    box(2.1, 0.07, 0.55, 0, -0.16, 3.15, m(0x151a26), true);               // front wing
    box(1.0, 0.42, 1.5, 0, 0.55, -0.35, m(ghost ? 0x9fb4ff : 0x0e131d, { metalness: 0.8, roughness: 0.1 }), true);   // canopy
    box(0.5, 0.05, 3.2, 0, 0.36, 0.1, m(0xffffff));                        // stripe
    box(1.9, 0.07, 0.55, 0, 0.85, -2.1, m(0x151a26), true);                // rear wing
    box(0.08, 0.5, 0.08, 0.6, 0.6, -2.05, m(0x151a26)); box(0.08, 0.5, 0.08, -0.6, 0.6, -2.05, m(0x151a26));
    box(0.3, 0.12, 4.0, 1.0, -0.02, 0, m(0x151a26)); box(0.3, 0.12, 4.0, -1.0, -0.02, 0, m(0x151a26));   // side pods
    const tail = new T.MeshBasicMaterial({ color: 0x551018, transparent: ghost, opacity: ghost ? 0.5 : 1 });
    box(1.3, 0.12, 0.05, 0, 0.3, -2.07, tail);
    const lamp = new T.MeshBasicMaterial({ color: 0xfff3d0, transparent: ghost, opacity: ghost ? 0.5 : 1 });
    box(0.25, 0.1, 0.06, 0.55, 0.28, 2.0, lamp); box(0.25, 0.1, 0.06, -0.55, 0.28, 2.0, lamp);
    const wheels = [], fronts = [];
    for (const [x, z, front] of [[1.0, 1.45, true], [-1.0, 1.45, true], [1.0, -1.35, false], [-1.0, -1.35, false]]) {
      const pivot = new T.Group(); pivot.position.set(x, -0.12, z);
      const spin = new T.Group();
      const cyl = new T.Mesh(new T.CylinderGeometry(0.42, 0.42, 0.38, 24), m(0x0c0f16, { roughness: 0.8, metalness: 0.05 }));
      cyl.rotation.z = Math.PI / 2; cyl.castShadow = !ghost;
      const hub = new T.Mesh(new T.CylinderGeometry(0.2, 0.2, 0.4, 12), m(0xc9d2ea));
      hub.rotation.z = Math.PI / 2;
      const rim = new T.Mesh(new T.BoxGeometry(0.42, 0.08, 0.34), m(0xc9d2ea)); rim.position.x = x > 0 ? 0.02 : -0.02;
      spin.add(cyl, hub, rim); pivot.add(spin); g.add(pivot);
      wheels.push(spin); if (front) fronts.push(pivot);
    }
    // underglow on the road and headlights
    const glow = new T.PointLight(ghost ? 0x5b8def : 0x8f7bff, ghost ? 1.1 : 2.4, 15, 1.6); glow.position.set(0, -0.2, 0); g.add(glow);
    if (!ghost) {
      const spot = new T.SpotLight(0xfff0d0, 2.6, 90, 0.5, 0.65, 1.2); spot.position.set(0, 0.3, 1.8);
      const tgt = new T.Object3D(); tgt.position.set(0, -2, 26); g.add(tgt); spot.target = tgt; g.add(spot);
    }
    // a glow for the brake lights (a sprite that only shows while braking)
    const brake = new T.Sprite(new T.SpriteMaterial({ map: glowTexture(T), color: 0xff2030, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }));
    brake.scale.set(3.2, 1.6, 1); brake.position.set(0, 0.35, -2.4); g.add(brake);
    g.matrixAutoUpdate = false;
    return { group: g, wheels, fronts, tail, brake };
  }

  const gl = {};

  function glowTexture(T) {
    if (gl.glowTex) return gl.glowTex;
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.35, "rgba(255,255,255,0.45)"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return (gl.glowTex = new T.CanvasTexture(c));
  }

  // A texture per kind of ground, one block (32 m) long, with the block seam at its ends, so the road reads like the game's.
  // `plain` leaves out the edge lines: that one is for the platform blocks under the road.
  const TEX = {};
  const SURF = {
    tech: { base: "#3a3e49", edge: "#d5d8e2", rough: 0.55, metal: 0.1 },
    bump: { base: "#363a47", edge: "#d5d8e2", rough: 0.7, metal: 0.05 },
    plastic: { base: "#6f84dc", edge: "#ffffff", rough: 0.35, metal: 0.05 },
    dirt: { base: "#6b4d31", edge: "#a07c52", rough: 0.95, metal: 0 },
    grass: { base: "#3f8a3b", edge: "#8fd37c", rough: 1, metal: 0 },
    ice: { base: "#c6eaf8", edge: "#ffffff", rough: 0.1, metal: 0.02 },
    water: { base: "#2a6aa8", edge: "#9fd0ff", rough: 0.2, metal: 0 },
    unknown: { base: "#3a3e49", edge: "#d5d8e2", rough: 0.6, metal: 0.05 },
  };
  function surfaceTexture(T, kind, plain) {
    const key = kind + (plain ? "-p" : "");
    if (TEX[key]) return TEX[key];
    const S = 256, def = SURF[kind] || SURF.unknown, c = document.createElement("canvas");
    c.width = c.height = S;
    const x = c.getContext("2d");
    x.fillStyle = def.base; x.fillRect(0, 0, S, S);
    for (let i = 0; i < 3600; i++) { x.fillStyle = Math.random() > 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.09)"; x.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 3, 1 + Math.random() * 3); }
    if (kind === "plastic") { x.fillStyle = "rgba(255,255,255,0.13)"; for (let i = 64; i < S; i += 64) { x.fillRect(i, 0, 2, S); x.fillRect(0, i, S, 2); } }
    if (kind === "ice") { x.strokeStyle = "rgba(255,255,255,0.4)"; x.lineWidth = 2; for (let i = 0; i < 26; i++) { const px = Math.random() * S, py = Math.random() * S; x.beginPath(); x.moveTo(px, py); x.lineTo(px + (Math.random() - 0.5) * 30, py + 20 + Math.random() * 60); x.stroke(); } }
    if (!plain) {
      x.fillStyle = def.edge; x.fillRect(10, 0, 10, S); x.fillRect(S - 20, 0, 10, S);                       // the road's edge lines
      x.fillStyle = "rgba(0,0,0,0.28)"; x.fillRect(20, 0, 2, S); x.fillRect(S - 22, 0, 2, S);
      if (kind === "tech" || kind === "unknown") { x.fillStyle = "rgba(255,255,255,0.35)"; for (let y = 8; y < S; y += 64) x.fillRect(S / 2 - 2, y, 4, 30); }
      if (kind === "bump") { x.fillStyle = "rgba(255,255,255,0.11)"; for (let y = 0; y < S; y += 24) x.fillRect(22, y, S - 44, 9); }
      if (kind === "dirt") { x.fillStyle = "rgba(0,0,0,0.2)"; x.fillRect(S * 0.3 - 9, 0, 18, S); x.fillRect(S * 0.7 - 9, 0, 18, S); }
    }
    x.fillStyle = "rgba(0,0,0,0.5)"; x.fillRect(0, 0, S, 3); x.fillRect(0, S - 3, S, 3);                    // the seam between two blocks
    if (plain) { x.fillRect(0, 0, 3, S); x.fillRect(S - 3, 0, 3, S); }
    const tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping; tex.anisotropy = 8; tex.encoding = T.sRGBEncoding;
    return (TEX[key] = tex);
  }
  function surfaceMaterial(T, kind, plain) {
    const def = SURF[kind] || SURF.unknown;
    return new T.MeshStandardMaterial({ map: surfaceTexture(T, kind, plain), roughness: def.rough, metalness: def.metal, side: T.DoubleSide, transparent: kind === "ice", opacity: kind === "ice" ? 0.93 : 1 });
  }

  // ------------------------------------------------------------------ effects: particles, streaks, arcs

  function makeParticles(T, N) {
    const geo = new T.BufferGeometry();
    const P = { N, i: 0, pos: new Float32Array(N * 3), vel: new Float32Array(N * 3), col: new Float32Array(N * 3), size: new Float32Array(N), alpha: new Float32Array(N), a0: new Float32Array(N), s0: new Float32Array(N), age: new Float32Array(N), ttl: new Float32Array(N).fill(0) };
    geo.setAttribute("position", new T.BufferAttribute(P.pos, 3)); geo.setAttribute("color", new T.BufferAttribute(P.col, 3));
    geo.setAttribute("size", new T.BufferAttribute(P.size, 1)); geo.setAttribute("alpha", new T.BufferAttribute(P.alpha, 1));
    const mat = new T.ShaderMaterial({
      transparent: true, depthWrite: false, vertexColors: true,
      uniforms: { scale: { value: 600 } },
      vertexShader: `attribute float size; attribute float alpha; varying vec3 vC; varying float vA; uniform float scale;
        void main(){ vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if(r > 0.5) discard; gl_FragColor = vec4(vC, vA * smoothstep(0.5, 0.0, r)); }`,
    });
    const pts = new T.Points(geo, mat); pts.frustumCulled = false;
    P.mesh = pts; P.geo = geo; P.mat = mat;
    return P;
  }

  function emit(P, x, y, z, vx, vy, vz, c, size, ttl, a) {
    const i = P.i; P.i = (P.i + 1) % P.N;
    P.pos.set([x, y, z], i * 3); P.vel.set([vx, vy, vz], i * 3); P.col.set(c, i * 3);
    P.s0[i] = size; P.size[i] = size; P.a0[i] = a; P.alpha[i] = a; P.age[i] = 0; P.ttl[i] = ttl;
  }

  function stepParticles(P, dt) {
    const drag = Math.exp(-dt * 1.4);
    for (let i = 0; i < P.N; i++) {
      if (P.ttl[i] <= 0) { P.alpha[i] = 0; continue; }
      P.age[i] += dt;
      if (P.age[i] >= P.ttl[i]) { P.ttl[i] = 0; P.alpha[i] = 0; continue; }
      const k = P.age[i] / P.ttl[i];
      P.vel[i * 3] *= drag; P.vel[i * 3 + 1] = P.vel[i * 3 + 1] * drag + 0.9 * dt; P.vel[i * 3 + 2] *= drag;
      P.pos[i * 3] += P.vel[i * 3] * dt; P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt; P.pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
      P.alpha[i] = P.a0[i] * (1 - k) * (1 - k); P.size[i] = P.s0[i] * (1 + k * 2.2);
    }
    P.geo.attributes.position.needsUpdate = true; P.geo.attributes.alpha.needsUpdate = true; P.geo.attributes.size.needsUpdate = true; P.geo.attributes.color.needsUpdate = true;
  }

  function clearParticles(P) { if (!P) return; P.ttl.fill(0); P.alpha.fill(0); P.geo.attributes.alpha.needsUpdate = true; }

  const groundAt = (t) => {
    if (!R.lab) return "unknown";
    const a = R.ptT; let lo = 0, hi = a.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] <= t) lo = m; else hi = m; }
    return R.lab[lo] || "unknown";
  };

  // one frame of sparks, spray and dust. dtr is race seconds, so it all slows down in slow motion
  function fx(dtr) {
    const T = R.THREE, P = gl.parts;
    if (!R.show.fx || dtr <= 0 || !P) return;
    V.v = V.v || new T.Vector3(); V.w = V.w || new T.Vector3(); V.pv = V.pv || mk(T);
    for (const who of ["you", "ghost"]) {
      if (who === "ghost" && !R.show.ghost) continue;
      const car = who === "you" ? gl.cy : gl.cg, A = R[who], air = inFlight(R.flights[who], R.t), gain = who === "you" ? 1 : 0.55;
      at(A, R.t - 70, V.pv, T);
      V.v.copy(car.p).sub(V.pv.p);
      const move = V.v.length();
      if (move < 0.05 || car.speed < 40) continue;
      V.v.divideScalar(move);
      const slip = Math.acos(clamp(V.v.dot(car.f), -1, 1)) * 57.2958;
      const gr = SPRAY[groundAt(R.t)] || SPRAY.unknown;
      if (!air && slip > 7) {                                  // sliding: spray off the rear tyres
        R[who + "Acc"] = (R[who + "Acc"] || 0) + clamp(slip - 5, 0, 40) * 7 * dtr * gain;
        while (R[who + "Acc"] >= 1) {
          R[who + "Acc"] -= 1;
          const side = Math.random() < 0.5 ? 1 : -1;
          emit(P, car.p.x - car.f.x * 1.3 + car.l.x * 0.95 * side - car.u.x * 0.35, car.p.y - car.f.y * 1.3 + car.l.y * 0.95 * side - car.u.y * 0.35, car.p.z - car.f.z * 1.3 + car.l.z * 0.95 * side - car.u.z * 0.35,
            -V.v.x * car.speed * 0.05 + car.l.x * side * (1 + Math.random() * 3) + car.u.x * (1.5 + Math.random() * 3),
            -V.v.y * car.speed * 0.05 + car.l.y * side * (1 + Math.random() * 3) + car.u.y * (1.5 + Math.random() * 3),
            -V.v.z * car.speed * 0.05 + car.l.z * side * (1 + Math.random() * 3) + car.u.z * (1.5 + Math.random() * 3),
            gr, 2.2 + Math.random() * 2.4, 0.7 + Math.random() * 0.7, 0.55 * gain);
        }
      }
      if (!air && car.brake > 0.5 && car.speed > 110) {        // hard braking: sparks and smoke off the front tyres
        R[who + "Bacc"] = (R[who + "Bacc"] || 0) + 55 * dtr * gain;
        while (R[who + "Bacc"] >= 1) {
          R[who + "Bacc"] -= 1;
          const side = Math.random() < 0.5 ? 1 : -1;
          emit(P, car.p.x + car.f.x * 1.45 + car.l.x * 1.0 * side - car.u.x * 0.35, car.p.y + car.f.y * 1.45 + car.l.y * 1.0 * side - car.u.y * 0.35, car.p.z + car.f.z * 1.45 + car.l.z * 1.0 * side - car.u.z * 0.35,
            car.u.x * 1.5, car.u.y * 1.5, car.u.z * 1.5, [0.9, 0.9, 0.95], 1.6 + Math.random(), 0.5 + Math.random() * 0.4, 0.35 * gain);
        }
      }
    }
  }

  function landingBurst(car, speedLost, who) {
    const P = gl.parts;
    if (!R.show.fx || !P) return;
    const gr = SPRAY[groundAt(R.t)] || SPRAY.unknown, n = Math.round(clamp(30 + speedLost * 2.2, 30, 140) * (who === "you" ? 1 : 0.6));
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.283, sp = 3 + Math.random() * 10;
      emit(P, car.p.x - car.u.x * 0.5, car.p.y - car.u.y * 0.5, car.p.z - car.u.z * 0.5,
        car.l.x * Math.cos(a) * sp + car.f.x * Math.sin(a) * sp * 0.6 + car.u.x * (2 + Math.random() * 6),
        car.l.y * Math.cos(a) * sp + car.f.y * Math.sin(a) * sp * 0.6 + car.u.y * (2 + Math.random() * 6),
        car.l.z * Math.cos(a) * sp + car.f.z * Math.sin(a) * sp * 0.6 + car.u.z * (2 + Math.random() * 6),
        gr, 2.5 + Math.random() * 3.5, 0.8 + Math.random() * 0.9, 0.6);
    }
    if (who === "you") R.shake = Math.max(R.shake, clamp(0.25 + speedLost / 60, 0.25, 1));
  }

  // speed streaks: bright lines that rush past when you are fast
  function makeStreaks(T, n) {
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(new Float32Array(n * 6), 3)); geo.setAttribute("color", new T.BufferAttribute(new Float32Array(n * 6), 3));
    const seed = []; for (let i = 0; i < n; i++) seed.push([Math.random() * 90, (Math.random() * 2 - 1) * 15, -2 + Math.random() * 10, 0.5 + Math.random()]);
    const mesh = new T.LineSegments(geo, new T.LineBasicMaterial({ vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false }));
    mesh.frustumCulled = false;
    return { mesh, seed, n };
  }

  function updateStreaks() {
    const s = gl.streaks, car = gl.cy, pos = s.mesh.geometry.attributes.position, col = s.mesh.geometry.attributes.color;
    const k = R.show.fx ? clamp((car.speed - 190) / 260, 0, 1) : 0;
    s.mesh.visible = k > 0.01;
    if (!s.mesh.visible) return;
    const L = 90, len = 1.5 + car.speed / 28;
    for (let i = 0; i < s.n; i++) {
      const [s0, ox, oy, br] = s.seed[i];
      const along = L / 2 - ((s0 + car.cd) % L) + 10;
      const bx = car.p.x + car.f.x * along + car.l.x * ox + car.u.x * oy, by = car.p.y + car.f.y * along + car.l.y * ox + car.u.y * oy, bz = car.p.z + car.f.z * along + car.l.z * ox + car.u.z * oy;
      pos.setXYZ(i * 2, bx, by, bz); pos.setXYZ(i * 2 + 1, bx + car.f.x * len, by + car.f.y * len, bz + car.f.z * len);
      const v = k * br * 0.55;
      col.setXYZ(i * 2, 0, 0, 0); col.setXYZ(i * 2 + 1, v * 0.8, v * 0.9, v);
    }
    pos.needsUpdate = true; col.needsUpdate = true;
  }

  // ------------------------------------------------------------------ the world

  function makeTrail(T, color, n) {
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    geo.setAttribute("color", new T.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    const mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false, blending: T.AdditiveBlending }));
    mesh.frustumCulled = false;
    return { mesh, n, color: new T.Color(color) };
  }

  function label(T, text, color) {
    const c = document.createElement("canvas"); c.width = 256; c.height = 96;
    const x = c.getContext("2d");
    x.fillStyle = "rgba(8,12,22,0.7)"; x.fillRect(8, 14, 240, 68);
    x.strokeStyle = color; x.lineWidth = 4; x.strokeRect(8, 14, 240, 68);
    x.fillStyle = "#fff"; x.font = "700 46px 'Barlow Condensed', Arial Narrow, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(text, 128, 50);
    const sp = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), transparent: true, depthWrite: false }));
    sp.scale.set(10, 3.75, 1);
    return sp;
  }

  function buildWorld(primary) {
    const T = R.THREE;
    if (gl.scene) gl.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    const scene = new T.Scene();
    const FOG = 0x6b3f7e;
    scene.fog = new T.Fog(FOG, 320, 4200);
    scene.add(new T.HemisphereLight(0x9aa4ff, 0x2a2236, 0.85));
    const sunDir = new T.Vector3(...SUN_DIR).normalize();
    const sun = new T.DirectionalLight(0xffd8bc, 1.3);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -42, right: 42, top: 42, bottom: -42, near: 1, far: 320 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.06;
    scene.add(sun, sun.target);
    gl.scene = scene; gl.sun = sun; gl.sunDir = sunDir;

    // sky
    const sky = new T.Mesh(new T.SphereGeometry(6500, 32, 20), new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new T.Color(0x070b26) }, mid: { value: new T.Color(0x2d2a74) }, hor: { value: new T.Color(FOG) }, sunDir: { value: sunDir } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 hor; uniform vec3 sunDir; varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        void main(){
          vec3 d = normalize(vDir); float h = d.y;
          vec3 c = mix(hor, mid, smoothstep(0.0, 0.22, h));
          c = mix(c, top, smoothstep(0.18, 0.75, h));
          c = mix(c, hor * 0.7, smoothstep(0.0, -0.2, h));
          float s = max(dot(d, normalize(sunDir)), 0.0);
          c += vec3(1.0, 0.72, 0.45) * (pow(s, 1200.0) * 3.0 + pow(s, 16.0) * 0.5);
          vec2 g = floor(d.xz / max(d.y, 0.06) * 70.0);
          c += vec3(step(0.9972, hash(g))) * smoothstep(0.3, 0.7, h);
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
    sky.renderOrder = -10; scene.add(sky); gl.sky = sky;

    const pts = primary.points, n = pts.length;
    const lab = state.surface && state.surface.labels && state.surface.labels.length === n ? state.surface.labels : null;
    R.lab = lab;
    const W = 16;
    let minY = Infinity, cx = 0, cz = 0;
    for (const p of pts) { minY = Math.min(minY, p.y); cx += p.x / n; cz += p.z / n; }

    // the road: a ribbon along the driven line, banked the way the car was, with markings and the ground colour
    const pos = new Float32Array(n * 6), uv = new Float32Array(n * 4);
    const P = new T.Vector3(), F = new T.Vector3(), U = new T.Vector3(), L = new T.Vector3(), C = new T.Color();
    const frame = (i) => {
      const p = pts[i], q = pts[Math.min(n - 1, i + 1)], o = pts[Math.max(0, i - 1)];
      P.set(p.x, p.y, p.z);
      if (p.fx != null) { F.set(p.fx, p.fy, p.fz); U.set(p.ux, p.uy, p.uz); }
      else { F.set(q.x - o.x, q.y - o.y, q.z - o.z); U.set(0, 1, 0); }
      F.normalize(); U.addScaledVector(F, -U.dot(F)).normalize();
      L.crossVectors(U, F).normalize();
    };
    const wall = [new Float32Array(n * 6), new Float32Array(n * 6), new Float32Array(n * 6), new Float32Array(n * 6)];
    const frames = [];
    for (let i = 0; i < n; i++) {
      frame(i);
      frames.push([P.clone(), F.clone(), U.clone(), L.clone()]);
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? 1 : -1;
        pos.set([P.x + L.x * W / 2 * side - U.x * 0.55, P.y + L.y * W / 2 * side - U.y * 0.55, P.z + L.z * W / 2 * side - U.z * 0.55], (i * 2 + s) * 3);
        uv.set([s, pts[i].distance_m / 32], (i * 2 + s) * 2);
      }
      // the barrier walls: a short vertical strip on each edge
      for (let side = 0; side < 2; side++) {
        const sg = side === 0 ? 1 : -1, ex = W / 2 + 0.05;
        const bx = P.x + L.x * ex * sg - U.x * 0.55, by = P.y + L.y * ex * sg - U.y * 0.55, bz = P.z + L.z * ex * sg - U.z * 0.55;
        wall[side].set([bx, by, bz, bx + U.x * 1.1, by + U.y * 1.1, bz + U.z * 1.1], i * 6);
      }
    }
    const strip = (position, extra) => {
      const geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.BufferAttribute(position, 3));
      if (extra) for (const [k, v, sz] of extra) geo.setAttribute(k, new T.BufferAttribute(v, sz));
      const idx = []; for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      geo.setIndex(idx); geo.computeVertexNormals();
      return geo;
    };
    // one mesh per kind of ground, each with its own surface, so tech, plastic, dirt, grass and ice look different
    const posAttr = new T.BufferAttribute(pos, 3), uvAttr = new T.BufferAttribute(uv, 2), byKind = {};
    for (let i = 0; i < n - 1; i++) { const a = i * 2, k = lab ? lab[i] || "unknown" : "unknown"; (byKind[k] = byKind[k] || []).push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    for (const [k, idx] of Object.entries(byKind)) {
      const g = new T.BufferGeometry(); g.setAttribute("position", posAttr); g.setAttribute("uv", uvAttr); g.setIndex(idx); g.computeVertexNormals();
      const road = new T.Mesh(g, surfaceMaterial(T, k, false)); road.receiveShadow = true; scene.add(road);
    }
    for (const [side, hex] of [[0, 0x8f7bff], [1, 0xffc247]]) {
      const w = new T.Mesh(strip(wall[side]), new T.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 0.9, transparent: true, opacity: 0.55, side: T.DoubleSide, roughness: 0.4 }));
      scene.add(w);
    }

    // terrain far below, with trees, and the pillars the track stands on
    const base = minY - 95, SZ = 7600, SEG = 150;
    gl.base = base;
    const tg = new T.PlaneGeometry(SZ, SZ, SEG, SEG); tg.rotateX(-Math.PI / 2);
    const tp = tg.attributes.position, tc = new Float32Array(tp.count * 3);
    for (let i = 0; i < tp.count; i++) {
      const x = tp.getX(i) + cx, z = tp.getZ(i) + cz, h = terrainH(x, z);
      tp.setXYZ(i, tp.getX(i), base + h, tp.getZ(i));
      const k = clamp((h + 70) / 140, 0, 1), forest = vnoise(x / 220, z / 220);
      C.setRGB(0.06 + k * 0.1 + forest * 0.04, 0.1 + k * 0.2 + forest * 0.08, 0.16 + k * 0.1);
      tc.set([C.r, C.g, C.b], i * 3);
    }
    tg.setAttribute("color", new T.BufferAttribute(tc, 3)); tg.computeVertexNormals();
    const terrain = new T.Mesh(tg, new T.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
    terrain.position.set(cx, 0, cz); terrain.receiveShadow = true; scene.add(terrain);
    gl.terrain = terrain;

    const trees = [], rnd = (() => { let s = 1234567; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
    for (let tries = 0; tries < 9000 && trees.length < 900; tries++) {
      const x = cx + (rnd() * 2 - 1) * 1700, z = cz + (rnd() * 2 - 1) * 1700;
      if (vnoise(x / 200, z / 200) < 0.5) continue;
      trees.push([x, base + terrainH(x, z), z, 0.7 + rnd() * 1.2, rnd()]);
    }
    const foliage = new T.InstancedMesh(new T.ConeGeometry(3.2, 10, 7), new T.MeshStandardMaterial({ roughness: 0.9 }), trees.length);
    const trunks = new T.InstancedMesh(new T.CylinderGeometry(0.35, 0.5, 3, 5), new T.MeshStandardMaterial({ color: 0x2a1c14, roughness: 1 }), trees.length);
    const M = new T.Matrix4(), Q = new T.Quaternion(), S = new T.Vector3(), Pp = new T.Vector3();
    trees.forEach((t, i) => {
      S.set(t[3], t[3], t[3]);
      M.compose(Pp.set(t[0], t[1] + 6.5 * t[3], t[2]), Q, S); foliage.setMatrixAt(i, M);
      M.compose(Pp.set(t[0], t[1] + 1.5 * t[3], t[2]), Q, S); trunks.setMatrixAt(i, M);
      foliage.setColorAt(i, C.setRGB(0.07 + t[4] * 0.1, 0.22 + t[4] * 0.2, 0.17 + t[4] * 0.1));
    });
    foliage.instanceColor && (foliage.instanceColor.needsUpdate = true);
    scene.add(foliage, trunks);

    const pillars = [];
    let lastD = -1e9;
    for (let i = 0; i < n; i++) {
      const [pp, , uu] = frames[i];
      if (pts[i].distance_m - lastD < 38 || uu.y < 0.6) continue;
      const top = pp.y - 0.75, bot = base + terrainH(pp.x, pp.z), h = top - bot;
      if (h < 4 || h > 600) continue;
      lastD = pts[i].distance_m; pillars.push([pp.x, bot, pp.z, h]);
    }
    if (pillars.length) {
      const pm = new T.InstancedMesh(new T.CylinderGeometry(1.1, 1.5, 1, 10), new T.MeshStandardMaterial({ color: 0x4a5270, roughness: 0.7, metalness: 0.3, emissive: 0x151a33 }), pillars.length);
      pillars.forEach((p, i) => { M.compose(Pp.set(p[0], p[1] + p[3] / 2, p[2]), Q, S.set(1, p[3], 1)); pm.setMatrixAt(i, M); });
      scene.add(pm);
    }

    // checkpoint gates with their number, and the finish
    gl.gates = [];
    const rows = primary.checkpoints || [];
    rows.forEach((r, k) => {
      let gx = r.x, gy = r.y, gz = r.z, idx;
      if (gx == null) { idx = n - 1; gx = pts[idx].x; gy = pts[idx].y; gz = pts[idx].z; }
      else idx = pts.reduce((b, p, i) => (Math.abs(p.distance_m - r.dist_m) < Math.abs(pts[b].distance_m - r.dist_m) ? i : b), 0);
      const [, f] = frames[idx];
      const fin = r.label === "Finish";
      const grp = new T.Group();
      const ringMat = new T.MeshBasicMaterial({ color: fin ? 0xffffff : 0xffc247, transparent: true, opacity: 0.85 });
      const ring = new T.Mesh(new T.TorusGeometry(9.5, 0.3, 10, 56), ringMat);
      grp.add(ring);
      const sp = label(T, fin ? "FINISH" : `CP ${k + 1}`, fin ? "#ffffff" : "#ffc247"); sp.position.set(0, 12.8, 0); grp.add(sp);
      grp.position.set(gx, gy + 3.5, gz); grp.lookAt(grp.position.clone().add(f));
      scene.add(grp); gl.gates.push({ grp, ringMat, ring, base: fin ? 0xffffff : 0xffc247 });
    });

    // the cars, their trails, jump arcs, sparks and streaks
    gl.you = buildCar(T, 0xf2f4ff, false); gl.ghost = buildCar(T, 0x5b8def, true);
    scene.add(gl.you.group, gl.ghost.group);
    gl.others = R.others.map((o) => { const car = buildCar(T, new T.Color(o.color), true); scene.add(car.group); return { car, cs: mk(T), spin: 0 }; });
    gl.ty = makeTrail(T, 0xeef2fb, 70); gl.tg = makeTrail(T, 0x5b8def, 70);
    scene.add(gl.ty.mesh, gl.tg.mesh);
    gl.cy = mk(T); gl.cg = mk(T);
    gl.parts = makeParticles(T, 1600); scene.add(gl.parts.mesh);
    gl.streaks = makeStreaks(T, 150); scene.add(gl.streaks.mesh);
    gl.arcs = new T.Group(); scene.add(gl.arcs);
    for (const [who, hex] of [["you", 0xffffff], ["ghost", 0x5b8def]]) {
      const A = R[who];
      for (const f of R.flights[who]) {
        const v = [];
        for (let i = 0; i < A.n; i++) if (A.t[i] >= f.t_ms - 50 && A.t[i] <= f.end_t_ms + 50) v.push(new T.Vector3(A.p[i * 3], A.p[i * 3 + 1], A.p[i * 3 + 2]));
        if (v.length > 1) gl.arcs.add(new T.Line(new T.BufferGeometry().setFromPoints(v), new T.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.8 })));
      }
    }
    R.sf = new T.Vector3(0, 0, 1); R.su = new T.Vector3(0, 1, 0); R.camPos = new T.Vector3(); R.camLook = new T.Vector3();
    R.deltas = pts.map((p) => p.delta_ms); R.ptT = pts.map((p) => p.t_ms);
    R.map = null;
  }

  // ------------------------------------------------------------------ the map's own blocks around the road

  // The map file lists each block's name, grid cell, level and facing, but not free blocks or custom items, and says nothing
  // about a ramp's or curve's shape. So: flat pieces under the line are drawn as platforms (placed from the driven line,
  // which is exact), pillars stand from their place down to the ground, and structures, decorations and stands are shown as
  // left out. Ramps and curves are left to the road itself.
  function addBlocks(data) {
    const T = R.THREE, scene = gl.scene;
    if (gl.blocks) { scene.remove(gl.blocks); gl.blocks.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
    const group = new T.Group(); group.visible = R.show.blocks; scene.add(group); gl.blocks = group;
    const pts = R.primary.points, CELL = data.cell || 32, LV = data.level || 8, off = data.y_offset;
    const grid = new Map(), key = (a, b) => a + "," + b;
    pts.forEach((p, i) => { const k = key(Math.floor(p.x / 24), Math.floor(p.z / 24)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    // the line point that runs through this block's footprint (and at about its height, when the heights are known)
    const under = (cx, cz, guessY) => {
      let best = -1, bd = Infinity;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const arr = grid.get(key(Math.floor(cx / 24) + a, Math.floor(cz / 24) + b));
        if (!arr) continue;
        for (const i of arr) {
          const p = pts[i], dx = p.x - cx, dz = p.z - cz;
          if (Math.abs(dx) > CELL / 2 || Math.abs(dz) > CELL / 2) continue;
          if (guessY != null && Math.abs(p.y - guessY) > 12) continue;
          const d = dx * dx + dz * dz;
          if (d < bd) { bd = d; best = i; }
        }
      }
      return best;
    };
    const list = data.blocks.map((b) => {
      const cx = b.x * CELL + CELL / 2, cz = b.z * CELL + CELL / 2;
      return { b, cx, cz, i: b.k === "flat" ? under(cx, cz, off != null ? b.y * LV + off + 4 : null) : -1 };
    });
    // the platforms under the line fix the height of everything else, by the number of levels between them
    const refs = list.filter((o) => o.i >= 0).map((o) => { o.top = pts[o.i].y - 0.78; return o; });
    if (!refs.length) { R.blockInfo = { total: data.total, drawn: 0, note: "none of the map's blocks line up with the road" }; return; }
    // a block takes its height from a platform under the line only if it is close to it; anything further off is left out
    const near = (o, max) => { let best = null, bd = Infinity; for (const r of refs) { const d = Math.max(Math.abs(r.b.x - o.b.x), Math.abs(r.b.z - o.b.z)); if (d < bd) { bd = d; best = r; } } return bd <= max ? best : null; };
    const M = new T.Matrix4(), Q = new T.Quaternion(), Sc = new T.Vector3(), Pp = new T.Vector3(), Y = new T.Vector3(0, 1, 0);
    const slabs = {}, pillars = [];
    for (const o of list) {
      const k = o.b.k;
      if (k === "flat") {
        // a flat piece on the same level as the road's platforms is on the same plane: draw it, so the platform reads as blocks
        const ref = o.i >= 0 ? o : near(o, 3);
        if (!ref || o.b.y !== ref.b.y) continue;
        let rot = (o.b.d || 0) * Math.PI / 2;
        if (o.i >= 0) { const p = pts[o.i], hd = p.fx != null ? Math.atan2(p.fx, p.fz) : 0; rot = Math.round(hd / (Math.PI / 2)) * (Math.PI / 2); }   // run the way the road runs through it
        (slabs[o.b.s || "tech"] = slabs[o.b.s || "tech"] || []).push([o.cx, ref.top - 1.1, o.cz, rot]);
      } else if (k === "pillar") {
        // a pillar close to the road and on a level at or below it stands from there down to the ground
        const ref = near(o, 2);
        if (!ref || o.b.y > ref.b.y) continue;
        const top = ref.top + (o.b.y - ref.b.y) * LV, bot = gl.base + terrainH(o.cx, o.cz), h = top - bot;
        if (h > 3 && h < 400) pillars.push([o.cx, bot + h / 2, o.cz, h]);
      }
    }
    let drawn = 0;
    for (const [kind, arr] of Object.entries(slabs)) {
      const mesh = new T.InstancedMesh(new T.BoxGeometry(CELL - 0.3, 2.2, CELL - 0.3), surfaceMaterial(T, kind, true), arr.length);
      arr.forEach((a, i) => { Q.setFromAxisAngle(Y, a[3]); M.compose(Pp.set(a[0], a[1], a[2]), Q, Sc.set(1, 1, 1)); mesh.setMatrixAt(i, M); });
      mesh.receiveShadow = true; mesh.castShadow = true; group.add(mesh); drawn += arr.length;
    }
    if (pillars.length) {
      const pm = new T.InstancedMesh(new T.BoxGeometry(3.4, 1, 3.4), new T.MeshStandardMaterial({ color: 0x5a6280, roughness: 0.6, metalness: 0.35 }), pillars.length);
      pillars.forEach((a, i) => { M.compose(Pp.set(a[0], a[1], a[2]), Q.identity(), Sc.set(1, a[3], 1)); pm.setMatrixAt(i, M); });
      pm.castShadow = true; group.add(pm);
    }
    R.blockInfo = { total: data.total, drawn, pillars: pillars.length, snapped: refs.length };
  }

  async function loadBlocks(mapUid, token) {
    R.blockInfo = null; updateBlockNote("Reading the map's blocks…");
    try {
      const pts = R.primary.points, step = Math.max(1, Math.floor(pts.length / 800));
      const data = await postJson("/api/blocks", { map_uid: mapUid, points: pts.filter((_, i) => i % step === 0).map((p) => [p.x, p.y, p.z]) });
      if (token !== R.blockToken) return;
      if (!data.available || !data.blocks.length) { R.blockInfo = { none: true }; updateBlockNote(); return; }
      addBlocks(data);
    } catch (e) { if (token === R.blockToken) R.blockInfo = { none: true }; }
    if (token === R.blockToken) updateBlockNote();
  }

  function updateBlockNote(text) {
    const el = R.root && R.root.querySelector(".rp-blocknote");
    if (!el) return;
    const i = R.blockInfo;
    el.textContent = text || (!i ? "" : i.none ? "The map file couldn't be read, so only the road is drawn."
      : !i.drawn && !i.pillars ? `The map has ${i.total} blocks but none line up with the road, so only the road is drawn (free blocks and custom items are not in the file).`
      : `From the map file: ${i.drawn} platform blocks and ${i.pillars || 0} pillars around the road. Only pieces that can be placed from the road itself are drawn: ramps, curves, free blocks and custom items are not in the file, so some maps show little.`);
  }

  // ------------------------------------------------------------------ cameras

  function delta(t) {
    const a = R.ptT;
    let lo = 0, hi = a.length - 1;
    if (t <= a[0]) return R.deltas[0];
    if (t >= a[hi]) return R.deltas[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] <= t) lo = m; else hi = m; }
    return R.deltas[lo] + (R.deltas[hi] - R.deltas[lo]) * ((t - a[lo]) / Math.max(1, a[hi] - a[lo]));
  }

  const V = {};
  function updateCamera(dt, snap) {
    const T = R.THREE, c = R.cam, cam = gl.camera;
    V.a = V.a || new T.Vector3(); V.b = V.b || new T.Vector3(); V.c = V.c || new T.Vector3(); V.up = V.up || new T.Vector3(0, 1, 0); V.q = V.q || new T.Quaternion();
    const you = gl.cy, ghost = gl.cg;
    const focus = c.mode === "ghost" ? ghost : you;
    const k = snap ? 1 : 1 - Math.exp(-dt * c.smooth);
    R.sf.lerp(focus.f, k).normalize();
    V.a.copy(V.up).lerp(focus.u, c.bank);                     // camera up leans into banks a little
    R.su.lerp(V.a, k).normalize();
    const up = R.su, dir = R.sf;
    const pos = R.camPos, look = R.camLook;
    const rotYaw = (vec, ang) => vec.applyQuaternion(V.q.setFromAxisAngle(up, ang));
    let camUp = up;
    switch (c.mode) {
      case "hood": {
        pos.copy(focus.p).addScaledVector(focus.u, 0.85).addScaledVector(focus.f, 0.55);
        look.copy(pos).addScaledVector(focus.f, 40);
        rotYaw(look.sub(pos), c.yaw); look.add(pos);
        camUp = focus.u; break;
      }
      case "duel": {
        V.b.copy(you.p).add(ghost.p).multiplyScalar(0.5);
        const sep = Math.min(70, you.p.distanceTo(ghost.p));
        V.c.copy(dir).negate(); rotYaw(V.c, c.yaw);
        pos.copy(V.b).addScaledVector(V.c, c.dist + sep * 0.75).addScaledVector(up, c.height + sep * 0.3 + c.dist * Math.sin(c.pitch));
        look.copy(V.b).addScaledVector(dir, c.look * 0.4).addScaledVector(up, 0.8); break;
      }
      case "orbit": {
        V.c.copy(dir).negate(); rotYaw(V.c, c.yaw + 0.7);
        pos.copy(focus.p).addScaledVector(V.c, c.orbR * Math.cos(c.pitch + 0.25)).addScaledVector(up, c.orbR * Math.sin(c.pitch + 0.25));
        look.copy(focus.p).addScaledVector(up, 0.4); break;
      }
      case "top": {
        V.b.copy(you.p).add(ghost.p).multiplyScalar(0.5);
        pos.copy(V.b).addScaledVector(V.up, c.orbR * 3); look.copy(V.b);
        camUp = V.a.copy(dir).setY(0).normalize(); break;
      }
      case "side": {
        // an unpinned trackside camera moves itself ahead of the cars whenever they have left it behind
        V.d = V.d || new T.Vector3();
        const far = c.fixed ? V.d.set(c.fixed[0], c.fixed[1], c.fixed[2]).sub(you.p) : null;
        const passed = far ? far.dot(you.f) < -40 || far.length() > 160 : true;
        if (!c.fixed || (!c.pinned && passed)) {
          const ahead = 22 + you.speed * 0.1;
          V.h = V.h || new T.Vector3(); V.h.set(-you.f.z, 0, you.f.x);                    // sideways on the flat, whatever the car's bank
          if (V.h.lengthSq() < 1e-4) V.h.set(1, 0, 0);
          V.h.normalize();
          c.fixed = [you.p.x + you.f.x * ahead + V.h.x * 13, you.p.y + you.f.y * ahead + 3.2, you.p.z + you.f.z * ahead + V.h.z * 13];
        }
        pos.set(c.fixed[0], c.fixed[1], c.fixed[2]);
        V.b.copy(you.p).add(ghost.p).multiplyScalar(0.5);
        look.copy(V.b).addScaledVector(V.up, 0.6); camUp = V.up; break;
      }
      case "free": {
        const fr = R.free || (R.free = { pos: cam.position.clone(), yaw: 0, pitch: 0, speed: 25 });
        pos.copy(fr.pos);
        V.c.set(Math.sin(fr.yaw) * Math.cos(fr.pitch), Math.sin(fr.pitch), Math.cos(fr.yaw) * Math.cos(fr.pitch));
        look.copy(pos).add(V.c); camUp = V.up; break;
      }
      default: {                                              // chase you / chase ghost
        V.c.copy(dir).negate(); rotYaw(V.c, c.yaw);
        pos.copy(focus.p).addScaledVector(V.c, c.dist * Math.cos(c.pitch)).addScaledVector(up, c.height + c.dist * Math.sin(c.pitch));
        look.copy(focus.p).addScaledVector(dir, c.look).addScaledVector(up, 0.9);
      }
    }
    cam.position.copy(pos);
    cam.up.copy(camUp);
    cam.lookAt(look);
    // shake: a kick on landings and a little rumble when it is very fast, only while playing so stills stay sharp
    if (R.show.shake && R.playing) {
      const amp = R.shake * 0.55 + clamp((focus.speed - 300) / 4000, 0, 0.08), t = performance.now() * 0.05;
      cam.position.x += Math.sin(t * 1.7) * amp; cam.position.y += Math.sin(t * 2.3 + 1) * amp; cam.position.z += Math.cos(t * 1.3) * amp;
    }
    R.shake *= Math.exp(-dt * 5);
    const fov = c.mode === "free" ? c.fov : c.mode === "side" ? c.fov * 0.6 : c.fov + (c.speedFov ? clamp((focus.speed - 160) / 7, 0, 22) : 0);   // trackside is a longer lens
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = snap ? fov : cam.fov + (fov - cam.fov) * Math.min(1, dt * 6); cam.updateProjectionMatrix(); }
    if (gl.parts) gl.parts.mat.uniforms.scale.value = gl.renderer.domElement.height / (2 * Math.tan(cam.fov * Math.PI / 360));
  }

  // ------------------------------------------------------------------ frame

  function setCar(car, s, spin) {
    const T = R.THREE;
    V.m = V.m || new T.Matrix4(); V.x = V.x || new T.Vector3();
    V.x.crossVectors(s.u, s.f).normalize();                   // the model's +x is the car's left
    V.m.makeBasis(V.x, s.u, s.f); V.m.setPosition(s.p);
    car.group.matrix.copy(V.m); car.group.matrixWorldNeedsUpdate = true;
    for (const f of car.fronts) f.rotation.y = -s.steer * 0.42;      // +y turns the nose toward the car's left; positive steer is right
    for (const w of car.wheels) w.rotation.x = spin;
    car.tail.color.setHex(s.brake > 0.1 ? 0xff2a3a : 0x551018);
    car.brake.material.opacity = s.brake > 0.1 ? 0.9 : 0;
  }

  function trail(tr, A, t, air) {
    const T = R.THREE, pos = tr.mesh.geometry.attributes.position, col = tr.mesh.geometry.attributes.color;
    const o = V.o || (V.o = mk(T));
    for (let i = 0; i < tr.n; i++) {
      at(A, t - (i + 4) * 45, o, T);
      const half = 0.4;
      for (let side = 0; side < 2; side++) {
        const sg = side ? -1 : 1;
        pos.setXYZ(i * 2 + side, o.p.x + o.l.x * half * sg - o.u.x * 0.55, o.p.y + o.l.y * half * sg - o.u.y * 0.55 + 0.04, o.p.z + o.l.z * half * sg - o.u.z * 0.55);
        const fade = (1 - i / tr.n) * 0.5, v = clamp(o.speed / 500, 0.1, 1);
        const cr = air(t - (i + 4) * 45) ? [1, 0.7, 0.25] : [tr.color.r, tr.color.g, tr.color.b];   // the trail turns gold while airborne
        col.setXYZ(i * 2 + side, cr[0] * fade * (0.4 + v), cr[1] * fade * (0.4 + v), cr[2] * fade * (0.4 + v));
      }
    }
    pos.needsUpdate = true; col.needsUpdate = true;
  }

  function render(dt, snap) {
    if (!R.loaded) return;
    const T = R.THREE;
    at(R.you, R.t, gl.cy, T); at(R.ghost, R.t, gl.cg, T);
    R.spinY = ((R.spinY || 0) + gl.cy.speed / 3.6 * dt / 0.42) % (Math.PI * 2);
    R.spinG = ((R.spinG || 0) + gl.cg.speed / 3.6 * dt / 0.42) % (Math.PI * 2);
    setCar(gl.you, gl.cy, R.spinY); setCar(gl.ghost, gl.cg, R.spinG);
    gl.others.forEach((o, i) => { at(R.others[i].A, R.t, o.cs, T); o.spin = ((o.spin || 0) + o.cs.speed / 3.6 * dt / 0.42) % (Math.PI * 2); setCar(o.car, o.cs, o.spin); o.car.group.visible = R.show.ghost; });
    V.sv = V.sv || mk(T); V.sd = V.sd || new T.Vector3();                 // how far sideways the car is travelling (drift angle)
    at(R.you, R.t - 70, V.sv, T); V.sd.copy(gl.cy.p).sub(V.sv.p);
    const mvl = V.sd.length();
    R.slip = mvl > 0.05 && gl.cy.speed > 40 ? Math.acos(clamp(V.sd.divideScalar(mvl).dot(gl.cy.f), -1, 1)) * 57.2958 : 0;
    gl.ghost.group.visible = R.show.ghost;
    gl.ty.mesh.visible = R.show.trails; gl.tg.mesh.visible = R.show.trails && R.show.ghost;
    gl.arcs.visible = R.show.arcs;
    gl.renderer.shadowMap.enabled = R.show.shadows;
    gl.sun.castShadow = R.show.shadows;
    // gates light up as the cars pass
    const cp = R.cps || [];
    gl.gates.forEach((g, i) => {
      g.grp.visible = R.show.gates;
      const since = cp[i] ? R.t - cp[i].t : -1, on = since >= 0 && since < 1400, f = on ? 1 - since / 1400 : 0;
      g.ringMat.color.setHex(on ? (cp[i].d > 0 ? 0xff5a73 : 0x2fe3a2) : g.base); g.ring.scale.setScalar(1 + f * 0.1); g.ringMat.opacity = 0.85 + f * 0.15;
    });
    if (R.show.trails) { const airY = (t) => !!inFlight(R.flights.you, t), airG = (t) => !!inFlight(R.flights.ghost, t); trail(gl.ty, R.you, R.t, airY); if (R.show.ghost) trail(gl.tg, R.ghost, R.t, airG); }
    // effects only run forward in time, and are wiped when you jump
    const jumped = Math.abs(R.t - R.prevT) > 400 || R.t < R.prevT;
    if (jumped) clearParticles(gl.parts);
    else if (R.t > R.prevT) {
      const dtr = (R.t - R.prevT) / 1000;
      fx(dtr);
      for (const who of ["you", "ghost"]) {
        for (const f of R.flights[who]) if (R.prevT < f.end_t_ms && R.t >= f.end_t_ms) landingBurst(who === "you" ? gl.cy : gl.cg, who === "you" ? (landingFor(f) || {}).speed_lost || f.speed_in - f.speed_out : 0, who);
      }
      stepParticles(gl.parts, dtr);
    }
    R.prevT = R.t;
    updateStreaks();
    // the sun and its shadow follow your car
    gl.sun.target.position.copy(gl.cy.p);
    gl.sun.position.copy(gl.cy.p).addScaledVector(gl.sunDir, 130);
    gl.sky.position.copy(gl.camera.position);
    updateCamera(dt, snap);
    gl.sky.position.copy(gl.camera.position);
    gl.renderer.render(gl.scene, gl.camera);
    drawHud();
    if (R.rec) compose();
    drawScrub();
    syncUi();
  }

  const landingFor = (f) => {
    let best = null, bd = 80;
    for (const l of R.landings) { const d = Math.hypot(l.x - f.end_x, l.z - f.end_z); if (d < bd) { bd = d; best = l; } }
    return best;
  };

  // ------------------------------------------------------------------ HUD (drawn on a 2D canvas over the 3D view)

  const mmss = (ms) => { ms = Math.max(0, Math.round(ms)); return `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`; };
  const sgn = (ms) => `${ms < 0 ? "-" : "+"}${mmss(Math.abs(ms))}`;

  function pill(c, x, y, w, h, bg, fg, text, font) {
    c.fillStyle = bg; c.fillRect(x, y, w, h);
    c.fillStyle = fg; c.font = font; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(text, x + w / 2, y + h / 2 + 1);
  }

  // the arrow pad, like the game's input display: left and right arrows fill with how far the wheel is turned,
  // up fills with the throttle and down with the brake, and the exact percentages are written underneath
  function drawPad(c, x, y, v, label, color) {
    const w = 206, h = 116;
    c.fillStyle = "rgba(8,12,22,0.5)"; c.fillRect(x, y, w, h);
    c.fillStyle = color; c.fillRect(x, y, 3, h);
    c.textAlign = "left"; c.textBaseline = "alphabetic";
    c.fillStyle = "#b4bfd6"; c.font = `700 11px Barlow, sans-serif`; c.fillText(label, x + 12, y + 16);
    InputPad.draw(c, x + 14, y + 24, v, color, 1);
    c.fillStyle = "#eef2fb"; c.font = `700 34px "Barlow Condensed", "Arial Narrow", sans-serif`; c.textAlign = "right";
    c.fillText(String(Math.round(v.speed)), x + w - 10, y + 64);
    c.fillStyle = "#7d8aa6"; c.font = `600 10px Barlow, sans-serif`; c.fillText("km/h", x + w - 10, y + 79);
  }

  function drawInputs(c, x, y, v, label, color) {
    if (R.show.pad) { drawPad(c, x, y - 20, v, label, color); return; }
    const w = 170, h = 96;
    c.fillStyle = "rgba(8,12,22,0.5)"; c.fillRect(x, y, w, h);
    c.fillStyle = color; c.fillRect(x, y, 3, h);
    c.textAlign = "left"; c.textBaseline = "alphabetic";
    c.fillStyle = "#b4bfd6"; c.font = `700 11px Barlow, sans-serif`; c.fillText(label, x + 12, y + 16);
    c.save(); c.translate(x + 44, y + 56); c.rotate(v.steer * WHEEL_RAD);                 // positive steer is right: clockwise
    c.strokeStyle = color; c.lineWidth = 5; c.beginPath(); c.arc(0, 0, 24, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 4; c.beginPath(); c.moveTo(-24, 0); c.lineTo(24, 0); c.moveTo(0, 0); c.lineTo(0, 24); c.stroke();
    c.fillStyle = "#ffc247"; c.fillRect(-3, -28, 6, 7); c.restore();
    const bar = (bx, val, col) => { c.fillStyle = "rgba(255,255,255,0.1)"; c.fillRect(bx, y + 24, 14, 62); c.fillStyle = col; const hh = 62 * clamp(val, 0, 1); c.fillRect(bx, y + 86 - hh, 14, hh); };
    bar(x + 84, v.brake, "#ff5a73"); bar(x + 102, v.gas, "#2fe3a2");
    c.fillStyle = "#eef2fb"; c.font = `700 30px "Barlow Condensed", "Arial Narrow", sans-serif`; c.textAlign = "right";
    c.fillText(String(Math.round(v.speed)), x + w - 8, y + 66);
    c.fillStyle = "#7d8aa6"; c.font = `600 10px Barlow, sans-serif`; c.fillText("km/h", x + w - 8, y + 80);
  }

  function tag(c, car, text, color, sub) {
    const v = V.tag || (V.tag = new R.THREE.Vector3());
    v.copy(car.p).addScaledVector(car.u, 2.4).project(gl.camera);
    if (v.z > 1 || v.z < -1) return;
    const W = c.canvas.clientWidth / R.k, H = c.canvas.clientHeight / R.k, x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
    if (x < 10 || x > W - 10 || y < 10 || y > H - 10) return;
    c.font = `700 13px Barlow, sans-serif`;
    const tw = Math.max(c.measureText(text).width, sub ? c.measureText(sub).width : 0) + 14;
    c.fillStyle = "rgba(8,12,22,0.7)"; c.fillRect(x - tw / 2, y - (sub ? 34 : 20), tw, sub ? 32 : 18);
    c.fillStyle = color; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(text, x, y - (sub ? 25 : 11));
    if (sub) { c.fillStyle = "#b4bfd6"; c.font = `600 11px Barlow, sans-serif`; c.fillText(sub, x, y - 9); }
    c.fillStyle = color; c.beginPath(); c.moveTo(x - 5, y + (sub ? -2 : 0)); c.lineTo(x + 5, y + (sub ? -2 : 0)); c.lineTo(x, y + 6); c.fill();
  }

  // the little map in the corner: the whole lap with both cars on it
  function drawMini(c, w) {
    const mw = 150, mh = 112, x0 = w - mw - 12, y0 = 46;
    if (!R.map || R.map.w !== mw) {
      const pts = R.primary.points; let a = Infinity, b = -Infinity, d = Infinity, e = -Infinity;
      for (const p of pts) { a = Math.min(a, p.x); b = Math.max(b, p.x); d = Math.min(d, p.z); e = Math.max(e, p.z); }
      const sc = Math.min((mw - 16) / Math.max(1, b - a), (mh - 16) / Math.max(1, e - d)), ox = (mw - (b - a) * sc) / 2, oz = (mh - (e - d) * sc) / 2;
      const cv = document.createElement("canvas"); cv.width = mw * 2; cv.height = mh * 2;
      const q = cv.getContext("2d"); q.scale(2, 2);
      q.fillStyle = "rgba(8,12,22,0.5)"; q.fillRect(0, 0, mw, mh);
      q.strokeStyle = "#5d6c93"; q.lineWidth = 2; q.lineJoin = "round"; q.beginPath();
      pts.forEach((p, i) => { const X = ox + (p.x - a) * sc, Y = oz + (p.z - d) * sc; if (i) q.lineTo(X, Y); else q.moveTo(X, Y); }); q.stroke();
      R.map = { w: mw, cv, a, d, sc, ox, oz };
    }
    const m = R.map;
    c.drawImage(m.cv, x0, y0, mw, mh);
    const dot = (car, col, r) => { c.fillStyle = col; c.beginPath(); c.arc(x0 + m.ox + (car.p.x - m.a) * m.sc, y0 + m.oz + (car.p.z - m.d) * m.sc, r, 0, 7); c.fill(); };
    if (R.show.ghost) { gl.others.forEach((o, i) => dot(o.cs, R.others[i].color, 3)); dot(gl.cg, "#5b8def", 3.5); }
    dot(gl.cy, "#fff", 4.5);
  }

  // the live timing tower: everyone on the track ranked by how far they have got, with the gap to the leader in seconds
  const timeAtCd = (A, cdv) => {
    const n = A.n;
    if (cdv <= 0) return A.t[0];
    if (cdv >= A.cd[n - 1]) return A.t[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A.cd[m] <= cdv) lo = m; else hi = m; }
    const span = A.cd[hi] - A.cd[lo];
    return A.t[lo] + (span > 0 ? (cdv - A.cd[lo]) / span : 0) * (A.t[hi] - A.t[lo]);
  };

  function tower() {
    const T = R.THREE, V0 = V.tw || (V.tw = mk(T));
    const ds = [{ name: "You", color: "#ffffff", A: R.you, you: true }, { name: R.ghostName, color: "#5b8def", A: R.ghost }, ...R.others];
    for (const d of ds) { d.fin = R.t >= d.A.t[d.A.n - 1]; d.cdv = at(d.A, R.t, V0, T).cd; d.finT = d.A.t[d.A.n - 1]; }
    ds.sort((a, b) => (a.fin && b.fin ? a.finT - b.finT : a.fin ? -1 : b.fin ? 1 : b.cdv - a.cdv));
    const lead = ds[0], leadT = lead.fin ? lead.finT : R.t;
    ds.forEach((d, i) => {
      if (d.fin) d.text = mmss(d.finT);
      else if (i === 0) d.text = "LEADER";
      else d.text = "+" + ((timeAtCd(d.A, lead.cdv) - leadT) / 1000).toFixed(3);
    });
    return ds;
  }

  function drawTower(c) {
    if (!R.show.tower) return;
    const rows = tower(), x = 12, y = 46, rh = 20;
    c.fillStyle = "rgba(8,12,22,0.5)"; c.fillRect(x, y, 196, 8 + rows.length * rh);
    rows.forEach((r, i) => {
      const yy = y + 4 + i * rh;
      if (r.you) { c.fillStyle = "rgba(143,123,255,0.28)"; c.fillRect(x + 2, yy, 192, rh - 1); }
      c.textBaseline = "middle"; c.textAlign = "left";
      c.fillStyle = "#b4bfd6"; c.font = `700 13px "Barlow Condensed", sans-serif`; c.fillText(String(i + 1), x + 8, yy + rh / 2);
      c.fillStyle = r.color; c.fillRect(x + 24, yy + 4, 4, rh - 9);
      c.fillStyle = r.you ? "#fff" : "#d6dcef"; c.font = `${r.you ? 700 : 600} 13px Barlow, sans-serif`;
      let nm = String(r.name); while (nm.length > 3 && c.measureText(nm).width > 92) nm = nm.slice(0, -2);
      c.fillText(nm, x + 34, yy + rh / 2);
      c.textAlign = "right"; c.fillStyle = r.fin ? "#ffc247" : "#eef2fb"; c.font = `600 12px "IBM Plex Mono", monospace`;
      c.fillText(r.text, x + 190, yy + rh / 2);
    });
  }

  // the coach's captions: what is happening right now and what to change, shown while it happens
  const CAP = { loss: "#ff5a73", gain: "#2fe3a2", note: "#ffc247" };
  function wrap(c, text, maxW) {
    const words = String(text).split(" "), lines = [];
    let cur = "";
    for (const w of words) { const t = cur ? cur + " " + w : w; if (cur && c.measureText(t).width > maxW) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur);
    return lines;
  }
  function drawCaptions(c, w, h) {
    const live = R.captions.filter((k) => R.t >= k.t0 && R.t <= k.t1).slice(0, 2);
    if (!live.length) return;
    const bw = clamp(w - 470, 300, 560), x = (w - bw) / 2;
    let y = h - 14;
    c.textBaseline = "alphabetic"; c.textAlign = "left";
    for (const k of live.reverse()) {
      const a = clamp(Math.min(R.t - k.t0, k.t1 - R.t) / 350, 0, 1);
      c.font = `600 13px Barlow, sans-serif`;
      const lines = k.lines.flatMap((l) => wrap(c, l, bw - 30)).slice(0, 5), bh = 30 + lines.length * 17;
      y -= bh;
      c.globalAlpha = a;
      c.fillStyle = "rgba(8,12,22,0.78)"; c.fillRect(x, y, bw, bh);
      c.fillStyle = CAP[k.kind] || CAP.note; c.fillRect(x, y, 4, bh);
      c.font = `700 15px "Barlow Condensed", sans-serif`; c.fillStyle = "#fff"; c.fillText(k.title, x + 14, y + 20);
      if (k.tag) { c.textAlign = "right"; c.fillStyle = CAP[k.kind] || CAP.note; c.fillText(k.tag, x + bw - 12, y + 20); c.textAlign = "left"; }
      c.font = `600 13px Barlow, sans-serif`; c.fillStyle = "#d6dcef";
      lines.forEach((l, i) => c.fillText(l, x + 14, y + 39 + i * 17));
      c.globalAlpha = 1;
      y -= 8;
    }
  }

  function drawHud() {
    const cv = gl.hud;
    if (!cv.clientWidth) return;
    // the display is laid out for a 1000-pixel-wide picture and scaled to the real one, times the HUD size setting
    const k = clamp(R.hudSize * cv.clientWidth / 1000, 0.4, 1.5);
    R.k = k;
    const w = cv.clientWidth / k, h = cv.clientHeight / k;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(cv.clientWidth * dpr) || cv.height !== Math.round(cv.clientHeight * dpr)) { cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr); }
    const c = cv.getContext("2d");
    c.setTransform(dpr * k, 0, 0, dpr * k, 0, 0); c.clearRect(0, 0, w, h);
    const d = delta(R.t);
    if (R.show.timer) {
    pill(c, w / 2 - 78, 12, 156, 32, "rgba(12,14,20,0.88)", "#fff", mmss(R.t), `700 22px "Barlow Condensed", "Arial Narrow", sans-serif`);
    pill(c, w / 2 - 78, 46, 156, 28, d > 0 ? "#d9363e" : "#2f6df0", "#fff", sgn(d), `700 19px "Barlow Condensed", "Arial Narrow", sans-serif`);
    // on pace for: the ghost's finish plus today's gap, like the Predictor plugin
    pill(c, w / 2 - 78, 76, 156, 18, "rgba(12,14,20,0.8)", "#b4bfd6", `ON PACE FOR ${mmss(R.ghost.t[R.ghost.n - 1] + d)}`, `600 12px Barlow, sans-serif`);
    if (R.cps) {
      const win = 2500 * clamp(R.rate, 0.1, 1);
      const hit = [...R.cps].reverse().find((x) => R.t >= x.t && R.t < x.t + win);
      if (hit) {
        pill(c, w / 2 - 78, 98, 156, 26, "rgba(12,14,20,0.88)", "#ffc247", `${hit.name}  ${mmss(hit.t)}`, `700 16px "Barlow Condensed", sans-serif`);
        pill(c, w / 2 - 78, 126, 156, 28, hit.d > 0 ? "#d9363e" : "#2f6df0", "#fff", sgn(hit.d), `700 19px "Barlow Condensed", sans-serif`);
        const dv = hit.sy - hit.sg;
        pill(c, w / 2 - 78, 156, 156, 22, "rgba(12,14,20,0.88)", dv < 0 ? "#ff8a9a" : "#7fe8c0", `${hit.sy} km/h  (${dv >= 0 ? "+" : "-"}${Math.abs(dv)})`, `700 14px "Barlow Condensed", sans-serif`);
      }
    }
    }
    drawTower(c);
    c.textAlign = "left"; c.textBaseline = "alphabetic";
    const m = MODES.find((x) => x[0] === R.cam.mode);
    c.fillStyle = "rgba(8,12,22,0.5)"; c.fillRect(12, 12, 150, 24);
    c.fillStyle = "#eef2fb"; c.font = `700 13px Barlow, sans-serif`; c.fillText(`CAM  ${m ? m[1].toUpperCase() : ""}`, 22, 29);
    if (R.rate !== 1) {
      c.fillStyle = "rgba(255,194,71,0.9)"; c.fillRect(w - 112, 12, 100, 26);
      c.fillStyle = "#1a1304"; c.font = `800 15px Barlow, sans-serif`; c.textAlign = "center"; c.fillText(R.rate < 1 ? `SLOW ${R.rate}×` : `${R.rate}×`, w - 62, 30);
    }
    if (R.rec) { c.fillStyle = "#ff5a73"; c.beginPath(); c.arc(w - 130, 25, 6, 0, 7); c.fill(); }
    if (R.show.mini) drawMini(c, w);
    // names over the cars and the distance between them
    const gap = gl.cy.p.distanceTo(gl.cg.p);
    const rel = (V.rv || (V.rv = new R.THREE.Vector3())).copy(gl.cg.p).sub(gl.cy.p).dot(gl.cy.f);
    if (R.show.ghost) tag(c, gl.cg, "GHOST", "#7fa6ff", `${gap < 1 ? "level" : `${Math.round(gap)} m ${rel > 0 ? "ahead" : "behind"}`}`);
    if (R.cam.mode !== "hood" && R.cam.mode !== "chase") tag(c, gl.cy, "YOU", "#eef2fb");
    // the air: a badge while airborne with the time so far, and the landing verdict afterwards
    const fl = inFlight(R.flights.you, R.t);
    if (fl) {
      const el = (R.t - fl.t_ms) / 1000;
      pill(c, w / 2 - 90, h * 0.5, 180, 40, "rgba(10,60,80,0.82)", "#9ff0ff", `AIR  ${el.toFixed(2)} s`, `800 26px "Barlow Condensed", sans-serif`);
      c.fillStyle = "rgba(8,12,22,0.7)"; c.fillRect(w / 2 - 90, h * 0.5 + 42, 180, 20);
      c.fillStyle = "#b4bfd6"; c.font = `600 12px Barlow, sans-serif`; c.textAlign = "center"; c.textBaseline = "middle";
      c.fillText(`${fl.length_m.toFixed(0)} m long · ${fl.height_m.toFixed(1)} m high${fl.brake_s > 0 ? " · air-brake" : ""}`, w / 2, h * 0.5 + 53);
    } else {
      const last = R.flights.you.filter((f) => R.t >= f.end_t_ms && R.t < f.end_t_ms + 2200 * clamp(R.rate, 0.2, 1)).pop();
      if (last) {
        const l = landingFor(last), good = l ? l.clean && l.speed_lost < 12 : true;
        pill(c, w / 2 - 130, h * 0.5, 260, 36, good ? "rgba(20,90,60,0.85)" : "rgba(130,30,45,0.85)", "#fff", good ? "CLEAN LANDING" : "ROUGH LANDING", `800 24px "Barlow Condensed", sans-serif`);
        c.fillStyle = "rgba(8,12,22,0.7)"; c.fillRect(w / 2 - Math.min(w / 2 - 8, 240), h * 0.5 + 38, Math.min(w - 16, 480), 20);
        c.fillStyle = "#d6dcef"; c.font = `600 12px Barlow, sans-serif`; c.textAlign = "center"; c.textBaseline = "middle";
        c.fillText(l ? l.text.replace(/^landed /, "Landed ") : `${(last.speed_in - last.speed_out).toFixed(0)} km/h lost`, w / 2, h * 0.5 + 49);
      }
    }
    // a slide badge
    if (R.slip && R.slip > 9 && !fl) { pill(c, 12, h - (R.show.pad ? 168 : 148), 110, 28, "rgba(255,150,40,0.85)", "#1d1103", `DRIFT ${Math.round(R.slip)}°`, `800 17px "Barlow Condensed", sans-serif`); }
    if (R.show.inputs) drawInputs(c, 12, h - 108, gl.cy, "YOU", "#eef2fb");
    if (R.show.inputs && R.show.ghost) drawInputs(c, R.show.pad ? w - 218 : w - 182, h - 108, gl.cg, "GHOST", "#5b8def");
    if (R.show.captions) drawCaptions(c, w, h);
    if (R.show.bars) { c.fillStyle = "#000"; c.fillRect(0, 0, w, h * 0.1); c.fillRect(0, h * 0.9, w, h * 0.1); }
  }

  // ------------------------------------------------------------------ scrub bar

  function drawScrub() {
    const cv = R.root.querySelector(".rp-scrub");
    if (!cv) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const X = (t) => (t / R.tEnd) * w;
    let m = 100; for (const d of R.deltas) m = Math.max(m, Math.abs(d));
    const Y = (d) => h / 2 - (d / m) * (h / 2 - 6);
    c.fillStyle = "rgba(255,90,115,0.2)"; c.beginPath(); c.moveTo(0, h / 2);
    R.ptT.forEach((t, i) => c.lineTo(X(t), Y(Math.max(0, R.deltas[i])))); c.lineTo(w, h / 2); c.fill();
    c.fillStyle = "rgba(47,227,162,0.2)"; c.beginPath(); c.moveTo(0, h / 2);
    R.ptT.forEach((t, i) => c.lineTo(X(t), Y(Math.min(0, R.deltas[i])))); c.lineTo(w, h / 2); c.fill();
    c.strokeStyle = "#34476a"; c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.stroke();
    c.strokeStyle = "#b4bfd6"; c.lineWidth = 1.5; c.beginPath(); R.ptT.forEach((t, i) => (i ? c.lineTo(X(t), Y(R.deltas[i])) : c.moveTo(X(t), Y(R.deltas[i])))); c.stroke();
    for (const f of R.flights.you) { c.fillStyle = "rgba(159,240,255,0.55)"; c.fillRect(X(f.t_ms), 0, Math.max(2, X(f.end_t_ms) - X(f.t_ms)), h); }   // the jumps
    for (const x of R.cps || []) { c.fillStyle = "#ffc247"; c.fillRect(X(x.t) - 0.5, h - 10, 1.5, 10); }
    for (const [i, s] of R.shots.entries()) {
      c.fillStyle = i === R.shotIdx ? "#8f7bff" : "#5b6b92"; const x = X(s.t);
      c.beginPath(); c.moveTo(x - 5, 0); c.lineTo(x + 5, 0); c.lineTo(x, 9); c.fill();
    }
    for (const k of R.captions) { c.fillStyle = CAP[k.kind] || CAP.note; c.beginPath(); c.arc(X(k.t0), h - 5, 3, 0, 7); c.fill(); }   // the coach's notes
    c.strokeStyle = "#fff"; c.lineWidth = 2; c.beginPath(); c.moveTo(X(R.t), 0); c.lineTo(X(R.t), h); c.stroke();
  }

  // ------------------------------------------------------------------ shots (camera cuts)

  const SHOT_KEYS = ["mode", "dist", "height", "fov", "look", "orbR", "yaw", "pitch", "fixed", "pinned"];

  function activeShot(t) { let k = -1; for (let i = 0; i < R.shots.length; i++) if (R.shots[i].t <= t) k = i; return k; }

  function applyShot(i) {
    const s = R.shots[i];
    if (!s) return;
    for (const k of SHOT_KEYS) if (s[k] !== undefined) R.cam[k] = Array.isArray(s[k]) ? [...s[k]] : s[k];
    if (s.rate != null) R.rate = s.rate;
  }

  function checkShots(snap) {
    if (!R.cuts) return;
    const k = activeShot(R.t);
    if (k !== R.shotIdx) { R.shotIdx = k; if (k >= 0) applyShot(k); if (!snap) updateSpeedUi(); }
  }

  function addShot() {
    R.shots.push({ t: Math.round(R.t / 10) * 10, ...Object.fromEntries(SHOT_KEYS.map((k) => [k, Array.isArray(R.cam[k]) ? [...R.cam[k]] : R.cam[k]])), rate: R.rate });
    R.shots.sort((a, b) => a.t - b.t);
    saveShots(); renderShots(); R.shotIdx = activeShot(R.t);
  }

  const pick = (cam, mode) => ({ mode, ...Object.fromEntries(SHOT_KEYS.filter((k) => k !== "mode").map((k) => [k, k === "fixed" ? null : k === "pinned" ? false : cam[k]])) });

  // cut to the corners that cost the most and to the jumps, in slow motion, and back to the chase view between them
  function autoDirect() {
    const pts = R.primary.points, tAt = (d) => { let lo = 0, hi = pts.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].distance_m <= d) lo = m; else hi = m; } return pts[lo].t_ms; };
    const base = { ...DEFAULT_CAM };
    const ev = [];
    [...(R.primary.corners || [])].filter((c) => Math.abs(c.time_change_ms) >= 15).sort((a, b) => Math.abs(b.time_change_ms) - Math.abs(a.time_change_ms)).slice(0, 4)
      .forEach((c, i) => ev.push({ t0: tAt(c.distance_start) - 1600, t1: tAt(c.distance_end) + 500, mode: ["side", "duel", "orbit", "duel"][i % 4], w: 1 }));
    R.flights.you.filter((f) => f.duration_s >= 0.35).sort((a, b) => b.duration_s - a.duration_s).slice(0, 3)
      .forEach((f, i) => ev.push({ t0: f.t_ms - 900, t1: f.end_t_ms + 1100, mode: ["side", "duel", "orbit"][i % 3], w: 2 }));
    ev.sort((a, b) => a.t0 - b.t0);
    const out = [{ t: 0, ...pick(base, "chase"), rate: 1 }];
    let edge = 1500;
    for (const e of ev) {
      const t0 = Math.max(edge + 300, e.t0);
      if (t0 >= R.tEnd - 800 || e.t1 <= t0 + 500) continue;
      out.push({ t: t0, ...pick({ ...base, dist: 11, orbR: 12 }, e.mode), rate: 0.25 });
      out.push({ t: e.t1, ...pick(base, "chase"), rate: 1 });
      edge = e.t1;
    }
    R.shots = out; R.shotIdx = -1; R.cuts = true;
    const cb = R.root.querySelector(".rp-cuts"); if (cb) cb.checked = true;
    saveShots(); renderShots(); checkShots(true);
  }

  const shotKey = () => `tm-shots-${(state.map && (state.map.map_uid || state.map.uid)) || R.primary.points.length}`;
  function saveShots() { try { localStorage.setItem(shotKey(), JSON.stringify(R.shots)); } catch (e) { /* storage is a convenience */ } }
  function loadShots() { try { R.shots = JSON.parse(localStorage.getItem(shotKey()) || "[]").filter((s) => s && typeof s.t === "number"); } catch (e) { R.shots = []; } }

  function renderShots() {
    const box = R.root.querySelector(".rp-shots");
    if (!R.shots.length) { box.innerHTML = `<p class="hint">No cuts yet. Set up a camera, scrub to a moment and add a shot. The replay then switches to it at that time, and can slow down there. Or let it direct the clip for you.</p>`; return; }
    const name = (m) => (MODES.find((x) => x[0] === m) || [0, m])[1];
    box.innerHTML = R.shots.map((s, i) => `<div class="rp-shot${i === R.shotIdx ? " on" : ""}" data-i="${i}">
      <input type="number" class="rp-st" step="0.1" min="0" value="${(s.t / 1000).toFixed(2)}" aria-label="Cut time in seconds" /><span>s</span>
      <b>${esc(name(s.mode))}</b>
      <select class="rp-sr" aria-label="Speed at this cut">${[1, 0.5, 0.25, 0.1, 0.05].map((r) => `<option value="${r}"${s.rate === r ? " selected" : ""}>${r === 1 ? "1×" : r + "×"}</option>`).join("")}</select>
      <button type="button" class="rp-sg" title="Jump here">&#9654;</button><button type="button" class="rp-sd" title="Remove this cut">&times;</button></div>`).join("");
    box.querySelectorAll(".rp-shot").forEach((row) => {
      const i = +row.dataset.i;
      row.querySelector(".rp-st").addEventListener("change", (e) => { R.shots[i].t = Math.max(0, Math.round(+e.target.value * 1000)); R.shots.sort((a, b) => a.t - b.t); saveShots(); renderShots(); });
      row.querySelector(".rp-sr").addEventListener("change", (e) => { R.shots[i].rate = +e.target.value; saveShots(); });
      row.querySelector(".rp-sg").addEventListener("click", () => { seek(R.shots[i].t + 1); });
      row.querySelector(".rp-sd").addEventListener("click", () => { R.shots.splice(i, 1); R.shotIdx = -1; saveShots(); renderShots(); });
    });
  }

  // ------------------------------------------------------------------ the air: a list of jumps to replay in slow motion

  function renderAir() {
    const box = R.root.querySelector(".rp-airlist");
    const you = R.flights.you, ghost = R.flights.ghost;
    if (!you.length && !ghost.length) { box.innerHTML = `<p class="hint">No jumps on this lap.</p>`; return; }
    const rows = you.map((f) => {
      const g = ghost.find((x) => Math.hypot(x.x - f.x, x.z - f.z) < 70), l = landingFor(f);
      const good = l ? l.clean && l.speed_lost < 12 : true;
      return { t: f.t_ms, html: `<div class="rp-jump"><div><b>${mmss(f.t_ms)}</b> <span class="mono">${f.duration_s.toFixed(1)} s · ${f.length_m.toFixed(0)} m · ${f.height_m.toFixed(1)} m high</span>
        <small class="${good ? "gain" : "loss"}">${l ? esc(l.text) : "landed"}</small><small>${g ? `ghost: ${g.duration_s.toFixed(1)} s in the air${g.brake_s > 0 ? ", air-braked" : ""}` : "the ghost stayed on the ground"}</small></div>
        <button type="button" class="btn quiet" data-t0="${Math.max(0, f.t_ms - 1200)}" data-t1="${f.end_t_ms + 1500}" title="Watch this jump in slow motion">&#9654; Slow-mo</button></div>` };
    });
    ghost.filter((g) => !you.some((f) => Math.hypot(g.x - f.x, g.z - f.z) < 70)).forEach((g) => rows.push({ t: g.t_ms, html: `<div class="rp-jump"><div><b>${mmss(g.t_ms)}</b> <span class="mono">ghost only: ${g.duration_s.toFixed(1)} s · ${g.length_m.toFixed(0)} m</span><small>You stayed on the ground here.</small></div>
        <button type="button" class="btn quiet" data-t0="${Math.max(0, g.t_ms - 1200)}" data-t1="${g.end_t_ms + 1500}">&#9654; Slow-mo</button></div>` }));
    rows.sort((a, b) => a.t - b.t);
    box.innerHTML = rows.map((r) => r.html).join("");
    box.querySelectorAll("button[data-t0]").forEach((b) => b.addEventListener("click", () => playClip(+b.dataset.t0, +b.dataset.t1, 0.25)));
  }

  function playClip(t0, t1, rate, mode) {
    cutsOff();
    R.cam = { ...R.cam, mode: mode || "duel", dist: mode === "chase" ? 6.8 : 11, height: mode === "chase" ? 2.3 : 3, yaw: 0, pitch: 0 };
    R.clip = { end: t1 };
    setRate(rate); seek(t0); play();
  }

  // ------------------------------------------------------------------ transport

  function cutsOff() { if (R.cuts && R.shots.length) { R.cuts = false; const c = R.root.querySelector(".rp-cuts"); if (c) c.checked = false; } }
  function seek(t) {
    R.t = clamp(t, 0, R.tEnd); R.shotIdx = -2; checkShots(true); R.prevT = R.t;
    R.spoken = new Set(R.captions.map((k, i) => (k.t0 < R.t ? i : -1)).filter((i) => i >= 0));      // captions already behind you are not read out
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    render(0, true);
  }

  // read the captions aloud as they come up (only while playing, once each)
  function speakCaptions() {
    if (!R.speak || !window.speechSynthesis) return;
    R.captions.forEach((k, i) => {
      if (R.spoken.has(i) || R.t < k.t0 || R.t > k.t0 + 700) return;
      R.spoken.add(i);
      const cost = k.tag ? (k.tag.startsWith("−") ? ` costs ${k.tag.slice(1).replace(" s", " seconds")}.` : ` gains ${k.tag.slice(1).replace(" s", " seconds")}.`) : ".";
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(`${k.title.replace(/^Steering: /, "Steering, ")}${cost} ${k.lines.join(". ")}`.replace(/→/g, "to"));
        u.rate = 1.15; window.speechSynthesis.speak(u);
      } catch (e) { /* speech is a bonus */ }
    });
  }

  function renderNotes() {
    const box = R.root.querySelector(".rp-notes");
    if (!box) return;
    if (!R.captions.length) { box.innerHTML = `<p class="hint">Nothing stands out on this lap.</p>`; return; }
    box.innerHTML = R.captions.map((k, i) => `<button type="button" class="rp-note" data-i="${i}">
      <span class="rp-nt">${mmss(k.t0 + 1300).slice(1, 7)}</span><span class="rp-nm"><b>${esc(k.title)}</b>${k.tag ? ` <em class="${k.kind}">${esc(k.tag)}</em>` : ""}<small>${esc(k.lines[0])}</small></span><span class="rp-ng">&#9654;</span></button>`).join("");
    box.querySelectorAll(".rp-note").forEach((b) => b.addEventListener("click", () => { const k = R.captions[+b.dataset.i]; playClip(Math.max(0, k.t0 - 300), k.t1 + 500, 0.5, "chase"); }));
  }
  function stepBy(ms) { pause(); seek(R.t + ms); }

  function play() {
    if (!R.loaded) return;
    if (R.t >= R.tEnd - 30) seek(0);
    R.playing = true; R.last = performance.now();
    syncUi();
  }
  function pause() { R.playing = false; syncUi(); }

  function frameLoop(now) {
    R.raf = requestAnimationFrame(frameLoop);
    if (!R.visible || !R.loaded) return;
    const dt = Math.min(0.1, (now - R.last) / 1000 || 0);
    R.last = now;
    if (R.playing) {
      R.t += dt * 1000 * R.rate;
      if (R.t >= R.tEnd) { R.t = R.tEnd; R.playing = false; stopRecord(); }
      if (R.clip && R.t >= R.clip.end) { R.clip = null; R.playing = false; setRate(1); }
      checkShots(false);
      speakCaptions();
    }
    moveFree(dt);
    render(R.playing ? dt : 0, !R.playing);
  }

  // the free camera: W A S D to fly, Q down, E up, shift to boost, + and - change the speed
  function moveFree(dt) {
    if (R.cam.mode !== "free" || !R.free || !dt) return;
    const k = R.keys, fr = R.free, T = R.THREE;
    V.fm = V.fm || new T.Vector3(); V.ff = V.ff || new T.Vector3(); V.fr = V.fr || new T.Vector3();
    V.ff.set(Math.sin(fr.yaw) * Math.cos(fr.pitch), Math.sin(fr.pitch), Math.cos(fr.yaw) * Math.cos(fr.pitch));
    V.fr.set(-Math.cos(fr.yaw), 0, Math.sin(fr.yaw));                       // forward x up
    V.fm.set(0, 0, 0);
    if (k.w) V.fm.add(V.ff); if (k.s) V.fm.sub(V.ff); if (k.d) V.fm.add(V.fr); if (k.a) V.fm.sub(V.fr); if (k.e) V.fm.y += 1; if (k.q) V.fm.y -= 1;
    if (V.fm.lengthSq() > 0) fr.pos.addScaledVector(V.fm.normalize(), fr.speed * (k.shift ? 3 : 1) * dt);
  }

  function startFree() {
    const T = R.THREE, d = gl.camera.getWorldDirection(new T.Vector3());
    R.free = { pos: gl.camera.position.clone(), yaw: Math.atan2(d.x, d.z), pitch: Math.asin(clamp(d.y, -1, 1)), speed: (R.free && R.free.speed) || 25 };
  }

  function setRate(r) { R.rate = r; updateSpeedUi(); }
  function updateSpeedUi() { R.root.querySelectorAll(".rp-rate button").forEach((b) => b.classList.toggle("on", +b.dataset.r === R.rate)); }

  // ------------------------------------------------------------------ recording and photos

  const REC_W = 1280, REC_H = 720;
  function compose() {
    const c = R.rec.ctx;
    c.drawImage(gl.renderer.domElement, 0, 0, REC_W, REC_H);
    c.drawImage(gl.hud, 0, 0, REC_W, REC_H);
  }
  function startRecord() {
    if (typeof MediaRecorder === "undefined") { alert("This browser can't record video."); return; }
    const out = document.createElement("canvas"); out.width = REC_W; out.height = REC_H;
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(out.captureStream(30), type ? { mimeType: type, videoBitsPerSecond: 8000000 } : {});
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      R.lastClipBytes = blob.size;
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = `replay-${String((state.map && state.map.name) || "run").replace(/[^\w]+/g, "-").toLowerCase()}.webm`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    };
    R.rec = { out, ctx: out.getContext("2d"), rec };
    rec.start(250);
    R.root.querySelector(".rp-rec").innerHTML = "&#9632; Stop and save"; R.root.querySelector(".rp-rec").classList.add("rec-on");
    seek(0); play();
  }
  function stopRecord() {
    if (!R.rec) return;
    const r = R.rec; R.rec = null;
    try { r.rec.stop(); } catch (e) { /* already stopped */ }
    const b = R.root && R.root.querySelector(".rp-rec");
    if (b) { b.innerHTML = "&#9679; Record clip"; b.classList.remove("rec-on"); }
  }
  function photo() {
    const out = document.createElement("canvas"); out.width = REC_W; out.height = REC_H;
    const c = out.getContext("2d"); render(0, true);
    c.drawImage(gl.renderer.domElement, 0, 0, REC_W, REC_H); c.drawImage(gl.hud, 0, 0, REC_W, REC_H);
    out.toBlob((blob) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "replay-frame.png"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); });
  }

  // ------------------------------------------------------------------ HUD settings, remembered between visits

  const HUD_KEYS = ["timer", "inputs", "mini", "tower", "pad", "captions"];
  function saveHud() { try { localStorage.setItem("tm-hud", JSON.stringify({ size: R.hudSize, speak: R.speak, ...Object.fromEntries(HUD_KEYS.map((k) => [k, R.show[k]])) })); } catch (e) { /* a convenience only */ } }
  function loadHud() {
    try {
      const h = JSON.parse(localStorage.getItem("tm-hud") || "null");
      if (!h) return;
      if (typeof h.size === "number") R.hudSize = clamp(h.size, 0.4, 1.4);
      for (const k of HUD_KEYS) if (typeof h[k] === "boolean") R.show[k] = h[k];
      if (typeof h.speak === "boolean") R.speak = h.speak;
    } catch (e) { /* ignore */ }
  }
  function syncHudUi() {
    const q = (s) => R.root.querySelector(s);
    q(".rp-hudsize").value = Math.round(R.hudSize * 100);
    for (const [cls, k] of [["rp-timer", "timer"], ["rp-inputs", "inputs"], ["rp-mini", "mini"], ["rp-tower", "tower"], ["rp-pad", "pad"], ["rp-caps", "captions"]]) q("." + cls).checked = !!R.show[k];
    q(".rp-speak").checked = !!R.speak;
  }

  // ------------------------------------------------------------------ DOM

  function template() {
    const chk = (cls, text, on) => `<label class="tv-check"><input type="checkbox" class="${cls}"${on ? " checked" : ""} /> ${text}</label>`;
    return `<div class="rp">
      <div class="rp-main">
        <div class="rp-stage"><canvas class="rp-gl"></canvas><canvas class="rp-hud"></canvas><div class="rp-loading">Loading the replay…</div></div>
        <div class="rp-transport">
          <button type="button" class="btn quiet rp-start" title="Back to the start">&#9198;</button>
          <button type="button" class="btn quiet rp-bk" title="One frame back (, ) · hold shift for 10 ms">&#9664;&#10074;</button>
          <button type="button" class="btn rp-play" aria-label="Play">&#9654;</button>
          <button type="button" class="btn quiet rp-fw" title="One frame forward (.) · hold shift for 10 ms">&#10074;&#9654;</button>
          <div class="rp-rate" role="group" aria-label="Speed">${[1, 0.5, 0.25, 0.1, 0.05].map((r) => `<button type="button" data-r="${r}"${r === 1 ? ' class="on"' : ""}>${r === 1 ? "1×" : r + "×"}</button>`).join("")}</div>
          <span class="rp-clock mono"></span>
          <span class="rp-spacer"></span>
          <button type="button" class="btn quiet rp-photo" title="Save this frame as a picture">Photo</button>
          <button type="button" class="btn quiet rp-rec" title="Record the replay, with your camera cuts, as a video">&#9679; Record clip</button>
          <button type="button" class="btn quiet rp-fs">Full screen</button>
        </div>
        <canvas class="rp-scrub" aria-label="Gap to the ghost over the lap, jumps in blue. Click or drag to scrub."></canvas>
        <div class="rp-keys">space play · , . one frame (shift: 10 ms) · [ ] slower / faster · ← → 1 s · drag the picture to look around, scroll to zoom, double-click to reset</div>
      </div>
      <aside class="rp-side">
        <section><h3>Camera</h3>
          <div class="rp-modes">${MODES.map((m) => `<button type="button" data-m="${m[0]}" title="${esc(m[2])}"${m[0] === "chase" ? ' class="on"' : ""}>${esc(m[1])}</button>`).join("")}</div>
          <div class="rp-sliders">
            <label>Distance<input type="range" class="rp-dist" min="3" max="40" step="0.5" /></label>
            <label>Height<input type="range" class="rp-height" min="0.5" max="14" step="0.1" /></label>
            <label>Field of view<input type="range" class="rp-fov" min="40" max="115" step="1" /></label>
            <label>Look ahead<input type="range" class="rp-look" min="0" max="50" step="1" /></label>
            <label>Follow lag<input type="range" class="rp-smooth" min="1.5" max="20" step="0.5" /></label>
          </div>
          <div class="rp-checks">
            ${chk("rp-sfov", "Wider view at speed", true)}${chk("rp-shake", "Camera shake", true)}
            ${chk("rp-ghostvis", "Ghost", true)}${chk("rp-fxon", "Spray, sparks, streaks", true)}
            ${chk("rp-trails", "Trails", true)}${chk("rp-arcs", "Jump arcs", true)}
            ${chk("rp-gates", "Checkpoints", true)}${chk("rp-shadows", "Shadows", true)}
            ${chk("rp-bars", "Cinematic bars", false)}${chk("rp-blocks", "Map blocks", true)}
          </div>
          <p class="hint rp-blocknote"></p>
          <button type="button" class="btn quiet rp-drop" title="Pin a trackside camera here so the cars drive past it">Pin a trackside camera here</button>
        </section>
        <section><h3>On-screen display</h3>
          <div class="rp-sliders"><label>HUD size<input type="range" class="rp-hudsize" min="40" max="140" step="5" /></label></div>
          <div class="rp-checks">
            ${chk("rp-timer", "Timer and gaps", true)}${chk("rp-tower", "Timing tower", true)}
            ${chk("rp-inputs", "Inputs", true)}${chk("rp-pad", "Arrow input display", true)}
            ${chk("rp-mini", "Mini-map", true)}${chk("rp-caps", "Coach captions", true)}
            ${chk("rp-speak", "Read captions aloud", false)}
          </div>
        </section>
        <section><h3>Coach notes <small>click one to watch it</small></h3><div class="rp-notes"></div></section>
        <section><h3>Air <small>jumps, replay them in slow motion</small></h3><div class="rp-airlist"></div></section>
        <section><h3>Shots <small>camera cuts</small></h3>
          <label class="tv-check rp-cutsrow"><input type="checkbox" class="rp-cuts" checked /> Use the cuts <small>(turns off when you take over the camera)</small></label>
          <div class="rp-shotbtns"><button type="button" class="btn quiet rp-addshot">+ Cut to this camera now</button><button type="button" class="btn quiet rp-auto">Auto-direct</button></div>
          <div class="rp-shots"></div>
        </section>
      </aside>
    </div>`;
  }

  function syncUi() {
    const r = R.root;
    if (!r) return;
    r.querySelector(".rp-play").innerHTML = R.playing ? "&#10074;&#10074;" : "&#9654;";
    r.querySelector(".rp-clock").textContent = `${mmss(R.t)} / ${mmss(R.tEnd)}`;
    r.querySelectorAll(".rp-shot").forEach((row, i) => row.classList.toggle("on", i === R.shotIdx));
    const c = R.cam;
    r.querySelectorAll(".rp-modes button").forEach((b) => b.classList.toggle("on", b.dataset.m === c.mode));
    const set = (cls, v) => { const el = r.querySelector(cls); if (el && document.activeElement !== el && +el.value !== v) el.value = v; };
    set(".rp-dist", c.mode === "orbit" || c.mode === "top" ? c.orbR : c.dist); set(".rp-height", c.height); set(".rp-fov", c.fov); set(".rp-look", c.look); set(".rp-smooth", c.smooth);
  }

  function wire() {
    const r = R.root, q = (s) => r.querySelector(s);
    q(".rp-play").addEventListener("click", () => (R.playing ? pause() : play()));
    q(".rp-start").addEventListener("click", () => seek(0));
    q(".rp-bk").addEventListener("click", (e) => stepBy(e.shiftKey ? -10 : -50));
    q(".rp-fw").addEventListener("click", (e) => stepBy(e.shiftKey ? 10 : 50));
    r.querySelectorAll(".rp-rate button").forEach((b) => b.addEventListener("click", () => setRate(+b.dataset.r)));
    r.querySelectorAll(".rp-modes button").forEach((b) => b.addEventListener("click", () => { cutsOff(); if (b.dataset.m === "free") startFree(); R.cam.mode = b.dataset.m; if (b.dataset.m === "side") { R.cam.fixed = null; R.cam.pinned = false; } R.cam.yaw = 0; R.cam.pitch = 0; render(0, true); }));
    const bind = (cls, key, alt) => q(cls).addEventListener("input", (e) => { cutsOff(); R.cam[alt && (R.cam.mode === "orbit" || R.cam.mode === "top") ? alt : key] = +e.target.value; render(0, true); });
    bind(".rp-dist", "dist", "orbR"); bind(".rp-height", "height"); bind(".rp-fov", "fov"); bind(".rp-look", "look"); bind(".rp-smooth", "smooth");
    const tog = (cls, fn) => q(cls).addEventListener("change", (e) => { fn(e.target.checked); render(0, true); });
    tog(".rp-sfov", (v) => (R.cam.speedFov = v)); tog(".rp-shake", (v) => (R.show.shake = v)); tog(".rp-ghostvis", (v) => (R.show.ghost = v));
    tog(".rp-fxon", (v) => (R.show.fx = v)); tog(".rp-trails", (v) => (R.show.trails = v)); tog(".rp-arcs", (v) => (R.show.arcs = v));
    tog(".rp-gates", (v) => (R.show.gates = v)); tog(".rp-shadows", (v) => (R.show.shadows = v)); tog(".rp-bars", (v) => (R.show.bars = v)); tog(".rp-pad", (v) => { R.show.pad = v; saveHud(); }); tog(".rp-tower", (v) => { R.show.tower = v; saveHud(); });
    tog(".rp-timer", (v) => { R.show.timer = v; saveHud(); }); tog(".rp-inputs", (v) => { R.show.inputs = v; saveHud(); }); tog(".rp-mini", (v) => { R.show.mini = v; saveHud(); });
    tog(".rp-caps", (v) => { R.show.captions = v; saveHud(); });
    tog(".rp-blocks", (v) => { R.show.blocks = v; if (gl.blocks) gl.blocks.visible = v; });
    q(".rp-speak").addEventListener("change", (e) => { R.speak = e.target.checked; if (!R.speak && window.speechSynthesis) window.speechSynthesis.cancel(); saveHud(); });
    q(".rp-hudsize").addEventListener("input", (e) => { R.hudSize = +e.target.value / 100; saveHud(); render(0, true); });
    q(".rp-drop").addEventListener("click", () => { cutsOff(); R.cam.mode = "side"; R.cam.fixed = null; R.cam.pinned = true; render(0, true); });
    q(".rp-cuts").addEventListener("change", (e) => { R.cuts = e.target.checked; R.shotIdx = -2; checkShots(true); });
    q(".rp-addshot").addEventListener("click", addShot);
    q(".rp-auto").addEventListener("click", autoDirect);
    q(".rp-rec").addEventListener("click", () => (R.rec ? stopRecord() : startRecord()));
    q(".rp-photo").addEventListener("click", photo);
    q(".rp-fs").addEventListener("click", () => { const el = q(".rp-stage"); if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen(); });
    const sc = q(".rp-scrub");
    let drag = false;
    const fromX = (ev) => { const b = sc.getBoundingClientRect(); seek(clamp((ev.clientX - b.left) / b.width, 0, 1) * R.tEnd); };
    sc.addEventListener("pointerdown", (ev) => { drag = true; sc.setPointerCapture(ev.pointerId); fromX(ev); });
    sc.addEventListener("pointermove", (ev) => drag && fromX(ev));
    sc.addEventListener("pointerup", () => (drag = false));
    const st = q(".rp-stage");
    let look = null;
    st.addEventListener("pointerdown", (ev) => { look = { x: ev.clientX, y: ev.clientY }; st.setPointerCapture(ev.pointerId); });
    st.addEventListener("pointermove", (ev) => {
      if (!look) return;
      cutsOff();
      if (R.cam.mode === "free" && R.free) { R.free.yaw -= (ev.clientX - look.x) * 0.005; R.free.pitch = clamp(R.free.pitch - (ev.clientY - look.y) * 0.005, -1.5, 1.5); }
      else { R.cam.yaw -= (ev.clientX - look.x) * 0.006; R.cam.pitch = clamp(R.cam.pitch + (ev.clientY - look.y) * 0.005, -0.5, 1.3); }
      look = { x: ev.clientX, y: ev.clientY };
    });
    st.addEventListener("pointerup", () => (look = null));
    st.addEventListener("dblclick", () => { R.cam.yaw = 0; R.cam.pitch = 0; });
    st.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const f = Math.exp(ev.deltaY * 0.0012);
      if (R.cam.mode === "free" && R.free) { const T = R.THREE, d = gl.camera.getWorldDirection(new T.Vector3()); R.free.pos.addScaledVector(d, -ev.deltaY * 0.06 * Math.max(1, R.free.speed / 25)); }
      else if (R.cam.mode === "orbit" || R.cam.mode === "top") R.cam.orbR = clamp(R.cam.orbR * f, 3, 120); else R.cam.dist = clamp(R.cam.dist * f, 3, 60);
    }, { passive: false });
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => resize()).observe(st);
  }

  function resize() {
    if (!gl.renderer) return;
    const st = R.root.querySelector(".rp-stage"), w = st.clientWidth, h = st.clientHeight;
    if (!w || !h) return;
    gl.renderer.setSize(w, h, false);
    gl.camera.aspect = w / h; gl.camera.updateProjectionMatrix();
  }

  window.addEventListener("keydown", (e) => {
    if (!R.visible || !R.loaded || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target.tagName || ""))) return;
    if (e.key === " ") { e.preventDefault(); R.playing ? pause() : play(); }
    else if (e.key === "," || e.key === "<") stepBy(e.shiftKey ? -10 : -50);
    else if (e.key === "." || e.key === ">") stepBy(e.shiftKey ? 10 : 50);
    else if (e.key === "ArrowRight") { e.preventDefault(); seek(R.t + (e.shiftKey ? 5000 : 1000)); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); seek(R.t - (e.shiftKey ? 5000 : 1000)); }
    else if (e.key === "Home") { e.preventDefault(); seek(0); }
    else if (e.key === "End") { e.preventDefault(); seek(R.tEnd); }
    else if ((e.key === "+" || e.key === "=" ) && R.free) R.free.speed = Math.min(400, R.free.speed * 1.3);
    else if (e.key === "-" && R.free) R.free.speed = Math.max(2, R.free.speed / 1.3);
    else if (e.key === "[" || e.key === "]") {
      const rates = [0.05, 0.1, 0.25, 0.5, 1, 2], i = rates.indexOf(R.rate);
      setRate(rates[clamp((i < 0 ? 4 : i) + (e.key === "]" ? 1 : -1), 0, rates.length - 1)]);
    }
  });

  window.addEventListener("keydown", (e) => { if (R.visible && R.cam.mode === "free" && !/^(INPUT|SELECT|TEXTAREA)$/.test((e.target.tagName || ""))) { const k = e.key.toLowerCase(); if ("wasdqe".includes(k) && k.length === 1) R.keys[k] = true; if (e.key === "Shift") R.keys.shift = true; } });
  window.addEventListener("keyup", (e) => { const k = e.key.toLowerCase(); if ("wasdqe".includes(k) && k.length === 1) R.keys[k] = false; if (e.key === "Shift") R.keys.shift = false; });

  // ------------------------------------------------------------------ public

  async function ensure() {
    const root = document.getElementById("replay-body");
    if (!root) return;
    R.root = root;
    const primary = R.primary;
    if (!primary || !primary.points || primary.points.length < 4) { root.innerHTML = `<div class="hint">The replay needs two runs with driving data. Pick your run and a ghost first.</div>`; R.loaded = false; return; }
    if (typeof THREE === "undefined") { root.innerHTML = `<div class="hint">The 3D replay needs three.js, which loads from the internet. Check your connection and reload.</div>`; return; }
    R.THREE = THREE;
    const others = sortedGhostIds().filter((id) => id !== state.primaryRefId).slice(0, 4);
    const key = [state.subjectId, state.primaryRefId, ...others].join("|");
    if (R.loaded && R.key === key) { resize(); return; }
    if (R.loading) return;
    R.loading = true; R.loaded = false;
    stopRecord();
    root.innerHTML = template();
    wire();
    try {
      const runs = await Store.getRuns([state.subjectId, state.primaryRefId, ...others]);
      const me = runs.find((x) => x.id === state.subjectId), ref = runs.find((x) => x.id === state.primaryRefId);
      if (!me || !ref || !me.samples.length || !ref.samples.length) throw new Error("no driving data");
      R.you = prep(me.samples); R.ghost = prep(ref.samples);
      R.ghostName = runLabel(state.primaryRefId);
      R.others = others.map((id) => runs.find((x) => x.id === id)).filter((r) => r && r.samples && r.samples.length > 20)
        .map((r) => ({ id: r.id, name: runLabel(r.id), color: ghostColor(r.id), A: prep(r.samples) }));
      R.tEnd = Math.max(R.you.t[R.you.n - 1], 1);
      R.flights = { you: (primary.subject_flights || []).filter((f) => f.end_t_ms > f.t_ms), ghost: (primary.reference_flights || []).filter((f) => f.end_t_ms > f.t_ms) };
      R.landings = (primary.driving && primary.driving.subject && primary.driving.subject.landings) || [];
      if (!gl.renderer || gl.renderer.domElement !== root.querySelector(".rp-gl")) {
        const canvas = root.querySelector(".rp-gl");
        gl.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
        gl.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        gl.renderer.shadowMap.enabled = true; gl.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        gl.renderer.outputEncoding = THREE.sRGBEncoding; gl.renderer.toneMapping = THREE.ACESFilmicToneMapping; gl.renderer.toneMappingExposure = 1.15;
      }
      gl.hud = root.querySelector(".rp-hud");
      gl.camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.3, 9000);
      buildWorld(R.primary);
      if (me.checkpoints && ref.checkpoints && me.checkpoints.length === ref.checkpoints.length) {
        const o1 = mk(THREE), o2 = mk(THREE);
        R.cps = me.checkpoints.map((t, i) => ({ t, d: t - ref.checkpoints[i], name: i === me.checkpoints.length - 1 ? "Finish" : `CP ${i + 1}`,
          sy: Math.round(at(R.you, t, o1, THREE).speed), sg: Math.round(at(R.ghost, ref.checkpoints[i], o2, THREE).speed) }));
      } else R.cps = [];
      R.key = key; R.loaded = true; R.t = 0; R.prevT = 0; R.playing = false; R.cam = { ...DEFAULT_CAM }; R.rate = 1; R.shotIdx = -1; R.clip = null; R.cuts = true;
      loadShots(); loadHud(); syncHudUi();
      R.captions = Captions.build(R.primary); R.spoken = new Set(); renderNotes();
      R.blockToken = (R.blockToken || 0) + 1; gl.blocks = null; loadBlocks(me.map_uid, R.blockToken);
      root.querySelector(".rp-loading").hidden = true;
      renderShots(); renderAir(); resize();
      seek(0);
      if (!R.raf) { R.last = performance.now(); R.raf = requestAnimationFrame(frameLoop); }
    } catch (e) {
      root.innerHTML = `<div class="hint">Couldn't load the replay data (${esc(e.message || e)}).</div>`;
    } finally { R.loading = false; }
  }

  return {
    render(primary) { R.primary = primary; R.key = null; R.loaded = false; if (R.visible) ensure(); },
    async show() { R.visible = true; await ensure(); if (R.loaded) { R.last = performance.now(); resize(); } },
    hide() { R.visible = false; if (R.playing) pause(); stopRecord(); },
    captions: () => R.captions.map((k) => [Math.round(k.t0), k.title, k.tag]),
    blockInfo: () => R.blockInfo,
    state: () => ({ particles: gl.parts ? Array.from(gl.parts.ttl).filter((x) => x > 0).length : 0, t: R.t, rate: R.rate, mode: R.cam.mode, loaded: R.loaded, shots: R.shots.length, clipBytes: R.lastClipBytes || 0, rec: !!R.rec, flights: R.flights.you.length }),
    // for checking: does the car turn the way the recorded steering says? (positive steer is right, a clockwise turn seen from above)
    probe() {
      const T = R.THREE, a = at(R.you, R.t, mk(T), T), b = at(R.you, R.t + 100, mk(T), T), mv = b.p.clone().sub(a.p).normalize();
      return { dot: a.f.dot(mv), speed: a.speed, steer: a.steer, turn: new T.Vector3().crossVectors(a.f, b.f).dot(a.u), flightsYou: R.flights.you.map((f) => [f.t_ms, f.end_t_ms]) };
    },
    towerRows: () => (R.loaded ? tower().map((r) => [r.name, r.text]) : []),
    api: { seek, play, pause, setRate, autoDirect, addShot, stepBy, playClip, cam: () => R.cam },
  };
})();

function renderReplay3D(primary) { Replay3D.render(primary); }
