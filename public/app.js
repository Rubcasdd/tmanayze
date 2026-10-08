"use strict";

// ============================================================ state & helpers

const state = {
  health: null,
  player: null, // chosen driver profile
  maps: [], // library summaries for the front page
  map: null, // the map open on the map page
  mapToken: 0,
  runs: [],
  subjectId: null,
  againstIds: new Set(),
  primaryRefId: null,
  compare: null, // { key, data, ids }
  compareToken: 0,
  tab: "overview",
  highlight: null, // { from, to, title, section }
  charts: [], // charts on the page (lap + sections); destroyed on every re-render
  expandChart: null,
  board: null, // leaderboard paging state for the open map
  trackMap: null,
};

const GHOST_COLORS = ["#3987e5", "#d95926", "#d55181", "#c98500", "#199e70"];
const YOU = "#f0ede6";
const GAIN = "#3dd68c";
const LOSS = "#ff6252";
const GRID = "#2e2d2a";
const MUTED = "#8a867d";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  (s ?? "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Strips Trackmania's in-game text formatting ($FFF colours, $O/$I/$S, $L[..] links, $$ escape).
function tmName(s) {
  if (!s) return s;
  return s
    .replace(/\$[lh]\[[^\]]*\]/gi, "")
    .replace(/\$[0-9a-f]{3}/gi, "")
    .replace(/\$[lhoiswntgz<>]/gi, "")
    .replace(/\$\$/g, "$")
    .trim();
}

const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};

// 1:23.456 — the way the game shows times.
function fmtTime(ms) {
  if (ms === null || ms === undefined) return "–";
  const m = Math.floor(ms / 60000);
  const s = (ms - m * 60000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}
const fmtGap = (ms) => (ms === null || ms === undefined ? "–" : `${ms > 0 ? "+" : ms < 0 ? "−" : ""}${(Math.abs(ms) / 1000).toFixed(2)}s`);
const r0 = (v) => (v === null || v === undefined ? "–" : Math.round(v));
const r1 = (v) => (v === null || v === undefined ? "–" : (Math.round(v * 10) / 10).toFixed(1));
const r2 = (v) => (v === null || v === undefined ? "–" : (Math.round(v * 100) / 100).toFixed(2));
const gapClass = (ms) => (ms > 0 ? "bad" : ms < 0 ? "good" : "");
const shortStyle = (s) => ((s || "").startsWith("digital") ? "keyboard" : (s || "").startsWith("analog") ? "analog" : "–");
const signed = (v, digits = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;

function parseTime(text) {
  const t = (text || "").trim().replace(",", ".");
  if (/^\d{5,}$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^(?:(\d+):)?(\d+)(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const ms = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
  return ((parseInt(m[1] || "0", 10) * 60) + parseInt(m[2], 10)) * 1000 + ms;
}

async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  const code = LS.get("tm_access_code");
  if (code) headers.set("X-Access-Code", code);
  if (path === "/api/analyze") {
    const key = LS.get("tm_nim_key");
    if (key) headers.set("X-NIM-Key", key);
    const admin = LS.get("tm_admin_code");
    if (admin) headers.set("X-Admin-Code", admin);
  }
  let res;
  try {
    res = await fetch(path, { ...opts, headers });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection.");
  }
  if (!res.ok) {
    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* non-JSON error body */ }
    if (res.status === 401) openSettings();
    if (res.status === 413) detail = "That request was too large for the server (hosted deployments limit bodies to 4.5 MB).";
    throw new Error(detail);
  }
  return res.json();
}

function postJson(path, body) {
  const text = JSON.stringify(body);
  const limit = state.health && state.health.max_body_bytes;
  if (limit && text.length > limit * 0.95) {
    throw new Error(
      `Too much telemetry for one request (${(text.length / 1e6).toFixed(1)} MB; this server accepts ${(limit / 1e6).toFixed(1)} MB). Switch some ghosts off.`
    );
  }
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
}

function setStatus(el, text, kind = "") {
  el.className = `status ${kind}`.trim();
  el.textContent = text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ settings

function openSettings() {
  const dlg = $("#settings-dialog");
  if (!dlg.open) dlg.showModal();
}

function loadSettingsFields() {
  $("#nim-key-input").value = LS.get("tm_nim_key") || "";
  $("#access-code-input").value = LS.get("tm_access_code") || "";
  $("#admin-code-input").value = LS.get("tm_admin_code") || "";
}

async function loadHealth() {
  try {
    state.health = await (await fetch("/api/health")).json();
  } catch {
    state.health = null;
    return;
  }
  const h = state.health;
  let note = h.server_has_ai_key
    ? "This server has an NVIDIA key, so the coach works without your own."
    : "This server has no NVIDIA key. Paste your own below to use the coach (get one at build.nvidia.com).";
  const lim = h.ai_limits || {};
  if (h.server_has_ai_key && (lim.per_hour || lim.per_day)) {
    const parts = [];
    if (lim.per_hour) parts.push(`${lim.per_hour} per hour`);
    if (lim.per_day) parts.push(`${lim.per_day} per day`);
    note += ` Free reports are limited to ${parts.join(" and ")} per visitor; your own key has no limit.`;
  }
  $("#settings-server-note").textContent = note;
  $("#access-code-field").hidden = !h.access_code_required;
  $("#admin-code-field").hidden = !h.admin_code_supported;
  if (h.access_code_required && !LS.get("tm_access_code")) openSettings();

  const select = $("#depth-select");
  const saved = LS.get("tm_depth");
  select.innerHTML = (h.depths || [{ id: "detailed", label: "Detailed" }])
    .map((d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`)
    .join("");
  select.value = [...select.options].some((o) => o.value === saved) ? saved : h.default_depth || "detailed";
}

// ============================================================ router

function route() {
  const hash = location.hash || "#/";
  const m = hash.match(/^#\/map\/([A-Za-z0-9_-]{20,40})/);
  closeExpand();
  if (m) {
    showView("map");
    openMap(m[1]);
  } else {
    showView("home");
    renderHome();
    const pending = LS.get("tm_search_name");
    if (pending) {
      LS.del("tm_search_name");
      searchPlayers(pending);
    }
  }
  window.scrollTo(0, 0);
}

function showView(name) {
  $("#view-home").hidden = name !== "home";
  $("#view-map").hidden = name !== "map";
  $("#nav-maps").classList.toggle("on", name === "home");
  $("#crumb").hidden = name !== "map";
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ============================================================ map info (names + thumbnails)

const infoCache = new Map();
const INFO_LS = "tm_mapinfo_v1";
let infoStore = {};
try { infoStore = JSON.parse(LS.get(INFO_LS) || "{}") || {}; } catch { infoStore = {}; }
let infoQueue = Promise.resolve();

function cachedInfo(uid) {
  return infoCache.get(uid) || infoStore[uid] || null;
}

// Looked up one-by-one and remembered, so the front page doesn't hammer ManiaExchange.
function fetchMapInfo(uid) {
  const known = cachedInfo(uid);
  if (known) return Promise.resolve(known.missing ? null : known);
  const job = infoQueue.then(async () => {
    try {
      const info = await api(`/api/mx/map-info/${encodeURIComponent(uid)}`);
      info.name = tmName(info.name);
      infoCache.set(uid, info);
      infoStore[uid] = { name: info.name, thumbnail_url: info.thumbnail_url, authors: info.authors, tags: info.tags, difficulty: info.difficulty };
      const keys = Object.keys(infoStore);
      if (keys.length > 600) delete infoStore[keys[0]];
      LS.set(INFO_LS, JSON.stringify(infoStore));
      return info;
    } catch {
      infoCache.set(uid, { missing: true });
      return null;
    }
  });
  infoQueue = job.then(() => sleep(120));
  return job;
}

// ============================================================ front page

const mapDisplayName = (m) => (cachedInfo(m.map_uid) && cachedInfo(m.map_uid).name) || tmName(m.map_name) || `Map ${m.map_uid.slice(0, 6)}`;

function mapCard(m) {
  const info = cachedInfo(m.map_uid);
  const thumb = info && info.thumbnail_url ? `style="background-image:url('${esc(info.thumbnail_url)}')"` : "";
  const by = info && info.authors ? `by ${esc(info.authors.map(tmName).join(", "))}` : "";
  const bits = [];
  if (m.own) bits.push(`${m.own} run${m.own === 1 ? "" : "s"}`);
  if (m.refs) bits.push(`${m.refs} ghost${m.refs === 1 ? "" : "s"}`);
  return `<a class="map-card-link" href="#/map/${esc(m.map_uid)}" data-uid="${esc(m.map_uid)}">
    <div class="mc-img ${thumb ? "" : "empty"}" ${thumb}></div>
    <div class="mc-body">
      <div class="mc-name">${esc(mapDisplayName(m))}</div>
      <div class="mc-by">${by}</div>
      <div class="mc-stats">
        <span class="mc-time">${m.best_own_ms != null ? fmtTime(m.best_own_ms) : "–"}</span>
        <span class="mc-sub">${esc(bits.join(" · "))}</span>
      </div>
    </div></a>`;
}

function hydrateCards() {
  $$(".map-card-link[data-uid]").forEach((card) => {
    const uid = card.dataset.uid;
    if (card.dataset.hydrated === "1" && cachedInfo(uid)) return;
    fetchMapInfo(uid).then((info) => {
      if (!info || !card.isConnected) return;
      card.dataset.hydrated = "1";
      const img = $(".mc-img", card);
      if (info.thumbnail_url) {
        img.style.backgroundImage = `url('${info.thumbnail_url}')`;
        img.classList.remove("empty");
      }
      $(".mc-name", card).textContent = info.name || $(".mc-name", card).textContent;
      $(".mc-by", card).textContent = info.authors && info.authors.length ? `by ${info.authors.map(tmName).join(", ")}` : "";
    });
  });
}

async function renderHome() {
  state.maps = await Store.listMaps();
  const finished = state.maps.filter((m) => m.best_own_ms != null);
  const studying = state.maps.filter((m) => m.best_own_ms == null);
  const totalOwn = state.maps.reduce((n, m) => n + m.own, 0);

  $("#home-summary").textContent = finished.length
    ? `${finished.length} map${finished.length === 1 ? "" : "s"} finished · ${totalOwn} run${totalOwn === 1 ? "" : "s"} saved in this browser. Pick one to see where you lose time.`
    : "Maps you've finished, built from the replays you add.";
  $("#library-toolbar").hidden = !finished.length;

  const q = $("#library-filter").value.trim().toLowerCase();
  const sort = $("#library-sort").value;
  const byName = (a, b) => mapDisplayName(a).localeCompare(mapDisplayName(b));
  const sorter = sort === "name" ? byName : sort === "runs" ? (a, b) => b.own - a.own || byName(a, b) : (a, b) => b.last_at - a.last_at;
  const visible = finished.filter((m) => !q || mapDisplayName(m).toLowerCase().includes(q)).sort(sorter);

  const grid = $("#finished-grid");
  if (!finished.length) {
    grid.innerHTML = `<div class="empty-state">
      <h3>No finished maps yet</h3>
      <p>The public Trackmania API doesn't list a player's own finished maps, so they come from your replay files. In the game, every personal best is saved automatically.</p>
      <ol>
        <li>Open <code>Documents\\Trackmania\\Replays\\Autosaves</code> on your computer.</li>
        <li>Use <b>Add a folder</b> above (or drag that folder onto this page).</li>
        <li>Each map you've finished appears here with your best time.</li>
      </ol></div>`;
  } else if (!visible.length) {
    grid.innerHTML = `<div class="empty-state">No map matches “${esc(q)}”.</div>`;
  } else {
    grid.innerHTML = visible.map(mapCard).join("");
  }

  $("#studying-block").hidden = !studying.length;
  $("#studying-grid").innerHTML = studying.sort(byName).map(mapCard).join("");
  hydrateCards();
}

// ---- importing many replays at once

async function collectDropped(dt) {
  const entries = [...(dt.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

let importing = false;

async function importFiles(fileList, kind) {
  if (importing) return;
  const files = [...fileList].filter((f) => /\.gbx$/i.test(f.name));
  const report = $("#import-report");
  const prog = $("#import-progress");
  if (!files.length) {
    report.hidden = false;
    report.textContent = "No .Gbx replay files found in what you chose.";
    return;
  }
  importing = true;
  report.hidden = true;
  prog.hidden = false;
  let done = 0, ok = 0, timeOnly = 0;
  const failed = [];
  const newMaps = new Set();
  const known = new Set((await Store.listMaps()).map((m) => m.map_uid));

  const update = () => {
    $("#import-bar").style.width = `${(done / files.length) * 100}%`;
    $("#import-text").textContent = `Reading replays ${done} / ${files.length}`;
  };
  update();

  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      try {
        const run = await api("/api/runs", { method: "POST", body: fd });
        await Store.putRuns([run]);
        ok++;
        if (!run.telemetry_available) timeOnly++;
        if (!known.has(run.map_uid)) newMaps.add(run.map_uid);
      } catch (err) {
        failed.push({ name: file.name, msg: err.message });
        if (/access code|unauthor/i.test(err.message)) next = files.length; // no point continuing
      }
      done++;
      update();
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  prog.hidden = true;
  importing = false;
  report.hidden = false;
  const reasons = {};
  failed.forEach((f) => (reasons[f.msg.replace(/'[^']*'/g, "…")] = (reasons[f.msg.replace(/'[^']*'/g, "…")] || 0) + 1));
  report.innerHTML =
    `<span class="${ok ? "ok" : ""}">Added ${ok} replay${ok === 1 ? "" : "s"}${newMaps.size ? `, ${newMaps.size} new map${newMaps.size === 1 ? "" : "s"}` : ""}.</span>` +
    (timeOnly ? ` ${timeOnly} had no telemetry (finish time only).` : "") +
    (failed.length
      ? ` ${failed.length} couldn't be read.<ul>${Object.entries(reasons).slice(0, 4).map(([m, n]) => `<li>${n} × ${esc(m)}</li>`).join("")}</ul>`
      : "");
  await renderHome();
}

// ---- driver lookup

async function searchPlayers(name) {
  const q = (name ?? $("#player-search-input").value).trim();
  if (!q) return;
  $("#player-search-input").value = q;
  const box = $("#player-results");
  box.hidden = false;
  box.innerHTML = `<div class="hint">Searching…</div>`;
  try {
    const results = await api(`/api/tmio/players/search?name=${encodeURIComponent(q)}`);
    if (!results.length) {
      box.innerHTML = `<div class="hint">No players found.</div>`;
      return;
    }
    box.innerHTML = results
      .slice(0, 8)
      .map((p) => `<div class="pick-row" data-id="${esc(p.account_id)}"><b>${esc(tmName(p.name))}</b><span class="hint">${esc(p.zone_name || "")}</span></div>`)
      .join("");
    $$(".pick-row", box).forEach((row) => row.addEventListener("click", () => selectPlayer(row.dataset.id)));
  } catch (err) {
    box.innerHTML = `<div class="hint">${esc(err.message)}</div>`;
  }
}

async function selectPlayer(accountId) {
  $("#player-results").hidden = true;
  const el = $("#player-profile");
  el.hidden = false;
  el.innerHTML = `<div class="hint">Loading profile…</div>`;
  try {
    const p = await api(`/api/tmio/players/${encodeURIComponent(accountId)}`);
    state.player = p;
    LS.set("tm_player", JSON.stringify({ account_id: p.account_id }));
    renderPlayerProfile(p);
    if (state.map && !$("#view-map").hidden) {
      renderBoardRows();
      renderRunsList();
    }
  } catch (err) {
    el.innerHTML = `<div class="hint">${esc(err.message)}</div>`;
  }
}

function renderPlayerProfile(p) {
  const maxRank = Math.max(1, ...p.zones.map((z) => z.rank || 1));
  $("#player-profile").innerHTML = `
    <div class="profile-name">${esc(tmName(p.name))}</div>
    <div class="profile-sub">${p.club_tag && tmName(p.club_tag) ? esc(tmName(p.club_tag)) + " · " : ""}${(p.trophy_points || 0).toLocaleString()} trophy points</div>
    <div class="zone-ladder">
      ${p.zones
        .map((z) => {
          const pct = z.rank ? Math.max(3, 100 - Math.min(100, (z.rank / maxRank) * 100)) : 0;
          return `<div class="zone-row"><span class="zone-name">${esc(z.name || "")}</span>
            <span class="zone-bar"><span style="width:${pct}%"></span></span>
            <span class="zone-rank">${z.rank ? "#" + z.rank.toLocaleString() : "–"}</span></div>`;
        })
        .join("")}
    </div>`;
}

// A clickable player name: sets you as that driver when we know the account id
// (leaderboard rows); replays only carry a nickname, so those search by name.
function playerLink(name, accountId) {
  const clean = tmName(name) || "?";
  return accountId
    ? `<span class="player-link" data-account-id="${esc(accountId)}" title="Use as me">${esc(clean)}</span>`
    : `<span class="player-link" data-name="${esc(clean)}">${esc(clean)}</span>`;
}

document.addEventListener("click", (e) => {
  const el = e.target.closest(".player-link");
  if (!el) return;
  if (el.dataset.accountId) {
    selectPlayer(el.dataset.accountId);
    if ($("#view-map").hidden) $("#driver-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (el.dataset.name) {
    if (!$("#view-map").hidden) {
      LS.set("tm_search_name", el.dataset.name);
      location.hash = "#/";
    } else {
      searchPlayers(el.dataset.name);
    }
  }
});

const samePlayer = (name) => !!state.player && tmName(name || "").toLowerCase() === tmName(state.player.name || "").toLowerCase();

// ---- finding any map

async function searchMaps() {
  const q = $("#map-search-input").value.trim();
  const box = $("#map-results");
  box.innerHTML = `<div class="hint">Searching…</div>`;
  try {
    const results = await api(`/api/mx/search?name=${encodeURIComponent(q)}&count=12`);
    if (!results.length) {
      box.innerHTML = `<div class="hint">No maps found.</div>`;
      return;
    }
    const backup = results.some((m) => m.fallback);
    const note = backup
      ? `<div class="hint" style="margin-bottom:6px">ManiaExchange isn't responding, so this shows recent Tracks of the Day${q ? ` matching “${esc(q)}”` : ""} from trackmania.io.</div>`
      : "";
    box.innerHTML = note + results
      .map(
        (m) => `<a class="result-row" href="#/map/${esc(m.map_uid)}">
          <img src="${esc(m.thumbnail_url)}" loading="lazy" alt="" />
          <span><div class="rr-name">${esc(m.name)}</div><div class="rr-by">${esc((m.authors || []).map(tmName).join(", "))}${m.totd ? ` · TOTD ${esc(m.totd)}` : ""}</div></span></a>`
      )
      .join("");
    results.forEach((m) => {
      if (m.map_uid && !infoCache.has(m.map_uid)) {
        infoCache.set(m.map_uid, { name: m.name, thumbnail_url: m.thumbnail_url, authors: m.authors, tags: m.tags, difficulty: m.difficulty });
      }
    });
  } catch (err) {
    box.innerHTML = `<div class="hint">${esc(err.message)}</div>`;
  }
}

// ============================================================ map page

async function openMap(mapUid) {
  const token = ++state.mapToken;
  const switched = !state.map || state.map.map_uid !== mapUid;
  if (switched) {
    state.subjectId = null;
    state.againstIds = new Set();
    state.compare = null;
    state.runs = [];
    state.highlight = null;
    state.board = null;
    state.tab = "overview";
    destroyCharts();
    $("#analyze-report").innerHTML = "";
    setStatus($("#analyze-status"), "");
    $("#quota-note").hidden = true;
    $("#board-tbody").innerHTML = "";
    $("#leaderboard-list").innerHTML = "";
    $("#mx-list").innerHTML = "";
  }

  const lib = (await Store.listMaps()).find((m) => m.map_uid === mapUid);
  const quickName = (cachedInfo(mapUid) && cachedInfo(mapUid).name) || tmName(lib && lib.map_name) || "Map";
  $("#map-title").textContent = quickName;
  $("#crumb").textContent = quickName;
  document.title = `${quickName} · Trackmania Analyzer`;
  renderMapMeta(cachedInfo(mapUid) && !cachedInfo(mapUid).missing ? cachedInfo(mapUid) : null, mapUid);

  let detail;
  try {
    detail = await api(`/api/mx/maps/${encodeURIComponent(mapUid)}`);
  } catch {
    detail = { map_uid: mapUid, name: quickName, thumbnail_url: "", tags: [], authors: [], difficulty: null, award_count: null, replays: [], notOnMx: true };
  }
  if (token !== state.mapToken) return;
  detail.name = tmName(detail.name) || quickName; // trackmania.io names carry in-game colour codes
  state.map = detail;
  infoCache.set(mapUid, { name: detail.name, thumbnail_url: detail.thumbnail_url, authors: detail.authors, tags: detail.tags, difficulty: detail.difficulty });

  $("#map-title").textContent = detail.name;
  $("#crumb").textContent = detail.name;
  document.title = `${detail.name} · Trackmania Analyzer`;
  renderMapMeta(detail, mapUid);
  renderMxReplays(detail.replays || []);
  setTab(state.tab);

  await Promise.all([loadRuns(), ensureBoardPage(0)]);
}

function renderMapMeta(detail, uid) {
  const thumb = $("#map-thumb");
  thumb.hidden = !(detail && detail.thumbnail_url);
  if (detail && detail.thumbnail_url) thumb.src = detail.thumbnail_url;
  const bits = [];
  if (detail && detail.authors && detail.authors.length) bits.push(`by ${esc(detail.authors.map(tmName).join(", "))}`);
  if (detail && detail.award_count != null && !detail.notOnMx) bits.push(`${detail.award_count} awards`);
  if (detail && detail.mx_unavailable) bits.push("ManiaExchange isn't responding, so these details come from trackmania.io");
  else if (detail && (detail.notOnMx || detail.not_on_mx)) bits.push("not on ManiaExchange");
  const tags = ((detail && detail.tags) || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  $("#map-meta").innerHTML = bits.map((b) => `<span>${b}</span>`).join("") + tags;
  renderMapKpis();
}

function bestOwn() {
  const own = state.runs.filter((r) => r.kind === "run" && r.race_time_ms != null);
  return own.length ? Math.min(...own.map((r) => r.race_time_ms)) : null;
}

function renderMapKpis() {
  const best = bestOwn();
  const first = state.board && state.board.pages && state.board.pages[0];
  const wr = first && first.entries.length ? first.entries[0].time_ms : null;
  const items = [];
  const author = state.map && state.map.medals && state.map.medals.author;
  items.push(["Your best", best != null ? fmtTime(best) : "–"]);
  if (author) items.push(["Author medal", fmtTime(author)]);
  if (wr != null) items.push(["World #1", fmtTime(wr)]);
  if (wr != null && best != null) items.push(["Behind #1", `${fmtGap(best - wr)} · ${(((best - wr) / wr) * 100).toFixed(2)}%`]);
  if (state.board && state.board.total) items.push(["Players", state.board.total.toLocaleString()]);
  $("#map-kpis").innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
}

// ---- tabs

function setTab(name) {
  state.tab = name;
  $$(".ws-bar .tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== name));
  if (name === "board") ensureBoardPage(state.board && state.board.offset ? state.board.offset : 0);
  if (name === "overview" && state.trackMap) requestAnimationFrame(drawTrackMap);
}

function updateTabAvailability() {
  const has = !!state.compare;
  ["sections", "corners", "coach"].forEach((t) => {
    const b = $(`.ws-bar .tab[data-tab="${t}"]`);
    b.disabled = !has;
  });
  if (!has && ["sections", "corners", "coach"].includes(state.tab)) setTab("overview");
}

// ---- adding ghosts

function kindSelect(isYou) {
  return `<select class="kind-pick" aria-label="Import as">
      <option value="reference"${isYou ? "" : " selected"}>ghost</option>
      <option value="run"${isYou ? " selected" : ""}>my run</option></select>`;
}

async function importInto(btn, path, formData) {
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    const run = await api(path, { method: "POST", body: formData });
    await Store.putRuns([run]);
    btn.textContent = run.telemetry_available ? "Added ✓" : "Added (time only)";
    await loadRuns();
  } catch (err) {
    btn.textContent = "Failed";
    btn.title = err.message;
    btn.disabled = false;
  }
}

function renderMxReplays(replays) {
  const box = $("#mx-list");
  if (!replays.length) {
    const down = state.map && state.map.mx_unavailable;
    box.innerHTML = `<div class="hint">${down
      ? "ManiaExchange isn't responding right now, so community replays can't be listed. Reload in a minute."
      : "No community replays on ManiaExchange for this map."}</div>`;
    return;
  }
  box.innerHTML = replays
    .map(
      (r) => `<div class="board-row" style="grid-template-columns:1fr auto auto">
        <span class="who">${playerLink(r.player_name)}</span><span class="t">${fmtTime(r.time_ms)}</span>
        <span>${r.has_file ? `${kindSelect(samePlayer(r.player_name))} <button type="button" class="btn tiny" data-replay-id="${r.replay_id}">Add</button>` : `<span class="hint">no file</span>`}</span></div>`
    )
    .join("");
  $$("button[data-replay-id]", box).forEach((btn) =>
    btn.addEventListener("click", () => {
      const fd = new FormData();
      fd.append("map_uid", state.map.map_uid);
      fd.append("mx_replay_id", btn.dataset.replayId);
      fd.append("kind", $(".kind-pick", btn.parentElement).value);
      importInto(btn, "/api/mx/import-replay", fd);
    })
  );
}

function addGhostFromBoard(btn) {
  const fd = new FormData();
  fd.append("map_uid", state.map.map_uid);
  fd.append("ghost_ref", btn.dataset.ghostRef);
  fd.append("kind", $(".kind-pick", btn.parentElement).value);
  fd.append("player_nickname", btn.dataset.name);
  fd.append("race_time_ms", btn.dataset.time);
  fd.append("world_position", btn.dataset.pos);
  importInto(btn, "/api/tmio/import-ghost", fd);
}

async function handleUpload() {
  const files = $("#file-input").files;
  const kind = $("#upload-kind").value;
  const statusEl = $("#upload-status");
  if (!files.length) return setStatus(statusEl, "Choose a .Gbx file first.", "error");
  setStatus(statusEl, `Uploading ${files.length} file(s)…`);
  let ok = 0;
  const problems = [];
  let lastMap = null;
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("kind", kind);
    try {
      const run = await api("/api/runs", { method: "POST", body: fd });
      await Store.putRuns([run]);
      lastMap = run.map_uid;
      ok++;
      if (!run.telemetry_available) problems.push(`${file.name}: no telemetry (time only)`);
    } catch (err) {
      problems.push(`${file.name}: ${err.message}`);
    }
  }
  $("#file-input").value = "";
  setStatus(statusEl, `${ok} uploaded${problems.length ? ` — ${problems.join("; ")}` : "."}`, problems.length && !ok ? "error" : "ok");
  if (lastMap && state.map && lastMap !== state.map.map_uid) location.hash = `#/map/${lastMap}`;
  else await loadRuns();
}

// ============================================================ runs list & selection

async function loadRuns() {
  if (!state.map) return;
  const list = await Store.listRunSummaries(state.map.map_uid);
  list.sort((a, b) => (a.race_time_ms ?? Infinity) - (b.race_time_ms ?? Infinity));
  const timed = list.filter((r) => r.race_time_ms != null);
  const bestRun = timed.find((r) => r.kind === "run");
  const bestRef = timed.find((r) => r.kind === "reference");
  list.forEach((r) => {
    r.is_best_run = !!bestRun && r.id === bestRun.id;
    r.is_best_reference = !!bestRef && r.id === bestRef.id;
  });
  state.runs = list;
  autoSelect();
  renderRunsList();
  renderMapKpis();
  await maybeLoadComparison();
}

// Sensible defaults so "your run vs the ghost" is one click: your best run with
// telemetry as the subject, the fastest ghost with telemetry as the reference.
function autoSelect() {
  const ids = new Set(state.runs.map((r) => r.id));
  if (state.subjectId && !ids.has(state.subjectId)) state.subjectId = null;
  state.againstIds = new Set([...state.againstIds].filter((id) => ids.has(id) && id !== state.subjectId));
  const usable = state.runs.filter((r) => r.telemetry_available);
  if (!state.subjectId) {
    const mine = usable.find((r) => r.kind === "run");
    if (mine) state.subjectId = mine.id;
  }
  if (state.againstIds.size === 0) {
    const ghost = usable.find((r) => r.kind === "reference" && r.id !== state.subjectId);
    if (ghost) state.againstIds.add(ghost.id);
  }
}

function runLabel(id) {
  const r = state.runs.find((x) => x.id === id);
  return r ? tmName(r.player_nickname) || r.source_filename || id : id;
}

const sortedGhostIds = () => [...state.againstIds].sort();
function ghostColor(id) {
  const i = sortedGhostIds().indexOf(id);
  return GHOST_COLORS[(i < 0 ? 0 : i) % GHOST_COLORS.length];
}

function renderRunsList() {
  const box = $("#runs-list");
  refreshMemoryNote();
  if (!state.runs.length) {
    box.innerHTML = `<div class="hint">No runs yet. Add a ghost from the tabs below, or upload your own replay.</div>`;
    return;
  }
  const best = bestOwn();
  box.innerHTML = state.runs
    .map((r) => {
      const flags = [];
      if (r.is_best_run) flags.push("your best");
      if (r.is_best_reference) flags.push("fastest ghost");
      if (r.world_position) flags.push(`world #${r.world_position}`);
      if (!r.telemetry_available) flags.push("time only");
      const off = !r.telemetry_available;
      const you = state.subjectId === r.id;
      const ghost = state.againstIds.has(r.id);
      const gap = best != null && r.race_time_ms != null && r.id !== state.subjectId ? ` <span class="hint">${fmtGap(r.race_time_ms - best)}</span>` : "";
      return `<div class="run-row ${off ? "dim" : ""}">
        <span class="run-name">${playerLink(r.player_nickname)}</span>
        <span class="run-time">${fmtTime(r.race_time_ms)}</span>
        <span class="run-sub">${esc(r.kind === "run" ? "run" : "ghost")} · ${esc(r.source)}${flags.length ? " · " + esc(flags.join(", ")) : ""}${gap}</span>
        <span class="run-actions">
          <button type="button" class="pill you ${you ? "on" : ""}" data-role="subject" data-id="${r.id}" ${off ? 'title="No telemetry: finish times only"' : ""}>You</button>
          <button type="button" class="pill ghost ${ghost ? "on" : ""}" style="--c:${ghost ? ghostColor(r.id) : GHOST_COLORS[0]}" data-role="against" data-id="${r.id}">Ghost</button>
          <button type="button" class="pill del" data-role="delete" data-id="${r.id}" title="Remove from this browser" aria-label="Remove">✕</button>
        </span></div>`;
    })
    .join("");

  $$("button[data-role]", box).forEach((btn) =>
    btn.addEventListener("click", async () => {
      const { id, role } = btn.dataset;
      if (role === "subject") {
        state.subjectId = state.subjectId === id ? null : id;
        state.againstIds.delete(id);
      } else if (role === "against") {
        if (id === state.subjectId) return;
        state.againstIds.has(id) ? state.againstIds.delete(id) : state.againstIds.add(id);
      } else if (role === "delete") {
        if (!confirm("Remove this run from your browser?")) return;
        await Store.deleteRun(id);
        if (state.subjectId === id) state.subjectId = null;
        state.againstIds.delete(id);
        await loadRuns();
        return;
      }
      renderRunsList();
      maybeLoadComparison();
    })
  );
}

// ============================================================ comparing

function showEmptyWorkspace() {
  const empty = $("#ws-empty");
  $("#overview-body").hidden = true;
  empty.hidden = false;
  const hasRuns = state.runs.length > 0;
  const hasTelemetry = state.runs.some((r) => r.telemetry_available);
  if (!hasRuns) {
    empty.innerHTML = `<h2>Nothing to compare yet</h2>
      <p>Add a ghost from the panel on the left (the world's top times are in <b>World top</b>), and add your own run under <b>Upload</b> or by adding your replays folder on the front page.</p>`;
  } else if (!hasTelemetry) {
    empty.innerHTML = `<h2>No telemetry in these runs</h2><p>Time-only runs can't be charted. Import a replay (<code>.Replay.Gbx</code>) or a ghost that includes driving data.</p>`;
  } else if (!state.subjectId) {
    empty.innerHTML = `<h2>Choose your run</h2><p>Press <b>You</b> next to your run in the list, then switch <b>Ghost</b> on for the run you want to race.</p>`;
  } else {
    empty.innerHTML = `<h2>Choose a ghost</h2><p>Switch <b>Ghost</b> on for one or more runs in the list. They are all drawn over yours.</p>`;
  }
}

async function maybeLoadComparison() {
  if (!state.subjectId || state.againstIds.size === 0) {
    state.compare = null;
    destroyCharts();
    $("#ws-vs").textContent = "";
    updateTabAvailability();
    showEmptyWorkspace();
    return;
  }
  const ids = sortedGhostIds();
  const key = [state.subjectId, ...ids].join("|");
  if (state.compare && state.compare.key === key) return;

  const token = ++state.compareToken;
  $("#ws-empty").hidden = true;
  $("#overview-body").hidden = false;
  $("#stats-row").innerHTML = `<div class="stat"><div class="label">Comparing…</div></div>`;
  $("#alignment-warning").hidden = true;

  try {
    const runs = await Store.getRuns([state.subjectId, ...ids]);
    const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
    const strip = (r) => ({
      id: r.id, map_uid: r.map_uid, map_name: r.map_name, player_nickname: r.player_nickname,
      race_time_ms: r.race_time_ms, samples: r.samples || [],
    });
    const subject = byId[state.subjectId];
    const refs = ids.map((id) => byId[id]).filter(Boolean);
    const data = await postJson("/api/compare", { subject: strip(subject), references: refs.map(strip) });
    if (token !== state.compareToken) return;
    state.compare = { key, data, ids: refs.map((r) => r.id) };
    state.highlight = null;
    renderComparison();
  } catch (err) {
    if (token !== state.compareToken) return;
    state.compare = null;
    updateTabAvailability();
    $("#stats-row").innerHTML = `<div class="stat"><div class="label">Can't compare</div><div class="sub" style="font-size:14px;color:var(--ink-2)">${esc(err.message)}</div></div>`;
    destroyCharts();
  }
}

function pickPrimary(data, ids) {
  // The ghost closest in finish time is the most relevant single reference; it
  // drives the focus cards, section list, corner table and the coach briefing.
  const candidates = ids.filter((id) => data[id] && data[id].stats.telemetry);
  const pool = candidates.length ? candidates : ids;
  return pool.reduce((best, id) => {
    const d = data[id].stats.final_delta_ms;
    const bd = data[best].stats.final_delta_ms;
    return d != null && (bd == null || Math.abs(d) < Math.abs(bd)) ? id : best;
  }, pool[0]);
}

function renderComparison() {
  const { data, ids } = state.compare;
  state.primaryRefId = pickPrimary(data, ids);
  const primary = data[state.primaryRefId];
  updateTabAvailability();

  $("#ws-vs").innerHTML = `<b>${esc(runLabel(state.subjectId))}</b> vs ${ids.map((id) => esc(runLabel(id))).join(", ")}`;

  const warn = $("#alignment-warning");
  if (primary.stats.alignment_poor) {
    warn.hidden = false;
    warn.textContent =
      `These two runs don't follow the same route (the ghost's path is ${primary.stats.path_length_ratio}× the length of yours; ` +
      `typical distance between matched points ${primary.stats.alignment_median_m} m). That usually means a different version of the map or a big detour, ` +
      `so section and corner numbers may be misleading.`;
  } else {
    warn.hidden = true;
  }

  renderStats(data, ids);
  renderFocus(primary);
  const chartable = ids.filter((id) => data[id].stats.telemetry);
  $("#chart-empty-note").hidden = chartable.length > 0;
  $("#lap-area").hidden = chartable.length === 0;
  destroyCharts();
  if (chartable.length) {
    renderLap(data, chartable);
    renderSections(data, chartable);
    renderCorners(data);
  } else {
    $("#sections-grid").innerHTML = "";
    $("#corner-tbody").innerHTML = "";
  }
  renderHighlightChip();
}

function renderStats(data, ids) {
  const tile = (label, value, cls = "", sub = "") =>
    `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;

  if (ids.length === 1) {
    const s = data[ids[0]].stats;
    if (!s.telemetry) {
      $("#stats-row").innerHTML =
        tile("Gap", fmtGap(s.final_delta_ms), gapClass(s.final_delta_ms)) +
        tile("Your time", fmtTime(s.subject_race_time_ms)) +
        tile("Ghost time", fmtTime(s.reference_race_time_ms)) +
        tile("Note", `<span style="font:400 14px var(--font-body);color:var(--ink-2)">No driving data for one of these runs, so it's a finish-time comparison only.</span>`);
      return;
    }
    $("#stats-row").innerHTML =
      tile("Gap to ghost", fmtGap(s.final_delta_ms), gapClass(s.final_delta_ms), "+ means you're behind") +
      tile("In corners", fmtGap(s.corner_time_change_ms), gapClass(s.corner_time_change_ms), `${s.corner_count} corners · ${s.corner_track_pct}% of the track`) +
      tile("Between corners", fmtGap(s.straight_time_change_ms), gapClass(s.straight_time_change_ms)) +
      tile("Average speed", `${r0(s.subject_avg_speed)} <small>vs ${r0(s.reference_avg_speed)}</small>`, "", "km/h") +
      tile("Top speed", `${r0(s.subject_top_speed)} <small>vs ${r0(s.reference_top_speed)}</small>`, "", "km/h") +
      tile("Steering", `${r2(s.subject_avg_abs_steer)} <small>vs ${r2(s.reference_avg_abs_steer)}</small>`, "", `${shortStyle(s.subject_input_style)} vs ${shortStyle(s.reference_input_style)}`) +
      tile("Steer reversals", `${s.subject_steer_reversals} <small>vs ${s.reference_steer_reversals}</small>`) +
      tile("Brake taps", `${s.subject_brake_events} <small>vs ${s.reference_brake_events}</small>`);
    return;
  }

  const rows = ids
    .map((id) => {
      const s = data[id].stats;
      const dot = `<span class="legend-line" style="--c:${s.telemetry ? ghostColor(id) : "#5a5851"}"></span> `;
      const label = `${dot}${esc(runLabel(id))}${id === state.primaryRefId ? ' <span class="hint">(coach uses this one)</span>' : ""}`;
      if (!s.telemetry) {
        return `<tr class="dim"><td>${label}</td><td class="${s.final_delta_ms > 0 ? "pos" : "neg"}">${fmtGap(s.final_delta_ms)}</td><td colspan="4">time only, no telemetry</td></tr>`;
      }
      return `<tr><td>${label}</td><td class="${s.final_delta_ms > 0 ? "pos" : "neg"}">${fmtGap(s.final_delta_ms)}</td>
        <td>${fmtGap(s.corner_time_change_ms)}</td><td>${fmtGap(s.straight_time_change_ms)}</td>
        <td>${r0(s.subject_avg_speed)} vs ${r0(s.reference_avg_speed)}</td>
        <td>${r2(s.subject_avg_abs_steer)} vs ${r2(s.reference_avg_abs_steer)} · ${s.subject_steer_reversals} vs ${s.reference_steer_reversals}</td></tr>`;
    })
    .join("");
  $("#stats-row").innerHTML = `<div class="stats-table-wrap" style="grid-column:1/-1"><table class="stats-table">
    <thead><tr><th>Ghost</th><th>Gap</th><th>In corners</th><th>Between</th><th>Avg speed km/h</th><th>Steering avg · reversals</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ============================================================ focus areas & highlight

function focusCard(item, kind) {
  const secs = Math.abs(item.time_change_ms / 1000).toFixed(2);
  const from = item.distance_start, to = item.distance_end;
  return `<button type="button" class="focus-card ${kind}" data-from="${from}" data-to="${to}" data-section="${item.section_index ?? ""}" data-title="${esc(item.title)}">
    <span class="focus-rank">${kind === "focus" ? item.rank : "✓"}</span>
    <span class="focus-title">${esc(item.title)}</span>
    <span class="focus-time">${kind === "focus" ? "−" : "+"}${secs}s</span>
    <span class="focus-evidence">${item.evidence.slice(1).map((e) => `<span>${esc(e)}</span>`).join("")}</span>
  </button>`;
}

function renderFocus(primary) {
  const area = $("#focus-area");
  const focus = (primary && primary.focus) || [];
  const strengths = (primary && primary.strengths) || [];
  const has = primary && primary.stats.telemetry && (focus.length || strengths.length);
  area.hidden = !has;
  if (!has) return;
  $("#focus-cards").innerHTML = focus.length
    ? focus.map((f) => focusCard(f, "focus")).join("")
    : `<div class="hint">No single stretch costs a meaningful amount of time. You're very close to the ghost everywhere.</div>`;
  $("#strength-cards").innerHTML = strengths.map((s) => focusCard(s, "strength")).join("");
  $$(".focus-card", area).forEach((card) =>
    card.addEventListener("click", () => {
      const same = state.highlight && state.highlight.from === +card.dataset.from && state.highlight.to === +card.dataset.to;
      setHighlight(same ? null : { from: +card.dataset.from, to: +card.dataset.to, title: card.dataset.title, section: card.dataset.section || null });
      if (!same) $("#lap-area").scrollIntoView({ behavior: "smooth", block: "start" });
    })
  );
}

function setHighlight(h) {
  state.highlight = h;
  $$(".focus-card").forEach((c) => c.classList.toggle("on", !!h && +c.dataset.from === h.from && +c.dataset.to === h.to));
  renderHighlightChip();
  state.charts.forEach((c) => c.draw());
  drawTrackMap();
}

function renderHighlightChip() {
  const chip = $("#highlight-chip");
  const h = state.highlight;
  chip.hidden = !h;
  if (!h) return;
  chip.innerHTML = `<span>Showing: ${esc(h.title)}</span>
    ${h.section ? `<button class="btn tiny" type="button" id="hl-section">Section charts →</button>` : ""}
    <button class="btn tiny quiet" type="button" id="hl-clear" aria-label="Clear">✕</button>`;
  $("#hl-clear").addEventListener("click", () => setHighlight(null));
  const sec = $("#hl-section");
  if (sec) sec.addEventListener("click", () => gotoSection(h.section));
}

function gotoSection(index) {
  setTab("sections");
  const card = $(`.section-card[data-index="${index}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1600);
}

// ============================================================ charts

Chart.defaults.color = MUTED;
Chart.defaults.font.family = '"Barlow", system-ui, sans-serif';
Chart.defaults.font.size = 12;
Chart.defaults.borderColor = GRID;

// Charts in the same group share one crosshair, so hovering any of them reads
// the same point of track in all of them (and in the track map and readout).
const hovers = new Map();
function hoverGroup(name) {
  if (!hovers.has(name)) hovers.set(name, { x: null, charts: new Set(), listeners: new Set(), raf: 0 });
  return hovers.get(name);
}
function setHover(name, x) {
  const g = hoverGroup(name);
  g.x = x;
  if (g.raf) return;
  g.raf = requestAnimationFrame(() => {
    g.raf = 0;
    g.charts.forEach((c) => c.ctx && c.draw());
    g.listeners.forEach((fn) => fn(g.x));
  });
}

function nearestIndex(arr, x, get) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (get(arr[mid]) < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(get(arr[lo - 1]) - x) <= Math.abs(get(arr[lo]) - x)) return lo - 1;
  return lo;
}

Chart.register({
  id: "sync",
  afterInit(chart, _args, opts) {
    if (opts && opts.group) hoverGroup(opts.group).charts.add(chart);
  },
  afterDestroy(chart, _args, opts) {
    if (opts && opts.group) hoverGroup(opts.group).charts.delete(chart);
  },
  afterEvent(chart, args, opts) {
    if (!opts || !opts.group || args.replay) return;
    const e = args.event;
    const a = chart.chartArea;
    if (!a) return;
    if (e.type === "mouseout") return setHover(opts.group, null);
    if (e.type === "mousemove" || e.type === "touchmove" || e.type === "touchstart" || e.type === "click") {
      const inside = e.x >= a.left && e.x <= a.right && e.y >= a.top && e.y <= a.bottom;
      setHover(opts.group, inside ? chart.scales.x.getValueForPixel(e.x) : null);
    }
  },
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.group) return;
    const x = hoverGroup(opts.group).x;
    const { ctx, chartArea: a, scales } = chart;
    if (x == null || !scales.x || x < scales.x.min || x > scales.x.max) return;
    const px = scales.x.getPixelForValue(x);
    ctx.save();
    ctx.strokeStyle = "rgba(240,237,230,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, a.top);
    ctx.lineTo(px, a.bottom);
    ctx.stroke();
    chart.data.datasets.forEach((ds, i) => {
      if (ds.noDot || !chart.isDatasetVisible(i) || !ds.data.length) return;
      const pt = ds.data[nearestIndex(ds.data, x, (p) => p.x)];
      if (!pt || pt.y == null) return;
      const py = scales.y.getPixelForValue(pt.y);
      if (py < a.top || py > a.bottom) return;
      ctx.fillStyle = ds.borderColor;
      ctx.strokeStyle = "#121211";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  },
});

// Corner shading (red: you lose time there, green: you gain) with the corner
// number on top, plus the stretch picked from a focus card.
Chart.register({
  id: "bands",
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea: a, scales } = chart;
    if (!opts || !a || !scales.x) return;
    ctx.save();
    for (const b of opts.bands || []) {
      const x1 = scales.x.getPixelForValue(Math.max(b.from, scales.x.min));
      const x2 = scales.x.getPixelForValue(Math.min(b.to, scales.x.max));
      if (x2 <= x1) continue;
      ctx.fillStyle = b.color;
      ctx.fillRect(x1, a.top, x2 - x1, a.bottom - a.top);
      if (opts.labels && b.label && x2 - x1 > 15) {
        ctx.fillStyle = "rgba(189,185,175,0.75)";
        ctx.font = '600 11px "IBM Plex Mono", monospace';
        ctx.textAlign = "center";
        ctx.fillText(b.label, (x1 + x2) / 2, a.top + 12);
      }
    }
    const h = state.highlight;
    if (h) {
      const x1 = scales.x.getPixelForValue(Math.max(h.from, scales.x.min));
      const x2 = scales.x.getPixelForValue(Math.min(h.to, scales.x.max));
      if (x2 > x1) {
        ctx.fillStyle = "rgba(240,237,230,0.10)";
        ctx.fillRect(x1, a.top, x2 - x1, a.bottom - a.top);
        ctx.strokeStyle = "rgba(240,237,230,0.7)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1, a.top); ctx.lineTo(x1, a.bottom);
        ctx.moveTo(x2, a.top); ctx.lineTo(x2, a.bottom);
        ctx.stroke();
      }
    }
    ctx.restore();
  },
});

function destroyCharts() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
  hoverGroup("lap").listeners.clear();
  hoverGroup("lap").x = null;
  state.trackMap = null;
  const plots = $("#lap-plots");
  if (plots) plots.innerHTML = "";
  const grid = $("#sections-grid");
  if (grid) grid.innerHTML = "";
  const nav = $("#section-nav");
  if (nav) nav.innerHTML = "";
  const legend = $("#sections-legend");
  if (legend) legend.innerHTML = "";
}

function lineChart(canvas, datasets, o) {
  const modal = !!o.modal;
  return new Chart(canvas, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      elements: { point: { radius: 0, hoverRadius: 0 }, line: { tension: 0 } },
      layout: { padding: { right: 6 } },
      scales: {
        x: {
          type: "linear", min: o.xMin, max: o.xMax,
          grid: { color: GRID },
          ticks: { maxTicksLimit: modal ? 14 : 9, callback: (v) => `${Math.round(v).toLocaleString()} m` },
        },
        y: {
          min: o.yMin, max: o.yMax,
          title: { display: !!o.yTitle, text: o.yTitle, color: MUTED },
          grid: { color: (c) => (o.zeroLine && c.tick.value === 0 ? "#77736a" : GRID) },
          ticks: o.yFmt ? { callback: o.yFmt } : {},
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: modal || !String(o.group || "").startsWith("lap"),
          mode: "index", intersect: false,
          callbacks: {
            title: (items) => `${Math.round(items[0].parsed.x).toLocaleString()} m`,
            ...(o.tooltipFmt ? { label: o.tooltipFmt } : {}),
          },
        },
        sync: { group: modal ? null : o.group || null },
        bands: { bands: o.bands || [], labels: !!o.labels },
      },
    },
  });
}

const solid = (label, data, color, width = 2.6) => ({ label, data, borderColor: color, borderWidth: width, order: 0 });
const dashed = (label, data, color, width = 1.8) => ({ label, data, borderColor: color, borderWidth: width, borderDash: [7, 4], order: 1 });

function cornerBands(corners, from = -Infinity, to = Infinity) {
  const maxAbs = Math.max(1, ...corners.map((c) => Math.abs(c.time_change_ms)));
  return corners
    .filter((c) => c.distance_end >= from && c.distance_start <= to)
    .map((c) => {
      const k = Math.min(1, Math.abs(c.time_change_ms) / maxAbs);
      const color =
        c.time_change_ms > 0 ? `rgba(255,98,82,${0.05 + k * 0.17})` : c.time_change_ms < 0 ? `rgba(61,214,140,${0.05 + k * 0.15})` : "rgba(138,134,125,0.06)";
      return { from: c.distance_start, to: c.distance_end, color, label: String(c.corner_index) };
    });
}

function plotCard(container, { title, hint, height }, build) {
  const el = document.createElement("div");
  el.className = "plot";
  el.innerHTML = `<div class="plot-head"><h3>${title}</h3><span class="hint">${hint || ""}</span>
    <button class="btn quiet tiny" type="button" data-expand>Expand</button></div>
    <div class="plot-box" style="height:${height}px"><canvas></canvas></div>`;
  container.appendChild(el);
  const chart = build($("canvas", el), {});
  state.charts.push(chart);
  $("[data-expand]", el).addEventListener("click", () => openExpand(title, build));
  return chart;
}

function openExpand(title, build) {
  const dlg = $("#expand-dialog");
  $("#expand-title").textContent = title;
  if (!dlg.open) dlg.showModal();
  if (state.expandChart) state.expandChart.destroy();
  // build after the dialog has laid out so the canvas has its real size
  requestAnimationFrame(() => {
    state.expandChart = build($("#expand-canvas"), { modal: true });
  });
}

function closeExpand() {
  const dlg = $("#expand-dialog");
  if (state.expandChart) {
    state.expandChart.destroy();
    state.expandChart = null;
  }
  if (dlg.open) dlg.close();
}

const legendHtml = (ids) =>
  `<span class="legend-item"><span class="legend-line" style="--c:${YOU}"></span>${esc(runLabel(state.subjectId))} <span class="hint">(you, solid)</span></span>` +
  ids.map((id) => `<span class="legend-item"><span class="legend-line dash" style="--c:${ghostColor(id)}"></span>${esc(runLabel(id))} <span class="hint">(dashed)</span></span>`).join("");

// ---- the whole-lap view

function renderLap(data, ids) {
  const primaryId = ids.includes(state.primaryRefId) ? state.primaryRefId : ids[0];
  const primary = data[primaryId];
  const bands = cornerBands(primary.corners);
  const base = data[ids[0]].points; // same distance axis for every ghost (they share your samples)
  const xMax = base[base.length - 1].distance_m;
  const container = $("#lap-plots");
  container.innerHTML = `<div class="legend-row">${legendHtml(ids)}</div>`;
  const xy = (pts, f) => pts.map((p) => ({ x: p.distance_m, y: f(p) }));
  const lp = (extra) => ({ xMin: 0, xMax, group: "lap", bands, ...extra });

  plotCard(container, { title: "Speed", hint: "km/h · shaded bands are corners: red where you lose time, green where you gain", height: 340 }, (canvas, b) => {
    const ds = ids.map((id) => dashed(runLabel(id), xy(data[id].points, (p) => p.reference_speed), ghostColor(id)));
    ds.push(solid(`${runLabel(state.subjectId)} (you)`, xy(base, (p) => p.subject_speed), YOU));
    return lineChart(canvas, ds, lp({ ...b, yMin: 0, yTitle: "km/h", labels: true }));
  });

  plotCard(container, { title: "Time gap", hint: "seconds · above 0 you are behind, a falling line means you're gaining", height: 230 }, (canvas, b) => {
    const ds = ids.map((id) => {
      const d = dashed(runLabel(id), xy(data[id].points, (p) => p.delta_ms / 1000), ghostColor(id), id === primaryId ? 2.2 : 1.6);
      if (id === primaryId) {
        d.borderDash = [];
        d.borderColor = ghostColor(id);
        d.fill = { target: "origin", above: "rgba(255,98,82,0.16)", below: "rgba(61,214,140,0.16)" };
      }
      return d;
    });
    return lineChart(canvas, ds, lp({
      ...b, yTitle: "seconds", zeroLine: true,
      tooltipFmt: (c) => `${c.dataset.label}: ${c.parsed.y > 0 ? "+" : ""}${c.parsed.y.toFixed(2)}s`,
    }));
  });

  plotCard(container, { title: "Speed difference", hint: "km/h, you minus the ghost · above 0 you are faster", height: 210 }, (canvas, b) => {
    const ds = ids.map((id) => ({
      ...solid(runLabel(id), xy(data[id].points, (p) => p.subject_speed - p.reference_speed), ghostColor(id), id === primaryId ? 2 : 1.4),
      fill: id === primaryId ? { target: "origin", above: "rgba(61,214,140,0.2)", below: "rgba(255,98,82,0.2)" } : false,
    }));
    return lineChart(canvas, ds, lp({
      ...b, yTitle: "km/h", zeroLine: true,
      tooltipFmt: (c) => `${c.dataset.label}: you are ${Math.abs(c.parsed.y).toFixed(1)} km/h ${c.parsed.y >= 0 ? "faster" : "slower"}`,
    }));
  });

  plotCard(container, { title: "Steering", hint: "− left · + right", height: 230 }, (canvas, b) => {
    const ds = ids.map((id) => dashed(runLabel(id), xy(data[id].points, (p) => p.reference_steer), ghostColor(id)));
    ds.push(solid("you", xy(base, (p) => p.subject_steer), YOU, 2.2));
    return lineChart(canvas, ds, lp({ ...b, yMin: -1.1, yMax: 1.1, yTitle: "steer", zeroLine: true }));
  });

  plotCard(container, { title: "Brake and throttle", hint: "your throttle (grey), your brake (red) and the ghost's brake (dashed)", height: 190 }, (canvas, b) => {
    const gas = { ...solid("your throttle", xy(base, (p) => p.subject_gas ?? 0), "#8a867d", 1), fill: "origin", backgroundColor: "rgba(138,134,125,0.22)", stepped: true, noDot: false };
    const brake = { ...solid("your brake", xy(base, (p) => p.subject_brake ?? 0), LOSS, 1.6), fill: "origin", backgroundColor: "rgba(255,98,82,0.28)", stepped: true };
    const ghostBrake = dashed(`${runLabel(primaryId)} brake`, xy(primary.points, (p) => p.reference_brake ?? 0), ghostColor(primaryId), 1.8);
    ghostBrake.stepped = true;
    return lineChart(canvas, [gas, brake, ghostBrake], lp({ ...b, yMin: 0, yMax: 1.05, yTitle: "0–1" }));
  });

  setupTrackMap(primary, primaryId, ids);
  hoverGroup("lap").listeners.add((x) => updateReadout(x, primary, primaryId, ids, data));
  updateReadout(null, primary, primaryId, ids, data);
}

// ---- readout bar

function updateReadout(x, primary, primaryId, ids, data) {
  const el = $("#readout");
  if (x == null) {
    el.innerHTML = `<span class="ro-hint">Hover a graph or the track to compare you and the ghost at that exact point.</span>`;
    return;
  }
  const pts = primary.points;
  const i = nearestIndex(pts, x, (p) => p.distance_m);
  const p = pts[i];
  const pct = (v) => `${Math.round((v || 0) * 100)}%`;
  const youBit = `<span class="ro-item" style="--c:${YOU}"><i></i>You <b>${r0(p.subject_speed)}</b> km/h · steer <b>${signed(p.subject_steer, 2)}</b> · throttle <b>${pct(p.subject_gas)}</b> · brake <b>${pct(p.subject_brake)}</b></span>`;
  const ghosts = ids
    .map((id) => {
      const q = (data[id].points[i]) || data[id].points[data[id].points.length - 1];
      const diff = p.subject_speed - q.reference_speed;
      return `<span class="ro-item" style="--c:${ghostColor(id)}"><i></i>${esc(runLabel(id))} <b>${r0(q.reference_speed)}</b> km/h <span>(you ${signed(diff, 0)})</span> · steer <b>${signed(q.reference_steer, 2)}</b> · brake <b>${pct(q.reference_brake)}</b></span>`;
    })
    .join("");
  const gap = primary.points[i].delta_ms;
  el.innerHTML = `<span class="ro-dist">${Math.round(p.distance_m).toLocaleString()} m</span>${youBit}${ghosts}
    <span class="ro-item ro-gap">gap <b class="${gap > 0 ? "loss" : gap < 0 ? "gain" : ""}">${gap > 0 ? "+" : gap < 0 ? "−" : ""}${(Math.abs(gap) / 1000).toFixed(3)}s</b></span>`;
}

// ---- track map

function mix(a, b, t) {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
  const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  return `rgb(${pa.map((v, k) => Math.round(v + (pb[k] - v) * t)).join(",")})`;
}

let mapObserver = null;

function setupTrackMap(primary, primaryId, ids) {
  const pts = primary.points.filter((p) => p.x != null && p.z != null);
  const canvas = $("#trackmap");
  if (pts.length < 4) {
    state.trackMap = null;
    $("#trackmap-card").hidden = true;
    return;
  }
  $("#trackmap-card").hidden = false;
  const n = pts.length;
  // time gained/lost per 100 m, smoothed over a few samples either side
  const slope = pts.map((_, i) => {
    const a = Math.max(0, i - 4), b = Math.min(n - 1, i + 4);
    const dd = pts[b].distance_m - pts[a].distance_m;
    return dd > 0 ? ((pts[b].delta_ms - pts[a].delta_ms) / dd) * 100 : 0;
  });
  const sortedAbs = slope.map(Math.abs).sort((a, b) => a - b);
  const scale = Math.max(5, sortedAbs[Math.floor(sortedAbs.length * 0.95)] || 5);
  const speeds = pts.map((p) => p.subject_speed);
  const vmin = Math.min(...speeds), vmax = Math.max(...speeds);
  state.trackMap = {
    canvas, pts, slope, scale, vmin, vmax, mode: state.trackMap ? state.trackMap.mode : "time",
    corners: primary.corners, screen: [], hoverX: null,
  };
  const tm = state.trackMap;
  tm.mode = $("#map-mode .on").dataset.mode;

  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = -1, bd = 28 * 28;
    tm.screen.forEach((s, i) => {
      const d = (s.x - mx) ** 2 + (s.y - my) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    setHover("lap", best >= 0 ? tm.pts[best].distance_m : null);
  };
  canvas.onmouseleave = () => setHover("lap", null);
  hoverGroup("lap").listeners.add((x) => { tm.hoverX = x; drawTrackMap(); });
  if (!mapObserver) mapObserver = new ResizeObserver(() => drawTrackMap());
  mapObserver.disconnect();
  mapObserver.observe(canvas);
  drawTrackMap();
  updateMapLegend();
}

function updateMapLegend() {
  const tm = state.trackMap;
  if (!tm) return;
  $("#map-legend").innerHTML =
    tm.mode === "time"
      ? `<span>gaining</span><span class="ramp" style="background:linear-gradient(90deg,${GAIN},#6b675f,${LOSS})"></span><span>losing</span>`
      : `<span>${Math.round(tm.vmin)} km/h</span><span class="ramp" style="background:linear-gradient(90deg,#27405f,#8fc2ff)"></span><span>${Math.round(tm.vmax)}</span>`;
}

function drawTrackMap() {
  const tm = state.trackMap;
  if (!tm || !tm.canvas.isConnected || tm.canvas.offsetParent === null) return;
  const { canvas, pts } = tm;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // top-down view: x to the right, z up the screen
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  pts.forEach((p) => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, -p.z); maxY = Math.max(maxY, -p.z);
  });
  const pad = 22;
  const k = Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxY - minY));
  const ox = (w - (maxX - minX) * k) / 2, oy = (h - (maxY - minY) * k) / 2;
  tm.screen = pts.map((p) => ({ x: ox + (p.x - minX) * k, y: oy + (-p.z - minY) * k }));
  const S = tm.screen;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // highlighted stretch gets a halo under the line
  const hl = state.highlight;
  if (hl) {
    ctx.strokeStyle = "rgba(240,237,230,0.28)";
    ctx.lineWidth = 15;
    ctx.beginPath();
    let started = false;
    pts.forEach((p, i) => {
      if (p.distance_m < hl.from || p.distance_m > hl.to) return;
      if (!started) { ctx.moveTo(S[i].x, S[i].y); started = true; } else ctx.lineTo(S[i].x, S[i].y);
    });
    ctx.stroke();
  }
  ctx.lineWidth = 5;
  for (let i = 1; i < pts.length; i++) {
    let c;
    if (tm.mode === "time") {
      const t = Math.max(-1, Math.min(1, tm.slope[i] / tm.scale));
      c = t >= 0 ? mix("6b675f", "ff6252", t) : mix("6b675f", "3dd68c", -t);
    } else {
      c = mix("27405f", "8fc2ff", (pts[i].subject_speed - tm.vmin) / Math.max(1, tm.vmax - tm.vmin));
    }
    ctx.strokeStyle = c;
    ctx.beginPath();
    ctx.moveTo(S[i - 1].x, S[i - 1].y);
    ctx.lineTo(S[i].x, S[i].y);
    ctx.stroke();
  }

  // corner numbers, nudged away from the line
  ctx.font = '600 11px "IBM Plex Mono", monospace';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  (tm.corners || []).forEach((c) => {
    const i = nearestIndex(pts, (c.distance_start + c.distance_end) / 2, (p) => p.distance_m);
    const a = S[Math.max(0, i - 3)], b = S[Math.min(S.length - 1, i + 3)];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const len = Math.hypot(nx, ny) || 1;
    nx = (nx / len) * 15; ny = (ny / len) * 15;
    ctx.fillStyle = "rgba(240,237,230,0.8)";
    ctx.fillText(String(c.corner_index), S[i].x + nx, S[i].y + ny);
  });

  // start / finish
  ctx.fillStyle = "#f0ede6";
  ctx.beginPath();
  ctx.arc(S[0].x, S[0].y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#f0ede6";
  ctx.lineWidth = 2;
  const f = S[S.length - 1];
  ctx.strokeRect(f.x - 5, f.y - 5, 10, 10);

  if (tm.hoverX != null) {
    const i = nearestIndex(pts, tm.hoverX, (p) => p.distance_m);
    ctx.fillStyle = "#121211";
    ctx.beginPath();
    ctx.arc(S[i].x, S[i].y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f0ede6";
    ctx.beginPath();
    ctx.arc(S[i].x, S[i].y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---- section by section

function renderSections(data, ids) {
  const primaryId = ids.includes(state.primaryRefId) ? state.primaryRefId : ids[0];
  const primary = data[primaryId];
  const grid = $("#sections-grid");
  $("#sections-legend").innerHTML = legendHtml(ids);

  $("#section-nav").innerHTML = primary.sections
    .map((s) => {
      const cls = s.time_change_ms > 0 ? "loss" : s.time_change_ms < 0 ? "gain" : "";
      return `<button type="button" class="section-chip" data-go="${s.index}"><span>Section ${s.index}</span><span class="t ${cls}">${fmtGap(s.time_change_ms)}</span></button>`;
    })
    .join("");
  $$(".section-chip").forEach((b) => b.addEventListener("click", () => gotoSection(b.dataset.go)));

  primary.sections.forEach((sec) => {
    const gain = sec.time_change_ms < 0;
    const badgeClass = sec.time_change_ms === 0 ? "even" : gain ? "gain" : "loss";
    const card = document.createElement("div");
    card.className = "section-card";
    card.dataset.index = sec.index;
    card.innerHTML = `
      <div class="section-head">
        <span class="section-title-sm">Section ${sec.index}</span>
        <span class="section-range">${Math.round(sec.distance_start)}–${Math.round(sec.distance_end)} m${sec.corner_indices.length ? ` · corners ${sec.corner_indices.join(", ")}` : " · no corners"}</span>
        <span class="badge ${badgeClass}">${gain ? "gain " : sec.time_change_ms === 0 ? "even " : "lose "}${Math.abs(sec.time_change_ms / 1000).toFixed(2)}s</span>
      </div>
      <div class="chip-row">
        <span class="chip">speed ${r0(sec.subject_avg_speed)} vs ${r0(sec.reference_avg_speed)} km/h</span>
        <span class="chip">slowest ${r0(sec.subject_min_speed)} vs ${r0(sec.reference_min_speed)}</span>
        <span class="chip">steering ${r2(sec.subject_avg_steer)} vs ${r2(sec.reference_avg_steer)}</span>
        <span class="chip">reversals ${sec.subject_steer_reversals} vs ${sec.reference_steer_reversals}</span>
        <span class="chip">brake taps ${sec.subject_brake_events} vs ${sec.reference_brake_events}</span>
      </div>
      <div class="chart-pair">
        <div><h4><span>Speed (km/h)</span><button class="btn quiet tiny" type="button" data-expand="speed">Expand</button></h4><div class="plot-box" style="height:320px"><canvas></canvas></div></div>
        <div><h4><span>Steering (− left, + right)</span><button class="btn quiet tiny" type="button" data-expand="steer">Expand</button></h4><div class="plot-box" style="height:320px"><canvas></canvas></div></div>
      </div>`;
    grid.appendChild(card);

    const [speedCanvas, steerCanvas] = $$("canvas", card);
    const bands = cornerBands(primary.corners, sec.distance_start, sec.distance_end);
    const common = { bands, xMin: sec.distance_start, xMax: sec.distance_end, labels: true };
    const mkSpeed = (canvas, b) => {
      const ds = [];
      ids.forEach((id) => {
        const other = data[id].sections.find((s) => s.index === sec.index);
        if (other) ds.push(dashed(runLabel(id), other.points.map((p) => ({ x: p.distance_m, y: p.reference_speed })), ghostColor(id), 1.8));
      });
      ds.push(solid("you", sec.points.map((p) => ({ x: p.distance_m, y: p.subject_speed })), YOU, 2.6));
      return lineChart(canvas, ds, { ...common, ...b, group: `sec-${sec.index}`, yTitle: "km/h" });
    };
    const mkSteer = (canvas, b) => {
      const ds = [];
      ids.forEach((id) => {
        const other = data[id].sections.find((s) => s.index === sec.index);
        if (other) ds.push(dashed(runLabel(id), other.points.map((p) => ({ x: p.distance_m, y: p.reference_steer })), ghostColor(id), 1.8));
      });
      ds.push(solid("you", sec.points.map((p) => ({ x: p.distance_m, y: p.subject_steer })), YOU, 2.6));
      return lineChart(canvas, ds, { ...common, ...b, group: `sec-${sec.index}`, yMin: -1.1, yMax: 1.1, yTitle: "steer", zeroLine: true });
    };
    state.charts.push(mkSpeed(speedCanvas, {}), mkSteer(steerCanvas, {}));
    $$("[data-expand]", card).forEach((btn) =>
      btn.addEventListener("click", () =>
        openExpand(`Section ${sec.index}: ${btn.dataset.expand === "speed" ? "speed" : "steering"}`, btn.dataset.expand === "speed" ? mkSpeed : mkSteer)
      )
    );
  });
}

// ============================================================ corner table

function brakeCell(c) {
  const sb = c.subject_brake_point_m;
  const rb = c.reference_brake_point_m;
  if (sb === null && rb === null) return `<span class="hint">neither braked</span>`;
  if (sb === null) return `<span class="hint">ghost braked ${Math.abs(rb).toFixed(0)} m before, you didn't</span>`;
  if (rb === null) return `<span class="hint">you braked ${Math.abs(sb).toFixed(0)} m before, ghost didn't</span>`;
  const off = sb - rb;
  return Math.abs(off) < 2 ? "same point" : `${Math.abs(off).toFixed(0)} m ${off > 0 ? "later" : "earlier"}`;
}

function renderCorners(data) {
  const id = data[state.primaryRefId] && data[state.primaryRefId].stats.telemetry ? state.primaryRefId : null;
  const corners = id ? data[id].corners : [];
  $("#corner-breakdown-sub").textContent = corners.length ? `vs ${runLabel(id)} · ${corners.length} corners detected from the ghost's path` : "";
  const tbody = $("#corner-tbody");
  if (!corners.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="hint">No distinct corners were detected on this ghost's path (a very straight map).</td></tr>`;
    return;
  }
  const maxAbs = Math.max(1, ...corners.map((c) => Math.abs(c.time_change_ms)));
  tbody.innerHTML = corners
    .map((c) => {
      const w = Math.min(50, (Math.abs(c.time_change_ms) / maxAbs) * 50);
      const bar = c.time_change_ms === 0 ? "" : c.time_change_ms > 0
        ? `<i style="left:50%;width:${w}%;background:${LOSS}"></i>` : `<i style="left:${50 - w}%;width:${w}%;background:${GAIN}"></i>`;
      return `<tr>
        <td class="mono">${c.corner_index}</td>
        <td><span class="dir ${c.direction}">${c.direction === "left" ? "left" : "right"} ${c.turn_deg}°</span></td>
        <td class="mono">${Math.round(c.distance_start)}–${Math.round(c.distance_end)} m</td>
        <td><span class="impact"><span class="impact-bar">${bar}</span><span class="mono ${c.time_change_ms > 0 ? "pos" : c.time_change_ms < 0 ? "neg" : ""}" style="font-family:var(--font-mono)">${c.time_change_ms > 0 ? "+" : c.time_change_ms < 0 ? "−" : ""}${Math.abs(c.time_change_ms)} ms</span></span></td>
        <td class="mono">${r0(c.subject_entry_speed)} / ${r0(c.subject_min_speed)} / ${r0(c.subject_exit_speed)} <span class="hint">vs</span> ${r0(c.reference_entry_speed)} / ${r0(c.reference_min_speed)} / ${r0(c.reference_exit_speed)}</td>
        <td>${brakeCell(c)}</td>
        <td class="mono">${r2(c.subject_avg_steer)} · ${c.subject_steer_reversals} <span class="hint">vs</span> ${r2(c.reference_avg_steer)} · ${c.reference_steer_reversals}</td>
        <td><button class="btn tiny" type="button" data-show="${c.corner_index}" data-from="${c.distance_start}" data-to="${c.distance_end}">Show</button></td></tr>`;
    })
    .join("");
  $$("button[data-show]", tbody).forEach((btn) =>
    btn.addEventListener("click", () => {
      setTab("overview");
      setHighlight({ from: +btn.dataset.from, to: +btn.dataset.to, title: `Corner ${btn.dataset.show}`, section: null });
      $("#lap-area").scrollIntoView({ behavior: "smooth", block: "start" });
    })
  );
}

// ============================================================ leaderboard

const BOARD_PAGE = 100;

function boardState() {
  if (!state.board) state.board = { offset: 0, total: null, pages: {}, loading: false, target: null, filter: "" };
  return state.board;
}

async function ensureBoardPage(offset) {
  const b = boardState();
  const uid = state.map && state.map.map_uid;
  if (!uid) return;
  const token = state.mapToken;
  b.offset = offset;
  if (!b.pages[offset]) {
    b.loading = true;
    setStatus($("#board-status"), "Loading…");
    try {
      const page = await api(`/api/tmio/maps/${encodeURIComponent(uid)}/leaderboard?length=${BOARD_PAGE}&offset=${offset}`);
      if (token !== state.mapToken) return;
      b.pages[offset] = page;
      if (page.total != null) b.total = page.total;
    } catch (err) {
      if (token !== state.mapToken) return;
      b.loading = false;
      setStatus($("#board-status"), err.message, "error");
      renderBoardRows();
      return;
    }
    b.loading = false;
  }
  setStatus($("#board-status"), "");
  renderBoardRows();
  renderTopTen();
  renderMapKpis();
}

function boardEntryRow(r, wr, mine, youId, extra = "") {
  const isYou = youId && r.account_id === youId;
  return `<tr class="${isYou ? "me" : ""} ${extra}" data-name="${esc(tmName(r.player_name) || "")}" data-time="${r.time_ms}">
    <td class="rank">${r.position}</td>
    <td>${playerLink(r.player_name, r.account_id)}${isYou ? ' <span class="hint">(you)</span>' : ""}</td>
    <td class="zone">${esc(r.zone || "")}</td>
    <td class="num">${fmtTime(r.time_ms)}</td>
    <td class="num">${wr != null && r.position > 1 ? `+${((r.time_ms - wr) / 1000).toFixed(3)}` : ""}</td>
    <td class="num">${mine != null ? `<span style="color:${r.time_ms < mine ? GAIN : r.time_ms > mine ? MUTED : "var(--ink)"}">${r.time_ms === mine ? "same" : signed((r.time_ms - mine) / 1000, 3) + "s"}</span>` : ""}</td>
    <td><span class="ghost-actions">${kindSelect(isYou)}<button type="button" class="btn tiny" data-ghost-ref="${esc(r.ghost_url)}" data-name="${esc(r.player_name)}" data-time="${r.time_ms}" data-pos="${r.position}">Add</button></span></td></tr>`;
}

function renderBoardRows() {
  const b = boardState();
  const page = b.pages[b.offset];
  const tbody = $("#board-tbody");
  const first = b.pages[0];
  const wr = first && first.entries.length ? first.entries[0].time_ms : null;
  const mine = bestOwn();
  const youId = state.player && state.player.account_id;

  $("#board-mine").hidden = mine == null;
  if (!page) {
    tbody.innerHTML = b.loading ? "" : `<tr><td colspan="7" class="hint">No leaderboard data for this map.</td></tr>`;
    return;
  }
  if (!page.entries.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="hint">Nothing on this page. Try an earlier one.</td></tr>`;
  } else {
    tbody.innerHTML = page.entries
      .map((r) => boardEntryRow(r, wr, mine, youId, b.target != null && r.time_ms === b.target ? "target" : ""))
      .join("");
  }
  $$("button[data-ghost-ref]", tbody).forEach((btn) => btn.addEventListener("click", () => addGhostFromBoard(btn)));

  const total = b.total;
  const pages = total ? Math.max(1, Math.ceil(total / BOARD_PAGE)) : null;
  const pageNo = Math.floor(b.offset / BOARD_PAGE) + 1;
  $("#board-page").value = pageNo;
  $("#board-pages").textContent = pages ? `of ${pages.toLocaleString()}` : "";
  $("#board-prev").disabled = b.offset <= 0;
  $("#board-next").disabled = pages != null ? pageNo >= pages : page.entries.length < BOARD_PAGE;
  $("#board-count").textContent = total
    ? `${total.toLocaleString()} players · showing ${page.entries.length ? `${page.entries[0].position.toLocaleString()}–${page.entries[page.entries.length - 1].position.toLocaleString()}` : "none"}`
    : "";
  applyBoardFilter();
}

function applyBoardFilter() {
  const q = $("#board-filter").value.trim().toLowerCase();
  let shown = 0;
  $$("#board-tbody tr[data-name]").forEach((tr) => {
    const hit = !q || tr.dataset.name.toLowerCase().includes(q);
    tr.hidden = !hit;
    if (hit) shown++;
  });
  if (q) setStatus($("#board-status"), shown ? `${shown} match${shown === 1 ? "" : "es"} on this page. Names on other pages aren't searched; use "Find a time" to jump to yours.` : "No match on this page. Names on other pages aren't searched; use “Find a time” to jump to yours.");
  else if (!boardState().loading) setStatus($("#board-status"), "");
}

function renderTopTen() {
  const first = state.board && state.board.pages[0];
  const box = $("#leaderboard-list");
  if (!first || !first.entries.length) {
    box.innerHTML = `<div class="hint">No leaderboard data for this map.</div>`;
    return;
  }
  const youId = state.player && state.player.account_id;
  box.innerHTML = first.entries
    .slice(0, 10)
    .map((r) => {
      const isYou = youId && r.account_id === youId;
      return `<div class="board-row ${isYou ? "me" : ""}"><span class="pos">${r.position}</span>
        <span class="who">${playerLink(r.player_name, r.account_id)}</span><span class="t">${fmtTime(r.time_ms)}</span>
        <span>${kindSelect(isYou)} <button type="button" class="btn tiny" data-ghost-ref="${esc(r.ghost_url)}" data-name="${esc(r.player_name)}" data-time="${r.time_ms}" data-pos="${r.position}">Add</button></span></div>`;
    })
    .join("");
  $$("button[data-ghost-ref]", box).forEach((btn) => btn.addEventListener("click", () => addGhostFromBoard(btn)));
}

async function goToRank(rank) {
  const b = boardState();
  const n = Math.max(1, parseInt(rank, 10) || 1);
  if (b.total && n > b.total) return setStatus($("#board-status"), `There are only ${b.total.toLocaleString()} players on this map.`, "error");
  b.target = null;
  await ensureBoardPage(Math.floor((n - 1) / BOARD_PAGE) * BOARD_PAGE);
  const row = $$("#board-tbody tr").find((tr) => $(".rank", tr).textContent === String(n));
  if (row) {
    row.classList.add("target");
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

async function findTime(ms) {
  const b = boardState();
  const uid = state.map.map_uid;
  setStatus($("#board-status"), `Looking for ${fmtTime(ms)} on the leaderboard… (big maps take around 15 seconds)`);
  const token = state.mapToken;
  try {
    const res = await api(`/api/tmio/maps/${encodeURIComponent(uid)}/locate?time_ms=${ms}`);
    if (token !== state.mapToken) return;
    if (res.total) b.total = res.total;
    b.target = ms;
    await ensureBoardPage(res.offset);
    const rows = $$("#board-tbody tr[data-time]");
    const exact = rows.find((tr) => +tr.dataset.time === ms);
    const after = exact || rows.find((tr) => +tr.dataset.time > ms);
    const rank = exact ? +$(".rank", exact).textContent : after ? +$(".rank", after).textContent : null;
    if (after) {
      after.scrollIntoView({ behavior: "smooth", block: "center" });
      if (!exact) after.classList.add("target");
    }
    setStatus(
      $("#board-status"),
      exact
        ? `${fmtTime(ms)} is at rank ${rank.toLocaleString()} of ${(b.total || 0).toLocaleString()}.`
        : rank
          ? `${fmtTime(ms)} would sit just above rank ${rank.toLocaleString()}${b.total ? ` of ${b.total.toLocaleString()}` : ""}.`
          : `${fmtTime(ms)} is slower than everything on this page.`,
      "ok"
    );
  } catch (err) {
    setStatus($("#board-status"), err.message, "error");
  }
}

function wireBoard() {
  $("#board-prev").addEventListener("click", () => ensureBoardPage(Math.max(0, boardState().offset - BOARD_PAGE)));
  $("#board-next").addEventListener("click", () => ensureBoardPage(boardState().offset + BOARD_PAGE));
  $("#board-page").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const b = boardState();
    const pages = b.total ? Math.ceil(b.total / BOARD_PAGE) : 99999;
    const n = Math.min(pages, Math.max(1, parseInt(e.target.value, 10) || 1));
    ensureBoardPage((n - 1) * BOARD_PAGE);
  });
  $("#board-rank-form").addEventListener("submit", (e) => { e.preventDefault(); goToRank($("#board-rank").value); });
  $("#board-time-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const ms = parseTime($("#board-time").value);
    if (ms == null) return setStatus($("#board-status"), "Type a time like 1:23.456 or 83.456.", "error");
    findTime(ms);
  });
  $("#board-mine").addEventListener("click", () => {
    const ms = bestOwn();
    if (ms == null) return;
    $("#board-time").value = fmtTime(ms);
    findTime(ms);
  });
  $("#board-filter").addEventListener("input", applyBoardFilter);
  $("#open-board").addEventListener("click", () => setTab("board"));
}

// ============================================================ coach (AI) report

const REPORT_SECTIONS = [
  "Top focus areas", "Steering comparison", "Techniques to try", "Map character", "Section-by-section", "Practice plan",
  "Skill assessment", "Where they stand", "Progress since last time",
];

function renderReport(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  let html = "";
  let inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    const sub = line.match(/^#{3,6}\s*(?:\d+\.\s*)?(.+?)\s*#*$/);
    if (sub) {
      closeList();
      html += `<h5>${esc(sub[1].replace(/\*\*/g, ""))}</h5>`;
      continue;
    }
    const heading =
      line.match(/^#{1,2}\s*(?:\d+\.\s*)?(.+?)\s*#*$/) ||
      (() => {
        const m = line.match(/^(?:\d+\.\s*)?\*\*\s*(?:\d+\.\s*)?(.+?)\s*\*\*\s*[:\-—]?\s*$/);
        return m && REPORT_SECTIONS.some((n) => m[1].toLowerCase().startsWith(n.toLowerCase())) ? m : null;
      })();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (heading) { closeList(); html += `<h4>${esc(heading[1].replace(/\*\*/g, ""))}</h4>`; }
    else if (bullet) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(bullet[1])}</li>`; }
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  return html;
}

function memoryKey(subjectSummary) {
  return `${state.map.map_uid}|${(subjectSummary && (tmName(subjectSummary.player_nickname) || subjectSummary.id)) || "player"}`;
}

async function handleAnalyze() {
  const btn = $("#analyze-btn");
  const statusEl = $("#analyze-status");
  const report = $("#analyze-report");
  if (!state.compare || !state.subjectId) return setStatus(statusEl, "Pick your run and a ghost first.", "error");

  const refId = state.primaryRefId;
  btn.disabled = true;
  report.innerHTML = "";
  setStatus(statusEl, `Briefing the coach on ${runLabel(state.subjectId)} vs ${runLabel(refId)}. Deeper reports take longer, up to a few minutes…`);

  try {
    const [subject, reference] = await Store.getRuns([state.subjectId, refId]);
    const subjectSummary = state.runs.find((r) => r.id === state.subjectId);
    const mine = state.runs.filter((r) => r.kind === "run" && r.race_time_ms != null);
    const times = mine.map((r) => r.race_time_ms).sort((a, b) => a - b);
    const history = {
      num_runs: mine.length,
      best_ms: times[0] ?? null,
      worst_ms: times[times.length - 1] ?? null,
      latest_ms: mine.length ? [...mine].sort((a, b) => (b.uploaded_at || 0) - (a.uploaded_at || 0))[0].race_time_ms : null,
    };
    const key = memoryKey(subjectSummary);
    const previous = await Store.getMemory(key);
    const strip = (r) => ({
      id: r.id, map_uid: r.map_uid, map_name: r.map_name, player_nickname: r.player_nickname,
      race_time_ms: r.race_time_ms, world_position: r.world_position ?? null, samples: r.samples || [],
    });
    const data = await postJson("/api/analyze", {
      subject: strip(subject), reference: strip(reference),
      account_id: state.player ? state.player.account_id : null, history, previous,
      depth: $("#depth-select").value,
    });
    report.innerHTML = renderReport(data.analysis);
    setStatus(statusEl, "Done.", "ok");
    showQuota(data.quota);
    if (data.memory) {
      await Store.putMemory(key, data.memory);
      showMemoryNote();
    }
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function showQuota(quota) {
  const note = $("#quota-note");
  const hour = quota && quota["ai-hour"];
  const day = quota && quota["ai-day"];
  if (!hour && !day) {
    note.hidden = true;
    return;
  }
  const bits = [];
  if (hour) bits.push(`${hour.remaining} of ${hour.limit} left this hour`);
  if (day) bits.push(`${day.remaining} of ${day.limit} left today`);
  note.hidden = false;
  note.textContent = `Free reports: ${bits.join(" · ")}. Paste your own NVIDIA key in Settings for unlimited use.`;
}

function showMemoryNote() {
  const note = $("#memory-note");
  note.hidden = false;
  note.innerHTML = `Saved this session's findings in your browser so the next report can check whether you improved. <a href="#" id="forget-memory">Forget them</a>`;
  $("#forget-memory").addEventListener("click", async (e) => {
    e.preventDefault();
    const subjectSummary = state.runs.find((r) => r.id === state.subjectId);
    await Store.deleteMemory(memoryKey(subjectSummary));
    note.hidden = true;
  });
}

async function refreshMemoryNote() {
  const note = $("#memory-note");
  note.hidden = true;
  if (!state.map || !state.subjectId) return;
  const subjectSummary = state.runs.find((r) => r.id === state.subjectId);
  const previous = await Store.getMemory(memoryKey(subjectSummary));
  if (previous) {
    note.hidden = false;
    note.textContent = `The coach remembers your last session on this map (${previous.saved_at.slice(0, 10)}) and will check whether you improved.`;
  }
}

// ============================================================ legacy migration & wiring

// Earlier versions saved runs on the server (data/*.json). Copy them into the
// browser once so nothing is lost; the files stay untouched.
async function migrateLegacy() {
  if (LS.get("tm_legacy_done")) return;
  try {
    const runs = await api("/api/legacy-runs");
    const fresh = [];
    for (const r of runs) if (!(await Store.hasRun(r.id))) fresh.push(r);
    if (fresh.length) await Store.putRuns(fresh);
    LS.set("tm_legacy_done", "1");
  } catch { /* try again next load */ }
}

function wire() {
  window.addEventListener("hashchange", route);
  $("#settings-btn").addEventListener("click", openSettings);
  $("#player-form").addEventListener("submit", (e) => { e.preventDefault(); searchPlayers(); });
  $("#map-form").addEventListener("submit", (e) => { e.preventDefault(); searchMaps(); });
  $("#library-filter").addEventListener("input", renderHome);
  $("#library-sort").addEventListener("change", renderHome);

  $("#pick-folder").addEventListener("click", () => $("#folder-input").click());
  $("#pick-files").addEventListener("click", () => $("#files-input").click());
  [$("#folder-input"), $("#files-input")].forEach((inp) =>
    inp.addEventListener("change", () => {
      importFiles(inp.files, $("#import-kind").value);
      inp.value = "";
    })
  );
  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", async (e) => {
    const files = await collectDropped(e.dataTransfer);
    importFiles(files, $("#import-kind").value);
  });
  // a stray drop elsewhere shouldn't navigate the browser away to the file
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  $$(".ws-bar .tab").forEach((b) => b.addEventListener("click", () => !b.disabled && setTab(b.dataset.tab)));
  $$("#rail .tabs .tab").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#rail .tabs .tab").forEach((x) => x.classList.toggle("on", x === b));
      $$(".add-pane").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.add));
    })
  );
  $$("#map-mode button").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#map-mode button").forEach((x) => x.classList.toggle("on", x === b));
      if (state.trackMap) {
        state.trackMap.mode = b.dataset.mode;
        updateMapLegend();
        drawTrackMap();
      }
    })
  );
  $("#upload-btn").addEventListener("click", handleUpload);
  $("#analyze-btn").addEventListener("click", handleAnalyze);
  $("#depth-select").addEventListener("change", (e) => LS.set("tm_depth", e.target.value));
  wireBoard();

  const applyWide = (on) => {
    $(".map-layout").classList.toggle("wide-view", on);
    $("#wide-btn").textContent = on ? "Show run list" : "Hide run list";
    LS.set("tm_wide", on ? "1" : "0");
    setTimeout(() => { state.charts.forEach((c) => c.resize()); drawTrackMap(); }, 60);
  };
  applyWide(LS.get("tm_wide") === "1");
  $("#wide-btn").addEventListener("click", () => applyWide(!$(".map-layout").classList.contains("wide-view")));
  $("#fs-btn").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $("#workspace").requestFullscreen().catch(() => {});
  });
  document.addEventListener("fullscreenchange", () => {
    $("#fs-btn").textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
    setTimeout(() => { state.charts.forEach((c) => c.resize()); drawTrackMap(); }, 80);
  });
  $("#expand-close").addEventListener("click", closeExpand);
  $("#expand-dialog").addEventListener("close", () => {
    if (state.expandChart) { state.expandChart.destroy(); state.expandChart = null; }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.highlight && !$("#expand-dialog").open && !$("#settings-dialog").open) setHighlight(null);
  });

  $("#settings-save").addEventListener("click", () => {
    const key = $("#nim-key-input").value.trim();
    const code = $("#access-code-input").value.trim();
    const admin = $("#admin-code-input").value.trim();
    key ? LS.set("tm_nim_key", key) : LS.del("tm_nim_key");
    code ? LS.set("tm_access_code", code) : LS.del("tm_access_code");
    admin ? LS.set("tm_admin_code", admin) : LS.del("tm_admin_code");
    setStatus($("#settings-status"), "Saved.", "ok");
  });
  $("#clear-data-btn").addEventListener("click", async () => {
    if (!confirm("Delete every run and coach note saved in this browser?")) return;
    await Store.clearAll();
    state.subjectId = null;
    state.againstIds = new Set();
    state.compare = null;
    setStatus($("#settings-status"), "Deleted.", "ok");
    route();
  });
}

async function init() {
  wire();
  loadSettingsFields();
  await loadHealth();
  await migrateLegacy();
  try {
    const saved = JSON.parse(LS.get("tm_player") || "null");
    if (saved && saved.account_id) selectPlayer(saved.account_id);
  } catch { /* ignore a corrupt value */ }
  route();
  searchMaps();
}

init();
