"use strict";

// The overview's "Skills" section: every driving skill found in the run (speed drifts, slides, air-brakes,
// jumps, landings, flips, wall-rides, boosts and the mistakes), set against the same skills in the ghost.
// The server finds and matches them (backend/skills.py); this file draws the cards.
// Relies on app.js for state, esc, $, $$, setHighlight and on lap.js for the ground under a distance.

const SKILL_STATUS = {
  missing: { cls: "bad", text: "Ghost uses it, you don't" },
  behind: { cls: "bad", text: "Ghost uses it more" },
  worse: { cls: "bad", text: "You make more of these" },
  ahead: { cls: "good", text: "You use it more" },
  better: { cls: "good", text: "Fewer than the ghost" },
  level: { cls: "", text: "Same as the ghost" },
  more: { cls: "", text: "You use it more" },
  fewer: { cls: "", text: "You use it less" },
  unused: { cls: "", text: "Not in either run" },
};

const SKILLS_UI = { open: new Set(), showUnused: false };

// the surface at a distance along the lap, as a small coloured chip
function skillGround(dist) {
  const p = currentPrimary();
  const run = groundRuns(p).find((r) => dist >= r.from && dist <= r.to);
  return run ? ` <span class="ground-chip"><i style="background:${groundColor(run.surf)}"></i>${esc(groundName(run.surf))}</span>` : "";
}

const skillN = (v, unit) => (v === null || v === undefined ? "–" : `${v}${unit || ""}`);

function skillMetrics(m) {
  if (!m || !m.you || !m.ghost) return "";
  const rows = [
    ["Top speed", "top_speed", " km/h"], ["Average speed", "avg_speed", " km/h"], ["Full throttle", "full_throttle_pct", "%"],
    ["Braking", "brake_pct", "%"], ["Sliding", "sliding_pct", "%"], ["Above 180 km/h", "drift_window_pct", "%"],
  ];
  return `<div class="sk-metrics">${rows.map(([label, key, unit]) => `<div class="sk-metric"><small>${label}</small>
      <b>${skillN(m.you[key], unit)}</b><span>vs ${skillN(m.ghost[key], unit)}</span></div>`).join("")}</div>`;
}

function skillEvents(row, def) {
  if (!row.events.length) return "";
  return `<div class="sk-events">${row.events.map((e) => {
    const who = e.who === "both" ? "Both" : e.who === "you" ? "Only you" : "Only the ghost";
    const lines = e.who === "both"
      ? `<span><em>You</em> ${esc(e.you)}</span><span><em>Ghost</em> ${esc(e.ghost)}</span>`
      : `<span>${esc(e.who === "you" ? e.you : e.ghost)}</span>`;
    return `<button type="button" class="sk-event ${e.who}" data-from="${Math.max(0, e.start_m - 25)}" data-to="${e.end_m + 25}" data-title="${esc(def.name)} · ${Math.round(e.dist_m)} m">
      <b>${Math.round(e.dist_m)} m</b><i>${who}</i>${skillGround(e.dist_m)}${lines}</button>`;
  }).join("")}</div>`;
}

function skillCard(row, def) {
  const st = SKILL_STATUS[row.status] || SKILL_STATUS.level;
  const open = SKILLS_UI.open.has(row.id);
  return `<div class="sk-card ${st.cls} ${open ? "open" : ""}" data-id="${row.id}">
    <button type="button" class="sk-head" aria-expanded="${open}">
      <span class="sk-glyph">${def.glyph}</span>
      <span class="sk-name">${esc(def.name)}<small>${esc(def.group)}</small></span>
      <span class="sk-count"><b>${row.you}</b><i>you</i></span>
      <span class="sk-count ghost"><b>${row.ghost}</b><i>ghost</i></span>
      <span class="sk-status">${esc(st.text)}${row.you && row.ghost ? ` · ${row.both} at the same place` : ""}</span>
    </button>
    <div class="sk-body" ${open ? "" : "hidden"}>
      <p class="sk-what">${esc(def.what)}</p>
      ${skillEvents(row, def)}
      <p class="sk-try"><b>Try:</b> ${esc(def.try)}</p>
    </div>
  </div>`;
}

function renderSkills(primary) {
  const area = $("#skills-area");
  const rep = primary && primary.stats.telemetry ? primary.skills : null;
  area.hidden = !rep;
  if (!rep) return;
  const defs = Object.fromEntries(rep.catalogue.map((d) => [d.id, d]));
  const known = rep.rows.filter((r) => r.status !== "unknown");  // "unknown": needs the car's orientation, which one run lacks
  const used = known.filter((r) => r.you || r.ghost);
  const unused = known.filter((r) => !r.you && !r.ghost);
  // what the ghost has and you lack comes first, then the rest by how much happens
  const weight = (r) => (["missing", "behind", "worse"].includes(r.status) ? 0 : 1);
  used.sort((a, b) => weight(a) - weight(b) || (b.you + b.ghost) - (a.you + a.ghost));
  const gaps = used.filter((r) => weight(r) === 0).length;
  $("#skills-hint").textContent = used.length
    ? `${used.length} skill${used.length === 1 ? "" : "s"} found${gaps ? `, ${gaps} where the ghost does something you don't, or you give time away` : ""}. Select one to see where, and to see it on the graphs.`
    : "Neither run shows any of the skills this page looks for.";
  const note = rep.oriented ? "" : `<div class="notice">One of these runs has no record of the car's orientation, so slides, landings and wall-rides can't be found in it.</div>`;
  $("#skills-body").innerHTML = `${note}${skillMetrics(rep.metrics)}
    <div class="sk-grid">${used.map((r) => skillCard(r, defs[r.id])).join("")}</div>
    <div class="sk-unused">
      <button type="button" class="btn tiny quiet" id="sk-unused-toggle">${SKILLS_UI.showUnused ? "Hide" : "Show"} skills not seen in either run (${unused.length})</button>
      <div class="sk-unused-list" ${SKILLS_UI.showUnused ? "" : "hidden"}>
        ${unused.map((r) => `<div class="sk-ghosted"><b>${defs[r.id].glyph} ${esc(defs[r.id].name)}</b><span>${esc(defs[r.id].what)}</span></div>`).join("")}
        <div class="sk-ghosted"><b>Can't be seen in a replay</b><span>${rep.not_visible.map(esc).join(". ")}.</span></div>
      </div>
    </div>`;

  $$(".sk-head", area).forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = btn.closest(".sk-card").dataset.id;
      if (SKILLS_UI.open.has(id)) SKILLS_UI.open.delete(id); else SKILLS_UI.open.add(id);
      renderSkills(currentPrimary());
    })
  );
  $$(".sk-event", area).forEach((btn) =>
    btn.addEventListener("click", () => {
      const from = +btn.dataset.from, to = +btn.dataset.to;
      const same = state.highlight && state.highlight.from === from && state.highlight.to === to;
      setHighlight(same ? null : { from, to, title: btn.dataset.title, section: null });
      if (!same) $("#lap-area").scrollIntoView({ behavior: "smooth", block: "start" });
    })
  );
  const toggle = $("#sk-unused-toggle");
  if (toggle) toggle.addEventListener("click", () => { SKILLS_UI.showUnused = !SKILLS_UI.showUnused; renderSkills(currentPrimary()); });
}
