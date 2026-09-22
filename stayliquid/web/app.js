// All fetch() calls are relative (no leading slash) because Ingress serves
// this add-on under a dynamic sub-path - an absolute "/api/..." URL would
// break outside of local dev.

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

let zonesCache = [];
let entitiesCache = [];
let builderZones = [];       // [{zone_id, zone_name, duration_minutes, sort_order}]
let editingProgramId = null;

// ---- fetch helper -----------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    throw new Error((body && (body.detail || JSON.stringify(body))) || res.statusText);
  }
  return body;
}
const apiGet = (p) => api(p);
const apiPost = (p, data) => api(p, { method: "POST", body: JSON.stringify(data) });
const apiPut = (p, data) => api(p, { method: "PUT", body: JSON.stringify(data) });
const apiPatch = (p) => api(p, { method: "PATCH" });
const apiDelete = (p) => api(p, { method: "DELETE" });

function fmtDateTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString([], {
    weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function scheduleSummary(p) {
  if (p.schedule_type === "interval") {
    return `Every ${p.interval_days} day(s) at ${p.start_time}`;
  }
  const days = (p.weekdays || "").split(",").filter(Boolean).map((d) => DAY_LABEL[d]).join(", ");
  return `${days || "(no days set)"} at ${p.start_time}`;
}

// ---- tabs -------------------------------------------------------------------

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (name === "zones") loadZonesTab();
  if (name === "programs") loadProgramsTab();
  if (name === "history") loadHistoryTab();
}

// ---- dashboard ----------------------------------------------------------------

async function loadDashboard() {
  let status;
  try {
    status = await apiGet("api/status");
  } catch (e) {
    return;
  }

  const banner = document.getElementById("raindelay-banner");
  if (status.rain_delay.active) {
    banner.hidden = false;
    banner.textContent = `Rain delay active until ${fmtDateTime(status.rain_delay.until)}`;
  } else {
    banner.hidden = true;
  }

  const runsEl = document.getElementById("current-runs");
  runsEl.innerHTML = "";
  if (status.current_runs.length === 0) {
    runsEl.textContent = "Nothing running right now.";
  } else {
    for (const r of status.current_runs) {
      const end = new Date(r.started_at).getTime() + r.duration_minutes * 60000;
      const remainingMin = Math.max(0, Math.round((end - Date.now()) / 60000));
      runsEl.appendChild(
        rowItem(r.zone_name, `${r.program_name} \u2022 ~${remainingMin} min left`)
      );
    }
  }

  const nextEl = document.getElementById("next-events");
  nextEl.innerHTML = "";
  if (status.next_events.length === 0) {
    nextEl.textContent = "No upcoming runs scheduled.";
  } else {
    for (const ev of status.next_events) {
      nextEl.appendChild(
        rowItem(ev.program_name, `${ev.zones} \u2022 ${fmtDateTime(ev.next_run_time)}`)
      );
    }
  }
}

function rowItem(primary, secondary, actionsHtml) {
  const div = document.createElement("div");
  div.className = "row-item";
  div.innerHTML = `
    <div class="meta">
      <div class="primary">${escapeHtml(primary)}</div>
      <div class="secondary">${escapeHtml(secondary)}</div>
    </div>
    <div class="actions">${actionsHtml || ""}</div>
  `;
  return div;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

document.querySelectorAll("[data-delay]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    await apiPost("api/raindelay", { hours: Number(btn.dataset.delay) });
    loadDashboard();
  });
});
document.getElementById("custom-delay-btn").addEventListener("click", () => {
  document.getElementById("custom-delay-row").hidden = false;
});
document.getElementById("apply-custom-delay").addEventListener("click", async () => {
  const hours = Number(document.getElementById("custom-delay-hours").value);
  if (!hours || hours <= 0) return;
  await apiPost("api/raindelay", { hours });
  document.getElementById("custom-delay-row").hidden = true;
  loadDashboard();
});
document.getElementById("clear-delay-btn").addEventListener("click", async () => {
  await apiDelete("api/raindelay");
  loadDashboard();
});

// ---- zones tab ----------------------------------------------------------------

async function loadZonesTab() {
  const [zones, entities] = await Promise.all([
    apiGet("api/zones"),
    apiGet("api/ha/entities"),
  ]);
  zonesCache = zones;
  entitiesCache = entities;

  const stateByEntity = Object.fromEntries(entities.map((e) => [e.entity_id, e.state]));

  const select = document.getElementById("new-zone-entity");
  const usedIds = new Set(zones.map((z) => z.entity_id));
  const available = entities.filter((e) => !usedIds.has(e.entity_id));
  select.innerHTML = available.length
    ? available.map((e) => `<option value="${e.entity_id}">${escapeHtml(e.friendly_name)} (${e.entity_id})</option>`).join("")
    : `<option value="">No unassigned switch/valve entities found</option>`;

  const list = document.getElementById("zones-list");
  list.innerHTML = "";
  if (zones.length === 0) {
    list.textContent = "No zones configured yet.";
  }
  for (const z of zones) {
    const state = stateByEntity[z.entity_id];
    const badge = state ? `<span class="badge ${state === "on" ? "badge-on" : "badge-off"}">${state}</span>` : "";
    const row = rowItem(
      `${z.name} ${z.enabled ? "" : "(disabled)"}`,
      `${z.entity_id} ${badge ? "\u2022" : ""}`,
      `
        <input type="number" class="run-minutes" value="5" min="0.5" step="0.5" style="width:60px" />
        <button class="btn btn-small run-zone">Run</button>
        <button class="btn btn-small toggle-zone">${z.enabled ? "Disable" : "Enable"}</button>
        <button class="btn btn-small btn-danger delete-zone">Delete</button>
      `
    );
    row.querySelector(".secondary").insertAdjacentHTML("beforeend", " " + badge);
    row.querySelector(".run-zone").addEventListener("click", async () => {
      const minutes = Number(row.querySelector(".run-minutes").value) || 5;
      await apiPost(`api/zones/${z.id}/run`, { minutes });
      loadDashboard();
      switchTab("dashboard");
    });
    row.querySelector(".toggle-zone").addEventListener("click", async () => {
      await api(`api/zones/${z.id}`, { method: "PUT", body: JSON.stringify({ enabled: !z.enabled }) });
      loadZonesTab();
    });
    row.querySelector(".delete-zone").addEventListener("click", async () => {
      if (!confirm(`Delete zone "${z.name}"? Programs using it will lose that zone.`)) return;
      await apiDelete(`api/zones/${z.id}`);
      loadZonesTab();
    });
    list.appendChild(row);
  }
}

document.getElementById("add-zone-btn").addEventListener("click", async () => {
  const entityId = document.getElementById("new-zone-entity").value;
  const name = document.getElementById("new-zone-name").value.trim();
  if (!entityId || !name) return alert("Pick an entity and give the zone a name.");
  await apiPost("api/zones", { entity_id: entityId, name });
  document.getElementById("new-zone-name").value = "";
  loadZonesTab();
});

// ---- programs tab -------------------------------------------------------------

async function loadProgramsTab() {
  const [presets, programs, zones] = await Promise.all([
    apiGet("api/presets"),
    apiGet("api/programs"),
    apiGet("api/zones"),
  ]);
  zonesCache = zones;

  const presetSelect = document.getElementById("pf-preset");
  presetSelect.innerHTML =
    `<option value="custom">Custom (blank)</option>` +
    presets.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");

  refreshZoneAddSelect();
  renderProgramsList(programs);
}

function refreshZoneAddSelect() {
  const select = document.getElementById("pf-add-zone-select");
  const usedIds = new Set(builderZones.map((z) => z.zone_id));
  const available = zonesCache.filter((z) => !usedIds.has(z.id));
  select.innerHTML = available.length
    ? available.map((z) => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join("")
    : `<option value="">No more zones to add</option>`;
}

function renderBuilderZones() {
  const list = document.getElementById("pf-zones-list");
  list.innerHTML = "";
  if (builderZones.length === 0) {
    list.textContent = "No zones added yet.";
    return;
  }
  builderZones.forEach((z, idx) => {
    const row = rowItem(
      `${idx + 1}. ${z.zone_name}`,
      `${z.duration_minutes} min`,
      `<button class="btn btn-small btn-danger remove-builder-zone">Remove</button>`
    );
    row.querySelector(".remove-builder-zone").addEventListener("click", () => {
      builderZones.splice(idx, 1);
      builderZones.forEach((bz, i) => (bz.sort_order = i));
      renderBuilderZones();
      refreshZoneAddSelect();
    });
    list.appendChild(row);
  });
}

document.getElementById("pf-preset").addEventListener("change", (e) => {
  const preset = window.__presetsCache?.find((p) => p.id === e.target.value);
  if (!preset) return; // "custom" - leave form as-is
  document.getElementById("pf-schedule-type").value = preset.schedule_type;
  toggleScheduleRows();
  document.querySelectorAll(".weekday-picker input").forEach((cb) => {
    cb.checked = (preset.weekdays || "").split(",").includes(cb.value);
  });
  if (preset.interval_days) document.getElementById("pf-interval-days").value = preset.interval_days;
  document.getElementById("pf-start-time").value = preset.start_time;
  document.getElementById("pf-run-mode").value = preset.run_mode;
  document.getElementById("pf-enabled").checked = preset.default_enabled !== false;
  document.getElementById("pf-add-zone-duration").value = preset.default_duration_minutes || "";
});

// cache presets on load so the change handler above can read defaults
(async () => {
  window.__presetsCache = await apiGet("api/presets").catch(() => []);
})();

document.getElementById("pf-schedule-type").addEventListener("change", toggleScheduleRows);
function toggleScheduleRows() {
  const type = document.getElementById("pf-schedule-type").value;
  document.getElementById("pf-weekdays-row").hidden = type !== "weekdays";
  document.getElementById("pf-interval-row").hidden = type !== "interval";
}

document.getElementById("pf-add-zone-btn").addEventListener("click", () => {
  const select = document.getElementById("pf-add-zone-select");
  const zoneId = Number(select.value);
  const duration = Number(document.getElementById("pf-add-zone-duration").value);
  if (!zoneId || !duration || duration <= 0) return alert("Pick a zone and a duration in minutes.");
  const zone = zonesCache.find((z) => z.id === zoneId);
  builderZones.push({ zone_id: zoneId, zone_name: zone.name, duration_minutes: duration, sort_order: builderZones.length });
  renderBuilderZones();
  refreshZoneAddSelect();
});

function resetProgramForm() {
  editingProgramId = null;
  document.getElementById("pf-name").value = "";
  document.getElementById("pf-preset").value = "custom";
  document.getElementById("pf-schedule-type").value = "weekdays";
  toggleScheduleRows();
  document.querySelectorAll(".weekday-picker input").forEach((cb) => (cb.checked = false));
  document.getElementById("pf-interval-days").value = 2;
  document.getElementById("pf-start-time").value = "06:00";
  document.getElementById("pf-run-mode").value = "sequential";
  document.getElementById("pf-enabled").checked = true;
  builderZones = [];
  renderBuilderZones();
  refreshZoneAddSelect();
  document.getElementById("pf-cancel-btn").hidden = true;
  document.getElementById("pf-save-btn").textContent = "Save program";
}

document.getElementById("pf-cancel-btn").addEventListener("click", resetProgramForm);

document.getElementById("pf-save-btn").addEventListener("click", async () => {
  const name = document.getElementById("pf-name").value.trim();
  if (!name) return alert("Give the program a name.");
  if (builderZones.length === 0) return alert("Add at least one zone.");

  const scheduleType = document.getElementById("pf-schedule-type").value;
  const weekdays = Array.from(document.querySelectorAll(".weekday-picker input:checked")).map((cb) => cb.value).join(",");
  if (scheduleType === "weekdays" && !weekdays) return alert("Pick at least one day, or switch to Custom/disable it.");

  const payload = {
    name,
    stage: document.getElementById("pf-preset").value,
    schedule_type: scheduleType,
    weekdays: scheduleType === "weekdays" ? weekdays : null,
    interval_days: scheduleType === "interval" ? Number(document.getElementById("pf-interval-days").value) : null,
    start_time: document.getElementById("pf-start-time").value,
    run_mode: document.getElementById("pf-run-mode").value,
    enabled: document.getElementById("pf-enabled").checked,
    zones: builderZones.map((z, i) => ({ zone_id: z.zone_id, duration_minutes: z.duration_minutes, sort_order: i })),
  };

  if (editingProgramId) {
    await apiPut(`api/programs/${editingProgramId}`, payload);
  } else {
    await apiPost("api/programs", payload);
  }
  resetProgramForm();
  loadProgramsTab();
});

function editProgram(p) {
  editingProgramId = p.id;
  document.getElementById("pf-name").value = p.name;
  document.getElementById("pf-preset").value = "custom";
  document.getElementById("pf-schedule-type").value = p.schedule_type;
  toggleScheduleRows();
  document.querySelectorAll(".weekday-picker input").forEach((cb) => {
    cb.checked = (p.weekdays || "").split(",").includes(cb.value);
  });
  document.getElementById("pf-interval-days").value = p.interval_days || 2;
  document.getElementById("pf-start-time").value = p.start_time;
  document.getElementById("pf-run-mode").value = p.run_mode;
  document.getElementById("pf-enabled").checked = !!p.enabled;
  builderZones = p.zones.map((z) => ({ zone_id: z.zone_id, zone_name: z.zone_name, duration_minutes: z.duration_minutes, sort_order: z.sort_order }));
  renderBuilderZones();
  refreshZoneAddSelect();
  document.getElementById("pf-cancel-btn").hidden = false;
  document.getElementById("pf-save-btn").textContent = "Save changes";
  document.getElementById("program-form").scrollIntoView({ behavior: "smooth" });
}

function renderProgramsList(programs) {
  const list = document.getElementById("programs-list");
  list.innerHTML = "";
  if (programs.length === 0) {
    list.textContent = "No programs yet - build one above.";
    return;
  }
  for (const p of programs) {
    const zoneSummary = p.zones.map((z) => z.zone_name).join(", ") || "(no zones)";
    const row = rowItem(
      `${p.name}${p.enabled ? "" : " (disabled)"}`,
      `${scheduleSummary(p)} \u2022 ${p.run_mode === "simultaneous" ? "all zones together" : "one at a time"} \u2022 ${zoneSummary}`,
      `
        <button class="btn btn-small run-now">Run now</button>
        <button class="btn btn-small toggle-program">${p.enabled ? "Disable" : "Enable"}</button>
        <button class="btn btn-small edit-program">Edit</button>
        <button class="btn btn-small btn-danger delete-program">Delete</button>
      `
    );
    row.querySelector(".run-now").addEventListener("click", async () => {
      await apiPost(`api/programs/${p.id}/run_now`, {});
      loadDashboard();
      switchTab("dashboard");
    });
    row.querySelector(".toggle-program").addEventListener("click", async () => {
      await apiPatch(`api/programs/${p.id}/toggle`);
      loadProgramsTab();
    });
    row.querySelector(".edit-program").addEventListener("click", () => editProgram(p));
    row.querySelector(".delete-program").addEventListener("click", async () => {
      if (!confirm(`Delete program "${p.name}"?`)) return;
      await apiDelete(`api/programs/${p.id}`);
      loadProgramsTab();
    });
    list.appendChild(row);
  }
}

// ---- history tab --------------------------------------------------------------

async function loadHistoryTab() {
  const rows = await apiGet("api/history?limit=50");
  const list = document.getElementById("history-list");
  list.innerHTML = "";
  if (rows.length === 0) {
    list.textContent = "No runs logged yet.";
    return;
  }
  for (const r of rows) {
    list.appendChild(
      rowItem(
        r.zone_name || `${r.program_name} \u2013 skipped`,
        `${r.program_name || "Manual"} \u2022 ${r.status} \u2022 ${fmtDateTime(r.started_at)}`
      )
    );
  }
}

// ---- init -----------------------------------------------------------------

toggleScheduleRows();
loadDashboard();
setInterval(loadDashboard, 5000);
