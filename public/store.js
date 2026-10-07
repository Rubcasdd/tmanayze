// Browser-side storage for imported runs and coach notes.
//
// The server is stateless, so each visitor's runs live in their own browser
// (IndexedDB). Two object stores keep lists fast: `runmeta` holds a small
// summary per run, `runs` holds the full record including the telemetry
// samples, which are only loaded when a comparison needs them.
// If IndexedDB is unavailable (some private windows) it falls back to memory
// for the session.

const Store = (() => {
  const DB_NAME = "tm-analyzer";
  const mem = { runs: new Map(), meta: new Map(), memory: new Map() };
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!("indexedDB" in window)) return resolve(null);
      let req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch {
        return resolve(null);
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("runs", { keyPath: "id" });
        db.createObjectStore("runmeta", { keyPath: "id" }).createIndex("map_uid", "map_uid");
        db.createObjectStore("memory", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  const wrap = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  const done = (tx) =>
    new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("storage transaction aborted"));
    });

  function summarize(run) {
    const { samples, ...meta } = run;
    return { ...meta, num_samples: samples ? samples.length : 0 };
  }

  async function putRuns(runs) {
    const db = await open();
    if (!db) {
      runs.forEach((r) => {
        mem.runs.set(r.id, r);
        mem.meta.set(r.id, summarize(r));
      });
      return;
    }
    const tx = db.transaction(["runs", "runmeta"], "readwrite");
    runs.forEach((r) => {
      tx.objectStore("runs").put(r);
      tx.objectStore("runmeta").put(summarize(r));
    });
    await done(tx);
  }

  async function listRunSummaries(mapUid) {
    const db = await open();
    if (!db) return [...mem.meta.values()].filter((m) => m.map_uid === mapUid);
    return wrap(db.transaction("runmeta").objectStore("runmeta").index("map_uid").getAll(mapUid));
  }

  async function getRuns(ids) {
    const db = await open();
    if (!db) return ids.map((id) => mem.runs.get(id)).filter(Boolean);
    const store = db.transaction("runs").objectStore("runs");
    const found = await Promise.all(ids.map((id) => wrap(store.get(id))));
    return found.filter(Boolean);
  }

  async function hasRun(id) {
    const db = await open();
    if (!db) return mem.meta.has(id);
    return !!(await wrap(db.transaction("runmeta").objectStore("runmeta").getKey(id)));
  }

  async function deleteRun(id) {
    const db = await open();
    if (!db) {
      mem.runs.delete(id);
      mem.meta.delete(id);
      return;
    }
    const tx = db.transaction(["runs", "runmeta"], "readwrite");
    tx.objectStore("runs").delete(id);
    tx.objectStore("runmeta").delete(id);
    await done(tx);
  }

  async function listLibrary() {
    const db = await open();
    const all = db ? await wrap(db.transaction("runmeta").objectStore("runmeta").getAll()) : [...mem.meta.values()];
    const maps = new Map();
    for (const m of all) {
      const entry = maps.get(m.map_uid) || { map_uid: m.map_uid, map_name: null, count: 0 };
      entry.count += 1;
      entry.map_name = entry.map_name || m.map_name;
      maps.set(m.map_uid, entry);
    }
    return [...maps.values()].sort((a, b) => b.count - a.count);
  }

  // One entry per map with what the front page needs: how many of your own runs
  // and ghosts there are, your best time, and when something was last added.
  async function listMaps() {
    const db = await open();
    const all = db ? await wrap(db.transaction("runmeta").objectStore("runmeta").getAll()) : [...mem.meta.values()];
    const maps = new Map();
    for (const m of all) {
      const e = maps.get(m.map_uid) || {
        map_uid: m.map_uid, map_name: null, own: 0, refs: 0, best_own_ms: null, last_at: 0, telemetry: 0,
      };
      if (m.kind === "run") {
        e.own += 1;
        if (m.race_time_ms != null && (e.best_own_ms === null || m.race_time_ms < e.best_own_ms)) e.best_own_ms = m.race_time_ms;
      } else {
        e.refs += 1;
      }
      if (m.telemetry_available) e.telemetry += 1;
      e.map_name = e.map_name || m.map_name;
      e.last_at = Math.max(e.last_at, m.uploaded_at || 0);
      maps.set(m.map_uid, e);
    }
    return [...maps.values()];
  }

  async function getMemory(key) {
    const db = await open();
    if (!db) return mem.memory.get(key) || null;
    const row = await wrap(db.transaction("memory").objectStore("memory").get(key));
    return row ? row.value : null;
  }

  async function putMemory(key, value) {
    const db = await open();
    if (!db) return void mem.memory.set(key, value);
    const tx = db.transaction("memory", "readwrite");
    tx.objectStore("memory").put({ key, value });
    await done(tx);
  }

  async function deleteMemory(key) {
    const db = await open();
    if (!db) return void mem.memory.delete(key);
    const tx = db.transaction("memory", "readwrite");
    tx.objectStore("memory").delete(key);
    await done(tx);
  }

  async function clearAll() {
    mem.runs.clear();
    mem.meta.clear();
    mem.memory.clear();
    const db = await open();
    if (!db) return;
    const tx = db.transaction(["runs", "runmeta", "memory"], "readwrite");
    ["runs", "runmeta", "memory"].forEach((s) => tx.objectStore(s).clear());
    await done(tx);
  }

  return { putRuns, listRunSummaries, getRuns, hasRun, deleteRun, listLibrary, listMaps, getMemory, putMemory, deleteMemory, clearAll };
})();
