"use strict";

// The Progress tab: how you are getting on with this map. Your own runs, oldest first: the time of each against the
// medals, how each stretch between checkpoints has moved, and, by comparing every run of yours with the same ghost,
// which corners are improving and which are stuck. It ends with a concrete target for the next session.
//
// The stretch numbers come straight from the checkpoint times stored with each run. The corner numbers need one
// comparison per run (done here, one after another, and remembered so the tab opens instantly next time).
//
// Relies on app.js for shared state and helpers (state, $, esc, fmtTime, fmtGap, postJson, runLabel) and on Store.

const Progress = (() => {
  const CACHE_V = "v1";
  const MAX_RUNS = 8;                      // the most recent runs get the corner analysis
  const P = { key: null, chart: null, token: 0, corner: {} };

  const own = () => state.runs.filter((r) => r.kind === "run" && r.race_time_ms != null)
    .sort((a, b) => String(a.uploaded_at || "").localeCompare(String(b.uploaded_at || "")) || a.race_time_ms - b.race_time_ms);

  const segs = (cps) => cps.map((t, i) => t - (i ? cps[i - 1] : 0));
  const secs = (ms, d = 3) => (Math.abs(ms) / 1000).toFixed(d);
  const sec = (ms) => `${ms < 0 ? "−" : "+"}${secs(ms)} s`;

  // the slope of a series, in units per step
  function slope(ys) {
    const n = ys.length;
    if (n < 2) return 0;
    const mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
    let c = 0, v = 0;
    ys.forEach((y, i) => { c += (i - mx) * (y - my); v += (i - mx) ** 2; });
    return v ? c / v : 0;
  }

  // lower is better for every series here (time lost, segment time)
  function verdict(ys, unit) {
    if (ys.length < 2) return { word: "one run", cls: "flat" };
    const s = slope(ys), first = ys[0], last = ys[ys.length - 1];
    if (ys.length === 2) { const d = last - first; return d <= -unit * 2 ? { word: "improving", cls: "up" } : d >= unit * 2 ? { word: "slipping", cls: "down" } : { word: "steady", cls: "flat" }; }
    if (s <= -unit && last < first) return { word: "improving", cls: "up" };
    if (s >= unit && last > first) return { word: "slipping", cls: "down" };
    return { word: "steady", cls: "flat" };
  }

  // a small line where up means better
  function spark(ys, cls) {
    if (ys.length < 2) return `<span class="pg-spark none">–</span>`;
    const w = 96, h = 26, lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
    const X = (i) => 3 + (i / (ys.length - 1)) * (w - 6), Y = (v) => 3 + ((v - lo) / span) * (h - 6);      // a lower value draws higher
    const pts = ys.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    return `<svg class="pg-spark ${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${X(ys.length - 1).toFixed(1)}" cy="${Y(ys[ys.length - 1]).toFixed(1)}" r="3"/></svg>`;
  }

  const dateLabel = (r) => { const d = r.uploaded_at ? new Date(r.uploaded_at) : null; return d && !isNaN(d) ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""; };

  // ------------------------------------------------------------------ corner analysis, one comparison per run

  const refId = () => {
    if (state.primaryRefId && state.runs.some((r) => r.id === state.primaryRefId)) return state.primaryRefId;
    const g = state.runs.filter((r) => r.kind !== "run" && r.telemetry_available && r.race_time_ms != null).sort((a, b) => a.race_time_ms - b.race_time_ms)[0];
    return g ? g.id : null;
  };

  async function cornerSummary(run, ref, token, setNote) {
    const mk = `progress:${CACHE_V}:${run.map_uid}:${ref.id}:${run.id}`;
    if (P.corner[mk]) return P.corner[mk];
    let cached = null;
    try { cached = await Store.getMemory(mk); } catch (e) { /* no cache */ }
    if (cached) return (P.corner[mk] = cached);
    const [full] = await Store.getRuns([run.id]), [refFull] = await Store.getRuns([ref.id]);
    if (!full || !refFull || !full.samples || !full.samples.length) return null;
    const strip = (r) => ({ id: r.id, map_uid: r.map_uid, map_name: r.map_name, player_nickname: r.player_nickname, race_time_ms: r.race_time_ms, checkpoints: r.checkpoints || null, samples: r.samples || [] });
    const data = await postJson("/api/compare", { subject: strip(full), references: [strip(refFull)], tags: ((state.map && state.map.tags) || []).map(String).slice(0, 30) });
    if (token !== P.token) return null;
    const d = data[ref.id] || Object.values(data)[0];
    if (!d || !d.corners) return null;
    const sum = { final: d.stats && d.stats.final_delta_ms, corners: d.corners.map((c) => ({ i: c.corner_index, ms: c.time_change_ms, d0: c.distance_start, dir: c.direction, deg: c.turn_deg, min: c.subject_min_speed, rmin: c.reference_min_speed, ex: c.subject_exit_speed, rex: c.reference_exit_speed })) };
    P.corner[mk] = sum;
    try { await Store.putMemory(mk, sum); } catch (e) { /* cache is a convenience */ }
    return sum;
  }

  // ------------------------------------------------------------------ rendering

  function template() {
    return `<div class="pg">
      <div class="pg-kpis"></div>
      <section class="pg-card"><h3>Your times <small>faster is higher; the dashed lines are the medals</small></h3><div class="pg-chartbox"><canvas class="pg-chart"></canvas></div></section>
      <section class="pg-card pg-target"><h3>Next session <small>a concrete target, from your own runs</small></h3><div class="pg-targets"></div></section>
      <div class="pg-two">
        <section class="pg-card"><h3>Corners <small>time lost against the same ghost, run after run</small></h3><div class="pg-corners"><p class="hint">Working it out…</p></div></section>
        <section class="pg-card"><h3>Stretches between checkpoints <small>the time each took, run after run</small></h3><div class="pg-stretches"></div></section>
      </div>
    </div>`;
  }

  function kpis(runs, best) {
    const first = runs[0], gain = first.race_time_ms - best;
    const per = runs.length > 1 ? gain / (runs.length - 1) : null;
    const cells = [
      ["Runs", String(runs.length), runs.length > 1 ? `${dateLabel(first)} to ${dateLabel(runs[runs.length - 1])}` : "add another to see progress"],
      ["Best", fmtTime(best), "your personal best"],
      ["Since the first run", runs.length > 1 ? `${gain > 0 ? "−" : "+"}${secs(gain)} s` : "–", runs.length > 1 ? `${fmtTime(first.race_time_ms)} to ${fmtTime(best)}` : "needs two runs"],
      ["Gain per run", per != null ? `${per > 0 ? "−" : "+"}${secs(per)} s` : "–", per != null ? "on average since the first" : ""],
    ];
    return cells.map((c) => `<div class="pg-kpi"><b class="mono">${esc(c[1])}</b><span>${esc(c[0])}</span><small>${esc(c[2])}</small></div>`).join("");
  }

  function chart(runs) {
    const canvas = $(".pg-chart", $("#progress-body"));
    if (P.chart) { P.chart.destroy(); P.chart = null; }
    if (typeof Chart === "undefined") return;
    const labels = runs.map((r, i) => `#${i + 1}${dateLabel(r) ? " · " + dateLabel(r) : ""}`);
    const times = runs.map((r) => r.race_time_ms / 1000);
    let run = Infinity;
    const pb = times.map((t) => (run = Math.min(run, t)));
    const med = (state.map && state.map.medals) || {};
    const lines = [["author", "Author", "#2fe3a2"], ["gold", "Gold", "#ffc247"], ["silver", "Silver", "#b4bfd6"], ["bronze", "Bronze", "#d08a5a"]]
      .filter(([k]) => typeof med[k] === "number").map(([k, name, col]) => ({ label: name, data: runs.map(() => med[k] / 1000), borderColor: col, borderDash: [5, 5], borderWidth: 1.2, pointRadius: 0, fill: false }));
    P.chart = new Chart(canvas, {
      type: "line",
      data: { labels, datasets: [
        { label: "Your runs", data: times, borderColor: "#8f7bff", backgroundColor: "#8f7bff", pointRadius: 5, pointHoverRadius: 7, borderWidth: 2, tension: 0.15 },
        { label: "Personal best so far", data: pb, borderColor: "#eef2fb", borderWidth: 1.5, stepped: true, pointRadius: 0, borderDash: [2, 3] },
        ...lines,
      ] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 500 },
        scales: { y: { reverse: true, grid: { color: "#223049" }, ticks: { color: "#b4bfd6", callback: (v) => fmtTime(Math.round(v * 1000)) } }, x: { grid: { display: false }, ticks: { color: "#b4bfd6" } } },
        plugins: { legend: { labels: { color: "#b4bfd6", boxWidth: 14 } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtTime(Math.round(c.parsed.y * 1000))}` } } },
      },
    });
  }

  // the checkpoint stretches, straight from the stored times
  function stretches(runs) {
    const box = $(".pg-stretches", $("#progress-body"));
    const withCp = runs.filter((r) => Array.isArray(r.checkpoints) && r.checkpoints.length > 1);
    const n = withCp.length ? withCp[withCp.length - 1].checkpoints.length : 0;
    const set = withCp.filter((r) => r.checkpoints.length === n);
    if (!set.length) { box.innerHTML = `<p class="hint">These runs have no checkpoint times stored, so the stretches can't be split.</p>`; return null; }
    const all = set.map((r) => segs(r.checkpoints));
    const label = (i) => `${i === 0 ? "Start" : "CP " + i} → ${i === n - 1 ? "Finish" : "CP " + (i + 1)}`;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const ys = all.map((s) => s[i]), best = Math.min(...ys), latest = ys[ys.length - 1], v = verdict(ys, 8);
      rows.push({ i, label: label(i), ys, best, latest, v, gap: latest - best });
    }
    box.innerHTML = `<table class="pg-table"><thead><tr><th>Stretch</th><th>Best</th><th>Latest</th><th>Latest vs best</th><th>Trend</th></tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${esc(r.label)}</td><td class="mono">${secs(r.best)}</td><td class="mono">${secs(r.latest)}</td>
      <td class="mono ${r.gap > 4 ? "loss" : "gain"}">${r.gap > 4 ? "+" + secs(r.gap) : "best"}</td><td>${spark(r.ys, r.v.cls)} <em class="${r.v.cls}">${r.v.word}</em></td></tr>`).join("")}</tbody></table>
      <p class="hint">${set.length < 2 ? "Only one run has checkpoint times, so there is no trend yet." : `${set.length} runs compared. "Latest vs best" is how much faster your own best run was through that stretch.`}</p>`;
    return { rows, set, ult: rows.reduce((a, r) => a + r.best, 0) };
  }

  function corners(runs, summaries, ref) {
    const box = $(".pg-corners", $("#progress-body"));
    const list = summaries.filter(Boolean);
    if (!list.length) { box.innerHTML = `<p class="hint">${ref ? "Couldn't analyse these runs against the ghost." : "Switch a ghost on in the run list to compare your runs corner by corner."}</p>`; return null; }
    // match corners across runs by index, if they are in the same place
    const base = list[list.length - 1].corners, rows = [];
    for (const c of base) {
      const ys = list.map((s) => { const m = s.corners.find((x) => x.i === c.i && Math.abs(x.d0 - c.d0) < 40); return m ? m.ms : null; });
      if (ys.some((y) => y == null)) continue;
      const v = verdict(ys, 3), latest = ys[ys.length - 1], bestV = Math.min(...ys);
      rows.push({ c, ys, v, latest, best: bestV });
    }
    rows.sort((a, b) => (b.latest + (b.v.cls === "up" ? -30 : 0)) - (a.latest + (a.v.cls === "up" ? -30 : 0)));
    box.innerHTML = `<table class="pg-table"><thead><tr><th>Corner</th><th>Lost now</th><th>Best so far</th><th>Trend</th></tr></thead><tbody>${rows.map((r) => `<tr>
      <td><b>${r.c.i}</b> <small>${esc(r.c.dir)} ${r.c.deg}°</small></td><td class="mono ${r.latest > 4 ? "loss" : "gain"}">${r.latest > 4 ? sec(-r.latest) : r.latest < -4 ? "+" + secs(r.latest) + " s" : "level"}</td>
      <td class="mono">${r.best > 4 ? sec(-r.best) : "level or ahead"}</td><td>${spark(r.ys, r.v.cls)} <em class="${r.v.cls}">${r.v.word}</em></td></tr>`).join("")}</tbody></table>
      <p class="hint">Against ${esc(ref ? runLabel(ref.id) : "the ghost")}${list.length < 2 ? ". Only one run could be analysed, so there is no trend yet." : `, over ${list.length} runs. Rows with the most time still lost come first.`}</p>`;
    return rows;
  }

  function targets(runs, best, st, cr) {
    const box = $(".pg-targets", $("#progress-body")), out = [];
    const med = (state.map && state.map.medals) || {};
    if (st && st.set.length >= 2) {
      const ult = st.ult, gain = best - ult;
      if (gain > 15) out.push(["goal", `<b>Beat ${fmtTime(best)}.</b> Your own best stretches add up to <b class="mono">${fmtTime(Math.round(ult))}</b>, so ${secs(gain)} s is already in you. Put your best stretches into one lap.`]);
      const worst = [...st.rows].sort((a, b) => b.gap - a.gap)[0];
      if (worst && worst.gap > 20) out.push(["work", `<b>${esc(worst.label)}</b> is where your latest run was furthest from your best: ${secs(worst.gap)} s slower than you have driven it before.`]);
    } else if (st) {
      out.push(["info", "Only one of your runs has checkpoint times, so your own best stretches can't be added up yet. Drive or add another run."]);
    }
    if (cr && cr.length) {
      const stuck = cr.filter((r) => r.latest > 12 && r.v.cls !== "up").sort((a, b) => b.latest - a.latest).slice(0, 2);
      for (const r of stuck) out.push(["work", `<b>Corner ${r.c.i}</b> (${esc(r.c.dir)} ${r.c.deg}°) still loses ${secs(r.latest)} s and ${r.v.cls === "down" ? "is getting worse" : r.ys.length > 1 ? "has not improved" : "is the one to start with"}${r.best < r.latest - 8 ? `; you have done it ${secs(r.latest - r.best)} s better before` : ""}. Open it in the Replay and watch the coach note.`]);
      const up = cr.filter((r) => r.v.cls === "up").sort((a, b) => (a.ys[0] - a.latest) - (b.ys[0] - b.latest)).pop();
      if (up && up.ys[0] - up.latest > 10) out.push(["good", `<b>Corner ${up.c.i}</b> is coming along: from ${sec(-up.ys[0])} to ${up.latest > 4 ? sec(-up.latest) : "level with the ghost"}. Keep doing what you are doing there.`]);
    }
    const medals = [["author", "the author medal"], ["gold", "gold"], ["silver", "silver"], ["bronze", "bronze"]].filter(([k]) => typeof med[k] === "number" && med[k] < best);
    if (medals.length) { const [k, name] = medals[medals.length - 1]; out.push(["goal", `<b>Next medal: ${name}</b>, ${secs(best - med[k])} s faster than your best (${fmtTime(med[k])}).`]); }
    else if (typeof med.author === "number") out.push(["good", `You have the author medal (${fmtTime(med.author)}).`]);
    if (!out.length) out.push(["info", "Add a second run of yours on this map and this page will show what is improving and what to work on."]);
    box.innerHTML = out.map(([k, html]) => `<div class="pg-t ${k}"><i></i><p>${html}</p></div>`).join("");
  }

  async function render() {
    const root = $("#progress-body");
    if (!root) return;
    const runs = own();
    const key = [runs.map((r) => r.id + ":" + r.race_time_ms).join(","), refId() || "", (state.map && state.map.medals && state.map.medals.author) || ""].join("|");
    if (P.key === key && root.querySelector(".pg")) return;
    P.key = key; const token = ++P.token;
    if (!runs.length) { root.innerHTML = `<div class="hint">No runs of yours on this map yet. Import one (a replay file or your account's record) and mark it as "my run".</div>`; return; }
    root.innerHTML = template();
    const best = Math.min(...runs.map((r) => r.race_time_ms));
    root.querySelector(".pg-kpis").innerHTML = kpis(runs, best);
    chart(runs);
    const st = stretches(runs);
    targets(runs, best, st, null);
    // the corner trends need a comparison per run: the most recent runs, oldest first
    const ref = state.runs.find((r) => r.id === refId());
    if (!ref) { corners(runs, [], null); return; }
    const todo = runs.filter((r) => r.telemetry_available && r.id !== ref.id).slice(-MAX_RUNS), sums = [];
    const note = root.querySelector(".pg-corners");
    for (let i = 0; i < todo.length; i++) {
      if (token !== P.token) return;
      note.innerHTML = `<p class="hint">Analysing your run ${i + 1} of ${todo.length} against ${esc(runLabel(ref.id))}…</p>`;
      try { sums.push(await cornerSummary(todo[i], ref, token)); } catch (e) { sums.push(null); }
    }
    if (token !== P.token) return;
    const cr = corners(runs, sums, ref);
    targets(runs, best, st, cr);
  }

  return {
    show() { render(); },
    invalidate() { P.key = null; },
  };
})();
