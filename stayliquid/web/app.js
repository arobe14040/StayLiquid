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

function fmtDateTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString([], {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
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

function rowItem(primary, secondary, actionsHtml) {
  const div = document.createElement("div");
  div.className = "row-item";
  div.innerHTML = `
    <div class="meta">
      <div class="primary">${primary}</div>
      <div class="secondary">${secondary}</div>
    </div>
    <div class="actions">${actionsHtml || ""}</div>
  `;
  return div;
}

function emptyState(container, message) {
  container.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

function scheduleSummary(p) {
  const times = (p.start_times || []).map(fmt12).join(", ") || "no cycles set";
  const cadence = p.schedule_type === "interval"
    ? `Every ${p.interval_days} day${p.interval_days === 1 ? "" : "s"}`
    : daysSummary(p.weekdays);
  return `${cadence} &middot; ${escapeHtml(times)}`;
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

async function loadDashboard() {
  let status;
  try {
    status = await apiGet("api/status");
  } catch {
    return;
  }

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

  const runs = status.current_runs;
  const countPill = el("running-count");
  countPill.textContent = runs.length
    ? `${runs.length} zone${runs.length === 1 ? "" : "s"} watering`
    : "Idle";
  countPill.className = `pill ${runs.length ? "pill-on" : "pill-quiet"}`;

  const runsEl = el("current-runs");
  if (!runs.length) {
    emptyState(runsEl, "Nothing is watering right now.");
  } else {
    runsEl.innerHTML = "";
    for (const r of runs) {
      const totalMs = r.duration_minutes * 60000;
      const elapsed = Date.now() - new Date(r.started_at).getTime();
      const pct = Math.min(100, Math.max(0, (elapsed / totalMs) * 100));
      const leftMin = Math.max(0, Math.ceil((totalMs - elapsed) / 60000));
      const row = rowItem(
        escapeHtml(r.zone_name),
        `${escapeHtml(r.program_name)} &middot; ${leftMin}m left of ${fmtDuration(r.duration_minutes)}`,
        `<span class="pill pill-on">On</span>`
      );
      row.querySelector(".meta").insertAdjacentHTML(
        "beforeend",
        `<div class="progress"><i style="width:${pct.toFixed(1)}%"></i></div>`
      );
      runsEl.appendChild(row);
    }
  }

  const nextEl = el("next-events");
  if (!status.next_events.length) {
    emptyState(nextEl, "No upcoming runs. Create a program to get started.");
  } else {
    nextEl.innerHTML = "";
    for (const ev of status.next_events) {
      nextEl.appendChild(
        rowItem(
          escapeHtml(ev.program_name),
          `${fmtDateTime(ev.next_run_time)} &middot; ${escapeHtml(ev.zones)}`,
          `<span class="pill pill-quiet">${escapeHtml(fmtRelative(ev.next_run_time))}</span>`
        )
      );
    }
  }
}

document.querySelectorAll("[data-delay]").forEach((btn) => {
  btn.addEventListener("click", () =>
    guard(async () => {
      await apiPost("api/raindelay", { hours: Number(btn.dataset.delay) });
      await loadDashboard();
    }, `Rain delay set for ${btn.dataset.delay} hours.`)
  );
});

on("apply-custom-delay", "click", () =>
  guard(async () => {
    const hours = Number(el("custom-delay-hours").value);
    if (!hours || hours <= 0) throw new Error("Enter a number of hours.");
    await apiPost("api/raindelay", { hours });
    el("custom-delay-hours").value = "";
    await loadDashboard();
  }, "Rain delay set.")
);

on("clear-delay-btn", "click", () =>
  guard(async () => {
    await apiDelete("api/raindelay");
    await loadDashboard();
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

/** Point each zone's run toggle at whatever is actually watering right now. */
function paintZoneRunState(currentRuns) {
  lastCurrentRuns = currentRuns || [];
  const running = new Map(lastCurrentRuns.map((r) => [r.zone_id, r]));

  zoneRows.forEach((refs, zoneId) => {
    if (!refs.button.isConnected) return zoneRows.delete(zoneId);
    const run = running.get(zoneId);

    // A run of ours just ended, which means we closed the valve - so whatever
    // HA reported when the list was drawn is now out of date.
    if (refs.wasRunning && !run) refs.reportedOn = false;
    refs.wasRunning = Boolean(run);

    // Open if we're running it, or if HA said so when the list was drawn -
    // somebody may have switched it on outside the add-on.
    refs.pill.hidden = !run && !refs.reportedOn;

    if (run) {
      const endsAt = new Date(run.started_at).getTime() + run.duration_minutes * 60000;
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 60000));
      refs.button.dataset.running = "true";
      refs.button.textContent = `Stop · ${left}m left`;
      refs.button.classList.add("btn-running");
      refs.button.setAttribute("aria-pressed", "true");
      refs.button.setAttribute("aria-label", `Stop ${refs.name}`);
      refs.minutes.disabled = true;
    } else {
      refs.button.dataset.running = "false";
      refs.button.textContent = "Test run";
      refs.button.classList.remove("btn-running");
      refs.button.setAttribute("aria-pressed", "false");
      refs.button.setAttribute("aria-label", `Test run ${refs.name}`);
      refs.minutes.disabled = false;
    }
  });
}

async function loadZonesTab() {
  const [zones, entities, status] = await Promise.all([
    apiGet("api/zones"),
    apiGet("api/ha/entities"),
    apiGet("api/status"),
  ]);
  zonesCache = zones;
  zoneRows.clear();

  const stateByEntity = Object.fromEntries(entities.map((e) => [e.entity_id, e.state]));
  const usedIds = new Set(zones.map((z) => z.entity_id));
  const available = entities.filter((e) => !usedIds.has(e.entity_id));

  el("new-zone-entity").innerHTML = available.length
    ? available
        .map((e) => `<option value="${escapeHtml(e.entity_id)}">${escapeHtml(e.friendly_name)} (${escapeHtml(e.entity_id)})</option>`)
        .join("")
    : `<option value="">No unassigned switch or valve entities found</option>`;

  const list = el("zones-list");
  if (!zones.length) {
    emptyState(list, "No zones yet. Add your first sprinkler circuit above.");
    return;
  }

  list.innerHTML = "";
  zones.forEach((z) => {
    const row = rowItem(
      `${escapeHtml(z.name)} ${z.enabled ? "" : `<span class="pill pill-quiet">Disabled</span>`}`,
      escapeHtml(z.entity_id),
      `
        <span class="pill pill-on zone-on-pill" ${stateByEntity[z.entity_id] === "on" ? "" : "hidden"}>On</span>
        <button class="btn btn-icon rename-zone" title="Rename zone" aria-label="Rename ${escapeHtml(z.name)}">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" />
            <path d="M14 6l4 4" />
          </svg>
        </button>
        <input type="number" class="run-minutes" value="5" min="0.5" step="0.5" style="width:70px" />
        <button class="btn btn-small run-zone" aria-pressed="false">Test run</button>
        <button class="btn btn-small toggle-zone">${z.enabled ? "Disable" : "Enable"}</button>
        <button class="btn btn-small btn-danger delete-zone">Delete</button>
      `
    );
    const runBtn = row.querySelector(".run-zone");
    const minutesInput = row.querySelector(".run-minutes");
    zoneRows.set(z.id, {
      button: runBtn,
      minutes: minutesInput,
      pill: row.querySelector(".zone-on-pill"),
      name: z.name,
      entityId: z.entity_id,
      reportedOn: stateByEntity[z.entity_id] === "on",
    });

    runBtn.addEventListener("click", () =>
      guard(async () => {
        if (runBtn.dataset.running === "true") {
          await apiPost(`api/zones/${z.id}/stop`, {});
          toast(`${z.name} stopped.`);
        } else {
          const minutes = Number(minutesInput.value);
          if (!minutes || minutes <= 0) throw new Error("Set how many minutes to run for.");
          await apiPost(`api/zones/${z.id}/run`, { minutes });
          toast(`${z.name} running for ${fmtDuration(minutes)}.`);
        }
        // Reflect the change straight away instead of waiting for the poll.
        await loadDashboard();
      })
    );
    row.querySelector(".rename-zone").addEventListener("click", () =>
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
    row.querySelector(".toggle-zone").addEventListener("click", () =>
      guard(async () => {
        await apiPut(`api/zones/${z.id}`, { enabled: !z.enabled });
        await loadZonesTab();
      })
    );
    row.querySelector(".delete-zone").addEventListener("click", () =>
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
    list.appendChild(row);
  });

  paintZoneRunState(status.current_runs);
}

on("add-zone-btn", "click", () =>
  guard(async () => {
    const entityId = el("new-zone-entity").value;
    const name = el("new-zone-name").value.trim();
    if (!entityId) throw new Error("Pick a Home Assistant entity first.");
    if (!name) throw new Error("Give the zone a name.");
    await apiPost("api/zones", { entity_id: entityId, name });
    el("new-zone-name").value = "";
    await loadZonesTab();
  }, "Zone added.")
);

// ---- programs tab -----------------------------------------------------------

async function loadProgramsTab() {
  const [presets, programs, zones] = await Promise.all([
    apiGet("api/presets"),
    apiGet("api/programs"),
    apiGet("api/zones"),
  ]);
  presetsCache = presets;
  zonesCache = zones;

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
    row.innerHTML = `
      <span class="cycle-tag">${escapeHtml(cycleLabel(time))}</span>
      <input type="time" value="${escapeHtml(time)}" step="300" />
      <span class="cycle-note"></span>
      <button type="button" class="btn btn-icon remove-cycle" title="Remove cycle">&times;</button>
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
  if (!builder.zones.length) {
    emptyState(
      list,
      zonesCache.length
        ? "No zones in this program yet. Add them below, or pick a growth stage to add them all."
        : "You have no zones configured. Add them on the Zones tab first."
    );
    return;
  }

  list.innerHTML = "";
  builder.zones.forEach((z, idx) => {
    const perCycle = inchesFor(z.duration_minutes);
    const row = rowItem(
      `${idx + 1}. ${escapeHtml(z.zone_name)}`,
      `<span class="water-note">${fmtInches(perCycle)} per cycle &middot; ${fmtInches(perCycle * builder.cycles.length)} per day</span>`,
      `
        <input type="number" class="zone-minutes" value="${z.duration_minutes}" min="0.5" step="0.5" style="width:78px" />
        <span class="inline-label">min</span>
        <button type="button" class="btn btn-icon move-up" title="Move earlier" ${idx === 0 ? "disabled" : ""}>&uarr;</button>
        <button type="button" class="btn btn-icon move-down" title="Move later" ${idx === builder.zones.length - 1 ? "disabled" : ""}>&darr;</button>
        <button type="button" class="btn btn-icon remove-zone" title="Remove zone">&times;</button>
      `
    );

    const input = row.querySelector(".zone-minutes");
    input.addEventListener("input", () => {
      z.duration_minutes = Number(input.value) || 0;
      const per = inchesFor(z.duration_minutes);
      row.querySelector(".water-note").innerHTML =
        `${fmtInches(per)} per cycle &middot; ${fmtInches(per * builder.cycles.length)} per day`;
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

    list.appendChild(row);
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

function renderProgramsList(programs) {
  const list = el("programs-list");
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
    const row = rowItem(
      `${escapeHtml(p.name)} ${p.enabled ? "" : `<span class="pill pill-quiet">Disabled</span>`}`,
      `${scheduleSummary(p)}<br />${zoneCount} zone${zoneCount === 1 ? "" : "s"} &middot; ${fmtDuration(runtime)} per cycle &middot; ${p.run_mode === "simultaneous" ? "all together" : "one at a time"}`,
      `
        <button class="btn btn-small run-now">Run now</button>
        <button class="btn btn-small toggle-program">${p.enabled ? "Disable" : "Enable"}</button>
        <button class="btn btn-small edit-program">Edit</button>
        <button class="btn btn-small btn-danger delete-program">Delete</button>
      `
    );
    row.querySelector(".run-now").addEventListener("click", () =>
      guard(async () => {
        await apiPost(`api/programs/${p.id}/run_now`, {});
        await loadDashboard();
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

async function loadHistoryTab() {
  const [stats, rows] = await Promise.all([
    apiGet("api/history/stats?days=14"),
    apiGet("api/history?limit=60"),
  ]);
  renderAttention(stats);
  renderHistoryStats(stats);
  renderActivityChart(stats);
  renderHistoryList(rows);
}

function renderAttention(stats) {
  const host = el("history-attention");
  const items = stats.attention || [];
  if (!items.length) {
    host.innerHTML = "";
    return;
  }

  // Errors mean something went wrong; a skip is usually deliberate (rain delay).
  const hasError = items.some((r) => r.status === "error" || r.status === "interrupted");
  const rows = items
    .map((r) => {
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
    })
    .join("");

  host.innerHTML = `
    <div class="attention ${hasError ? "" : "is-warning"}">
      <div class="attention-head">
        <span class="attention-icon" aria-hidden="true">${hasError ? "&#9888;" : "&#9208;"}</span>
        <h2>${items.length} run${items.length === 1 ? "" : "s"} need${items.length === 1 ? "s" : ""} a look</h2>
      </div>
      <p class="hint">
        ${hasError
          ? "A zone failed or was cut short. Check the valve and the add-on log."
          : "These runs were skipped on purpose - no water went out."}
      </p>
      <div class="stack">${rows}</div>
    </div>
  `;
}

function renderHistoryStats(stats) {
  const t = stats.totals;
  el("history-timezone").textContent = stats.timezone;
  el("history-stats").innerHTML = `
    <div class="stat">
      <div class="label">Water applied</div>
      <div class="value">${fmtInches(t.inches)}</div>
      <div class="sub">estimated, per zone</div>
    </div>
    <div class="stat">
      <div class="label">Time watering</div>
      <div class="value">${escapeHtml(fmtDuration(t.minutes))}</div>
      <div class="sub">${t.zones} zone${t.zones === 1 ? "" : "s"} involved</div>
    </div>
    <div class="stat">
      <div class="label">Runs completed</div>
      <div class="value">${t.runs}</div>
      <div class="sub">across ${stats.days} days</div>
    </div>
    <div class="stat${t.problems ? " stat-problem" : ""}">
      <div class="label">Needs a look</div>
      <div class="value">${t.problems}</div>
      <div class="sub">${t.errors} error${t.errors === 1 ? "" : "s"}, ${t.skipped} skipped</div>
    </div>
  `;
}

function renderActivityChart(stats) {
  const plot = el("chart-plot");
  const days = stats.by_day;
  const max = Math.max(...days.map((d) => d.minutes), 1);
  const hasAny = days.some((d) => d.minutes > 0 || d.problems > 0);

  if (!hasAny) {
    plot.innerHTML = `<div class="timeline-empty">Nothing watered in the last ${stats.days} days.</div>`;
    return;
  }

  const bars = days
    .map((d) => {
      const height = d.minutes > 0 ? Math.max(2, (d.minutes / max) * 100) : 2;
      const flag = d.problems ? `<span class="chart-flag" aria-hidden="true"></span>` : "";
      return `<div class="chart-col${d.minutes ? "" : " is-empty"}">
        <div class="chart-bar" style="height:${height.toFixed(1)}%">${flag}</div>
      </div>`;
    })
    .join("");

  el("chart-peak").textContent = `peak ${fmtDuration(max)}`;
  plot.innerHTML = `
    <div class="chart-grid"><span style="top:0"></span><span style="top:50%"></span><span style="bottom:0"></span></div>
    <div class="chart-bars">${bars}</div>
    <div class="chart-axis">${days.map((d) => `<span>${d.day_of_month}</span>`).join("")}</div>
    <div class="chart-tip" hidden></div>
  `;

  const tip = plot.querySelector(".chart-tip");
  plot.querySelectorAll(".chart-col").forEach((col, i) => {
    const d = days[i];
    col.addEventListener("mouseenter", () => {
      tip.innerHTML = `
        <div class="tip-day">${escapeHtml(d.weekday)}, ${escapeHtml(fmtShortDate(d.date))}</div>
        <div class="tip-row">${escapeHtml(fmtDuration(d.minutes))} &middot; ${d.runs} run${d.runs === 1 ? "" : "s"}</div>
        ${d.problems ? `<div class="tip-problem">${d.problems} need${d.problems === 1 ? "s" : ""} a look</div>` : ""}
      `;
      tip.hidden = false;

      // Anchor above the bar, but keep the whole tooltip inside the plot so a
      // full-height bar doesn't push it over the caption or off the edge.
      const bar = col.querySelector(".chart-bar").getBoundingClientRect();
      const host = plot.getBoundingClientRect();
      const half = tip.offsetWidth / 2;
      const left = bar.left - host.left + bar.width / 2;
      tip.style.left = `${Math.min(Math.max(left, half), host.width - half)}px`;
      tip.style.top = `${Math.max(bar.top - host.top - 8, tip.offsetHeight + 2)}px`;
    });
    col.addEventListener("mouseleave", () => { tip.hidden = true; });
  });
}

function fmtShortDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: "short", day: "numeric" });
}

function dayHeading(iso) {
  const today = new Date();
  const date = new Date(iso);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function renderHistoryList(rows) {
  const list = el("history-list");
  if (!rows.length) {
    emptyState(list, "No runs logged yet.");
    return;
  }

  list.innerHTML = "";
  let currentDay = null;
  rows.forEach((r) => {
    const heading = dayHeading(r.started_at);
    if (heading !== currentDay) {
      currentDay = heading;
      const h = document.createElement("div");
      h.className = "day-heading";
      h.textContent = heading;
      list.appendChild(h);
    }

    const label = STATUS_LABEL[r.status] || r.status;
    // A skipped run never opened a valve, so its elapsed time means nothing.
    const ran = r.started_at && r.ended_at && !r.status.startsWith("skipped")
      ? fmtDuration((new Date(r.ended_at) - new Date(r.started_at)) / 60000)
      : null;
    const time = new Date(r.started_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const source = r.zone_name ? escapeHtml(r.program_name || "Manual") : "Whole program";

    list.appendChild(
      rowItem(
        escapeHtml(r.zone_name || r.program_name || "Run"),
        `${escapeHtml(time)} &middot; ${source}${ran ? ` &middot; ran ${ran}` : ""}`,
        `<span class="pill ${STATUS_PILL[r.status] || "pill-quiet"}">${escapeHtml(label)}</span>`
      )
    );
  });
}

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
