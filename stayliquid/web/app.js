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

let zonesCache = [];
let presetsCache = [];

const builder = {
  editingId: null,
  autoName: "",        // the last name we filled in ourselves, so we can replace it
  stage: "custom",
  scheduleType: "weekdays",
  weekdays: new Set(),
  intervalDays: 3,
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

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function toast(message, kind = "ok") {
  const div = document.createElement("div");
  div.className = `toast ${kind === "error" ? "error" : ""}`;
  div.textContent = message;
  el("toasts").appendChild(div);
  setTimeout(() => div.remove(), 3600);
}

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

el("apply-custom-delay").addEventListener("click", () =>
  guard(async () => {
    const hours = Number(el("custom-delay-hours").value);
    if (!hours || hours <= 0) throw new Error("Enter a number of hours.");
    await apiPost("api/raindelay", { hours });
    el("custom-delay-hours").value = "";
    await loadDashboard();
  }, "Rain delay set.")
);

el("clear-delay-btn").addEventListener("click", () =>
  guard(async () => {
    await apiDelete("api/raindelay");
    await loadDashboard();
  }, "Rain delay cleared.")
);

// ---- zones tab --------------------------------------------------------------

async function loadZonesTab() {
  const [zones, entities] = await Promise.all([
    apiGet("api/zones"),
    apiGet("api/ha/entities"),
  ]);
  zonesCache = zones;

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
    const state = stateByEntity[z.entity_id];
    const statePill = state === "on" ? `<span class="pill pill-on">On</span>` : "";
    const row = rowItem(
      `${escapeHtml(z.name)} ${z.enabled ? "" : `<span class="pill pill-quiet">Disabled</span>`}`,
      escapeHtml(z.entity_id),
      `
        ${statePill}
        <input type="number" class="run-minutes" value="5" min="0.5" step="0.5" style="width:70px" />
        <button class="btn btn-small run-zone">Test run</button>
        <button class="btn btn-small toggle-zone">${z.enabled ? "Disable" : "Enable"}</button>
        <button class="btn btn-small btn-danger delete-zone">Delete</button>
      `
    );
    row.querySelector(".run-zone").addEventListener("click", () =>
      guard(async () => {
        const minutes = Number(row.querySelector(".run-minutes").value) || 5;
        await apiPost(`api/zones/${z.id}/run`, { minutes });
        await loadDashboard();
        switchTab("dashboard");
      }, `${z.name} running.`)
    );
    row.querySelector(".toggle-zone").addEventListener("click", () =>
      guard(async () => {
        await apiPut(`api/zones/${z.id}`, { enabled: !z.enabled });
        await loadZonesTab();
      })
    );
    row.querySelector(".delete-zone").addEventListener("click", () =>
      guard(async () => {
        if (!confirm(`Delete zone "${z.name}"? Programs using it will lose that zone.`)) return;
        await apiDelete(`api/zones/${z.id}`);
        await loadZonesTab();
      })
    );
    list.appendChild(row);
  });
}

el("add-zone-btn").addEventListener("click", () =>
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
  renderBuilder();
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
  builder.scheduleType = preset.schedule_type;
  builder.weekdays = new Set(
    preset.schedule_type === "weekdays" ? (preset.weekdays || "").split(",").filter(Boolean) : DAYS
  );
  builder.intervalDays = preset.interval_days || 3;
  builder.cycles = [...preset.cycle_times];
  builder.runMode = preset.run_mode;

  if (!builder.zones.length) {
    builder.zones = zonesCache
      .filter((z) => z.enabled)
      .map((z) => ({ zone_id: z.id, zone_name: z.name, duration_minutes: preset.duration_minutes }));
  } else {
    builder.zones.forEach((z) => (z.duration_minutes = preset.duration_minutes));
  }

  // Replace a name we generated from another preset, but never one the user typed.
  const current = el("pf-name").value.trim();
  if (!current || current === builder.autoName) {
    builder.autoName = `Stage ${preset.stage} - ${preset.name}`;
    el("pf-name").value = builder.autoName;
  }
  el("pf-add-zone-duration").value = preset.duration_minutes;

  renderBuilder();
  el("program-form").scrollIntoView({ behavior: "smooth", block: "start" });
  toast(`Loaded Stage ${preset.stage}: ${preset.name}.`);
}

// -- builder: schedule type / days / run mode

function setSegmented(container, value) {
  container.dataset.value = value;
  container.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.value === value));
}

el("pf-schedule-type").querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    builder.scheduleType = btn.dataset.value;
    renderBuilder();
  });
});

el("pf-run-mode").querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    builder.runMode = btn.dataset.value;
    renderBuilder();
  });
});

el("pf-weekdays-row").querySelectorAll(".day").forEach((btn) => {
  btn.addEventListener("click", () => {
    const day = btn.dataset.day;
    if (builder.weekdays.has(day)) builder.weekdays.delete(day);
    else builder.weekdays.add(day);
    renderBuilder();
  });
});

el("pf-everyday-btn").addEventListener("click", () => {
  builder.weekdays = new Set(builder.weekdays.size === 7 ? [] : DAYS);
  renderBuilder();
});

el("pf-interval-days").addEventListener("input", (e) => {
  builder.intervalDays = Number(e.target.value) || 1;
});

// -- builder: cycles

document.querySelectorAll("[data-quick-cycles]").forEach((btn) => {
  btn.addEventListener("click", () => {
    builder.cycles = [...QUICK_CYCLES[btn.dataset.quickCycles]];
    renderBuilder();
  });
});

el("pf-add-cycle-btn").addEventListener("click", () => {
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

el("pf-add-zone-btn").addEventListener("click", () => {
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

function renderBuilder() {
  setSegmented(el("pf-schedule-type"), builder.scheduleType);
  setSegmented(el("pf-run-mode"), builder.runMode);

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
  builder.scheduleType = "weekdays";
  builder.weekdays = new Set();
  builder.intervalDays = 3;
  builder.cycles = [];
  builder.zones = [];
  builder.runMode = "sequential";
  el("pf-name").value = "";
  el("pf-add-zone-duration").value = "";
  el("pf-enabled").checked = true;
  el("pf-cancel-btn").hidden = true;
  el("pf-save-btn").textContent = "Save program";
  el("builder-title").textContent = "Build a program";
  renderBuilder();
}

el("pf-cancel-btn").addEventListener("click", () => {
  resetBuilder();
  toast("Edit cancelled.");
});

el("pf-save-btn").addEventListener("click", () =>
  guard(async () => {
    const name = el("pf-name").value.trim();
    if (!name) throw new Error("Give the program a name.");
    if (!builder.cycles.length) throw new Error("Add at least one cycle time.");
    if (!builder.zones.length) throw new Error("Add at least one zone.");

    const weekdays = DAYS.filter((d) => builder.weekdays.has(d)).join(",");
    if (builder.scheduleType === "weekdays" && !weekdays) {
      throw new Error("Pick at least one day of the week.");
    }

    const payload = {
      name,
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
    resetBuilder();
    await loadProgramsTab();
  }, "Program saved.")
);

function editProgram(p) {
  builder.editingId = p.id;
  builder.autoName = "";
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
  el("pf-name").value = p.name;
  el("pf-enabled").checked = !!p.enabled;
  el("pf-cancel-btn").hidden = false;
  el("pf-save-btn").textContent = "Save changes";
  el("builder-title").textContent = `Editing "${p.name}"`;
  renderBuilder();
  el("program-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderProgramsList(programs) {
  const list = el("programs-list");
  if (!programs.length) {
    emptyState(list, "No programs yet. Pick a growth stage above to build your first one.");
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
    row.querySelector(".edit-program").addEventListener("click", () => editProgram(p));
    row.querySelector(".delete-program").addEventListener("click", () =>
      guard(async () => {
        if (!confirm(`Delete program "${p.name}"?`)) return;
        await apiDelete(`api/programs/${p.id}`);
        if (builder.editingId === p.id) resetBuilder();
        await loadProgramsTab();
      })
    );
    list.appendChild(row);
  });
}

// ---- history tab ------------------------------------------------------------

const STATUS_PILL = {
  completed: "pill-quiet",
  running: "pill-on",
  error: "pill-danger",
  skipped_rain_delay: "pill-warn",
};
const STATUS_LABEL = {
  completed: "Completed",
  running: "Running",
  error: "Error",
  skipped_rain_delay: "Skipped - rain delay",
};

async function loadHistoryTab() {
  const rows = await apiGet("api/history?limit=50");
  const list = el("history-list");
  if (!rows.length) {
    emptyState(list, "No runs logged yet.");
    return;
  }

  list.innerHTML = "";
  rows.forEach((r) => {
    const pillClass = STATUS_PILL[r.status] || "pill-quiet";
    const label = STATUS_LABEL[r.status] || r.status;
    const ran = r.started_at && r.ended_at
      ? fmtDuration((new Date(r.ended_at) - new Date(r.started_at)) / 60000)
      : null;
    list.appendChild(
      rowItem(
        escapeHtml(r.zone_name || r.program_name || "Run"),
        `${escapeHtml(r.program_name || "Manual")} &middot; ${fmtDateTime(r.started_at)}${ran ? ` &middot; ran ${ran}` : ""}`,
        `<span class="pill ${pillClass}">${escapeHtml(label)}</span>`
      )
    );
  });
}

// ---- init -------------------------------------------------------------------

renderBuilder();
guard(loadDashboard);
setInterval(() => loadDashboard(), 5000);
