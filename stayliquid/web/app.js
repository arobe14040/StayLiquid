// All fetch() calls are relative (no leading slash) because Ingress serves
// this add-on under a dynamic sub-path - an absolute "/api/..." URL would
// break outside of local dev.

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

// Matches PRECIP_RATE_IN_PER_HR in app/presets.py - a typical residential
// spray zone. Every water estimate in the UI scales linearly off this.
const PRECIP_RATE = 0.4;

const QUICK_CYCLES = {
  1: ["06:00"],
  2: ["08:00", "13:00"],
  3: ["08:00", "11:30", "15:00"],
};

const STATUS_PILL = {
  completed: "pill-quiet",
  running: "pill-on",
  error: "pill-danger",
  interrupted: "pill-warn",
  stopped: "pill-quiet",
  paused_expired: "pill-warn",
  skipped_paused: "pill-warn",
  stopped_external: "pill-quiet",
  skipped_rain_delay: "pill-warn",
  skipped_unavailable: "pill-warn",
};
const STATUS_LABEL = {
  completed: "Completed",
  running: "Running",
  error: "Error",
  interrupted: "Interrupted - add-on restarted",
  stopped: "Stopped early",
  paused_expired: "Ended - paused too long",
  skipped_paused: "Skipped - watering paused",
  stopped_external: "Switched off in Home Assistant",
  skipped_rain_delay: "Skipped - rain delay",
  skipped_unavailable: "Skipped - zone unavailable",
};

let zonesCache = [];
let presetsCache = [];

const builder = {
  editingId: null,
  autoName: "",        // the last name we filled in ourselves, so we can replace it
  stage: "custom",
  presetName: "",
  scheduleType: "weekdays",
  weekdays: new Set(),
  intervalDays: 3,
  defaultMinutes: 10,  // drives every zone's runtime; overridable per zone later
  cycles: [],
  zones: [],
  runMode: "sequential",
};

// ---- fetch helper -----------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    throw new Error(errorText(body) || res.statusText);
  }
  return body;
}
const apiGet = (p) => api(p);
const apiPost = (p, data) => api(p, { method: "POST", body: JSON.stringify(data) });
const apiPut = (p, data) => api(p, { method: "PUT", body: JSON.stringify(data) });
const apiPatch = (p) => api(p, { method: "PATCH" });
const apiDelete = (p) => api(p, { method: "DELETE" });

function errorText(body) {
  if (!body) return null;
  const detail = body.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => d.msg || JSON.stringify(d)).join("; ");
  return JSON.stringify(body);
}

// ---- small helpers ----------------------------------------------------------

function el(id) { return document.getElementById(id); }

// Counts elements the script expected but didn't find. That happens when a
// browser pairs a fresh app.js with an index.html it still has cached, and
// wiring up a missing node used to throw and kill every later line in the file
// - including constants, so unrelated tabs failed with confusing errors.
let missingNodes = 0;

function on(id, event, handler) {
  const node = el(id);
  if (!node) {
    missingNodes += 1;
    console.warn(`StayLiquid: #${id} is not on the page - is index.html stale?`);
    return;
  }
  node.addEventListener(event, handler);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function toast(message, kind = "ok") {
  const host = el("toasts");
  if (!host) return console.warn(`StayLiquid: ${message}`);
  const div = document.createElement("div");
  div.className = `toast ${kind === "error" ? "error" : ""}`;
  div.textContent = message;
  host.appendChild(div);
  setTimeout(() => div.remove(), 3600);
}

// ---- confirm dialog ---------------------------------------------------------

let settleConfirm = null;

/**
 * Shared dialog. With `field` it collects a line of text and resolves to the
 * trimmed string (or null if dismissed); without, it resolves true/false.
 */
function openDialog({ title, message, confirmLabel = "Confirm", danger = false, field = null }) {
  const modal = el("confirm-modal");
  // If the markup isn't there (a stale index.html), fall back to the browser's
  // own dialogs rather than silently doing nothing.
  if (!modal) {
    return Promise.resolve(field ? window.prompt(message, field.value ?? "") : window.confirm(message));
  }

  return new Promise((resolve) => {
    // A second request would strand the first promise, so close that one out.
    if (settleConfirm) settleConfirm(null);

    const previous = document.activeElement;
    el("confirm-title").textContent = title;
    el("confirm-message").textContent = message;
    modal.querySelector(".modal").setAttribute("role", field ? "dialog" : "alertdialog");

    const ok = el("confirm-ok");
    ok.textContent = confirmLabel;
    ok.className = `btn ${danger ? "btn-danger-solid" : "btn-primary"}`;
    ok.disabled = false;

    const fieldWrap = el("confirm-field");
    const input = el("confirm-input");
    fieldWrap.hidden = !field;
    if (field) {
      el("confirm-field-label").textContent = field.label;
      input.value = field.value ?? "";
      input.placeholder = field.placeholder ?? "";
      ok.disabled = !input.value.trim();
    }

    modal.hidden = false;
    document.body.style.overflow = "hidden";
    if (field) {
      input.focus();
      input.select();
    } else {
      // Focus the safe choice when the action can't be undone, so a stray Enter
      // cancels instead of deleting.
      (danger ? el("confirm-cancel") : ok).focus();
    }

    settleConfirm = (answer) => {
      settleConfirm = null;
      modal.hidden = true;
      // The builder modal may still be open underneath and wants the lock kept.
      document.body.style.overflow = el("program-modal")?.hidden === false ? "hidden" : "";
      if (previous) previous.focus();
      resolve(answer);
    };
  });
}

/** Resolves true if the user goes ahead. */
function askConfirm(options) {
  return openDialog(options).then((answer) => answer === true);
}

/** Resolves the trimmed text, or null if the user backed out. */
function askText(options) {
  return openDialog({ ...options, field: options.field ?? { label: "", value: "" } })
    .then((answer) => (typeof answer === "string" && answer.trim() ? answer.trim() : null));
}

function submitDialog() {
  const input = el("confirm-input");
  if (el("confirm-field").hidden) return settleConfirm?.(true);
  const value = input.value.trim();
  if (value) settleConfirm?.(value);
}

on("confirm-ok", "click", submitDialog);
on("confirm-cancel", "click", () => settleConfirm?.(null));
on("confirm-modal", "click", (e) => {
  if (e.target === el("confirm-modal")) settleConfirm?.(null);
});
on("confirm-input", "input", (e) => {
  el("confirm-ok").disabled = !e.target.value.trim();
});
on("confirm-input", "keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitDialog();
  }
});

async function guard(fn, successMessage) {
  try {
    await fn();
    if (successMessage) toast(successMessage);
  } catch (e) {
    toast(e.message || "Something went wrong.", "error");
  }
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

function fmt12(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${period}`;
}

function minutesTo12(total) {
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, "0");
  const mm = String(wrapped % 60).padStart(2, "0");
  const label = fmt12(`${hh}:${mm}`);
  return total >= 1440 ? `${label} +1d` : label;
}

function cycleLabel(hhmm) {
  const m = toMinutes(hhmm);
  if (m < 11 * 60) return "Morning";
  if (m < 14 * 60) return "Midday";
  if (m < 18 * 60) return "Afternoon";
  if (m < 21 * 60) return "Evening";
  return "Night";
}

// Rounded to hundredths the same way the backend does, so a day's total is
// 3 x 0.07" rather than 3 x 0.0667" - it has to match the number on the card.
function inchesFor(minutes) {
  return Math.round((Number(minutes) || 0) / 60 * PRECIP_RATE * 100) / 100;
}

function fmtInches(value) {
  return `${value.toFixed(2).replace(/^0/, "")}"`;
}

function fmtDuration(minutes) {
  const total = Math.round(Number(minutes) || 0);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

// ---- time, as it is at the lawn ---------------------------------------------

// Every clock time and "today" on the page is Home Assistant's - the timezone
// the schedule runs in - not the browser's. Viewed from another zone the page
// would otherwise put "Next run 10:03 PM" beside a program's 9:03 PM cycle, and
// ask the server for the wrong day's history around midnight.
// Unset until the first status arrives, which means the browser's own zone.
let lawnTimeZone;

function setLawnTimeZone(name) {
  if (!name || name === lawnTimeZone) return;
  try {
    new Intl.DateTimeFormat([], { timeZone: name });   // throws on an unknown zone
    lawnTimeZone = name;
  } catch {
    console.warn(`StayLiquid: "${name}" isn't a timezone this browser knows; showing local times.`);
  }
}

function inLawnZone(options) {
  return lawnTimeZone ? { ...options, timeZone: lawnTimeZone } : options;
}

/** The lawn's calendar date at an instant, as "YYYY-MM-DD". */
function lawnDate(when = Date.now()) {
  // en-CA formats dates as YYYY-MM-DD, which is exactly the API's shape.
  return new Intl.DateTimeFormat("en-CA", inLawnZone({ year: "numeric", month: "2-digit", day: "2-digit" }))
    .format(new Date(when));
}

/** How far the lawn's zone is from UTC at an instant, in ms (DST-aware). */
function lawnOffsetMs(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", inLawnZone({
      hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    })).formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)])
  );
  const wallClockAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallClockAsUtc - Math.floor(ms / 1000) * 1000;
}

function fmtDateTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString([], inLawnZone({
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }));
}

function fmtClock(when) {
  return when
    ? new Date(when).toLocaleTimeString([], inLawnZone({ hour: "numeric", minute: "2-digit" }))
    : "";
}

function isToday(when) {
  return lawnDate(when) === lawnDate();
}

function fmtRelative(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Turning a zone on from here always runs it for a fixed spell rather than
// opening the valve indefinitely - a switch with no timer behind it is one
// forgotten tap away from watering all night.
const QUICK_RUN_MINUTES = 10;

const zoneTiles = new Map();   // zone id -> the tile's elements

/**
 * The zone switches. Built once and then patched, so the poll can't rebuild
 * the row someone is mid-tap on, and so a pending toggle isn't yanked back by
 * a status response that predates it.
 */
function renderZonePanel(status) {
  const zones = status.zones || [];
  const host = el("zone-toggles");
  const paused = status.pause?.active;

  el("zone-panel-hint").textContent = zones.length
    ? `Turning one on waters it for ${QUICK_RUN_MINUTES} minutes. Shows the valve's real state, however it was opened.`
    : "";

  const on = zones.filter((z) => z.state === "on").length;
  const count = el("zone-panel-count");
  count.textContent = !zones.length ? "none yet" : on ? `${on} open` : "all closed";
  count.className = `pill ${on ? "pill-on" : "pill-quiet"}`;

  if (!zones.length) {
    host.innerHTML = `<div class="empty">No zones yet - add them on the Zones tab.</div>`;
    zoneTiles.clear();
    return;
  }

  // Rebuild only when the set of zones changes, not on every poll.
  const signature = zones.map((z) => `${z.id}:${z.name}`).join("|");
  if (host.dataset.signature !== signature) {
    host.dataset.signature = signature;
    host.innerHTML = "";
    zoneTiles.clear();

    zones.forEach((zone) => {
      const tile = document.createElement("div");
      tile.className = "zone-tile";
      tile.innerHTML = `
        <button type="button" class="switch-toggle" role="switch" aria-checked="false">
          <span class="switch-track"><span class="switch-knob"></span></span>
        </button>
        <div class="zone-tile-meta">
          <div class="zone-tile-name" title="${escapeHtml(zone.name)}">${escapeHtml(zone.name)}</div>
          <div class="zone-tile-state"></div>
        </div>
      `;
      const button = tile.querySelector(".switch-toggle");
      button.addEventListener("click", () => toggleZone(zone.id, button));
      zoneTiles.set(zone.id, { tile, button, state: tile.querySelector(".zone-tile-state") });
      host.appendChild(tile);
    });
  }

  zones.forEach((zone) => {
    const refs = zoneTiles.get(zone.id);
    if (!refs || refs.button.dataset.pending === "true") return;

    const isOn = zone.state === "on";
    const unknown = zone.state == null;

    refs.button.setAttribute("aria-checked", String(isOn));
    refs.button.setAttribute("aria-label", `${isOn ? "Turn off" : "Turn on"} ${zone.name}`);
    refs.button.disabled = unknown || (!isOn && (paused || !zone.enabled));
    refs.tile.classList.toggle("is-on", isOn);
    refs.tile.classList.toggle("is-unknown", unknown);

    refs.state.textContent = unknown
      ? "State unknown"
      : isOn
        ? zone.running ? "Watering" : "On - opened elsewhere"
        : !zone.enabled ? "Disabled" : paused ? "Paused" : "Off";
  });
}

function toggleZone(zoneId, button) {
  const turningOn = button.getAttribute("aria-checked") !== "true";

  // Flip straight away rather than waiting out the round trip, which makes the
  // switch feel broken. The label changes too - left alone it contradicts the
  // switch ("Watering" beside an off switch) until the request comes back.
  const tile = button.closest(".zone-tile");
  button.dataset.pending = "true";
  button.setAttribute("aria-checked", String(turningOn));
  tile.classList.toggle("is-on", turningOn);
  tile.querySelector(".zone-tile-state").textContent = turningOn ? "Starting…" : "Stopping…";

  guard(async () => {
    try {
      if (turningOn) {
        await apiPost(`api/zones/${zoneId}/run`, { minutes: QUICK_RUN_MINUTES });
      } else {
        await apiPost(`api/zones/${zoneId}/stop`, {});
      }
    } finally {
      // Repaint from the real state either way, so a failed request puts the
      // switch back straight away instead of at the next poll.
      delete button.dataset.pending;
      await refreshDashboard();
    }
  });
}

function renderPause(status) {
  const paused = status.pause?.active;
  const banner = el("pause-banner");
  const button = el("pause-btn");

  banner.hidden = !paused;
  if (paused) {
    banner.innerHTML = `
      <div class="attention-head">
        <span class="attention-icon" aria-hidden="true">&#9208;</span>
        <h2>Watering is paused</h2>
      </div>
      <p class="hint">
        Every valve is shut and the schedule is on hold. Runs already going keep
        the time they still owe. Resumes on its own at
        ${escapeHtml(fmtDateTime(status.pause.until))} if you forget.
      </p>
      <button class="btn btn-primary" id="resume-btn">Resume watering</button>
    `;
    banner.querySelector("#resume-btn").addEventListener("click", () =>
      guard(async () => {
        await apiDelete("api/pause");
        await refreshDashboard();
      }, "Watering resumed.")
    );
  }

  // Pausing is only meaningful when something would otherwise be watering.
  button.hidden = paused || !status.current_runs.length;
}

function emptyState(container, message) {
  container.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

function daysSummary(weekdays) {
  const days = (weekdays || "").split(",").filter(Boolean);
  if (days.length === 7) return "Every day";
  if (!days.length) return "No days selected";
  return days.map((d) => DAY_LABEL[d]).join(", ");
}

// ---- tabs -------------------------------------------------------------------

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (name === "zones") guard(loadZonesTab);
  if (name === "programs") guard(loadProgramsTab);
  if (name === "history") guard(loadHistoryTab);
}

// ---- dashboard --------------------------------------------------------------

// The status poll says what's running and what's still due; what already
// happened today comes from the run log. That doesn't change second to second,
// so it's cached and refreshed on a slower beat than the 5s poll.
let todayPlan = { day: null, runs: [], at: 0 };

async function refreshTodayPlan(force = false) {
  const day = todayIso();
  if (!force && todayPlan.day === day && Date.now() - todayPlan.at < 30000) return;
  try {
    const history = await apiGet(`api/history?date=${day}`);
    todayPlan = { day, runs: history.runs, at: Date.now() };
  } catch {
    // Leave the last plan in place - a slightly stale track beats an empty one.
  }
}

/** After an action that changes something, don't wait out the plan's cache. */
async function refreshDashboard() {
  await refreshTodayPlan(true);
  await loadDashboard();
}

async function loadDashboard() {
  let status;
  try {
    status = await apiGet("api/status");
  } catch {
    return;
  }

  setLawnTimeZone(status.timezone);
  if (status.version) el("app-version").textContent = `v${status.version}`;

  // Keeps the Zones tab's run toggles honest even while another tab is showing.
  paintZoneRunState(status.current_runs);

  const pill = el("raindelay-pill");
  if (status.rain_delay.active) {
    pill.hidden = false;
    pill.textContent = `Rain delay until ${fmtDateTime(status.rain_delay.until)}`;
  } else {
    pill.hidden = true;
  }

  renderZonePanel(status);
  renderPause(status);

  const runs = status.current_runs;
  const paused = status.pause?.active;
  const countPill = el("running-count");
  countPill.textContent = !runs.length
    ? "Idle"
    : paused
      ? `${runs.length} zone${runs.length === 1 ? "" : "s"} held`
      : `${runs.length} zone${runs.length === 1 ? "" : "s"} watering`;
  countPill.className = `pill ${runs.length && !paused ? "pill-on" : "pill-quiet"}`;

  await refreshTodayPlan();
  renderToday(status);
  renderTiles(status);
}

// ---- dashboard: the day as one track ----------------------------------------

const HOUR_MS = 3600000;

/**
 * How long a run still has to go. Counted from what it's owed rather than the
 * wall clock: the clock keeps moving through a pause but the valve is shut.
 */
function runMsLeft(run) {
  const owed = (run.seconds_left ?? run.duration_minutes * 60) * 1000;
  if (run.paused) return Math.max(0, owed);
  const sinceSegment = Date.now() - new Date(run.resumed_at || run.started_at).getTime();
  return Math.max(0, owed - sinceSegment);
}

function shortHour(ms) {
  return new Date(ms).toLocaleTimeString([], inLawnZone({ hour: "numeric" }));
}

/** Round to the lawn's whole hours - not UTC's, which differ in a :30 zone. */
function floorLawnHour(ms) {
  const offset = lawnOffsetMs(ms);
  return Math.floor((ms + offset) / HOUR_MS) * HOUR_MS - offset;
}

function ceilLawnHour(ms) {
  const offset = lawnOffsetMs(ms);
  return Math.ceil((ms + offset) / HOUR_MS) * HOUR_MS - offset;
}

/**
 * One lane per zone. Everything before now comes from the run log, the live
 * block from the current runs, and everything after now from the scheduler -
 * so the track never guesses at a cycle it can already account for.
 */
function buildTodayLanes(status) {
  const lanes = new Map();
  status.zones.forEach((z) => lanes.set(z.id, { name: z.name, blocks: [] }));

  const idByName = new Map(status.zones.map((z) => [z.name, z.id]));
  const push = (zoneId, block) => {
    const lane = lanes.get(zoneId);
    if (lane) lane.blocks.push(block);
  };

  // Already happened. A step still running is left to the live pass below,
  // which is the only place that knows how much of it is left.
  todayPlan.runs.forEach((run) => {
    run.steps.forEach((s) => {
      if (!s.zone_name || !s.started_at || s.status === "running") return;
      const zoneId = idByName.get(s.zone_name);
      if (zoneId == null) return;
      const start = new Date(s.started_at).getTime();
      const ended = s.ended_at ? new Date(s.ended_at).getTime() : start;
      const outcome = stepOutcome(s.status);
      push(zoneId, {
        start,
        // A skip has no duration at all; give it a minute so it still shows.
        end: Math.max(ended, start + 60000),
        kind: outcome === "ok" ? "done" : outcome,
        program: run.program_name,
        note: STATUS_LABEL[s.status] || s.status,
      });
    });
  });

  // Watering right now - drawn out to when it will actually finish, which a
  // pause pushes back.
  status.current_runs.forEach((r) => {
    push(r.zone_id, {
      start: new Date(r.started_at).getTime(),
      end: Date.now() + runMsLeft(r),
      kind: r.paused ? "held" : "live",
      program: r.program_name,
      note: r.paused ? "paused" : "watering now",
    });
  });

  // Still to come. The scheduler works these out in Home Assistant's timezone
  // and knows each interval program's anchor date, so the browser just draws
  // them - recomputing here would be an hour out for a viewer in another zone.
  (status.planned_today || []).forEach((slot) => {
    push(slot.zone_id, {
      start: new Date(slot.start).getTime(),
      end: new Date(slot.end).getTime(),
      kind: "planned",
      program: slot.program_name,
      note: `scheduled, ${fmtDuration(slot.minutes)}`,
    });
  });

  lanes.forEach((lane) => lane.blocks.sort((a, b) => a.start - b.start));
  return [...lanes.values()];
}

function renderToday(status) {
  const host = el("today-track");
  const sub = el("today-sub");

  if (!status.zones.length) {
    host.innerHTML = `<div class="empty">No zones yet - add them on the Zones tab.</div>`;
    sub.textContent = "";
    return;
  }

  const lanes = buildTodayLanes(status);
  const blocks = lanes.flatMap((lane) => lane.blocks);
  if (!blocks.length) {
    const next = (status.next_events || [])[0];
    host.innerHTML = `<div class="empty">Nothing has watered today and nothing is left to run.${
      next ? ` Next up: ${escapeHtml(next.program_name)}, ${escapeHtml(fmtDateTime(next.next_run_time))}.` : ""
    }</div>`;
    sub.textContent = "";
    return;
  }

  // Round out to whole hours, and always keep the current time on the chart.
  const now = Date.now();
  const from = floorLawnHour(Math.min(now, ...blocks.map((b) => b.start)));
  let to = ceilLawnHour(Math.max(now, ...blocks.map((b) => b.end)));
  if (to - from < 4 * HOUR_MS) to = from + 4 * HOUR_MS;
  const span = to - from;
  const pct = (ms) => ((ms - from) / span) * 100;

  const rows = lanes.map((lane) => {
    const bars = lane.blocks.map((b) => {
      const left = Math.max(0, pct(b.start));
      const width = Math.max(0.7, pct(b.end) - pct(b.start));
      const when = fmtClock(b.start);
      return `<i class="blk blk-${b.kind}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"
                 title="${escapeHtml(`${lane.name} · ${b.program} · ${when} · ${b.note}`)}"></i>`;
    }).join("");
    return `
      <div class="track-row">
        <span class="track-name" title="${escapeHtml(lane.name)}">${escapeHtml(lane.name)}</span>
        <div class="track-lane">
          ${bars}
          <span class="track-now" style="left:${pct(now).toFixed(2)}%"></span>
        </div>
      </div>`;
  }).join("");

  // Thin the hour labels out rather than letting them collide on a long day.
  const hours = Math.round(span / HOUR_MS);
  const every = Math.ceil(hours / 8);
  const ticks = [];
  for (let i = 0; i <= hours; i += every) {
    const t = from + i * HOUR_MS;
    const edge = i === 0 ? " is-first" : i + every > hours ? " is-last" : "";
    ticks.push(`<span class="tick${edge}" style="left:${pct(t).toFixed(2)}%">${escapeHtml(shortHour(t))}</span>`);
  }

  host.innerHTML = `
    <div class="track-rows">${rows}</div>
    <div class="track-axis">
      <span></span>
      <div class="track-axis-line">${ticks.join("")}</div>
    </div>
    <div class="track-key">
      <span class="key key-done">watered</span>
      <span class="key key-live">watering now</span>
      <span class="key key-planned">still to come</span>
      <span class="key key-bad">didn't water</span>
    </div>
  `;

  const done = blocks.filter((b) => b.kind === "done").length;
  const toCome = blocks.filter((b) => b.kind === "planned").length;
  const bad = blocks.filter((b) => b.kind === "bad").length;
  const cut = blocks.filter((b) => b.kind === "cut").length;
  sub.textContent = [
    `${done} zone run${done === 1 ? "" : "s"} done`,
    toCome ? `${toCome} to come` : null,
    cut ? `${cut} cut short` : null,
    bad ? `${bad} didn't water` : null,
    status.rain_delay.active ? "rain delay on" : null,
  ].filter(Boolean).join(" · ");
}

function renderTiles(status) {
  const next = (status.next_events || [])[0];
  el("tile-next-value").textContent = next ? fmtNextRun(next.next_run_time) : "—";
  el("tile-next-sub").textContent = next
    ? `${next.program_name} · ${next.zone_count} zone${next.zone_count === 1 ? "" : "s"} · ${fmtRelative(next.next_run_time)}`
    : "No programs scheduled.";

  // Water today, per zone: the day's watering minutes split across the zones
  // that ran, which is what any one zone actually received.
  const steps = todayPlan.runs
    .flatMap((r) => r.steps)
    .filter((s) => s.zone_name && s.minutes > 0);
  const zonesRun = new Set(steps.map((s) => s.zone_name));
  const minutes = steps.reduce((total, s) => total + s.minutes, 0);
  el("tile-water-value").textContent = zonesRun.size
    ? fmtInches(inchesFor(minutes / zonesRun.size))
    : "—";
  el("tile-water-sub").textContent = zonesRun.size
    ? `per zone, across ${zonesRun.size} zone${zonesRun.size === 1 ? "" : "s"} · ${fmtDuration(minutes)} of watering`
    : "Nothing has watered today.";

  const delay = status.rain_delay;
  el("tile-delay-value").textContent = delay.active ? "On" : "Off";
  el("tile-delay-sub").textContent = delay.active
    ? `Until ${fmtDateTime(delay.until)} - scheduled programs are on hold.`
    : "Holds every scheduled program. Manual runs still work.";
  el("clear-delay-btn").hidden = !delay.active;
}

document.querySelectorAll("[data-delay]").forEach((btn) => {
  btn.addEventListener("click", () =>
    guard(async () => {
      await apiPost("api/raindelay", { hours: Number(btn.dataset.delay) });
      await refreshDashboard();
    }, `Rain delay set for ${btn.dataset.delay} hours.`)
  );
});

on("apply-custom-delay", "click", () =>
  guard(async () => {
    const hours = Number(el("custom-delay-hours").value);
    if (!hours || hours <= 0) throw new Error("Enter a number of hours.");
    await apiPost("api/raindelay", { hours });
    el("custom-delay-hours").value = "";
    await refreshDashboard();
  }, "Rain delay set.")
);

on("pause-btn", "click", () =>
  guard(async () => {
    await apiPost("api/pause", {});
    await refreshDashboard();
  }, "Watering paused - valves shut.")
);

on("clear-delay-btn", "click", () =>
  guard(async () => {
    await apiDelete("api/raindelay");
    await refreshDashboard();
  }, "Rain delay cleared.")
);

// ---- zones tab --------------------------------------------------------------

// zone_id -> the row's run toggle and minutes box, so the poll can flip a
// toggle back when a run finishes without rebuilding the list underneath the
// user's cursor.
const zoneRows = new Map();
let lastCurrentRuns = [];

/**
 * Re-read the valves' actual on/off from Home Assistant. Without this the page
 * only knows what the state was when it was drawn, so a zone switched off in
 * HA (or by hand at the box) would keep showing as on here.
 */
async function refreshZoneStates() {
  if (!zoneRows.size || !el("tab-zones")?.classList.contains("active")) return;
  let payload;
  try {
    payload = await apiGet("api/zones/states");
  } catch {
    return; // HA unreachable - keep showing the last thing we knew
  }
  const states = payload.states || {};
  zoneRows.forEach((refs) => {
    if (refs.entityId in states) refs.reportedOn = states[refs.entityId] === "on";
  });
  paintZoneRunState(lastCurrentRuns);
}

/** Point each zone card at whatever is actually watering right now. */
function paintZoneRunState(currentRuns) {
  lastCurrentRuns = currentRuns || [];
  const running = new Map(lastCurrentRuns.map((r) => [r.zone_id, r]));

  zoneRows.forEach((refs, zoneId) => {
    if (!refs.card.isConnected) return zoneRows.delete(zoneId);
    const run = running.get(zoneId);

    // A run of ours just ended, which means we closed the valve - so whatever
    // HA reported when the list was drawn is now out of date.
    if (refs.wasRunning && !run) refs.reportedOn = false;
    refs.wasRunning = Boolean(run);

    // Don't yank the switch back while its own request is still in flight.
    if (refs.toggle.dataset.pending === "true") return;

    // On if we're running it, or if HA said so - somebody may have switched it
    // on outside the add-on.
    const isOn = Boolean(run) || refs.reportedOn;
    refs.toggle.setAttribute("aria-checked", String(isOn));
    refs.toggle.setAttribute("aria-label", `${isOn ? "Stop" : "Test run"} ${refs.name}`);
    refs.card.classList.toggle("is-on", isOn);
    refs.minutes.disabled = isOn;

    let state = refs.enabled ? "Off" : "Disabled";
    let tone = "pill-quiet";
    let detail = refs.idle;

    if (run) {
      const left = Math.ceil(runMsLeft(run) / 60000);
      state = run.paused ? "Paused" : "Watering";
      tone = run.paused ? "pill-warn" : "pill-on";
      detail = run.paused
        ? `${run.program_name} · held with ${left}m still to run`
        : `${left}m left of ${fmtDuration(run.duration_minutes)} · ${run.program_name}`;
    } else if (refs.reportedOn) {
      state = "On";
      tone = "pill-on";
      detail = "Opened outside the add-on";
    }

    refs.pill.textContent = state;
    refs.pill.className = `pill ${tone} zone-card-state`;
    refs.detail.textContent = detail;
  });
}

const PENCIL_SVG = `
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" />
    <path d="M14 6l4 4" />
  </svg>`;

async function loadZonesTab() {
  const [zones, entities, status, history] = await Promise.all([
    apiGet("api/zones"),
    apiGet("api/ha/entities"),
    apiGet("api/status"),
    // Only used to say what a zone last did, so a failure here shouldn't take
    // the whole tab down with it.
    apiGet(`api/history?date=${todayIso()}`).catch(() => ({ runs: [] })),
  ]);
  zonesCache = zones;
  setLawnTimeZone(status.timezone);
  zoneRows.clear();

  const stateByEntity = Object.fromEntries(entities.map((e) => [e.entity_id, e.state]));
  const usedIds = new Set(zones.map((z) => z.entity_id));
  const available = entities.filter((e) => !usedIds.has(e.entity_id));

  el("new-zone-entity").innerHTML = available.length
    ? available
        .map((e) => `<option value="${escapeHtml(e.entity_id)}">${escapeHtml(e.friendly_name)} (${escapeHtml(e.entity_id)})</option>`)
        .join("")
    : `<option value="">No unassigned switch or valve entities found</option>`;

  // The last thing each zone did today, so an idle card says more than "Off".
  const lastToday = new Map();
  history.runs.forEach((run) => {
    run.steps.forEach((s) => {
      if (!s.zone_name || !s.started_at) return;
      const seen = lastToday.get(s.zone_name);
      if (!seen || s.started_at > seen.started_at) lastToday.set(s.zone_name, s);
    });
  });

  const openCount = zones.filter((z) => stateByEntity[z.entity_id] === "on").length;
  el("zones-sub").textContent = zones.length
    ? `${zones.length} circuit${zones.length === 1 ? "" : "s"}${openCount ? ` · ${openCount} open` : ""}`
    : "";

  const list = el("zones-list");
  if (!zones.length) {
    emptyState(list, "No zones yet. Add your first sprinkler circuit.");
    return;
  }

  list.innerHTML = "";
  zones.forEach((z) => {
    const last = lastToday.get(z.name);
    const idle = !z.enabled
      ? "Programs skip this zone while it's disabled"
      : last
        ? [
            `Last run ${fmtClock(last.started_at)}`,
            // A run stopped straight away would otherwise read "0m".
            last.minutes >= 1 ? fmtDuration(last.minutes) : null,
            stepOutcome(last.status) === "ok" ? null : STATUS_LABEL[last.status] || last.status,
          ].filter(Boolean).join(" · ")
        : "No runs today";

    const card = document.createElement("article");
    card.className = "zone-card";
    card.innerHTML = `
      <div class="zone-card-head">
        <div class="zone-card-id">
          <div class="zone-card-title">
            <h3>${escapeHtml(z.name)}</h3>
            <button class="btn btn-icon rename-zone" title="Rename zone"
                    aria-label="Rename ${escapeHtml(z.name)}">${PENCIL_SVG}</button>
          </div>
          <div class="zone-card-entity">${escapeHtml(z.entity_id)}</div>
        </div>
        <button type="button" class="switch-toggle" role="switch" aria-checked="false"
                aria-label="Test run ${escapeHtml(z.name)}">
          <span class="switch-track"><span class="switch-knob"></span></span>
        </button>
      </div>
      <div class="zone-card-status">
        <span class="pill pill-quiet zone-card-state">Off</span>
        <span class="zone-card-detail"></span>
      </div>
      <div class="zone-card-actions">
        <label class="run-for">
          <span class="inline-label">Run for</span>
          <input type="number" class="run-minutes" value="5" min="0.5" step="0.5"
                 aria-label="Minutes to run ${escapeHtml(z.name)} for" />
          <span class="inline-label">min</span>
        </label>
        <button class="btn btn-small toggle-zone">${z.enabled ? "Disable" : "Enable"}</button>
        <button class="btn btn-small btn-danger delete-zone">Delete</button>
      </div>
    `;

    const toggle = card.querySelector(".switch-toggle");
    const minutes = card.querySelector(".run-minutes");
    zoneRows.set(z.id, {
      card,
      toggle,
      minutes,
      pill: card.querySelector(".zone-card-state"),
      detail: card.querySelector(".zone-card-detail"),
      name: z.name,
      enabled: Boolean(z.enabled),
      entityId: z.entity_id,
      idle,
      reportedOn: stateByEntity[z.entity_id] === "on",
    });

    // On runs the zone for the minutes in the box; off stops it there and then.
    toggle.addEventListener("click", () => {
      const turningOn = toggle.getAttribute("aria-checked") !== "true";
      const mins = Number(minutes.value);
      if (turningOn && (!mins || mins <= 0)) {
        return toast("Set how many minutes to run for.", "error");
      }

      // Flip straight away and hold that until the next poll confirms it;
      // waiting for the round trip makes the switch feel broken.
      toggle.dataset.pending = "true";
      toggle.setAttribute("aria-checked", String(turningOn));
      card.classList.toggle("is-on", turningOn);
      const refs = zoneRows.get(z.id);
      refs.pill.textContent = turningOn ? "Starting…" : "Stopping…";
      refs.pill.className = "pill pill-quiet zone-card-state";

      guard(async () => {
        try {
          if (turningOn) {
            await apiPost(`api/zones/${z.id}/run`, { minutes: mins });
            toast(`${z.name} running for ${fmtDuration(mins)}.`);
          } else {
            await apiPost(`api/zones/${z.id}/stop`, {});
            toast(`${z.name} stopped.`);
          }
        } finally {
          // Repaint from the real state either way, so a failed request puts
          // the switch back straight away instead of at the next poll.
          delete toggle.dataset.pending;
          await refreshDashboard();
        }
      });
    });

    card.querySelector(".rename-zone").addEventListener("click", () =>
      guard(async () => {
        const name = await askText({
          title: "Rename zone",
          message: "Programs using this zone follow the new name.",
          confirmLabel: "Save name",
          field: { label: "Zone name", value: z.name, placeholder: "e.g. Front lawn" },
        });
        if (!name || name === z.name) return;
        await apiPut(`api/zones/${z.id}`, { name });
        await loadZonesTab();
        toast(`Renamed to ${name}.`);
      })
    );
    card.querySelector(".toggle-zone").addEventListener("click", () =>
      guard(async () => {
        await apiPut(`api/zones/${z.id}`, { enabled: !z.enabled });
        await loadZonesTab();
      })
    );
    card.querySelector(".delete-zone").addEventListener("click", () =>
      guard(async () => {
        const go = await askConfirm({
          title: `Delete ${z.name}?`,
          message: "Any program using this zone will lose it. This can't be undone.",
          confirmLabel: "Delete zone",
          danger: true,
        });
        if (!go) return;
        await apiDelete(`api/zones/${z.id}`);
        await loadZonesTab();
      })
    );
    list.appendChild(card);
  });

  paintZoneRunState(status.current_runs);
}

function showAddZone(show) {
  el("add-zone-card").hidden = !show;
  el("show-add-zone").hidden = show;
  if (show) el("new-zone-entity").focus();
}

on("show-add-zone", "click", () => showAddZone(true));
on("cancel-add-zone", "click", () => {
  el("new-zone-name").value = "";
  showAddZone(false);
});

on("add-zone-btn", "click", () =>
  guard(async () => {
    const entityId = el("new-zone-entity").value;
    const name = el("new-zone-name").value.trim();
    if (!entityId) throw new Error("Pick a Home Assistant entity first.");
    if (!name) throw new Error("Give the zone a name.");
    await apiPost("api/zones", { entity_id: entityId, name });
    el("new-zone-name").value = "";
    showAddZone(false);
    await loadZonesTab();
  }, "Zone added.")
);

// ---- programs tab -----------------------------------------------------------

async function loadProgramsTab() {
  const [presets, programs, zones, status] = await Promise.all([
    apiGet("api/presets"),
    apiGet("api/programs"),
    apiGet("api/zones"),
    apiGet("api/status"),   // for the lawn's timezone, which next-run times are shown in
  ]);
  presetsCache = presets;
  zonesCache = zones;
  setLawnTimeZone(status.timezone);

  renderPresetGallery();
  renderProgramsList(programs);
}

function renderPresetGallery() {
  const gallery = el("preset-gallery");
  gallery.innerHTML = "";
  presetsCache.forEach((p) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "preset-card";
    card.innerHTML = `
      <span class="preset-stage">Stage ${p.stage}</span>
      <h4>${escapeHtml(p.name)}</h4>
      <p class="preset-tagline">${escapeHtml(p.tagline)}</p>
      <div class="preset-specs">
        <span class="spec">${p.duration_minutes} min/zone</span>
        <span class="spec">${p.cycles_per_day}&times; a day</span>
        <span class="spec">${fmtInches(p.inches_per_cycle)}/cycle</span>
        <span class="spec">${p.schedule_type === "interval" ? `every ${p.interval_days}d` : "daily"}</span>
      </div>
    `;
    card.title = `${p.goal}\n\nTypical window: ${p.typical_window}`;
    card.addEventListener("click", () => applyPreset(p));
    gallery.appendChild(card);
  });
}

function applyPreset(preset) {
  builder.stage = preset.id;
  builder.presetName = `Stage ${preset.stage} - ${preset.name}`;
  builder.scheduleType = preset.schedule_type;
  builder.weekdays = new Set(
    preset.schedule_type === "weekdays" ? (preset.weekdays || "").split(",").filter(Boolean) : DAYS
  );
  builder.intervalDays = preset.interval_days || 3;
  builder.cycles = [...preset.cycle_times];
  builder.runMode = preset.run_mode;
  setDefaultMinutes(preset.duration_minutes);

  if (!builder.zones.length) {
    builder.zones = zonesCache
      .filter((z) => z.enabled)
      .map((z) => ({ zone_id: z.id, zone_name: z.name, duration_minutes: preset.duration_minutes }));
  }

  // Replace a name we generated from another preset, but never one the user typed.
  const current = el("pf-name").value.trim();
  if (!current || current === builder.autoName) {
    builder.autoName = builder.presetName;
    el("pf-name").value = builder.autoName;
  }

  renderBuilder();
  goToStep(modalSteps.indexOf("schedule"));
}

// The runtime set here is the program's default, so it applies to every zone -
// including ones added later. A zone can still be given its own time on the
// Zones step; changing this again overwrites those.
function setDefaultMinutes(minutes) {
  builder.defaultMinutes = minutes;
  builder.zones.forEach((z) => (z.duration_minutes = minutes));
  el("pf-add-zone-duration").value = minutes;
}

// -- builder: schedule type / days / run mode

function setSegmented(container, value) {
  container.dataset.value = value;
  container.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.value === value));
}

el("pf-schedule-type")?.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    builder.scheduleType = btn.dataset.value;
    renderBuilder();
  });
});

el("pf-run-mode")?.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    builder.runMode = btn.dataset.value;
    renderBuilder();
  });
});

el("pf-weekdays-row")?.querySelectorAll(".day").forEach((btn) => {
  btn.addEventListener("click", () => {
    const day = btn.dataset.day;
    if (builder.weekdays.has(day)) builder.weekdays.delete(day);
    else builder.weekdays.add(day);
    renderBuilder();
  });
});

on("pf-everyday-btn", "click", () => {
  builder.weekdays = new Set(builder.weekdays.size === 7 ? [] : DAYS);
  renderBuilder();
});

on("pf-interval-days", "input", (e) => {
  builder.intervalDays = Number(e.target.value) || 1;
});

on("pf-default-minutes", "input", (e) => {
  const minutes = Number(e.target.value);
  if (!minutes || minutes <= 0) return;
  setDefaultMinutes(minutes);
  // Everything downstream reads the zone durations this just rewrote, so the
  // later steps have to be re-rendered or they keep showing the old number.
  renderWaterReadout();
  renderCycles();
  renderBuilderZones();
  renderTimeline();
});

// -- builder: cycles

document.querySelectorAll("[data-quick-cycles]").forEach((btn) => {
  btn.addEventListener("click", () => {
    builder.cycles = [...QUICK_CYCLES[btn.dataset.quickCycles]];
    renderBuilder();
  });
});

on("pf-add-cycle-btn", "click", () => {
  const last = builder.cycles[builder.cycles.length - 1];
  const next = last ? minutesToValue(toMinutes(last) + 180) : "08:00";
  builder.cycles.push(builder.cycles.includes(next) ? minutesToValue(toMinutes(next) + 30) : next);
  renderBuilder();
});

function minutesToValue(total) {
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function renderCycles() {
  const list = el("pf-cycles");
  el("cycle-count-pill").textContent = builder.cycles.length
    ? `${builder.cycles.length}× a day`
    : "none yet";

  if (!builder.cycles.length) {
    list.innerHTML = `<div class="cycle-empty">No cycles yet. Use a quick set above, or add one.</div>`;
    return;
  }

  list.innerHTML = "";
  builder.cycles.forEach((time, idx) => {
    const row = document.createElement("div");
    row.className = "cycle-row";
    // Remove button before the note: the note spans the full width on its own
    // row, so anything after it in the DOM would be pushed onto a third.
    row.innerHTML = `
      <span class="cycle-tag">${escapeHtml(cycleLabel(time))}</span>
      <input type="time" value="${escapeHtml(time)}" step="300" aria-label="Cycle start time" />
      <button type="button" class="btn btn-icon remove-cycle" title="Remove cycle"
              aria-label="Remove the ${escapeHtml(cycleLabel(time))} cycle">&times;</button>
      <span class="cycle-note"></span>
    `;
    const input = row.querySelector("input");
    const tag = row.querySelector(".cycle-tag");
    const note = row.querySelector(".cycle-note");

    const updateNote = () => {
      const total = cycleRuntime();
      note.textContent = builder.zones.length
        ? `all zones done by ${minutesTo12(toMinutes(builder.cycles[idx]) + total)}`
        : "";
    };

    input.addEventListener("input", () => {
      if (!input.value) return;
      builder.cycles[idx] = input.value;
      tag.textContent = cycleLabel(input.value);
      updateNote();
      renderTimeline();
    });
    input.addEventListener("change", () => {
      builder.cycles.sort((a, b) => toMinutes(a) - toMinutes(b));
      renderBuilder();
    });
    row.querySelector(".remove-cycle").addEventListener("click", () => {
      builder.cycles.splice(idx, 1);
      renderBuilder();
    });

    updateNote();
    list.appendChild(row);
  });
}

// -- builder: zones

function refreshZoneAddSelect() {
  const select = el("pf-add-zone-select");
  const used = new Set(builder.zones.map((z) => z.zone_id));
  const available = zonesCache.filter((z) => !used.has(z.id));
  select.innerHTML = available.length
    ? available.map((z) => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join("")
    : `<option value="">All zones added</option>`;
  select.disabled = !available.length;
  el("pf-add-zone-btn").disabled = !available.length;
}

on("pf-add-zone-btn", "click", () => {
  const zoneId = Number(el("pf-add-zone-select").value);
  const duration = Number(el("pf-add-zone-duration").value);
  if (!zoneId) return toast("No zone to add.", "error");
  if (!duration || duration <= 0) return toast("Enter how many minutes each zone should run.", "error");
  const zone = zonesCache.find((z) => z.id === zoneId);
  builder.zones.push({ zone_id: zoneId, zone_name: zone.name, duration_minutes: duration });
  renderBuilder();
});

function renderBuilderZones() {
  const list = el("pf-zones-list");
  const pill = el("zone-count-pill");
  if (pill) {
    pill.textContent = builder.zones.length
      ? `${builder.zones.length} zone${builder.zones.length === 1 ? "" : "s"}`
      : "none yet";
  }

  if (!builder.zones.length) {
    emptyState(
      list,
      zonesCache.length
        ? "None yet - add one below, or pick a growth stage to add them all."
        : "You have no zones configured. Add them on the Zones tab first."
    );
    return;
  }

  // One line per zone. As full-height list rows, five zones ran well past the
  // bottom of the modal on a laptop.
  list.innerHTML = `<ol class="zone-rows"></ol>`;
  const rows = list.firstElementChild;

  builder.zones.forEach((z, idx) => {
    const row = document.createElement("li");
    row.className = "zone-row";
    row.innerHTML = `
      <span class="zone-row-n">${idx + 1}</span>
      <span class="zone-row-name">${escapeHtml(z.zone_name)}</span>
      <span class="zone-row-water"></span>
      <input type="number" class="zone-minutes" value="${z.duration_minutes}"
             min="0.5" step="0.5" aria-label="Minutes for ${escapeHtml(z.zone_name)}" />
      <span class="inline-label">min</span>
      <span class="zone-row-actions">
        <button type="button" class="btn btn-icon move-up" title="Move earlier"
                aria-label="Move ${escapeHtml(z.zone_name)} earlier" ${idx === 0 ? "disabled" : ""}>&uarr;</button>
        <button type="button" class="btn btn-icon move-down" title="Move later"
                aria-label="Move ${escapeHtml(z.zone_name)} later" ${idx === builder.zones.length - 1 ? "disabled" : ""}>&darr;</button>
        <button type="button" class="btn btn-icon remove-zone" title="Remove"
                aria-label="Remove ${escapeHtml(z.zone_name)}">&times;</button>
      </span>
    `;

    const water = row.querySelector(".zone-row-water");
    const showWater = () => {
      water.textContent = `${fmtInches(inchesFor(z.duration_minutes))}/cycle`;
    };
    showWater();

    const input = row.querySelector(".zone-minutes");
    input.addEventListener("input", () => {
      z.duration_minutes = Number(input.value) || 0;
      showWater();
      renderTimeline();
      renderCycles();
    });
    row.querySelector(".move-up").addEventListener("click", () => {
      [builder.zones[idx - 1], builder.zones[idx]] = [builder.zones[idx], builder.zones[idx - 1]];
      renderBuilder();
    });
    row.querySelector(".move-down").addEventListener("click", () => {
      [builder.zones[idx + 1], builder.zones[idx]] = [builder.zones[idx], builder.zones[idx + 1]];
      renderBuilder();
    });
    row.querySelector(".remove-zone").addEventListener("click", () => {
      builder.zones.splice(idx, 1);
      renderBuilder();
    });

    rows.appendChild(row);
  });
}

// -- builder: live timeline

function cycleRuntime() {
  const durations = builder.zones.map((z) => Number(z.duration_minutes) || 0);
  if (!durations.length) return 0;
  return builder.runMode === "sequential"
    ? durations.reduce((a, b) => a + b, 0)
    : Math.max(...durations);
}

function computeTimeline() {
  const sequential = builder.runMode === "sequential";
  return builder.cycles.map((start) => {
    const base = toMinutes(start);
    let offset = 0;
    const cells = builder.zones.map((z) => {
      const duration = Number(z.duration_minutes) || 0;
      const startMin = base + (sequential ? offset : 0);
      if (sequential) offset += duration;
      return { startMin, endMin: startMin + duration };
    });
    return {
      start,
      startMin: base,
      cells,
      endMin: cells.length ? Math.max(...cells.map((c) => c.endMin)) : base,
    };
  });
}

function renderTimeline() {
  const summary = el("timeline-summary");
  const warning = el("timeline-warning");
  const preview = el("timeline-preview");

  const runtime = cycleRuntime();
  const perCycleWater = builder.zones.map((z) => inchesFor(z.duration_minutes));
  const waterLabel = perCycleWater.length
    ? (Math.min(...perCycleWater) === Math.max(...perCycleWater)
        ? fmtInches(perCycleWater[0])
        : `${fmtInches(Math.min(...perCycleWater))}–${fmtInches(Math.max(...perCycleWater))}`)
    : "—";
  const dailyWater = perCycleWater.length
    ? (Math.min(...perCycleWater) === Math.max(...perCycleWater)
        ? fmtInches(perCycleWater[0] * builder.cycles.length)
        : `${fmtInches(Math.min(...perCycleWater) * builder.cycles.length)}–${fmtInches(Math.max(...perCycleWater) * builder.cycles.length)}`)
    : "—";

  const cadence = builder.scheduleType === "interval"
    ? `Every ${builder.intervalDays} day${builder.intervalDays === 1 ? "" : "s"}`
    : daysSummary([...builder.weekdays].filter((d) => DAYS.includes(d)).sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)).join(","));

  summary.innerHTML = `
    <div class="stat"><div class="label">Runs on</div><div class="value" style="font-size:14px">${escapeHtml(cadence)}</div></div>
    <div class="stat"><div class="label">Cycles per day</div><div class="value">${builder.cycles.length}</div></div>
    <div class="stat"><div class="label">Per cycle</div><div class="value">${escapeHtml(fmtDuration(runtime))}</div><div class="sub">${builder.zones.length} zone${builder.zones.length === 1 ? "" : "s"}, ${builder.runMode === "sequential" ? "in order" : "together"}</div></div>
    <div class="stat"><div class="label">Water per zone</div><div class="value">${waterLabel}</div><div class="sub">${dailyWater} per watering day</div></div>
  `;

  const rows = computeTimeline();

  const clashes = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].startMin < rows[i - 1].endMin) {
      clashes.push(`The ${fmt12(rows[i - 1].start)} cycle runs until ${minutesTo12(rows[i - 1].endMin)}, past the next start at ${fmt12(rows[i].start)}.`);
    }
  }
  const overnight = rows.some((r) => r.endMin >= 1440);
  if (overnight) clashes.push("The last cycle finishes after midnight.");

  if (clashes.length) {
    warning.hidden = false;
    warning.innerHTML = `<strong>Cycles overlap.</strong> ${clashes.map(escapeHtml).join(" ")} Move the start times further apart or shorten each zone.`;
  } else {
    warning.hidden = true;
  }

  if (!builder.cycles.length || !builder.zones.length) {
    preview.innerHTML = `<div class="timeline-empty">Add at least one cycle and one zone to see the watering schedule.</div>`;
    return;
  }

  const header = builder.zones
    .map((z) => `<th>${escapeHtml(z.zone_name)}</th>`)
    .join("");
  const body = rows
    .map((r) => {
      const cells = r.cells.map((c) => `<td class="tl-time">${minutesTo12(c.startMin)}</td>`).join("");
      return `
        <tr>
          <th>${escapeHtml(cycleLabel(r.start))}<small>starts ${fmt12(r.start)}</small></th>
          ${cells}
          <td class="tl-done">${minutesTo12(r.endMin)}</td>
        </tr>
      `;
    })
    .join("");

  preview.innerHTML = `
    <table class="timeline">
      <thead><tr><th>Cycle</th>${header}<th>All done</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function renderWaterReadout() {
  const perCycle = inchesFor(builder.defaultMinutes);
  const cycles = builder.cycles.length;
  el("water-readout").innerHTML = cycles
    ? `Each zone gets about <strong>${fmtInches(perCycle)}</strong> per cycle, so
       <strong>${fmtInches(perCycle * cycles)}</strong> across ${cycles}
       cycle${cycles === 1 ? "" : "s"} on a watering day.`
    : `Each zone gets about <strong>${fmtInches(perCycle)}</strong> per cycle.`;
}

function renderPresetBanner() {
  const banner = el("preset-banner");
  if (builder.stage === "custom" || !builder.presetName) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `
    <strong>${escapeHtml(builder.presetName)}</strong>
    <span>These are the stage's defaults - change anything here and the rest of
    the program follows.</span>
  `;
}

function renderBuilder() {
  setSegmented(el("pf-schedule-type"), builder.scheduleType);
  setSegmented(el("pf-run-mode"), builder.runMode);
  // Don't fight the user mid-keystroke: "2.5" would round-trip to "2" while
  // they're still typing the decimal.
  const minutesInput = el("pf-default-minutes");
  if (minutesInput !== document.activeElement) minutesInput.value = builder.defaultMinutes;
  renderPresetBanner();
  renderWaterReadout();

  el("pf-weekdays-row").hidden = builder.scheduleType !== "weekdays";
  el("pf-interval-row").hidden = builder.scheduleType !== "interval";
  el("pf-interval-days").value = builder.intervalDays;
  el("pf-weekdays-row").querySelectorAll(".day").forEach((btn) => {
    btn.classList.toggle("active", builder.weekdays.has(btn.dataset.day));
  });
  el("pf-everyday-btn").textContent = builder.weekdays.size === 7 ? "Clear days" : "Every day";

  el("run-mode-hint").textContent = builder.runMode === "sequential"
    ? "Zones water one after another. Right for almost every home system - it keeps pressure up."
    : "Every zone opens at the cycle time. Only pick this if your supply can feed them all at once.";

  renderCycles();
  renderBuilderZones();
  refreshZoneAddSelect();
  renderTimeline();
}

// -- builder: save / reset / edit

function resetBuilder() {
  builder.editingId = null;
  builder.autoName = "";
  builder.stage = "custom";
  builder.presetName = "";
  builder.scheduleType = "weekdays";
  builder.weekdays = new Set();
  builder.intervalDays = 3;
  builder.defaultMinutes = 10;
  builder.cycles = [];
  builder.zones = [];
  builder.runMode = "sequential";
  el("pf-name").value = "";
  el("pf-add-zone-duration").value = 10;
  el("pf-enabled").checked = true;
  renderBuilder();
}

// ---- the builder modal --------------------------------------------------

const STEP_INFO = {
  start: { name: "Start", note: "Pick the stage your lawn is at, or start from blank." },
  schedule: { name: "Defaults", note: "Change any of these - the rest of the program follows." },
  zones: { name: "Zones", note: "Pick the zones, in the order they should run." },
  review: { name: "Review", note: "Check the timings, then save." },
};

let modalSteps = [];
let stepIndex = 0;
let lastFocused = null;

function openModal(program) {
  lastFocused = document.activeElement;
  if (program) {
    fillBuilderFrom(program);
    modalSteps = ["schedule", "zones", "review"];
    el("modal-title").textContent = "Edit program";
    el("modal-sub").textContent = program.name;
  } else {
    resetBuilder();
    modalSteps = ["start", "schedule", "zones", "review"];
    el("modal-title").textContent = "New program";
    el("modal-sub").textContent = "Four quick steps.";
  }
  el("program-modal").hidden = false;
  document.body.style.overflow = "hidden";
  goToStep(0);
}

async function closeModal(skipConfirm) {
  const started = builder.zones.length || builder.cycles.length || el("pf-name").value.trim();
  if (!skipConfirm && started) {
    const discard = await askConfirm({
      title: builder.editingId ? "Discard your changes?" : "Discard this program?",
      message: builder.editingId
        ? "The program stays exactly as it was before you opened it."
        : "Nothing has been saved yet, so this program will be lost.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (!discard) return;
  }
  el("program-modal").hidden = true;
  document.body.style.overflow = "";
  resetBuilder();
  if (lastFocused) lastFocused.focus();
}

function goToStep(index) {
  stepIndex = Math.max(0, Math.min(index, modalSteps.length - 1));
  const step = modalSteps[stepIndex];

  document.querySelectorAll(".step").forEach((section) => {
    section.hidden = section.dataset.step !== step;
  });

  el("modal-stepper").innerHTML = modalSteps
    .map((name, i) => {
      const state = i === stepIndex ? "current" : i < stepIndex ? "done" : "";
      return `<li class="${state}">
        <span class="dot">${i < stepIndex ? "&check;" : i + 1}</span>
        <span class="step-name">${STEP_INFO[name].name}</span>
      </li>`;
    })
    .join("");

  el("modal-step-note").textContent = STEP_INFO[step].note;
  el("modal-back").hidden = stepIndex === 0;
  const onReview = step === "review";
  el("modal-next").hidden = onReview;
  el("modal-save").hidden = !onReview;
  el("modal-save").textContent = builder.editingId ? "Save changes" : "Save program";

  if (onReview) renderTimeline();
  el("modal-body").scrollTop = 0;

  const firstInput = document.querySelector(`.step[data-step="${step}"] input, .step[data-step="${step}"] select`);
  if (firstInput) firstInput.focus({ preventScroll: true });
}

function stepProblem(step) {
  if (step === "schedule") {
    if (!el("pf-name").value.trim()) return "Give the program a name.";
    if (builder.scheduleType === "weekdays" && !builder.weekdays.size) {
      return "Pick at least one day of the week.";
    }
    if (!builder.cycles.length) return "Add at least one cycle time.";
  }
  if (step === "zones" && !builder.zones.length) {
    return zonesCache.length
      ? "Add at least one zone."
      : "You have no zones yet - add them on the Zones tab first.";
  }
  return null;
}

on("new-program-btn", "click", () => openModal(null));
on("modal-close", "click", () => closeModal(false));
on("modal-back", "click", () => goToStep(stepIndex - 1));
on("pf-custom-start", "click", () => {
  builder.stage = "custom";
  builder.presetName = "";
  renderBuilder();
  goToStep(modalSteps.indexOf("schedule"));
});

on("modal-next", "click", () => {
  const problem = stepProblem(modalSteps[stepIndex]);
  if (problem) return toast(problem, "error");
  goToStep(stepIndex + 1);
});

on("program-modal", "click", (e) => {
  if (e.target === el("program-modal")) closeModal(false);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // The confirm dialog sits on top, so it gets the key first.
  if (settleConfirm) return settleConfirm(null);
  if (!el("program-modal").hidden) closeModal(false);
});

on("modal-save", "click", () =>
  guard(async () => {
    for (const step of modalSteps) {
      const problem = stepProblem(step);
      if (problem) {
        goToStep(modalSteps.indexOf(step));
        throw new Error(problem);
      }
    }

    const weekdays = DAYS.filter((d) => builder.weekdays.has(d)).join(",");
    const payload = {
      name: el("pf-name").value.trim(),
      stage: builder.stage,
      schedule_type: builder.scheduleType,
      weekdays: builder.scheduleType === "weekdays" ? weekdays : null,
      interval_days: builder.scheduleType === "interval" ? builder.intervalDays : null,
      start_times: builder.cycles,
      run_mode: builder.runMode,
      enabled: el("pf-enabled").checked,
      zones: builder.zones.map((z, i) => ({
        zone_id: z.zone_id,
        duration_minutes: Number(z.duration_minutes),
        sort_order: i,
      })),
    };

    if (builder.editingId) {
      await apiPut(`api/programs/${builder.editingId}`, payload);
    } else {
      await apiPost("api/programs", payload);
    }
    await closeModal(true);
    await loadProgramsTab();
  }, "Program saved.")
);

function fillBuilderFrom(p) {
  builder.editingId = p.id;
  builder.autoName = "";
  builder.presetName = "";
  builder.stage = p.stage || "custom";
  builder.scheduleType = p.schedule_type;
  builder.weekdays = new Set((p.weekdays || "").split(",").filter(Boolean));
  builder.intervalDays = p.interval_days || 3;
  builder.cycles = [...(p.start_times || [])];
  builder.runMode = p.run_mode;
  builder.zones = p.zones.map((z) => ({
    zone_id: z.zone_id,
    zone_name: z.zone_name,
    duration_minutes: z.duration_minutes,
  }));
  // Seed the default from the saved zones without writing it back over them -
  // an existing program may deliberately give one zone its own runtime.
  builder.defaultMinutes = builder.zones.length ? builder.zones[0].duration_minutes : 10;
  el("pf-add-zone-duration").value = builder.defaultMinutes;
  el("pf-name").value = p.name;
  el("pf-enabled").checked = !!p.enabled;
  renderBuilder();
}

/**
 * "Stage 1 · Before Germination" when the program came from a preset, or null
 * when its name already says so - the preset's default name is exactly that,
 * and repeating it above itself is noise.
 */
function stageLabelFor(program) {
  const preset = presetsCache.find((p) => p.id === program.stage);
  if (!preset) return !program.stage || program.stage === "custom" ? "Custom" : program.stage;
  if (program.name.toLowerCase().startsWith(`stage ${preset.stage}`)) return null;
  return `Stage ${preset.stage} · ${preset.name}`;
}

function weekStrip(weekdays) {
  const active = new Set((weekdays || "").split(",").filter(Boolean));
  const days = DAYS.map((d) =>
    `<span class="week-day${active.has(d) ? " is-on" : ""}">${DAY_LABEL[d][0]}</span>`
  ).join("");
  return `<div class="week-strip" role="img"
               aria-label="${escapeHtml(daysSummary(weekdays))}">${days}</div>`;
}

function fmtNextRun(iso) {
  return isToday(iso)
    ? fmtClock(iso)
    : new Date(iso).toLocaleString([], inLawnZone({ weekday: "short", hour: "numeric", minute: "2-digit" }));
}

function renderProgramsList(programs) {
  const list = el("programs-list");
  const running = programs.filter((p) => p.enabled).length;
  el("programs-sub").textContent = programs.length
    ? `${running} enabled · ${programs.length - running} off`
    : "";

  if (!programs.length) {
    emptyState(list, 'No programs yet. Hit "New program" to build your first one.');
    return;
  }

  list.innerHTML = "";
  programs.forEach((p) => {
    const zoneCount = p.zones.length;
    const perCycle = p.zones.reduce((a, z) => a + z.duration_minutes, 0);
    const runtime = p.run_mode === "simultaneous"
      ? Math.max(0, ...p.zones.map((z) => z.duration_minutes))
      : perCycle;
    const runtimes = new Set(p.zones.map((z) => z.duration_minutes));
    const next = p.next_run_time;
    const stage = stageLabelFor(p);

    const row = document.createElement("article");
    row.className = `program-card${p.enabled ? "" : " is-off"}`;
    row.innerHTML = `
      <div class="program-head">
        <div class="program-id">
          ${stage ? `<div class="program-stage">${escapeHtml(stage)}</div>` : ""}
          <div class="program-title">
            <h3>${escapeHtml(p.name)}</h3>
            <span class="pill ${p.enabled ? "pill-on" : "pill-quiet"}">${p.enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <div class="program-detail">${
            zoneCount ? `${zoneCount} zone${zoneCount === 1 ? "" : "s"}` : "no zones"
          } &middot; ${
            runtimes.size === 1 ? `${[...runtimes][0]} min each` : "mixed runtimes"
          } &middot; ${
            p.run_mode === "simultaneous" ? "all together" : "one at a time"
          } &middot; ${escapeHtml(fmtDuration(runtime))} per cycle</div>
        </div>
        <div class="program-next">
          <div class="tile-label">Next run</div>
          <div class="program-next-time">${next ? escapeHtml(fmtNextRun(next)) : "&mdash;"}</div>
          <div class="tile-sub">${
            next ? escapeHtml(fmtRelative(next)) : p.enabled ? "not scheduled" : "off while disabled"
          }</div>
        </div>
      </div>

      <div class="program-foot">
        ${p.schedule_type === "interval"
          ? `<span class="chip chip-cadence">Every ${p.interval_days} day${p.interval_days === 1 ? "" : "s"}</span>`
          : weekStrip(p.weekdays)}
        <div class="cycle-chips">${
          (p.start_times || []).map((t) => `<span class="chip">${escapeHtml(fmt12(t))}</span>`).join("")
            || `<span class="chip chip-empty">no cycles set</span>`
        }</div>
        <div class="program-actions">
          <button class="btn btn-small run-now">Run now</button>
          <button class="btn btn-small edit-program">Edit</button>
          <button class="btn btn-small toggle-program">${p.enabled ? "Disable" : "Enable"}</button>
          <button class="btn btn-small btn-danger delete-program">Delete</button>
        </div>
      </div>
    `;
    row.querySelector(".run-now").addEventListener("click", () =>
      guard(async () => {
        await apiPost(`api/programs/${p.id}/run_now`, {});
        await refreshDashboard();
        switchTab("dashboard");
      }, `${p.name} started.`)
    );
    row.querySelector(".toggle-program").addEventListener("click", () =>
      guard(async () => {
        await apiPatch(`api/programs/${p.id}/toggle`);
        await loadProgramsTab();
      })
    );
    row.querySelector(".edit-program").addEventListener("click", () => openModal(p));
    row.querySelector(".delete-program").addEventListener("click", () =>
      guard(async () => {
        const go = await askConfirm({
          title: `Delete ${p.name}?`,
          message: "The schedule and its cycle times are removed. Run history is kept.",
          confirmLabel: "Delete program",
          danger: true,
        });
        if (!go) return;
        await apiDelete(`api/programs/${p.id}`);
        await loadProgramsTab();
      })
    );
    list.appendChild(row);
  });
}

// ---- history tab ------------------------------------------------------------

let historyDay = null;   // YYYY-MM-DD currently shown; null means "today"

/** Today where the lawn is - the day the history API takes as "today". */
function todayIso() {
  return lawnDate();
}

function shiftDay(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

let historyTimezone = "";

async function loadHistoryTab() {
  historyDay = historyDay || todayIso();
  const [stats, day] = await Promise.all([
    // Not scoped to the day: something that failed three weeks ago and was
    // never looked at is exactly what the panel at the top is for.
    apiGet("api/history/stats?days=14"),
    apiGet(`api/history?date=${historyDay}`),
  ]);
  historyTimezone = stats.timezone || "";
  setLawnTimeZone(stats.timezone);
  renderAttention(stats);
  renderDayPicker();
  renderRuns(day.runs);
}

/** Fetch just the chosen day - the tab no longer loads everything ever run. */
async function showDay(iso) {
  historyDay = iso;
  renderDayPicker();
  el("history-list").innerHTML = `<div class="empty">Loading&#8230;</div>`;
  const day = await apiGet(`api/history?date=${iso}`);
  renderRuns(day.runs);
}

function renderDayPicker() {
  const today = todayIso();
  el("day-input").value = historyDay;
  el("day-input").max = today;
  el("day-next").disabled = historyDay >= today;
  el("day-today").hidden = historyDay === today;

  el("history-day-title").textContent = historyDay === today
    ? "Today"
    : historyDay === shiftDay(today, -1)
      ? "Yesterday"
      : fmtLongDate(historyDay);
}

function fmtLongDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], {
    weekday: "long", month: "long", day: "numeric",
  });
}

function renderAttention(stats) {
  const host = el("history-attention");
  const items = stats.attention || [];
  if (!items.length) {
    host.innerHTML = "";
    return;
  }

  // The list is only the latest few; the total is how many are outstanding.
  const total = Math.max(stats.attention_total ?? items.length, items.length);

  // Errors mean something went wrong; a skip is usually deliberate (rain delay).
  const hasError = items.some((r) => r.status === "error" || r.status === "interrupted");
  const row = (r) => {
    const label = STATUS_LABEL[r.status] || r.status;
    // A whole-program skip has no zone, so the program name is already the title.
    const detail = r.zone_name
      ? `${escapeHtml(r.program_name || "Manual")} &middot; ${fmtDateTime(r.started_at)}`
      : `Whole program &middot; ${fmtDateTime(r.started_at)}`;
    return `<div class="row-item">
      <div class="meta">
        <div class="primary">${escapeHtml(r.zone_name || r.program_name || "Run")}</div>
        <div class="secondary">${detail}</div>
      </div>
      <div class="actions">
        <span class="pill ${STATUS_PILL[r.status] || "pill-quiet"}">${escapeHtml(label)}</span>
      </div>
    </div>`;
  };

  // The latest few up front and the rest folded away: a long backlog here
  // otherwise pushes the day's timeline - the point of the tab - off screen.
  const SHOWN = 3;
  const hidden = items.slice(SHOWN);
  const more = total - SHOWN;
  host.innerHTML = `
    <div class="attention ${hasError ? "" : "is-warning"}">
      <div class="attention-head">
        <span class="attention-icon" aria-hidden="true">${hasError ? "&#9888;" : "&#9208;"}</span>
        <h2>${total} run${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} a look</h2>
        <button class="btn btn-small" id="dismiss-attention">${total > 1 ? "Mark all as seen" : "Mark as seen"}</button>
      </div>
      <p class="hint">
        ${hasError
          ? "A zone failed or was cut short. Check the valve and the add-on log."
          : "These runs were skipped on purpose - no water went out."}
      </p>
      <div class="stack">${items.slice(0, SHOWN).map(row).join("")}</div>
      ${more > 0 ? `
        <details class="attention-more">
          <summary>Show ${more} more</summary>
          <div class="stack">${hidden.map(row).join("")}</div>
          ${total > items.length
            ? `<p class="hint">…and ${total - items.length} older. Marking all as seen clears those too.</p>`
            : ""}
        </details>` : ""}
    </div>
  `;

  host.querySelector("#dismiss-attention").addEventListener("click", () =>
    guard(async () => {
      // Clears the flag only - the runs stay in the history either way. Name
      // the runs when every one is on screen; when some aren't, "all" has to
      // mean all, not just the ones that happened to be loaded.
      const { cleared } = await apiPost("api/history/acknowledge", {
        run_ids: total > items.length ? null : items.map((r) => r.id),
      });
      await loadHistoryTab();
      toast(`${cleared} run${cleared === 1 ? "" : "s"} marked as seen.`);
    })
  );
}


// Three outcomes, not two: a zone that watered, one deliberately cut short, and
// one that failed. Lumping the middle in with either misreads what happened.
const STEP_OK = new Set(["completed", "running"]);
const STEP_CUT_SHORT = new Set(["stopped", "stopped_external", "paused_expired"]);

function stepOutcome(status) {
  if (STEP_OK.has(status)) return "ok";
  return STEP_CUT_SHORT.has(status) ? "cut" : "bad";
}

// Matches PROBLEM_STATUSES in app/api/routes_status.py - the ones the
// "needs a look" panel counts, and so the ones worth offering to clear.
const PROBLEM_STATUSES = new Set(["error", "interrupted", "skipped_rain_delay", "skipped_unavailable"]);

// The subset that means something went wrong, as opposed to a run that was
// held back on purpose (a rain delay) - only these are painted red.
const FAILURE_STATUSES = new Set(["error", "interrupted", "skipped_unavailable"]);

/**
 * The day as a timeline: time down the left, one event per program execution,
 * each opened out into the zones it ran. The point is being able to see at a
 * glance that steps 1-2 watered and 3-4 didn't, instead of reading four
 * separate rows and working out they belonged together.
 */
function renderRuns(runs) {
  const list = el("history-list");

  renderDaySummary(runs);

  if (!runs.length) {
    emptyState(list, "Nothing ran on this day.");
    return;
  }

  list.innerHTML = "";
  runs.forEach((run) => {
    // Red for something that went wrong; amber for a zone that didn't finish
    // for a reason that isn't a fault, like a rain delay or someone stopping it.
    const failed = run.steps.some((s) => FAILURE_STATUSES.has(s.status));
    const partial = !failed && run.unfinished_count > 0;

    // A zone run by hand is a single step with no number - it reads as that
    // zone, not as a program called "Manual run" with one anonymous step.
    // Older rows have no step number; newer manual runs are "step 1" of no
    // program. Either way it's one zone on its own.
    const solo = run.steps.length === 1 && Boolean(run.steps[0].zone_name)
      && (run.steps[0].step == null || run.program_id == null);
    const title = solo ? run.steps[0].zone_name : run.program_name;

    let summary;
    if (run.whole_program) {
      summary = STATUS_LABEL[run.steps[0].status] || run.steps[0].status;
    } else if (solo) {
      summary = failed ? "Failed" : partial ? STATUS_LABEL[run.steps[0].status] || "Didn't finish" : "Completed";
    } else if (failed) {
      const first = run.steps.find((s) => FAILURE_STATUSES.has(s.status));
      summary = first?.step ? `Failed at step ${first.step}` : "Failed";
    } else if (partial) {
      summary = `${run.unfinished_count} of ${run.steps.length} didn't finish`;
    } else {
      summary = run.steps.length === 1 ? "Completed" : `All ${run.steps.length} zones watered`;
    }

    // Hundredths of an inch is the precision the estimate has; a run that
    // gave less than that reads better with no figure than with ".00".
    const inches = inchesFor(perZoneMinutes(run));

    const event = document.createElement("div");
    event.className = `run-event${failed ? " has-problem" : partial ? " is-partial" : ""}`;
    event.innerHTML = `
      <div class="run-when">
        <div class="run-time">${escapeHtml(fmtClock(run.started_at))}</div>
        <div class="run-dur">${run.minutes >= 1 ? escapeHtml(fmtDuration(run.minutes)) : ""}</div>
      </div>
      <div class="run-rail"><span class="run-dot"></span></div>
      <div class="run-card">
        <div class="run-head">
          <div class="run-name">${escapeHtml(title)}</div>
          <span class="pill ${failed ? "pill-danger" : partial ? "pill-warn" : "pill-quiet"}">${escapeHtml(summary)}</span>
          <span class="run-water">${inches >= 0.01 ? `${escapeHtml(fmtInches(inches))} per zone` : ""}</span>
        </div>
        <div class="run-sub">${
          solo ? "Run by hand" : run.trigger_source === "manual" ? "Started by hand" : "Scheduled"
        }${run.ended_at ? ` &middot; finished ${escapeHtml(fmtClock(run.ended_at))}` : ""}</div>
      </div>
    `;

    const card = event.querySelector(".run-card");

    // Say what went wrong in words, right where it happened, and let it be
    // cleared from here rather than only from the panel at the top.
    const problems = run.steps.filter((s) => stepOutcome(s.status) !== "ok");
    const lines = problems
      .map((s) => {
        const label = STATUS_LABEL[s.status] || s.status;
        if (solo || run.whole_program) return label;
        return `${s.step ? `Step ${s.step} · ` : ""}${s.zone_name || "Zone"}: ${label}`;
      })
      .join(". ");
    const clearable = problems.filter((s) => PROBLEM_STATUSES.has(s.status) && !s.acknowledged);
    // Skip the note when the pill already says exactly this and there's
    // nothing to acknowledge - "Stopped early" twice is just noise.
    if (problems.length && (lines !== summary || clearable.length)) {
      card.insertAdjacentHTML("beforeend", `
        <div class="run-problem${failed ? " is-failure" : ""}">
          <span>${escapeHtml(lines)}.</span>
          ${clearable.length ? `<button class="btn btn-small ack-run">Acknowledge</button>` : ""}
        </div>
      `);
      card.querySelector(".ack-run")?.addEventListener("click", () =>
        guard(async () => {
          await apiPost("api/history/acknowledge", { run_ids: clearable.map((s) => s.id) });
          await loadHistoryTab();
        }, "Marked as seen.")
      );
    }

    // One zone has nothing to lay out - the title and the note above say it all.
    if (!run.whole_program && !solo) {
      const steps = run.steps
        .map((s) => {
          const outcome = stepOutcome(s.status);
          const label = STATUS_LABEL[s.status] || s.status;
          const detail = outcome === "ok"
            ? s.minutes ? fmtDuration(s.minutes) : "—"
            : label;
          return `<li class="run-step run-step-${outcome}"
                      title="${escapeHtml(`${s.zone_name || "Zone"} - ${label}`)}">
            <span class="run-step-n">${s.step ? `Step ${s.step}` : "Zone"}</span>
            <span class="run-step-zone">${escapeHtml(s.zone_name || "Zone")}</span>
            <span class="run-step-detail">${escapeHtml(detail)}</span>
          </li>`;
        })
        .join("");
      card.insertAdjacentHTML("beforeend", `<ol class="run-steps">${steps}</ol>`);
    }

    list.appendChild(event);
  });
}

/** What a single zone got out of this run, which is what an inch figure means. */
function perZoneMinutes(run) {
  const zones = new Set(run.steps.filter((s) => s.zone_name).map((s) => s.zone_name));
  return zones.size ? run.minutes / zones.size : run.minutes;
}

function renderDaySummary(runs) {
  const problems = runs.flatMap((r) => r.steps).filter((s) => FAILURE_STATUSES.has(s.status)).length;
  const minutes = runs.reduce((total, r) => total + r.minutes, 0);
  const zones = new Set(
    runs.flatMap((r) => r.steps).filter((s) => s.zone_name && s.minutes > 0).map((s) => s.zone_name)
  );
  el("history-day-sub").textContent = [
    `${runs.length} run${runs.length === 1 ? "" : "s"}`,
    zones.size ? `${fmtInches(inchesFor(minutes / zones.size))} per zone` : null,
    problems ? `${problems} failure${problems === 1 ? "" : "s"}` : null,
    historyTimezone,
  ].filter(Boolean).join(" · ");
}

// Remember whether the zone panel was left open. localStorage can throw in a
// locked-down browser, and a forgotten preference is not worth an exception.
(() => {
  const panel = el("zone-panel");
  if (!panel) return;
  try {
    panel.open = localStorage.getItem("zonePanelOpen") !== "false";
  } catch { /* fine - it just starts open */ }
  panel.addEventListener("toggle", () => {
    try {
      localStorage.setItem("zonePanelOpen", String(panel.open));
    } catch { /* ignore */ }
  });
})();

on("day-prev", "click", () => guard(() => showDay(shiftDay(historyDay, -1))));
on("day-next", "click", () => guard(() => showDay(shiftDay(historyDay, 1))));
on("day-today", "click", () => guard(() => showDay(todayIso())));
on("day-input", "change", (e) => {
  if (e.target.value) guard(() => showDay(e.target.value));
});

// ---- init -------------------------------------------------------------------

// A stale index.html paired with a fresh app.js leaves half the page unwired.
// Say so plainly rather than letting the user hunt dead buttons.
if (missingNodes) {
  toast("This page is out of date. Reload the page to get the current version.", "error");
}

renderBuilder();
guard(loadDashboard);
setInterval(() => {
  loadDashboard();
  refreshZoneStates();
}, 5000);
