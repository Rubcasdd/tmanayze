"use strict";

// The Replay tab: a real 3D replay of both runs on the same race clock, like the game's own replay. Your car and the
// ghost (see-through, as in the game) drive the line they actually drove, with the car turned the way it was
// recorded (banks, jumps, slides), a chase camera behind you, the game-style timer and checkpoint flash, and the
// wheel and pedals of both drivers on screen. Slow it down to a twentieth, step one frame at a time, grab the
// camera and look closely, cut between cameras with a shot list you can edit, and record the result as a video.
//
// Needs three.js (loaded from the CDN in index.html) and app.js helpers ($, esc, fmtGap, Store, state).

const Replay3D = (() => {
  const WHEEL_RAD = 1.9;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const GROUND = { tech: 0x343c4f, bump: 0x3b4358, plastic: 0x4b5b9a, dirt: 0x6e5238, grass: 0x3a6a3a, ice: 0x9fd8f2, water: 0x2a6aa8, unknown: 0x3a4256 };
  const MODES = [
    ["chase", "Chase you", "Behind your car, like the game"],
    ["duel", "Both cars", "Frames you and the ghost together"],
    ["ghost", "Chase ghost", "Behind the ghost"],
    ["hood", "Hood", "From the front of your car"],
    ["orbit", "Orbit", "Circle your car: drag to look around"],
    ["side", "Trackside", "A fixed camera that watches the cars go past"],
    ["top", "Top down", "From above, heading up"],
  ];
  const DEFAULT_CAM = { mode: "chase", dist: 6.8, height: 2.3, fov: 72, look: 14, smooth: 7, speedFov: true, bank: 0.6, yaw: 0, pitch: 0, orbR: 11, fixed: null, pinned: false };

  const R = {
    primary: null, key: null, loaded: false, loading: false, visible: false, THREE: null,
    t: 0, tEnd: 0, rate: 1, playing: false, last: 0, raf: 0,
    cam: { ...DEFAULT_CAM }, shots: [], shotIdx: -1, cuts: true, show: { ghost: true, trails: true, gates: true }, rec: null, root: null,
  };

  // ------------------------------------------------------------------ samples

  // sample arrays in scene space: the game is left-handed, three.js is right-handed, so z is flipped everywhere
  function prep(samples) {
    const n = samples.length;
    const A = { n, t: new Float32Array(n), p: new Float32Array(n * 3), f: new Float32Array(n * 3), u: new Float32Array(n * 3), sp: new Float32Array(n), st: new Float32Array(n), ga: new Float32Array(n), br: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      A.t[i] = s.time_ms;
      A.p.set([s.x, s.y, -s.z], i * 3);
      if (s.fx != null && s.ux != null) { A.f.set([s.fx, s.fy, -s.fz], i * 3); A.u.set([s.ux, s.uy, -s.uz], i * 3); }
      else {                                             // no orientation recorded: point along the motion, level
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        const dx = samples[b].x - samples[a].x, dz = -(samples[b].z - samples[a].z), dy = samples[b].y - samples[a].y, l = Math.hypot(dx, dy, dz) || 1;
        A.f.set([dx / l, dy / l, dz / l], i * 3); A.u.set([0, 1, 0], i * 3);
      }
      A.sp[i] = s.speed; A.st[i] = s.steer; A.ga[i] = s.gas; A.br[i] = s.brake;
    }
    return A;
  }

  function mk(T) { return { p: new T.Vector3(), f: new T.Vector3(), u: new T.Vector3(), l: new T.Vector3(), speed: 0, steer: 0, gas: 0, brake: 0 }; }

  // the car's state at a race time (ms), interpolated between the 50 ms samples
  function at(A, t, out, T) {
    let lo = 0, hi = A.n - 1;
    if (t <= A.t[0]) hi = lo = 0;
    else if (t >= A.t[hi]) lo = hi;
    else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A.t[m] <= t) lo = m; else hi = m; }
    const span = A.t[hi] - A.t[lo], k = span > 0 ? (t - A.t[lo]) / span : 0;
    const L = (arr, o, j) => arr[lo * 3 + j] + (arr[hi * 3 + j] - arr[lo * 3 + j]) * k;
    out.p.set(L(A.p, 0, 0), L(A.p, 0, 1), L(A.p, 0, 2));
    out.f.set(L(A.f, 0, 0), L(A.f, 0, 1), L(A.f, 0, 2)).normalize();
    out.u.set(L(A.u, 0, 0), L(A.u, 0, 1), L(A.u, 0, 2));
    out.u.addScaledVector(out.f, -out.u.dot(out.f)).normalize();        // keep it square with the heading
    out.l.crossVectors(out.u, out.f).normalize();                        // the car's left
    const S = (arr) => arr[lo] + (arr[hi] - arr[lo]) * k;
    out.speed = S(A.sp); out.steer = S(A.st); out.gas = S(A.ga); out.brake = S(A.br);
    return out;
  }

  // ------------------------------------------------------------------ the scene

  function buildCar(T, color, ghost) {
    const g = new T.Group();
    const m = (c, extra) => new T.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.4, metalness: 0.35 }, ghost ? { transparent: true, opacity: 0.45, depthWrite: false } : {}, extra || {}));
    const box = (w, h, d, x, y, z, mat) => { const b = new T.Mesh(new T.BoxGeometry(w, h, d), mat); b.position.set(x, y, z); g.add(b); return b; };
    box(1.9, 0.42, 4.1, 0, 0.12, 0, m(color));
    box(1.15, 0.26, 1.5, 0, 0.0, 2.55, m(color));
    box(2.1, 0.07, 0.55, 0, -0.16, 3.15, m(0x151a26));
    box(1.0, 0.42, 1.5, 0, 0.55, -0.35, m(ghost ? 0x9fb4ff : 0x10151f, { metalness: 0.7, roughness: 0.15 }));
    box(0.5, 0.05, 3.2, 0, 0.35, 0.1, m(0xffffff));
    box(1.9, 0.07, 0.55, 0, 0.85, -2.1, m(0x151a26));
    box(0.08, 0.5, 0.08, 0.6, 0.6, -2.05, m(0x151a26)); box(0.08, 0.5, 0.08, -0.6, 0.6, -2.05, m(0x151a26));
    const tail = new T.MeshBasicMaterial({ color: 0x551018, transparent: ghost, opacity: ghost ? 0.5 : 1 });
    box(1.3, 0.12, 0.05, 0, 0.3, -2.07, tail);
    const wheels = [], fronts = [];
    for (const [x, z, front] of [[1.0, 1.45, true], [-1.0, 1.45, true], [1.0, -1.35, false], [-1.0, -1.35, false]]) {
      const pivot = new T.Group(); pivot.position.set(x, -0.12, z);
      const spin = new T.Group();
      const cyl = new T.Mesh(new T.CylinderGeometry(0.42, 0.42, 0.38, 22), m(0x0c0f16, { roughness: 0.8, metalness: 0.05 }));
      cyl.rotation.z = Math.PI / 2;
      const hub = new T.Mesh(new T.CylinderGeometry(0.2, 0.2, 0.4, 12), m(0xc9d2ea));
      hub.rotation.z = Math.PI / 2;
      spin.add(cyl, hub); pivot.add(spin); g.add(pivot);
      wheels.push(spin); if (front) fronts.push(pivot);
    }
    g.matrixAutoUpdate = false;
    return { group: g, wheels, fronts, tail };
  }

  const gl = {};

  function makeTrail(T, color, n) {
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    geo.setAttribute("color", new T.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    const mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
    mesh.frustumCulled = false;
    return { mesh, n, color: new T.Color(color) };
  }

  function buildWorld(primary) {
    const T = R.THREE;
    if (gl.scene) { gl.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
    const scene = new T.Scene();
    scene.background = new T.Color(0x0a1020);
    scene.fog = new T.Fog(0x0a1020, 250, 2400);
    scene.add(new T.HemisphereLight(0xbfd2ff, 0x1b2236, 0.95));
    const sun = new T.DirectionalLight(0xffffff, 1.1); sun.position.set(0.4, 1, 0.3); scene.add(sun);
    gl.scene = scene;

    const pts = primary.points;
    const lab = state.surface && state.surface.labels && state.surface.labels.length === pts.length ? state.surface.labels : null;
    const W = 14, n = pts.length;
    const pos = new Float32Array(n * 2 * 3), col = new Float32Array(n * 2 * 3);
    const P = new T.Vector3(), F = new T.Vector3(), U = new T.Vector3(), L = new T.Vector3(), C = new T.Color();
    let minY = Infinity;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[Math.min(n - 1, i + 1)], o = pts[Math.max(0, i - 1)];
      P.set(p.x, p.y, -p.z);
      if (p.fx != null) { F.set(p.fx, p.fy, -p.fz); U.set(p.ux, p.uy, -p.uz); }
      else { F.set(q.x - o.x, q.y - o.y, -(q.z - o.z)); U.set(0, 1, 0); }
      F.normalize(); U.addScaledVector(F, -U.dot(F)).normalize();
      L.crossVectors(U, F).normalize();
      const cy = P.y - 0.55;
      minY = Math.min(minY, cy);
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? 1 : -1;
        pos.set([P.x + L.x * W / 2 * side - U.x * 0.55, P.y + L.y * W / 2 * side - U.y * 0.55, P.z + L.z * W / 2 * side - U.z * 0.55], (i * 2 + s) * 3);
        C.setHex(GROUND[lab ? lab[i] : "unknown"] || GROUND.unknown);
        const shade = 0.9 + 0.1 * Math.sin(i * 0.9);                       // a faint banding so speed reads on the road
        col.set([C.r * shade, C.g * shade, C.b * shade], (i * 2 + s) * 3);
      }
    }
    const ribbon = (position, color, material) => {
      const geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.BufferAttribute(position, 3));
      if (color) geo.setAttribute("color", new T.BufferAttribute(color, 3));
      const idx = [];
      for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      geo.setIndex(idx); geo.computeVertexNormals();
      return new T.Mesh(geo, material);
    };
    scene.add(ribbon(pos, col, new T.MeshLambertMaterial({ vertexColors: true, side: T.DoubleSide })));
    // glowing edges: thin lines on both sides so the road shows up at speed
    for (const [side, hex] of [[1, 0x8f7bff], [-1, 0xffc247]]) {
      const ep = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) {
        const p = pts[i], q = pts[Math.min(n - 1, i + 1)], o = pts[Math.max(0, i - 1)];
        P.set(p.x, p.y, -p.z);
        if (p.fx != null) { F.set(p.fx, p.fy, -p.fz); U.set(p.ux, p.uy, -p.uz); } else { F.set(q.x - o.x, q.y - o.y, -(q.z - o.z)); U.set(0, 1, 0); }
        F.normalize(); U.addScaledVector(F, -U.dot(F)).normalize(); L.crossVectors(U, F).normalize();
        for (let s = 0; s < 2; s++) {
          const off = W / 2 + (s ? 0.9 : 0.15);
          ep.set([P.x + L.x * off * side - U.x * 0.5, P.y + L.y * off * side - U.y * 0.5, P.z + L.z * off * side - U.z * 0.5], (i * 2 + s) * 3);
        }
      }
      scene.add(ribbon(ep, null, new T.MeshBasicMaterial({ color: hex, side: T.DoubleSide })));
    }
    // a faint floor far below so there is something to judge height against
    const floorY = minY - 40;
    const floor = new T.Mesh(new T.PlaneGeometry(9000, 9000), new T.MeshBasicMaterial({ color: 0x0c1324 }));
    floor.rotation.x = -Math.PI / 2; floor.position.set(pts[0].x, floorY, -pts[0].z); scene.add(floor);
    const grid = new T.GridHelper(9000, 90, 0x1c2a48, 0x131c33); grid.position.set(pts[0].x, floorY + 0.1, -pts[0].z); scene.add(grid);

    // checkpoint gates and the finish
    gl.gates = [];
    const rows = (primary.checkpoints || []);
    rows.forEach((r, k) => {
      let gx = r.x, gy = r.y, gz = r.z, idx;
      if (gx == null) { idx = n - 1; gx = pts[idx].x; gy = pts[idx].y; gz = pts[idx].z; }
      else idx = pts.reduce((b, p, i) => (Math.abs(p.distance_m - r.dist_m) < Math.abs(pts[b].distance_m - r.dist_m) ? i : b), 0);
      const p = pts[idx], q = pts[Math.min(n - 1, idx + 1)], o = pts[Math.max(0, idx - 1)];
      const f = new T.Vector3(q.x - o.x, q.y - o.y, -(q.z - o.z)).normalize();
      const fin = r.label === "Finish";
      const ring = new T.Mesh(new T.TorusGeometry(9.5, 0.28, 10, 48), new T.MeshBasicMaterial({ color: fin ? 0xffffff : 0xffc247, transparent: true, opacity: 0.85 }));
      ring.position.set(gx, gy + 3.5, -gz);
      ring.lookAt(ring.position.clone().add(f));
      scene.add(ring); gl.gates.push(ring);
    });

    // the two cars and their trails
    gl.you = buildCar(T, 0xf2f4ff, false); gl.ghost = buildCar(T, 0x5b8def, true);
    scene.add(gl.you.group, gl.ghost.group);
    gl.ty = makeTrail(T, 0xeef2fb, 70); gl.tg = makeTrail(T, 0x5b8def, 70);
    scene.add(gl.ty.mesh, gl.tg.mesh);
    gl.cy = mk(T); gl.cg = mk(T);
    R.sf = new T.Vector3(0, 0, 1); R.su = new T.Vector3(0, 1, 0); R.camPos = new T.Vector3(); R.camLook = new T.Vector3();
    R.deltas = pts.map((p) => p.delta_ms); R.ptT = pts.map((p) => p.t_ms);
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
      default: {                                              // chase you / chase ghost
        V.c.copy(dir).negate(); rotYaw(V.c, c.yaw);
        pos.copy(focus.p).addScaledVector(V.c, c.dist * Math.cos(c.pitch)).addScaledVector(up, c.height + c.dist * Math.sin(c.pitch));
        look.copy(focus.p).addScaledVector(dir, c.look).addScaledVector(up, 0.9);
      }
    }
    cam.position.copy(pos);
    cam.up.copy(camUp);
    cam.lookAt(look);
    const fov = c.mode === "side" ? c.fov * 0.6 : c.fov + (c.speedFov ? clamp((focus.speed - 160) / 7, 0, 22) : 0);   // trackside is a longer lens
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = snap ? fov : cam.fov + (fov - cam.fov) * Math.min(1, dt * 6); cam.updateProjectionMatrix(); }
  }

  // ------------------------------------------------------------------ frame

  function setCar(car, s, steerVis, spin) {
    const T = R.THREE;
    V.m = V.m || new T.Matrix4(); V.x = V.x || new T.Vector3();
    V.x.crossVectors(s.u, s.f).normalize();                   // the model's +x is the car's left
    V.m.makeBasis(V.x, s.u, s.f); V.m.setPosition(s.p);
    car.group.matrix.copy(V.m); car.group.matrixWorldNeedsUpdate = true;
    for (const f of car.fronts) f.rotation.y = -s.steer * 0.42;
    for (const w of car.wheels) w.rotation.x = spin;
    car.tail.color.setHex(s.brake > 0.1 ? 0xff2a3a : 0x551018);
  }

  function trail(tr, A, t, s) {
    const T = R.THREE, pos = tr.mesh.geometry.attributes.position, col = tr.mesh.geometry.attributes.color;
    const o = V.o || (V.o = mk(T));
    for (let i = 0; i < tr.n; i++) {
      at(A, t - (i + 5) * 45, o, T);
      const half = 0.45;
      for (let side = 0; side < 2; side++) {
        const sg = side ? -1 : 1;
        pos.setXYZ(i * 2 + side, o.p.x + o.l.x * half * sg - o.u.x * 0.55, o.p.y + o.l.y * half * sg - o.u.y * 0.55 + 0.04, o.p.z + o.l.z * half * sg - o.u.z * 0.55);
        const fade = (1 - i / tr.n) * 0.55, v = clamp(o.speed / 500, 0.1, 1);
        col.setXYZ(i * 2 + side, tr.color.r * fade * (0.4 + v), tr.color.g * fade * (0.4 + v), tr.color.b * fade * (0.4 + v));
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
    setCar(gl.you, gl.cy, 0, R.spinY);
    setCar(gl.ghost, gl.cg, 0, R.spinG);
    gl.ghost.group.visible = R.show.ghost;
    gl.ty.mesh.visible = R.show.trails; gl.tg.mesh.visible = R.show.trails && R.show.ghost;
    gl.gates.forEach((g) => (g.visible = R.show.gates));
    if (R.show.trails) { trail(gl.ty, R.you, R.t, gl.cy); if (R.show.ghost) trail(gl.tg, R.ghost, R.t, gl.cg); }
    updateCamera(dt, snap);
    gl.renderer.render(gl.scene, gl.camera);
    drawHud();
    if (R.rec) compose();
    drawScrub();
    syncUi();
  }

  // ------------------------------------------------------------------ HUD (drawn on a 2D canvas over the 3D view)

  const mmss = (ms) => { ms = Math.max(0, Math.round(ms)); return `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`; };
  const sgn = (ms) => `${ms < 0 ? "-" : "+"}${mmss(Math.abs(ms))}`;

  function pill(c, x, y, w, h, bg, fg, text, font) {
    c.fillStyle = bg; c.fillRect(x, y, w, h);
    c.fillStyle = fg; c.font = font; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(text, x + w / 2, y + h / 2 + 1);
  }

  function drawInputs(c, x, y, v, label, color, mirror) {
    const w = 170, h = 96;
    c.fillStyle = "rgba(8,12,22,0.62)"; c.fillRect(x, y, w, h);
    c.fillStyle = color; c.fillRect(x, y, 3, h);
    c.textAlign = "left"; c.textBaseline = "alphabetic";
    c.fillStyle = "#b4bfd6"; c.font = `700 11px Barlow, sans-serif`; c.fillText(label, x + 12, y + 16);
    // wheel
    c.save(); c.translate(x + 44, y + 56); c.rotate(v.steer * WHEEL_RAD);
    c.strokeStyle = color; c.lineWidth = 5; c.beginPath(); c.arc(0, 0, 24, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 4; c.beginPath(); c.moveTo(-24, 0); c.lineTo(24, 0); c.moveTo(0, 0); c.lineTo(0, 24); c.stroke();
    c.fillStyle = "#ffc247"; c.fillRect(-3, -28, 6, 7); c.restore();
    // pedals
    const bar = (bx, val, col) => { c.fillStyle = "rgba(255,255,255,0.1)"; c.fillRect(bx, y + 24, 14, 62); c.fillStyle = col; const hh = 62 * clamp(val, 0, 1); c.fillRect(bx, y + 86 - hh, 14, hh); };
    bar(x + 84, v.brake, "#ff5a73"); bar(x + 102, v.gas, "#2fe3a2");
    c.fillStyle = "#eef2fb"; c.font = `700 30px "Barlow Condensed", "Arial Narrow", sans-serif`; c.textAlign = "right";
    c.fillText(String(Math.round(v.speed)), x + w - 8, y + 66);
    c.fillStyle = "#7d8aa6"; c.font = `600 10px Barlow, sans-serif`; c.fillText("km/h", x + w - 8, y + 80);
  }

  function tag(c, car, text, color, sub) {
    const v = R.THREE.Vector3 && (V.tag || (V.tag = new R.THREE.Vector3()));
    v.copy(car.p).addScaledVector(car.u, 2.4).project(gl.camera);
    if (v.z > 1 || v.z < -1) return;
    const W = c.canvas.clientWidth, H = c.canvas.clientHeight, x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
    if (x < 10 || x > W - 10 || y < 10 || y > H - 10) return;
    c.font = `700 13px Barlow, sans-serif`;
    const tw = Math.max(c.measureText(text).width, sub ? c.measureText(sub).width : 0) + 14;
    c.fillStyle = "rgba(8,12,22,0.7)"; c.fillRect(x - tw / 2, y - (sub ? 34 : 20), tw, sub ? 32 : 18);
    c.fillStyle = color; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(text, x, y - (sub ? 25 : 11));
    if (sub) { c.fillStyle = "#b4bfd6"; c.font = `600 11px Barlow, sans-serif`; c.fillText(sub, x, y - 9); }
    c.fillStyle = color; c.beginPath(); c.moveTo(x - 5, y + (sub ? -2 : 0)); c.lineTo(x + 5, y + (sub ? -2 : 0)); c.lineTo(x, y + 6); c.fill();
  }

  function drawHud() {
    const cv = gl.hud, w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const d = delta(R.t);
    // the game-style timer, top centre
    pill(c, w / 2 - 78, 12, 156, 32, "rgba(12,14,20,0.88)", "#fff", mmss(R.t), `700 22px "Barlow Condensed", "Arial Narrow", sans-serif`);
    pill(c, w / 2 - 78, 46, 156, 28, d > 0 ? "#d9363e" : "#2f6df0", "#fff", sgn(d), `700 19px "Barlow Condensed", "Arial Narrow", sans-serif`);
    // the checkpoint flash
    if (R.cps) {
      const win = 2500 * clamp(R.rate, 0.1, 1);
      const hit = [...R.cps].reverse().find((x) => R.t >= x.t && R.t < x.t + win);
      if (hit) {
        pill(c, w / 2 - 78, 80, 156, 26, "rgba(12,14,20,0.88)", "#ffc247", `${hit.name}  ${mmss(hit.t)}`, `700 16px "Barlow Condensed", sans-serif`);
        pill(c, w / 2 - 78, 108, 156, 28, hit.d > 0 ? "#d9363e" : "#2f6df0", "#fff", sgn(hit.d), `700 19px "Barlow Condensed", sans-serif`);
      }
    }
    // camera and speed badges
    c.textAlign = "left"; c.textBaseline = "alphabetic";
    const m = MODES.find((x) => x[0] === R.cam.mode);
    c.fillStyle = "rgba(8,12,22,0.62)"; c.fillRect(12, 12, 150, 24);
    c.fillStyle = "#eef2fb"; c.font = `700 13px Barlow, sans-serif`; c.fillText(`CAM  ${m ? m[1].toUpperCase() : ""}`, 22, 29);
    if (R.rate !== 1) {
      c.fillStyle = "rgba(255,194,71,0.9)"; c.fillRect(w - 112, 12, 100, 26);
      c.fillStyle = "#1a1304"; c.font = `800 15px Barlow, sans-serif`; c.textAlign = "center"; c.fillText(R.rate < 1 ? `SLOW ${R.rate}×` : `${R.rate}×`, w - 62, 30);
    }
    if (R.rec) { c.fillStyle = "#ff5a73"; c.beginPath(); c.arc(w - 130, 25, 6, 0, 7); c.fill(); }
    // names over the cars and the distance between them
    const gap = gl.cy.p.distanceTo(gl.cg.p);
    const rel = (V.rv || (V.rv = new R.THREE.Vector3())).copy(gl.cg.p).sub(gl.cy.p).dot(gl.cy.f);
    if (R.show.ghost) tag(c, gl.cg, "GHOST", "#7fa6ff", `${gap < 1 ? "level" : `${Math.round(gap)} m ${rel > 0 ? "ahead" : "behind"}`}`);
    if (R.cam.mode !== "hood" && R.cam.mode !== "chase") tag(c, gl.cy, "YOU", "#eef2fb");
    // wheels and pedals
    drawInputs(c, 12, h - 108, gl.cy, "YOU", "#eef2fb");
    if (R.show.ghost) drawInputs(c, w - 182, h - 108, gl.cg, "GHOST", "#5b8def");
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
    for (const x of R.cps || []) { c.fillStyle = "#ffc247"; c.fillRect(X(x.t) - 0.5, h - 10, 1.5, 10); }
    for (const [i, s] of R.shots.entries()) {                         // camera cuts
      c.fillStyle = i === R.shotIdx ? "#8f7bff" : "#5b6b92"; const x = X(s.t);
      c.beginPath(); c.moveTo(x - 5, 0); c.lineTo(x + 5, 0); c.lineTo(x, 9); c.fill();
    }
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

  function autoDirect() {
    const pts = R.primary.points, tAt = (d) => { let lo = 0, hi = pts.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].distance_m <= d) lo = m; else hi = m; } return pts[lo].t_ms; };
    const base = { ...DEFAULT_CAM }, out = [{ t: 0, ...pick(base, "chase"), rate: 1 }];
    const moments = [...(R.primary.corners || [])].filter((c) => Math.abs(c.time_change_ms) >= 15).sort((a, b) => Math.abs(b.time_change_ms) - Math.abs(a.time_change_ms)).slice(0, 4).sort((a, b) => a.distance_start - b.distance_start);
    const modes = ["side", "duel", "orbit", "duel"];
    moments.forEach((c, i) => {
      const t0 = Math.max(1500, tAt(c.distance_start) - 1600), t1 = tAt(c.distance_end) + 500;
      const mode = modes[i % modes.length];
      const last = out[out.length - 1];
      if (out.length > 1 && last.rate === 1 && t0 < last.t + 600) out.pop();          // cut straight from one moment to the next
      if (t0 > out[out.length - 1].t + 800) out.push({ t: t0, ...pick({ ...base, dist: 11, orbR: 12 }, mode), rate: 0.25 });
      out.push({ t: Math.max(t1, out[out.length - 1].t + 1500), ...pick(base, "chase"), rate: 1 });
    });
    R.shots = out;
    R.shotIdx = -1; R.cuts = true; const cb = R.root.querySelector(".rp-cuts"); if (cb) cb.checked = true; saveShots(); renderShots(); checkShots(true);
  }
  const pick = (cam, mode) => ({ mode, ...Object.fromEntries(SHOT_KEYS.filter((k) => k !== "mode").map((k) => [k, k === "fixed" ? null : k === "pinned" ? false : cam[k]])) });

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

  // ------------------------------------------------------------------ transport

  function cutsOff() { if (R.cuts && R.shots.length) { R.cuts = false; const c = R.root.querySelector(".rp-cuts"); if (c) c.checked = false; } }
  function seek(t) { R.t = clamp(t, 0, R.tEnd); R.shotIdx = -2; checkShots(true); render(0, true); }
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
      checkShots(false);
    }
    render(R.playing ? dt : 0, !R.playing);
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

  // ------------------------------------------------------------------ DOM

  function template() {
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
        <canvas class="rp-scrub" aria-label="Gap to the ghost over the lap. Click or drag to scrub."></canvas>
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
            <label class="tv-check"><input type="checkbox" class="rp-sfov" checked /> Wider view at speed</label>
            <label class="tv-check"><input type="checkbox" class="rp-ghostvis" checked /> Ghost</label>
            <label class="tv-check"><input type="checkbox" class="rp-trails" checked /> Trails</label>
            <label class="tv-check"><input type="checkbox" class="rp-gates" checked /> Checkpoints</label>
          </div>
          <button type="button" class="btn quiet rp-drop" title="Pin a trackside camera here so the cars drive past it">Pin a trackside camera here</button>
        </section>
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
    r.querySelectorAll(".rp-modes button").forEach((b) => b.addEventListener("click", () => { cutsOff(); R.cam.mode = b.dataset.m; if (b.dataset.m === "side") { R.cam.fixed = null; R.cam.pinned = false; } R.cam.yaw = 0; R.cam.pitch = 0; render(0, true); }));
    const bind = (cls, key, alt) => q(cls).addEventListener("input", (e) => { cutsOff(); R.cam[alt && (R.cam.mode === "orbit" || R.cam.mode === "top") ? alt : key] = +e.target.value; render(0, true); });
    bind(".rp-dist", "dist", "orbR"); bind(".rp-height", "height"); bind(".rp-fov", "fov"); bind(".rp-look", "look"); bind(".rp-smooth", "smooth");
    q(".rp-sfov").addEventListener("change", (e) => (R.cam.speedFov = e.target.checked));
    q(".rp-ghostvis").addEventListener("change", (e) => (R.show.ghost = e.target.checked));
    q(".rp-trails").addEventListener("change", (e) => (R.show.trails = e.target.checked));
    q(".rp-gates").addEventListener("change", (e) => (R.show.gates = e.target.checked));
    q(".rp-drop").addEventListener("click", () => { cutsOff(); R.cam.mode = "side"; R.cam.fixed = null; R.cam.pinned = true; render(0, true); });
    q(".rp-cuts").addEventListener("change", (e) => { R.cuts = e.target.checked; R.shotIdx = -2; checkShots(true); });
    q(".rp-addshot").addEventListener("click", addShot);
    q(".rp-auto").addEventListener("click", autoDirect);
    q(".rp-rec").addEventListener("click", () => (R.rec ? stopRecord() : startRecord()));
    q(".rp-photo").addEventListener("click", photo);
    q(".rp-fs").addEventListener("click", () => { const el = q(".rp-stage"); if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen(); });
    // the scrub bar
    const sc = q(".rp-scrub");
    let drag = false;
    const fromX = (ev) => { const b = sc.getBoundingClientRect(); seek(clamp((ev.clientX - b.left) / b.width, 0, 1) * R.tEnd); };
    sc.addEventListener("pointerdown", (ev) => { drag = true; sc.setPointerCapture(ev.pointerId); fromX(ev); });
    sc.addEventListener("pointermove", (ev) => drag && fromX(ev));
    sc.addEventListener("pointerup", () => (drag = false));
    // look around: drag the picture, scroll to zoom
    const st = q(".rp-stage");
    let look = null;
    st.addEventListener("pointerdown", (ev) => { look = { x: ev.clientX, y: ev.clientY }; st.setPointerCapture(ev.pointerId); });
    st.addEventListener("pointermove", (ev) => {
      if (!look) return;
      cutsOff();
      R.cam.yaw -= (ev.clientX - look.x) * 0.006; R.cam.pitch = clamp(R.cam.pitch + (ev.clientY - look.y) * 0.005, -0.5, 1.3);
      look = { x: ev.clientX, y: ev.clientY };
    });
    st.addEventListener("pointerup", () => (look = null));
    st.addEventListener("dblclick", () => { R.cam.yaw = 0; R.cam.pitch = 0; });
    st.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const f = Math.exp(ev.deltaY * 0.0012);
      if (R.cam.mode === "orbit" || R.cam.mode === "top") R.cam.orbR = clamp(R.cam.orbR * f, 3, 120); else R.cam.dist = clamp(R.cam.dist * f, 3, 60);
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
    else if (e.key === "[" || e.key === "]") {
      const rates = [0.05, 0.1, 0.25, 0.5, 1, 2], i = rates.indexOf(R.rate);
      setRate(rates[clamp((i < 0 ? 4 : i) + (e.key === "]" ? 1 : -1), 0, rates.length - 1)]);
    }
  });

  // ------------------------------------------------------------------ public

  async function ensure() {
    const root = document.getElementById("replay-body");
    if (!root) return;
    R.root = root;
    const primary = R.primary;
    if (!primary || !primary.points || primary.points.length < 4) { root.innerHTML = `<div class="hint">The replay needs two runs with driving data. Pick your run and a ghost first.</div>`; R.loaded = false; return; }
    if (typeof THREE === "undefined") { root.innerHTML = `<div class="hint">The 3D replay needs three.js, which loads from the internet. Check your connection and reload.</div>`; return; }
    R.THREE = THREE;
    const key = [state.subjectId, state.primaryRefId].join("|");
    if (R.loaded && R.key === key) { resize(); return; }
    if (R.loading) return;
    R.loading = true; R.loaded = false;
    stopRecord();
    root.innerHTML = template();
    wire();
    try {
      const runs = await Store.getRuns([state.subjectId, state.primaryRefId]);
      const me = runs.find((x) => x.id === state.subjectId), ref = runs.find((x) => x.id === state.primaryRefId);
      if (!me || !ref || !me.samples.length || !ref.samples.length) throw new Error("no driving data");
      R.you = prep(me.samples); R.ghost = prep(ref.samples);
      R.tEnd = Math.max(R.you.t[R.you.n - 1], 1);
      if (!gl.renderer || gl.renderer.domElement !== root.querySelector(".rp-gl")) {
        const canvas = root.querySelector(".rp-gl");
        gl.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
        gl.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      }
      gl.hud = root.querySelector(".rp-hud");
      gl.camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.3, 6000);
      buildWorld(R.primary);
      if (me.checkpoints && ref.checkpoints && me.checkpoints.length === ref.checkpoints.length) {
        R.cps = me.checkpoints.map((t, i) => ({ t, d: t - ref.checkpoints[i], name: i === me.checkpoints.length - 1 ? "Finish" : `CP ${i + 1}` }));
      } else R.cps = [];
      R.key = key; R.loaded = true; R.t = 0; R.playing = false; R.cam = { ...DEFAULT_CAM }; R.rate = 1; R.shotIdx = -1;
      loadShots();
      root.querySelector(".rp-loading").hidden = true;
      renderShots(); resize();
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
    state: () => ({ t: R.t, rate: R.rate, mode: R.cam.mode, loaded: R.loaded, shots: R.shots.length, clipBytes: R.lastClipBytes || 0, rec: !!R.rec }),
    // for checking: how well the car's recorded heading matches the way it actually moves
    probe() { const T = R.THREE, a = at(R.you, R.t, mk(T), T), b = at(R.you, R.t + 100, mk(T), T), mv = b.p.clone().sub(a.p).normalize(); return { dot: a.f.dot(mv), speed: a.speed, steer: a.steer, left: a.l.toArray() }; },
    api: { seek, play, pause, setRate, autoDirect, addShot, stepBy, cam: () => R.cam },
  };
})();

function renderReplay3D(primary) { Replay3D.render(primary); }
