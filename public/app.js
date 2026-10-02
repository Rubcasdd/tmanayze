"use strict";

// ============================================================ state & helpers

const state = {
  health: null,
  player: null,
  map: null,
  runs: [], // run summaries (no telemetry) for the selected map
  subjectId: null,
  againstIds: new Set(),
  primaryRefId: null,
  compare: null, // { key, data, ids }
  compareToken: 0,
  charts: [],
};

const REF_COLORS = ["#ff4d8d", "#ffb547", "#7c5cff", "#2be08a", "#ff8a5c", "#5cc8ff"];
const SUBJECT_COLOR = "#00e5ff";

const $ = (sel) => document.querySelector(sel);
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

const fmtTime = (ms) => (ms === null || ms === undefined ? "–" : `${(ms / 1000).toFixed(2)}s`);
const fmtGap = (ms) => (ms === null || ms === undefined ? "–" : `${ms > 0 ? "+" : ""}${(ms / 1000).toFixed(2)}s`);
const r0 = (v) => (v === null || v === undefined ? "–" : Math.round(v));
const r1 = (v) => (v === null || v === undefined ? "–" : (Math.round(v * 10) / 10).toFixed(1));
const r2 = (v) => (v === null || v === undefined ? "–" : (Math.round(v * 100) / 100).toFixed(2));
const gapClass = (ms) => (ms > 0 ? "bad" : ms < 0 ? "good" : "");
const shortStyle = (s) => (s || "").startsWith("digital") ? "keyboard" : (s || "").startsWith("analog") ? "analog" : "–";

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
    throw new Error("Couldn't reach the server — check your connection.");
  }
  if (!res.ok) {
    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* non-JSON error body */ }
    if (res.status === 401) openSettings(true);
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
      `Too much telemetry for one request (${(text.length / 1e6).toFixed(1)} MB; this server accepts ${(limit / 1e6).toFixed(1)} MB). Deselect some ghosts.`
    );
  }
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
}

function setStatus(el, text, kind = "") {
  el.className = `status ${kind}`.trim();
  el.textContent = text;
}

// ============================================================ settings

function openSettings(force = false) {
  const panel = $("#settings-panel");
  panel.hidden = force ? false : !panel.hidden;
  $("#settings-btn").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
  $("#settings-server-note").textContent = h.server_has_ai_key
    ? "This server has an NVIDIA key configured, so AI analysis works without your own key."
    : "This server has no NVIDIA key configured — paste your own below to use AI analysis (get one at build.nvidia.com).";
  $("#access-code-field").hidden = !h.access_code_required;
  $("#admin-code-field").hidden = !h.admin_code_supported;
  if (h.access_code_required && !LS.get("tm_access_code")) openSettings(true);

  const select = $("#depth-select");
  const saved = LS.get("tm_depth");
  select.innerHTML = (h.depths || [{ id: "detailed", label: "Detailed" }])
    .map((d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`)
    .join("");
  select.value = [...select.options].some((o) => o.value === saved) ? saved : h.default_depth || "detailed";

  const lim = h.ai_limits || {};
  if (h.server_has_ai_key && (lim.per_hour || lim.per_day)) {
    const parts = [];
    if (lim.per_hour) parts.push(`${lim.per_hour} per hour`);
    if (lim.per_day) parts.push(`${lim.per_day} per day`);
    $("#settings-server-note").textContent += ` Free AI analyses are limited to ${parts.join(" and ")} per visitor; your own key has no limit.`;
  }
}

// ============================================================ player

async function searchPlayers() {
  const q = $("#player-search-input").value.trim();
  if (!q) return;
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
      .map((p) => `<div class="player-result-row" data-id="${esc(p.account_id)}"><b>${esc(tmName(p.name))}</b><span class="hint">${esc(p.zone_name || "")}</span></div>`)
      .join("");
    box.querySelectorAll(".player-result-row").forEach((row) => row.addEventListener("click", () => selectPlayer(row.dataset.id)));
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
    renderPlayerProfile(p);
    if (state.map) loadLeaderboard();
  } catch (err) {
    el.innerHTML = `<div class="hint">${esc(err.message)}</div>`;
  }
}

function renderPlayerProfile(p) {
  const maxRank = Math.max(1, ...p.zones.map((z) => z.rank || 1));
  $("#player-profile").innerHTML = `
    <div class="profile-top">
      <div class="profile-name">${esc(tmName(p.name))}</div>
      ${p.club_tag && tmName(p.club_tag) ? `<span class="profile-club">${esc(tmName(p.club_tag))}</span>` : ""}
      <span class="profile-points">${(p.trophy_points || 0).toLocaleString()} trophy points</span>
    </div>
    <div class="zone-ladder">
      ${p.zones
        .map((z) => {
          const pct = z.rank ? Math.max(4, 100 - Math.min(100, (z.rank / maxRank) * 100)) : 0;
          return `<div class="zone-row"><span class="zone-name">${esc(z.name || "")}</span>
            <span class="zone-bar-track"><span class="zone-bar-fill" style="width:${pct}%"></span></span>
            <span class="zone-rank">${z.rank ? "#" + z.rank.toLocaleString() : "–"}</span></div>`;
        })
        .join("")}
    </div>`;
}

// A clickable player name: straight to their profile when we know the account
// id (leaderboard rows), otherwise a name search (replays only carry a nickname).
function playerLink(name, accountId) {
  const clean = tmName(name) || "?";
  return accountId
    ? `<span class="player-link" data-account-id="${esc(accountId)}">${esc(clean)}</span>`
    : `<span class="player-link" data-name="${esc(clean)}">${esc(clean)}</span>`;
}

document.addEventListener("click", (e) => {
  const el = e.target.closest(".player-link");
  if (!el) return;
  if (el.dataset.accountId) selectPlayer(el.dataset.accountId);
  else if (el.dataset.name) {
    $("#player-search-input").value = el.dataset.name;
    searchPlayers();
  }
  $("#player-card").scrollIntoView({ behavior: "smooth", block: "start" });
});

const samePlayer = (name) => !!state.player && tmName(name || "").toLowerCase() === tmName(state.player.name || "").toLowerCase();

// ============================================================ map finder

async function searchMaps() {
  const q = $("#map-search-input").value.trim();
  const grid = $("#map-grid");
  grid.innerHTML = `<div class="hint">Searching…</div>`;
  try {
    const results = await api(`/api/mx/search?name=${encodeURIComponent(q)}&count=24`);
    if (!results.length) {
      grid.innerHTML = `<div class="hint">No maps found.</div>`;
      return;
    }
    grid.innerHTML = results
      .map(
        (m) => `<div class="map-tile" data-uid="${esc(m.map_uid)}">
          <img src="${esc(m.thumbnail_url)}" loading="lazy" alt="${esc(m.name)}" />
          <div class="map-tile-body"><div class="map-tile-name">${esc(m.name)}</div>
          <div class="map-tile-authors">${esc((m.authors || []).map(tmName).join(", "))}</div></div></div>`
      )
      .join("");
    grid.querySelectorAll(".map-tile").forEach((tile) => tile.addEventListener("click", () => selectMap(tile.dataset.uid)));
  } catch (err) {
    grid.innerHTML = `<div class="hint">${esc(err.message)}</div>`;
  }
}

async function renderLibrary() {
  const lib = await Store.listLibrary();
  const row = $("#library-row");
  row.hidden = !lib.length;
  row.innerHTML = lib.length
    ? `<span class="label">Your library</span>` +
      lib.map((m) => `<button type="button" class="library-chip" data-uid="${esc(m.map_uid)}">${esc(tmName(m.map_name) || m.map_uid.slice(0, 8))} · ${m.count}</button>`).join("")
    : "";
  row.querySelectorAll(".library-chip").forEach((b) => b.addEventListener("click", () => selectMap(b.dataset.uid)));
}

async function selectMap(mapUid) {
  const card = $("#map-detail-card");
  card.hidden = false;
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("#map-detail-title").textContent = "Loading…";

  let detail;
  try {
    detail = await api(`/api/mx/maps/${encodeURIComponent(mapUid)}`);
  } catch (err) {
    // Not every map is on ManiaExchange (e.g. campaign maps) — the leaderboard
    // and anything already in the library still work.
    const lib = (await Store.listLibrary()).find((m) => m.map_uid === mapUid);
    detail = {
      map_uid: mapUid, name: tmName(lib && lib.map_name) || "Map", thumbnail_url: "", tags: [], authors: [],
      difficulty: null, award_count: null, replays: [], notOnMx: true,
    };
  }

  if (!state.map || state.map.map_uid !== detail.map_uid) {
    state.subjectId = null;
    state.againstIds = new Set();
    state.compare = null;
    $("#compare-panel").hidden = true;
    $("#analyze-report").innerHTML = "";
    setStatus($("#analyze-status"), "");
  }
  state.map = detail;

  $("#map-detail-title").textContent = detail.name;
  const thumb = $("#map-detail-thumb");
  thumb.hidden = !detail.thumbnail_url;
  if (detail.thumbnail_url) thumb.src = detail.thumbnail_url;
  $("#map-detail-tags").innerHTML =
    (detail.tags || []).map((t) => `<span class="tag-pill">${esc(t)}</span>`).join("") +
    (detail.difficulty !== null && detail.difficulty !== undefined ? `<span class="tag-pill">difficulty ${detail.difficulty}</span>` : "");
  $("#map-detail-authors").textContent = detail.notOnMx
    ? "Not on ManiaExchange — leaderboard and your saved runs still work."
    : `By ${(detail.authors || []).map(tmName).join(", ")} · ${detail.award_count ?? 0} awards`;

  renderMxReplays(detail.replays || []);
  $("#compare-section").hidden = false;
  await Promise.all([loadLeaderboard(), loadRuns()]);
}

// ============================================================ importing

function kindSelect(isYou) {
  return `<select class="ghost kind-pick">
      <option value="reference"${isYou ? "" : " selected"}>as ghost</option>
      <option value="run"${isYou ? " selected" : ""}>as my run</option></select>`;
}

async function importInto(btn, path, formData) {
  btn.disabled = true;
  btn.textContent = "Importing…";
  try {
    const run = await api(path, { method: "POST", body: formData });
    await Store.putRuns([run]);
    btn.textContent = run.telemetry_available ? "Imported ✓" : "Imported (time only)";
    await Promise.all([loadRuns(), renderLibrary()]);
  } catch (err) {
    btn.textContent = "Failed";
    btn.title = err.message;
    btn.disabled = false;
  }
}

function renderMxReplays(replays) {
  const tbody = $("#mx-replays-tbody");
  if (!replays.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="hint">No community replays on ManiaExchange for this map.</td></tr>`;
    return;
  }
  tbody.innerHTML = replays
    .map(
      (r) => `<tr><td>${playerLink(r.player_name)}</td><td>${fmtTime(r.time_ms)}</td>
        <td>${r.has_file ? `${kindSelect(samePlayer(r.player_name))}<button type="button" class="ghost" data-replay-id="${r.replay_id}">Import</button>` : `<span class="hint">no file</span>`}</td></tr>`
    )
    .join("");
  tbody.querySelectorAll("button[data-replay-id]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const fd = new FormData();
      fd.append("map_uid", state.map.map_uid);
      fd.append("mx_replay_id", btn.dataset.replayId);
      fd.append("kind", btn.previousElementSibling.value);
      importInto(btn, "/api/mx/import-replay", fd);
    })
  );
}

async function loadLeaderboard() {
  const tbody = $("#leaderboard-tbody");
  tbody.innerHTML = `<tr><td colspan="4" class="hint">Loading…</td></tr>`;
  try {
    const top = await api(`/api/tmio/maps/${encodeURIComponent(state.map.map_uid)}/leaderboard?length=20`);
    const youId = state.player && state.player.account_id;
    if (!top.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="hint">No leaderboard data for this map.</td></tr>`;
      return;
    }
    tbody.innerHTML = top
      .map((r) => {
        const isYou = youId && r.account_id === youId;
        return `<tr class="${isYou ? "you-row" : ""}"><td>${r.position}</td>
          <td>${playerLink(r.player_name, r.account_id)}${isYou ? " (you)" : ""}</td><td>${fmtTime(r.time_ms)}</td>
          <td>${kindSelect(isYou)}<button type="button" class="ghost" data-ghost-ref="${esc(r.ghost_url)}" data-name="${esc(r.player_name)}" data-time="${r.time_ms}" data-pos="${r.position}">Import</button></td></tr>`;
      })
      .join("");
    tbody.querySelectorAll("button[data-ghost-ref]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const fd = new FormData();
        fd.append("map_uid", state.map.map_uid);
        fd.append("ghost_ref", btn.dataset.ghostRef);
        fd.append("kind", btn.previousElementSibling.value);
        fd.append("player_nickname", btn.dataset.name);
        fd.append("race_time_ms", btn.dataset.time);
        fd.append("world_position", btn.dataset.pos);
        importInto(btn, "/api/tmio/import-ghost", fd);
      })
    );
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="hint">${esc(err.message)}</td></tr>`;
  }
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
      if (!run.telemetry_available) problems.push(`${file.name}: no telemetry in this file (time only)`);
    } catch (err) {
      problems.push(`${file.name}: ${err.message}`);
    }
  }
  $("#file-input").value = "";
  setStatus(statusEl, `${ok} uploaded${problems.length ? ` — ${problems.join("; ")}` : "."}`, problems.length && !ok ? "error" : "ok");
  await renderLibrary();
  if (lastMap && state.map && lastMap !== state.map.map_uid) await selectMap(lastMap);
  else await loadRuns();
}

// ============================================================ runs table & selection

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
  renderRunsTable();
  await maybeLoadComparison();
}

// Pick sensible defaults so "your run vs the ghost" is one click: your best
// run with telemetry as the subject, the fastest ghost with telemetry as the
// reference. Never overrides a choice that's still valid.
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

function renderRunsTable() {
  const tbody = $("#runs-tbody");
  refreshMemoryNote();
  if (!state.runs.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="hint">No runs yet — import a ghost above or upload one of your own replays.</td></tr>`;
    return;
  }
  tbody.innerHTML = state.runs
    .map((r) => {
      const flags = [];
      if (r.is_best_run) flags.push("★ best run");
      if (r.is_best_reference) flags.push("★ best ghost");
      if (r.world_position) flags.push(`world #${r.world_position}`);
      if (!r.telemetry_available) flags.push("no telemetry");
      const title = r.telemetry_available ? "" : `title="No per-tick telemetry — compares by finish time only, without charts."`;
      return `<tr class="${r.telemetry_available ? "" : "no-telemetry-row"}">
        <td><button type="button" class="ghost ${state.subjectId === r.id ? "active" : ""}" data-role="subject" data-id="${r.id}" ${title}>You</button></td>
        <td><button type="button" class="ghost ${state.againstIds.has(r.id) ? "active" : ""}" data-role="against" data-id="${r.id}" ${title}>Ghost</button></td>
        <td>${playerLink(r.player_nickname)}</td><td>${fmtTime(r.race_time_ms)}</td>
        <td>${esc(r.kind)} / ${esc(r.source)}${flags.length ? " · " + esc(flags.join(", ")) : ""}</td>
        <td><button type="button" class="ghost" data-role="delete" data-id="${r.id}" title="Remove from this browser">✕</button></td></tr>`;
    })
    .join("");

  tbody.querySelectorAll("button[data-role]").forEach((btn) =>
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
        await Promise.all([loadRuns(), renderLibrary()]);
        return;
      }
      renderRunsTable();
      maybeLoadComparison();
    })
  );
}

// ============================================================ comparing

async function maybeLoadComparison() {
  const panel = $("#compare-panel");
  if (!state.subjectId || state.againstIds.size === 0) {
    panel.hidden = true;
    state.compare = null;
    destroyCharts();
    return;
  }
  const ids = [...state.againstIds].sort();
  const key = [state.subjectId, ...ids].join("|");
  if (state.compare && state.compare.key === key) return;

  const token = ++state.compareToken;
  panel.hidden = false;
  $("#stats-row").innerHTML = `<div class="hint">Comparing…</div>`;
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
    if (token !== state.compareToken) return; // a newer selection superseded this one
    state.compare = { key, data, ids: refs.map((r) => r.id) };
    renderComparison();
  } catch (err) {
    if (token !== state.compareToken) return;
    $("#stats-row").innerHTML = `<div class="stat wide"><div class="label">Can't compare</div><div class="value" style="font-size:13px;font-weight:400">${esc(err.message)}</div></div>`;
    destroyCharts();
  }
}

function pickPrimary(data, ids) {
  // The ghost closest in finish time is the most relevant single reference;
  // it drives the section chips, corner table and the AI briefing.
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

  const warn = $("#alignment-warning");
  if (primary.stats.alignment_poor) {
    warn.hidden = false;
    warn.textContent =
      `These two runs don't follow the same route (the ghost's path is ${primary.stats.path_length_ratio}× the length of yours; ` +
      `typical distance between matched points ${primary.stats.alignment_median_m} m). That usually means a different version of the map or a big detour, ` +
      `so section and corner numbers below may be misleading.`;
  } else {
    warn.hidden = true;
  }

  renderStats(data, ids);
  renderFocus(primary);
  const chartable = ids.filter((id) => data[id].stats.telemetry);
  $("#chart-empty-note").hidden = chartable.length > 0;
  $("#charts-area").hidden = chartable.length === 0;
  destroyCharts();
  if (chartable.length) {
    renderCharts(data, chartable);
    renderSections(data, chartable);
    renderCorners(data);
  }
}

function renderStats(data, ids) {
  const tile = (label, value, cls = "", sub = "") =>
    `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;

  if (ids.length === 1) {
    const s = data[ids[0]].stats;
    if (!s.telemetry) {
      $("#stats-row").innerHTML =
        tile("Result gap", fmtGap(s.final_delta_ms), gapClass(s.final_delta_ms)) +
        tile("Your time", fmtTime(s.subject_race_time_ms)) +
        tile("Ghost time", fmtTime(s.reference_race_time_ms)) +
        `<div class="stat wide"><div class="label">Note</div><div class="value" style="font-size:12px;font-weight:400">No per-tick telemetry for one of these runs — time-only comparison, no charts.</div></div>`;
      return;
    }
    $("#stats-row").innerHTML =
      tile("Result gap", fmtGap(s.final_delta_ms), gapClass(s.final_delta_ms), "+ = you're behind") +
      tile("Lost in corners", fmtGap(s.corner_time_change_ms), gapClass(s.corner_time_change_ms), `${s.corner_count} corners · ${s.corner_track_pct}% of track`) +
      tile("Lost between corners", fmtGap(s.straight_time_change_ms), gapClass(s.straight_time_change_ms)) +
      tile("Avg speed", `${r0(s.subject_avg_speed)} <small>vs ${r0(s.reference_avg_speed)}</small>`, "", "km/h") +
      tile("Top speed", `${r0(s.subject_top_speed)} <small>vs ${r0(s.reference_top_speed)}</small>`, "", "km/h") +
      tile("Steering (avg)", `${r2(s.subject_avg_abs_steer)} <small>vs ${r2(s.reference_avg_abs_steer)}</small>`, "", `${shortStyle(s.subject_input_style)} vs ${shortStyle(s.reference_input_style)}`) +
      tile("Steer reversals", `${s.subject_steer_reversals} <small>vs ${s.reference_steer_reversals}</small>`) +
      tile("Brake events", `${s.subject_brake_events} <small>vs ${s.reference_brake_events}</small>`);
    return;
  }

  const rows = ids
    .map((id, i) => {
      const s = data[id].stats;
      const dot = `<span class="legend-dot" style="background:${s.telemetry ? REF_COLORS[i % REF_COLORS.length] : "#3a3f4f"}"></span>`;
      const label = `${dot}${esc(runLabel(id))}${id === state.primaryRefId ? ' <span class="hint">(AI ghost)</span>' : ""}`;
      if (!s.telemetry) {
        return `<tr class="no-telemetry-row"><td>${label}</td><td class="${gapClass(s.final_delta_ms)}">${fmtGap(s.final_delta_ms)}</td><td colspan="4" class="hint">no telemetry — time only</td></tr>`;
      }
      return `<tr><td>${label}</td><td class="${s.final_delta_ms > 0 ? "pos" : "neg"}">${fmtGap(s.final_delta_ms)}</td>
        <td>${fmtGap(s.corner_time_change_ms)}</td><td>${fmtGap(s.straight_time_change_ms)}</td>
        <td>${r0(s.subject_avg_speed)} vs ${r0(s.reference_avg_speed)}</td>
        <td>${r2(s.subject_avg_abs_steer)} vs ${r2(s.reference_avg_abs_steer)} · ${s.subject_steer_reversals} vs ${s.reference_steer_reversals}</td></tr>`;
    })
    .join("");
  $("#stats-row").innerHTML = `<table class="multi-compare-table">
    <thead><tr><th>Ghost</th><th>Gap</th><th>In corners</th><th>Between</th><th>Avg speed (km/h)</th><th>Steering avg · reversals</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// ============================================================ focus areas

function focusCard(item, kind) {
  const cls = kind === "focus" ? "loss" : "gain";
  const secs = Math.abs(item.time_change_ms / 1000).toFixed(2);
  return `<button type="button" class="focus-card ${kind}" data-section="${item.section_index ?? ""}">
    <span class="focus-rank">${kind === "focus" ? item.rank : "✓"}</span>
    <span class="focus-body">
      <span class="focus-title">${esc(item.title)}</span>
      <span class="focus-evidence">${item.evidence.slice(1).map((e) => `<span class="chip">${esc(e)}</span>`).join("")}</span>
    </span>
    <span class="badge ${cls}">${kind === "focus" ? "−" : "+"}${secs}s</span>
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
    : `<div class="hint">No single stretch loses a meaningful amount of time — you're very close to the ghost everywhere.</div>`;
  $("#strength-cards").innerHTML = strengths.map((s) => focusCard(s, "strength")).join("");
  area.querySelectorAll(".focus-card").forEach((card) =>
    card.addEventListener("click", () => {
      const target = card.dataset.section && document.querySelector(`.section-card[data-index="${card.dataset.section}"]`);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("flash");
      setTimeout(() => target.classList.remove("flash"), 1600);
    })
  );
}

// ============================================================ charts

Chart.defaults.color = "#8c92a8";
Chart.defaults.font.family = "Inter, system-ui, sans-serif";
Chart.defaults.font.size = 11;

// Shades corner stretches behind the lines so you can see what each bend does.
Chart.register({
  id: "cornerBands",
  beforeDatasetsDraw(chart, _args, opts) {
    const bands = (opts && opts.bands) || [];
    const { ctx, chartArea, scales } = chart;
    if (!bands.length || !chartArea || !scales.x) return;
    ctx.save();
    for (const b of bands) {
      const x1 = scales.x.getPixelForValue(Math.max(b.from, scales.x.min));
      const x2 = scales.x.getPixelForValue(Math.min(b.to, scales.x.max));
      if (x2 <= x1) continue;
      ctx.fillStyle = b.color;
      ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
    }
    ctx.restore();
  },
});

function destroyCharts() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
  const grid = $("#sections-grid");
  if (grid) grid.innerHTML = "";
}

function lineChart(canvas, datasets, { yTitle, yMin, yMax, bands = [], xMin, xMax, zeroLine = false, legend = false, tooltipFmt }) {
  const chart = new Chart(canvas, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      elements: { point: { radius: 0, hoverRadius: 3 }, line: { tension: 0 } },
      scales: {
        x: { type: "linear", min: xMin, max: xMax, title: { display: true, text: "distance (m)" }, grid: { color: "#262b3a" }, ticks: { maxTicksLimit: 8, callback: (v) => Math.round(v).toLocaleString() } },
        y: {
          min: yMin, max: yMax, title: { display: true, text: yTitle },
          grid: { color: (c) => (zeroLine && c.tick.value === 0 ? "#6c7390" : "#262b3a") },
        },
      },
      plugins: {
        legend: { display: legend, labels: { color: "#e8eaf2", boxWidth: 22 } },
        tooltip: { callbacks: tooltipFmt ? { label: tooltipFmt } : {} },
        cornerBands: { bands },
      },
    },
  });
  state.charts.push(chart);
  return chart;
}

const solid = (label, data, color, width = 2.4) => ({ label, data, borderColor: color, borderWidth: width, order: 0 });
const dashed = (label, data, color, width = 1.6) => ({ label, data, borderColor: color, borderWidth: width, borderDash: [6, 3], order: 1 });

function cornerBands(corners, from = -Infinity, to = Infinity) {
  const maxAbs = Math.max(1, ...corners.map((c) => Math.abs(c.time_change_ms)));
  return corners
    .filter((c) => c.distance_end >= from && c.distance_start <= to)
    .map((c) => {
      const k = Math.min(1, Math.abs(c.time_change_ms) / maxAbs);
      const color =
        c.time_change_ms > 0 ? `rgba(255,77,141,${0.06 + k * 0.2})` : c.time_change_ms < 0 ? `rgba(43,224,138,${0.06 + k * 0.2})` : "rgba(140,146,168,0.07)";
      return { from: c.distance_start, to: c.distance_end, color };
    });
}

function renderCharts(data, ids) {
  const primary = data[state.primaryRefId] && data[state.primaryRefId].stats.telemetry ? data[state.primaryRefId] : data[ids[0]];
  const bands = cornerBands(primary.corners);
  const base = data[ids[0]].points; // same distance axis for every ghost (they share the subject's samples)
  const xMax = base[base.length - 1].distance_m;

  const speed = [];
  const speedDiff = [];
  const delta = [];
  ids.forEach((id, i) => {
    const color = REF_COLORS[i % REF_COLORS.length];
    const pts = data[id].points;
    speed.push(dashed(runLabel(id), pts.map((p) => ({ x: p.distance_m, y: p.reference_speed })), color));
    speedDiff.push({
      ...solid(runLabel(id), pts.map((p) => ({ x: p.distance_m, y: p.subject_speed - p.reference_speed })), color, id === state.primaryRefId ? 2.2 : 1.5),
      fill: id === state.primaryRefId ? "origin" : false,
      backgroundColor: `${color}22`,
    });
    delta.push({
      ...dashed(runLabel(id), pts.map((p) => ({ x: p.distance_m, y: p.delta_ms / 1000 })), color, id === state.primaryRefId ? 2.2 : 1.5),
      fill: id === state.primaryRefId ? "origin" : false,
      backgroundColor: `${color}22`,
    });
  });
  speed.push(solid(`${runLabel(state.subjectId)} (you)`, base.map((p) => ({ x: p.distance_m, y: p.subject_speed })), SUBJECT_COLOR));

  lineChart($("#speed-chart"), speed, { yTitle: "km/h", yMin: 0, bands, xMin: 0, xMax, legend: true });
  lineChart($("#speed-diff-chart"), speedDiff, {
    yTitle: "km/h faster (+)", bands, xMin: 0, xMax, zeroLine: true, legend: true,
    tooltipFmt: (c) => `${c.dataset.label}: you are ${Math.abs(c.parsed.y).toFixed(1)} km/h ${c.parsed.y >= 0 ? "faster" : "slower"}`,
  });
  lineChart($("#delta-chart"), delta, {
    yTitle: "gap (s)", bands, xMin: 0, xMax, zeroLine: true, legend: true,
    tooltipFmt: (c) => `${c.dataset.label}: ${c.parsed.y > 0 ? "+" : ""}${c.parsed.y.toFixed(2)}s`,
  });
}

function renderSections(data, ids) {
  const primaryId = ids.includes(state.primaryRefId) ? state.primaryRefId : ids[0];
  const primary = data[primaryId];
  const grid = $("#sections-grid");

  const legend = `<div class="legend-row"><span class="legend-item"><span class="legend-dot" style="background:${SUBJECT_COLOR}"></span>${esc(runLabel(state.subjectId))} (you, solid)</span>` +
    ids.map((id, i) => `<span class="legend-item"><span class="legend-dot" style="background:${REF_COLORS[i % REF_COLORS.length]}"></span>${esc(runLabel(id))} (dashed)</span>`).join("") + "</div>";
  grid.innerHTML = legend;

  primary.sections.forEach((sec) => {
    const gain = sec.time_change_ms < 0;
    const badgeClass = sec.time_change_ms === 0 ? "even" : gain ? "gain" : "loss";
    const card = document.createElement("div");
    card.className = "section-card";
    card.dataset.index = sec.index;
    card.innerHTML = `
      <div class="section-head">
        <span class="section-title">Section ${sec.index}</span>
        <span class="section-range">${Math.round(sec.distance_start)}–${Math.round(sec.distance_end)} m${sec.corner_indices.length ? ` · corners ${sec.corner_indices.join(", ")}` : " · no corners"}</span>
        <span class="badge ${badgeClass}">${gain ? "you gain " : sec.time_change_ms === 0 ? "even " : "you lose "}${Math.abs(sec.time_change_ms / 1000).toFixed(2)}s</span>
      </div>
      <div class="chip-row">
        <span class="chip">speed ${r0(sec.subject_avg_speed)} vs ${r0(sec.reference_avg_speed)} km/h</span>
        <span class="chip">slowest ${r0(sec.subject_min_speed)} vs ${r0(sec.reference_min_speed)}</span>
        <span class="chip">steering avg ${r2(sec.subject_avg_steer)} vs ${r2(sec.reference_avg_steer)}</span>
        <span class="chip">reversals ${sec.subject_steer_reversals} vs ${sec.reference_steer_reversals}</span>
        <span class="chip">brake events ${sec.subject_brake_events} vs ${sec.reference_brake_events}</span>
      </div>
      <div class="chart-pair">
        <div><h4>Speed (km/h)</h4><div class="chart-box small"><canvas></canvas></div></div>
        <div><h4>Steering (− left · + right)</h4><div class="chart-box small"><canvas></canvas></div></div>
      </div>`;
    grid.appendChild(card);

    const [speedCanvas, steerCanvas] = card.querySelectorAll("canvas");
    const bands = cornerBands(primary.corners, sec.distance_start, sec.distance_end);
    const speed = [];
    const steer = [];
    ids.forEach((id, i) => {
      const other = data[id].sections.find((s) => s.index === sec.index);
      if (!other) return;
      const color = REF_COLORS[i % REF_COLORS.length];
      speed.push(dashed(runLabel(id), other.points.map((p) => ({ x: p.distance_m, y: p.reference_speed })), color, 1.5));
      steer.push(dashed(runLabel(id), other.points.map((p) => ({ x: p.distance_m, y: p.reference_steer })), color, 1.5));
    });
    speed.push(solid("you", sec.points.map((p) => ({ x: p.distance_m, y: p.subject_speed })), SUBJECT_COLOR, 2.2));
    steer.push(solid("you", sec.points.map((p) => ({ x: p.distance_m, y: p.subject_steer })), SUBJECT_COLOR, 2.2));

    lineChart(speedCanvas, speed, { yTitle: "km/h", bands, xMin: sec.distance_start, xMax: sec.distance_end });
    lineChart(steerCanvas, steer, { yTitle: "steer", yMin: -1.1, yMax: 1.1, bands, xMin: sec.distance_start, xMax: sec.distance_end, zeroLine: true });
  });
}

// ============================================================ corner table

function brakeCell(c) {
  const sb = c.subject_brake_point_m;
  const rb = c.reference_brake_point_m;
  if (sb === null && rb === null) return `<span class="hint">neither braked</span>`;
  if (sb === null) return `<span class="hint">ghost braked ${Math.abs(rb).toFixed(0)}m before; you didn't</span>`;
  if (rb === null) return `<span class="hint">you braked ${Math.abs(sb).toFixed(0)}m before; ghost didn't</span>`;
  const off = sb - rb;
  return Math.abs(off) < 2 ? "same point" : `${Math.abs(off).toFixed(0)}m ${off > 0 ? "later" : "earlier"}`;
}

function renderCorners(data) {
  const id = data[state.primaryRefId] && data[state.primaryRefId].stats.telemetry ? state.primaryRefId : null;
  const corners = id ? data[id].corners : [];
  $("#corner-breakdown-sub").textContent = corners.length ? `vs ${runLabel(id)} · ${corners.length} corners detected from the ghost's path` : "";
  const tbody = $("#corner-tbody");
  if (!corners.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="hint">No distinct corners were detected on this ghost's path (a very straight map).</td></tr>`;
    return;
  }
  const maxAbs = Math.max(1, ...corners.map((c) => Math.abs(c.time_change_ms)));
  tbody.innerHTML = corners
    .map((c) => {
      const k = Math.min(1, Math.abs(c.time_change_ms) / maxAbs);
      const bg = c.time_change_ms === 0 ? "transparent" : c.time_change_ms > 0 ? `rgba(255,77,141,${0.05 + k * 0.22})` : `rgba(43,224,138,${0.05 + k * 0.22})`;
      return `<tr style="background:${bg}">
        <td>${c.corner_index}</td>
        <td><span class="dir ${c.direction}">${c.direction === "left" ? "◀ left" : "right ▶"} ${c.turn_deg}°</span></td>
        <td>${Math.round(c.distance_start)}–${Math.round(c.distance_end)}m</td>
        <td class="${c.time_change_ms > 0 ? "pos" : c.time_change_ms < 0 ? "neg" : ""}">${c.time_change_ms > 0 ? "+" : ""}${c.time_change_ms}ms</td>
        <td>${r0(c.subject_entry_speed)} / ${r0(c.subject_min_speed)} / ${r0(c.subject_exit_speed)} <span class="hint">vs</span> ${r0(c.reference_entry_speed)} / ${r0(c.reference_min_speed)} / ${r0(c.reference_exit_speed)}</td>
        <td>${brakeCell(c)}</td>
        <td>${r2(c.subject_avg_steer)} · ${c.subject_steer_reversals} <span class="hint">vs</span> ${r2(c.reference_avg_steer)} · ${c.reference_steer_reversals}</td></tr>`;
    })
    .join("");
}

// ============================================================ AI analysis

const REPORT_SECTIONS = [
  "Top focus areas", "Steering comparison", "Map character", "Section-by-section", "Practice plan",
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
  setStatus(statusEl, `Briefing the AI on ${runLabel(state.subjectId)} vs ${runLabel(refId)} — deeper analyses take longer (up to a few minutes)…`);

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
      showMemoryNote(data.memory);
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
  note.textContent = `Free AI analyses: ${bits.join(" · ")}. Paste your own NVIDIA key in Settings for unlimited use.`;
}

function showMemoryNote(memory) {
  const note = $("#memory-note");
  note.hidden = false;
  note.innerHTML = `Saved this session's findings in your browser so the next analysis can check whether you improved. <a href="#" id="forget-memory">Forget them</a>`;
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

// ============================================================ legacy migration & settings wiring

// Earlier versions of this app saved runs on the server (data/*.json). Copy
// them into the browser once so nothing is lost; the files stay untouched.
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
  $("#player-search-btn").addEventListener("click", searchPlayers);
  $("#player-search-input").addEventListener("keydown", (e) => e.key === "Enter" && searchPlayers());
  $("#map-search-btn").addEventListener("click", searchMaps);
  $("#map-search-input").addEventListener("keydown", (e) => e.key === "Enter" && searchMaps());
  $("#upload-btn").addEventListener("click", handleUpload);
  $("#analyze-btn").addEventListener("click", handleAnalyze);
  $("#depth-select").addEventListener("change", (e) => LS.set("tm_depth", e.target.value));
  $("#settings-btn").addEventListener("click", () => openSettings());

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
    await Promise.all([loadRuns(), renderLibrary()]);
    setStatus($("#settings-status"), "Deleted.", "ok");
  });
}

async function init() {
  wire();
  loadSettingsFields();
  await loadHealth();
  await migrateLegacy();
  await renderLibrary();
  searchMaps();
}

init();
