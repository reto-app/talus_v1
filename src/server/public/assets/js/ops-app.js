import { requireSession, logout, authHeaders } from "./auth-client.js";
import { h, clear, icon, api, ApiError, toast, openDialog, formatCurrency, formatDateTime, renderNav, renderTabBar, createPoller } from "./shell.js";

const REQUIRED_CHECK_ITEMS = ["tires", "brakes", "body_panels", "safety_gear"];
const OUTCOME_LABEL = { pass: "Pass", damage: "Damage noted", unsafe: "Unsafe" };
const FILTER_DEFS = [
  { key: "all", label: "All" },
  { key: "pickup", label: "Pickups" },
  { key: "on_rent", label: "On rent" },
  { key: "return_due", label: "Returns due" },
  { key: "overdue", label: "Overdue" },
  { key: "settlement_pending", label: "Settlement" },
  { key: "closed", label: "Closed" },
];
const STAGE_LABEL = {
  prepare: "Prepare",
  ready_to_dispatch: "Ready to dispatch",
  on_rent: "On rent",
  overdue: "Overdue",
  settlement_pending: "Settlement pending",
  closed: "Closed",
};

const state = {
  session: null,
  date: todayIso(),
  filter: "all",
  items: [],
  selectedBookingItemId: null,
  detail: null,
  gate: null,
  returnSummary: null,
  machines: [],
  chosenMachineId: null,
  pending: new Set(),
  poller: null,
};

function todayIso() { return new Date().toISOString().slice(0, 10); }

function syncUrl() {
  const params = new URLSearchParams();
  if (state.date) params.set("date", state.date);
  if (state.filter !== "all") params.set("filter", state.filter);
  if (state.selectedBookingItemId) params.set("bookingItemId", state.selectedBookingItemId);
  history.replaceState({}, "", `/ops?${params.toString()}`);
}

function isPending(key) { return state.pending.has(key); }
async function withPending(key, fn) {
  state.pending.add(key);
  renderCommandCenter();
  try { return await fn(); }
  finally { state.pending.delete(key); }
}

/* ---------------------------------------------------------------------- *
 * Queue
 * ---------------------------------------------------------------------- */
function renderFilterStrip() {
  const strip = document.querySelector("#filterStrip");
  clear(strip);
  const counts = state.items.reduce((acc, item) => { acc[item.dispatch_bucket] = (acc[item.dispatch_bucket] || 0) + 1; return acc; }, {});
  for (const def of FILTER_DEFS) {
    const count = def.key === "all" ? state.items.length : (counts[def.key] || 0);
    strip.appendChild(h("button", {
      type: "button", class: "ops-filter-chip", "aria-pressed": String(state.filter === def.key),
      onclick: () => { state.filter = def.key; syncUrl(); renderQueue(); },
    }, [document.createTextNode(def.label + " "), h("span", { class: "count" }, `(${count})`)]));
  }
}

function filteredItems() { return state.filter === "all" ? state.items : state.items.filter((i) => i.dispatch_bucket === state.filter); }

function renderQueue() {
  renderFilterStrip();
  const list = document.querySelector("#queueList");
  clear(list);
  const items = filteredItems();
  document.querySelector("#queueCount").textContent = String(items.length);
  if (!items.length) {
    list.appendChild(h("div", { class: "talus-empty" }, [icon("calendar-x", { size: 26 }), h("p", {}, "No bookings match this filter for the selected date.")]));
    return;
  }
  for (const item of items) {
    const blocker = mostUrgentBlocker(item);
    const card = h("button", {
      type: "button", class: "ops-job", "aria-current": String(item.booking_item_id === state.selectedBookingItemId),
      onclick: () => selectBooking(item.booking_item_id),
    }, [
      h("div", { class: "ops-job-top" }, [
        h("div", {}, [h("b", {}, item.customer_name || "Customer"), h("div", { class: "ops-job-sub" }, `${item.product_name || "Rental"} · ${item.booking_reference}`)]),
        h("span", { class: "ops-job-time" }, formatDateTime(item.dispatch_bucket === "pickup" ? item.scheduled_start_at : item.scheduled_end_at, { year: undefined })),
      ]),
      h("div", { class: "ops-job-badges" }, [
        bucketBadge(item.dispatch_bucket),
        blocker ? h("span", { class: "talus-badge talus-badge-amber" }, blocker) : h("span", { class: "talus-badge talus-badge-green" }, "Ready"),
      ]),
    ]);
    list.appendChild(card);
  }
}
function bucketBadge(bucket) {
  const cls = bucket === "overdue" ? "red" : bucket === "return_due" || bucket === "settlement_pending" ? "amber" : bucket === "closed" ? "neutral" : "blue";
  const label = FILTER_DEFS.find((f) => f.key === bucket)?.label || bucket;
  return h("span", { class: `talus-badge talus-badge-${cls}` }, label);
}
function mostUrgentBlocker(item) {
  if (item.dispatch_bucket === "closed" || item.dispatch_bucket === "settlement_pending") return null;
  if (item.dispatch_bucket === "on_rent" || item.dispatch_bucket === "overdue" || item.dispatch_bucket === "return_due") return item.active_trip ? null : null;
  if (!item.machine_id) return "Needs assignment";
  if (!item.waiver_ready) return "Needs waiver";
  if (!item.deposit_ready) return "Needs deposit";
  if (!item.outbound_inspection_ready) return "Needs inspection";
  return null;
}

/* ---------------------------------------------------------------------- *
 * Selecting a booking
 * ---------------------------------------------------------------------- */
async function selectBooking(bookingItemId) {
  state.selectedBookingItemId = bookingItemId;
  state.chosenMachineId = null;
  state.returnSummary = null;
  syncUrl();
  document.querySelector("#emptyState").hidden = true;
  const detailEl = document.querySelector("#bookingDetail");
  detailEl.hidden = false;
  clear(detailEl);
  detailEl.appendChild(h("div", { class: "talus-empty" }, "Loading booking…"));
  setMobileView("detail");
  renderQueue();

  try {
    state.detail = await api(`/api/v1/operations/booking-items/${bookingItemId}`);
    state.gate = state.detail.gate;
    if (state.detail.machine_id) await loadReturnSummary();
    await loadMachines();
    renderCommandCenter();
  } catch (error) {
    clear(detailEl);
    detailEl.appendChild(h("div", { class: "talus-empty" }, `Could not load this reservation: ${error.message}`));
  }
}

async function loadMachines() {
  if (!state.detail) return;
  try {
    state.machines = (await api(`/api/v1/operations/machines?categoryLocationId=${state.detail.category_location_id}&start=${encodeURIComponent(state.detail.scheduled_start_at)}&end=${encodeURIComponent(state.detail.scheduled_end_at)}`)).machines;
  } catch { state.machines = []; }
}
async function loadReturnSummary() {
  try { state.returnSummary = await api(`/api/v1/operations/booking-items/${state.selectedBookingItemId}/return-summary`); }
  catch { state.returnSummary = null; }
}

function computeStage() {
  const d = state.detail;
  if (!d) return null;
  if (["closed", "cancelled", "no_show"].includes(d.booking_item_state)) return "closed";
  if (d.booking_item_state === "returned") return state.returnSummary?.isSettled ? "closed" : "settlement_pending";
  if (d.active_trip) return new Date(d.scheduled_end_at) < new Date() ? "overdue" : "on_rent";
  return state.gate?.isReady ? "ready_to_dispatch" : "prepare";
}

/* ---------------------------------------------------------------------- *
 * Command center
 * ---------------------------------------------------------------------- */
function renderCommandCenter() {
  if (!state.detail) return;
  const stage = computeStage();
  const d = state.detail;
  const container = document.querySelector("#bookingDetail");
  clear(container);

  container.appendChild(h("div", { class: "ops-booking-header" }, [
    h("div", { style: "flex:1;min-width:200px" }, [
      h("h2", {}, `${d.booking_reference} · ${d.customer_name || "Customer"}`),
      h("p", {}, `${d.product_name || "Rental"} · ${formatDateTime(d.scheduled_start_at)} → ${formatDateTime(d.scheduled_end_at)}`),
    ]),
    h("span", { class: `talus-badge talus-badge-${stage === "closed" ? "neutral" : stage === "overdue" ? "red" : stage === "on_rent" ? "blue" : stage === "settlement_pending" ? "amber" : stage === "ready_to_dispatch" ? "green" : "neutral"}` }, STAGE_LABEL[stage]),
  ]));

  if (stage === "prepare" || stage === "ready_to_dispatch") {
    container.appendChild(renderGateCard(stage));
    container.appendChild(renderAssignmentCard());
    container.appendChild(renderInspectionCard("outbound", stage));
  } else if (stage === "on_rent" || stage === "overdue") {
    container.appendChild(renderTripCard(stage));
    container.appendChild(renderInspectionCard("inbound", stage));
  } else if (stage === "settlement_pending") {
    container.appendChild(renderSettlementCard());
  } else {
    container.appendChild(h("div", { class: "talus-card" }, h("div", { class: "talus-card-body" }, [
      h("p", {}, "This reservation is closed. No further dispatch actions are available."),
      state.returnSummary ? h("p", { style: "color:var(--talus-muted);font-size:12.5px" }, `Settled ${formatDateTime(state.returnSummary.settled_at)} · Captured ${formatCurrency(state.returnSummary.captured_cents)} · Released ${formatCurrency(state.returnSummary.released_cents)}`) : null,
    ].filter(Boolean))));
  }
}

function renderGateCard(stage) {
  const g = state.gate;
  const card = h("div", { class: "talus-card" });
  card.appendChild(h("div", { class: "talus-card-head" }, [h("div", {}, [h("h2", {}, "Dispatch gate"), h("p", {}, g.isReady ? "All release requirements are satisfied." : "Complete every requirement before dispatch.")])]));
  const body = h("div", { class: "talus-card-body" });
  body.appendChild(h("div", { class: "ops-gate-grid" }, [
    gateTile("Waiver", g.waiver_ready, "Digital waiver required"),
    gateTile("Deposit", g.deposit_ready, "Authorization hold required"),
    gateTile("Assignment", g.assignment_ready, "Select an available unit"),
    gateTile("Inspection", g.outbound_inspection_ready, g.outbound_inspection_unsafe ? "Unsafe — blocked, needs service" : "Complete the pre-trip inspection", g.outbound_inspection_unsafe),
  ]));
  const fleetNumber = state.machines.find((m) => m.machine_id === (state.detail.machine_id || state.chosenMachineId))?.fleet_number;
  const dispatchKey = `dispatch:${state.selectedBookingItemId}`;
  body.appendChild(h("div", { style: "margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap" }, [
    h("button", {
      type: "button", class: "talus-btn talus-btn-primary", disabled: !g.isReady || isPending(dispatchKey),
      onclick: () => dispatchBooking(fleetNumber),
    }, isPending(dispatchKey) ? "Dispatching…" : `Dispatch ${fleetNumber || "unit"}`),
    h("div", { id: `${dispatchKey}-error`, style: "color:var(--talus-red);font-size:12px" }),
  ]));
  card.appendChild(body);
  return card;
}
function gateTile(label, ready, help, blocked = false) {
  const cls = ready ? " is-ready" : blocked ? " is-blocked" : "";
  return h("div", { class: `ops-gate${cls}` }, [
    h("div", { class: "ops-gate-label" }, [icon(blocked ? "alert-triangle" : ready ? "check" : "circle-x", { size: 14 }), h("span", {}, label)]),
    h("div", { class: `ops-gate-help${blocked ? " is-blocked-text" : ""}` }, ready ? "Complete" : help),
  ]);
}

function renderAssignmentCard() {
  const card = h("div", { class: "talus-card" });
  card.appendChild(h("div", { class: "talus-card-head" }, h("div", {}, [h("h2", {}, "Unit assignment"), h("p", {}, "Available units for this reservation window")])));
  const body = h("div", { class: "talus-card-body" });
  const list = h("div", { class: "ops-machine-list" });
  const assigned = state.detail.machine_id;
  const options = assigned
    ? [{ machine_id: assigned, fleet_number: state.detail.fleet_number, assigned: true }, ...state.machines.filter((m) => m.machine_id !== assigned)]
    : state.machines;
  if (!options.length) list.appendChild(h("p", { style: "color:var(--talus-muted);font-size:12.5px" }, "No units are free in this booking window."));
  const chosen = state.chosenMachineId || assigned;
  for (const m of options) {
    list.appendChild(h("button", {
      type: "button", class: "ops-machine-option", "aria-pressed": String(m.machine_id === chosen), disabled: !!assigned,
      onclick: () => { state.chosenMachineId = m.machine_id; renderCommandCenter(); },
    }, [icon("car-front"), h("span", { style: "flex:1" }, m.fleet_number || m.display_name), m.assigned ? h("span", { class: "talus-badge talus-badge-blue" }, "Assigned") : null].filter(Boolean)));
  }
  body.appendChild(list);
  const assignKey = `assign:${state.selectedBookingItemId}`;
  if (!assigned) {
    body.appendChild(h("button", {
      type: "button", class: "talus-btn", style: "margin-top:12px", disabled: !state.chosenMachineId || isPending(assignKey),
      onclick: () => assignMachine(),
    }, isPending(assignKey) ? "Assigning…" : "Assign selected unit"));
    body.appendChild(h("div", { id: `${assignKey}-error`, style: "color:var(--talus-red);font-size:12px;margin-top:6px" }));
  }
  card.appendChild(body);
  return card;
}

function renderTripCard(stage) {
  const card = h("div", { class: "talus-card" });
  card.appendChild(h("div", { class: "talus-card-head" }, h("div", {}, [h("h2", {}, "Active rental"), h("p", {}, `${state.detail.fleet_number || "Unit"} · due back ${formatDateTime(state.detail.scheduled_end_at)}`)])));
  const body = h("div", { class: "talus-card-body" });
  if (stage === "overdue") body.appendChild(h("p", { style: "color:var(--talus-red);font-weight:700;font-size:13px" }, "This rental is overdue. Contact the renter or prepare for return."));
  card.appendChild(body);
  return card;
}

/* ---------------------------------------------------------------------- *
 * Inspection
 * ---------------------------------------------------------------------- */
function draftKey(type) { return `talus.inspectionDraft.${state.selectedBookingItemId}.${type}`; }
function loadDraft(type) { try { return JSON.parse(localStorage.getItem(draftKey(type)) || "null"); } catch { return null; } }
function saveDraft(type, draft) { try { localStorage.setItem(draftKey(type), JSON.stringify(draft)); } catch { /* ignore */ } }
function clearDraft(type) { try { localStorage.removeItem(draftKey(type)); } catch { /* ignore */ } }
function emptyInspectionDraft() {
  return { items: REQUIRED_CHECK_ITEMS.map((item) => ({ item, outcome: null, notes: "", photoRefs: [] })), fuelPct: "", odometerMiles: "", fuelUnavailable: false, odometerUnavailable: false, fuelReason: "", odometerReason: "", notes: "" };
}

function renderInspectionCard(type, stage) {
  const existing = type === "outbound" ? (state.gate?.outbound_inspection_ready) : (state.detail.inspections?.some((i) => i.inspection_type === "inbound"));
  const card = h("div", { class: "talus-card" });
  card.appendChild(h("div", { class: "talus-card-head" }, h("div", {}, [h("h2", {}, type === "outbound" ? "Pre-trip inspection" : "Post-trip inspection"), h("p", {}, "Completed inspections are sealed and immutable.")])));
  const body = h("div", { class: "talus-card-body" });
  const inspection = (state.detail.inspections || []).find((i) => i.inspection_type === type);
  if (inspection) {
    body.appendChild(h("div", { class: "ops-inspection-row" }, [
      h("span", {}, `${formatDateTime(inspection.completed_at)} · ${inspection.fuel_pct ?? "—"}% fuel · ${inspection.odometer_miles ?? "—"} mi`),
      h("span", { class: "talus-badge talus-badge-green" }, [icon("lock", { size: 12 }), "Sealed"]),
    ]));
  } else {
    const disabled = type === "outbound" ? false : !state.detail.active_trip;
    body.appendChild(h("button", { type: "button", class: "talus-btn", disabled, onclick: () => openInspectionDrawer(type) }, `Complete ${type === "outbound" ? "pre-trip" : "post-trip"} inspection`));
  }
  card.appendChild(body);
  return card;
}

let currentInspectionType = null;
let currentDraft = null;
let draftDirty = false;
let currentInspectionDialog = null;

function openInspectionDrawer(type) {
  currentInspectionType = type;
  currentDraft = loadDraft(type) || emptyInspectionDraft();
  draftDirty = false;
  const attemptClose = () => {
    if (draftDirty && !confirm("You have unsaved changes to this inspection. Close anyway? Your progress will be saved as a draft.")) return;
    currentInspectionDialog.close();
  };
  const drawer = buildInspectionDrawer(attemptClose);
  document.body.appendChild(drawer);
  currentInspectionDialog = openDialog(drawer, {
    onClose: () => {
      if (draftDirty) saveDraft(type, currentDraft);
      drawer.remove();
    },
  });
}

function buildInspectionDrawer(attemptClose) {
  const type = currentInspectionType;
  const drawer = h("div", { class: "talus-drawer", role: "dialog", "aria-modal": "true", "aria-label": `${type} inspection`, tabindex: "-1", style: "position:fixed" });
  const body = h("div", { class: "talus-drawer-body" });
  const foot = h("div", { class: "talus-drawer-foot" });

  function refresh() { clear(body); body.appendChild(buildInspectionBody()); }

  function buildInspectionBody() {
    const wrap = h("div");
    wrap.appendChild(h("p", { style: "font-size:12.5px;color:var(--talus-muted)" }, `${state.detail.fleet_number || "Unit"} · ${state.detail.booking_reference} · ${state.detail.customer_name || "Customer"}`));
    wrap.appendChild(h("div", { class: "talus-section-title" }, "WALKAROUND CHECKLIST"));
    const checklist = h("div", { class: "ops-checklist" });
    for (const entry of currentDraft.items) checklist.appendChild(buildCheckItem(entry, refresh));
    wrap.appendChild(checklist);

    wrap.appendChild(h("div", { class: "talus-section-title" }, "READINGS"));
    wrap.appendChild(readingField("Fuel level (%)", "fuelPct", "fuelUnavailable", "fuelReason", refresh));
    wrap.appendChild(readingField("Odometer (miles)", "odometerMiles", "odometerUnavailable", "odometerReason", refresh));

    wrap.appendChild(h("label", { class: "talus-field" }, ["Notes", h("textarea", { class: "talus-textarea", value: currentDraft.notes, oninput: (e) => { currentDraft.notes = e.target.value; draftDirty = true; } })]));
    return wrap;
  }

  function readingField(label, valueKey, unavailableKey, reasonKey, onChange) {
    const wrap = h("div", { class: "talus-field" });
    const input = h("input", { class: "talus-input", type: "number", inputmode: "decimal", value: currentDraft[valueKey], disabled: currentDraft[unavailableKey], oninput: (e) => { currentDraft[valueKey] = e.target.value; draftDirty = true; } });
    const unavailableBox = h("input", { type: "checkbox", checked: currentDraft[unavailableKey], onchange: (e) => { currentDraft[unavailableKey] = e.target.checked; draftDirty = true; onChange(); } });
    const reasonInput = h("input", { class: "talus-input", placeholder: "Why is this unavailable?", value: currentDraft[reasonKey], hidden: !currentDraft[unavailableKey], oninput: (e) => { currentDraft[reasonKey] = e.target.value; draftDirty = true; } });
    wrap.append(label, input, h("label", { style: "display:flex;align-items:center;gap:7px;margin-top:8px;font-weight:500" }, [unavailableBox, "Unavailable"]), reasonInput);
    return wrap;
  }

  function buildCheckItem(entry) {
    const item = h("div", { class: "ops-check-item" });
    const head = h("div", { class: "ops-check-item-head" }, [h("b", {}, entry.item.replaceAll("_", " "))]);
    const outcomes = h("div", { class: "ops-outcome-group" });
    for (const outcome of ["pass", "damage", "unsafe"]) {
      outcomes.appendChild(h("button", {
        type: "button", class: "ops-outcome-btn", "data-outcome": outcome, "aria-pressed": String(entry.outcome === outcome),
        onclick: () => { entry.outcome = outcome; draftDirty = true; refresh(); },
      }, OUTCOME_LABEL[outcome]));
    }
    head.appendChild(outcomes);
    item.appendChild(head);
    if (entry.outcome && entry.outcome !== "pass") {
      const detail = h("div", { class: "ops-check-item-detail" });
      detail.appendChild(h("textarea", { class: "talus-textarea", placeholder: "Describe what you found", value: entry.notes, style: "min-height:56px", oninput: (e) => { entry.notes = e.target.value; draftDirty = true; } }));
      const photoInput = h("input", { type: "file", accept: "image/*", multiple: true, onchange: (e) => uploadPhotos(e, entry, refresh) });
      const thumbs = h("div", { class: "ops-photo-strip" }, entry.photoRefs.map((ref) => h("span", { class: "talus-badge talus-badge-neutral" }, [icon("camera", { size: 12 }), "Photo attached"])));
      detail.append(photoInput, thumbs);
      item.appendChild(detail);
    }
    return item;
  }

  async function uploadPhotos(event, entry, onDone) {
    const files = [...event.target.files];
    for (const file of files) {
      try {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/v1/inspections/photos", { method: "POST", headers: authHeaders(), body: form });
        const body = await response.json();
        if (!response.ok) throw new Error(body.code || "upload failed");
        entry.photoRefs.push(body.evidenceFileId);
        draftDirty = true;
      } catch (error) { toast(`Photo upload failed: ${error.message}`, { kind: "error" }); }
    }
    onDone();
  }

  refresh();

  const submitButton = h("button", { type: "button", class: "talus-btn talus-btn-primary" }, "Review & complete");
  submitButton.addEventListener("click", () => openInspectionReview());
  foot.appendChild(submitButton);

  drawer.append(
    h("div", { class: "talus-drawer-head" }, [
      h("div", {}, [h("h2", { class: "talus-condensed" }, type === "outbound" ? "PRE-TRIP INSPECTION" : "POST-TRIP INSPECTION"), h("p", {}, `${state.detail.fleet_number || "Unit"} · ${state.detail.booking_reference}`)]),
      h("button", { type: "button", class: "talus-icon-btn", style: "margin-left:auto", "aria-label": "Close", onclick: () => attemptClose() }, icon("x")),
    ]),
    body, foot,
  );

  return drawer;
}

function openInspectionReview() {
  const missing = currentDraft.items.filter((i) => !i.outcome);
  if (missing.length) { toast(`Set an outcome for: ${missing.map((m) => m.item.replaceAll("_", " ")).join(", ")}`, { kind: "error" }); return; }
  if (!currentDraft.fuelUnavailable && currentDraft.fuelPct === "") { toast("Enter a fuel reading or mark it unavailable.", { kind: "error" }); return; }
  if (currentDraft.fuelUnavailable && !currentDraft.fuelReason.trim()) { toast("Explain why the fuel reading is unavailable.", { kind: "error" }); return; }
  if (!currentDraft.odometerUnavailable && currentDraft.odometerMiles === "") { toast("Enter an odometer reading or mark it unavailable.", { kind: "error" }); return; }
  if (currentDraft.odometerUnavailable && !currentDraft.odometerReason.trim()) { toast("Explain why the odometer reading is unavailable.", { kind: "error" }); return; }

  const unsafeItems = currentDraft.items.filter((i) => i.outcome === "unsafe");
  const panel = h("div", { class: "talus-modal-panel" });
  const modal = h("div", { class: "talus-modal", role: "dialog", "aria-modal": "true", "aria-label": "Confirm inspection", tabindex: "-1" }, panel);
  document.body.appendChild(modal);
  panel.append(
    h("h2", {}, "Complete inspection"),
    h("p", { style: "font-size:12.5px;color:var(--talus-muted)" }, `${state.detail.fleet_number || "Unit"} · ${state.detail.booking_reference} · ${state.detail.customer_name || "Customer"}`),
    unsafeItems.length ? h("p", { style: "color:var(--talus-red);font-weight:700;font-size:13px;margin-top:10px" }, `${unsafeItems.map((i) => i.item.replaceAll("_", " ")).join(", ")} marked unsafe. This will block dispatch and open a maintenance hold.`) : null,
    h("ul", { style: "font-size:13px;padding-left:18px;margin:12px 0" }, currentDraft.items.map((i) => h("li", {}, `${i.item.replaceAll("_", " ")}: ${OUTCOME_LABEL[i.outcome]}`))),
    h("p", { style: "font-size:13px" }, `Fuel: ${currentDraft.fuelUnavailable ? `Unavailable (${currentDraft.fuelReason})` : `${currentDraft.fuelPct}%`} · Odometer: ${currentDraft.odometerUnavailable ? `Unavailable (${currentDraft.odometerReason})` : `${currentDraft.odometerMiles} mi`}`),
    h("div", { style: "display:flex;gap:8px;justify-content:flex-end;margin-top:16px" }, [
      h("button", { type: "button", class: "talus-btn", onclick: () => dialog.close() }, "Back"),
      h("button", { type: "button", class: "talus-btn talus-btn-primary", onclick: (event) => submitInspection(event, dialog) }, "Complete inspection"),
    ]),
  );
  const dialog = openDialog(modal, { onClose: () => modal.remove() });
}

async function submitInspection(event, dialog) {
  event.target.disabled = true; event.target.textContent = "Completing…";
  try {
    await api("/api/v1/inspections", {
      method: "POST",
      body: {
        bookingItemId: state.selectedBookingItemId,
        machineId: state.detail.machine_id || state.chosenMachineId,
        type: currentInspectionType,
        fuelLevelPct: currentDraft.fuelUnavailable ? null : Number(currentDraft.fuelPct),
        odometerMiles: currentDraft.odometerUnavailable ? null : Number(currentDraft.odometerMiles),
        fuelUnavailableReason: currentDraft.fuelUnavailable ? currentDraft.fuelReason : null,
        odometerUnavailableReason: currentDraft.odometerUnavailable ? currentDraft.odometerReason : null,
        notes: currentDraft.notes,
        checkItems: currentDraft.items.map((i) => ({ item: i.item, outcome: i.outcome, notes: i.notes, photoRefs: i.photoRefs })),
      },
    });
    clearDraft(currentInspectionType);
    draftDirty = false;
    toast("Inspection completed.", { kind: "success" });
    dialog.close();
    currentInspectionDialog?.close();
    await selectBooking(state.selectedBookingItemId);
  } catch (error) {
    toast(`Could not complete inspection: ${error.message}`, { kind: "error" });
    event.target.disabled = false; event.target.textContent = "Complete inspection";
  }
}

/* ---------------------------------------------------------------------- *
 * Settlement
 * ---------------------------------------------------------------------- */
function renderSettlementCard() {
  const s = state.returnSummary;
  const card = h("div", { class: "talus-card" });
  card.appendChild(h("div", { class: "talus-card-head" }, h("div", {}, [h("h2", {}, "Return & deposit settlement"), h("p", {}, "Compare readings and settle the deposit hold.")])));
  const body = h("div", { class: "talus-card-body" });

  if (!state.detail.active_trip && !state.detail.inspections?.some((i) => i.inspection_type === "inbound" && i.status === "completed")) {
    body.appendChild(h("p", { style: "color:var(--talus-muted);font-size:12.5px" }, "Complete the post-trip inspection above, then receive the return here."));
    card.appendChild(body); return card;
  }
  if (state.detail.active_trip) {
    body.appendChild(h("button", { type: "button", class: "talus-btn talus-btn-primary", onclick: () => receiveReturn() }, "Receive return"));
    card.appendChild(body); return card;
  }

  if (!s) { body.appendChild(h("p", {}, "Loading return summary…")); card.appendChild(body); return card; }

  body.appendChild(h("div", { class: "ops-reconcile-grid" }, [
    reconcileTile("Authorized deposit", formatCurrency(s.hold_amount_cents)),
    reconcileTile("Outbound baseline", `${s.outbound_fuel_pct ?? "—"}% fuel · ${s.outbound_odometer_miles ?? "—"} mi`),
    reconcileTile("Return reading", `${s.inbound_fuel_pct ?? "—"}% fuel · ${s.inbound_odometer_miles ?? "—"} mi`),
  ]));

  const fuelInput = h("input", { class: "talus-input", type: "number", inputmode: "decimal", min: "0", placeholder: "0.00" });
  const mileageInput = h("input", { class: "talus-input", type: "number", inputmode: "decimal", min: "0", placeholder: "0.00" });
  const damageInput = h("input", { class: "talus-input", type: "number", inputmode: "decimal", min: "0", placeholder: "0.00" });
  body.appendChild(h("div", { class: "talus-section-title" }, "APPROVED CHARGES (USD)"));
  body.appendChild(h("div", { class: "ops-reconcile-grid" }, [
    h("label", { class: "talus-field" }, ["Fuel charge", fuelInput]),
    h("label", { class: "talus-field" }, ["Mileage charge", mileageInput]),
    h("label", { class: "talus-field" }, ["Damage / other", damageInput]),
  ]));

  const summaryBox = h("div", { class: "talus-settle-summary", style: "margin-top:14px" });
  function updateSummary() {
    const fuel = Math.round((Number(fuelInput.value) || 0) * 100);
    const mileage = Math.round((Number(mileageInput.value) || 0) * 100);
    const damage = Math.round((Number(damageInput.value) || 0) * 100);
    const total = fuel + mileage + damage;
    const hold = Number(s.hold_amount_cents);
    const captured = Math.min(total, hold);
    const released = hold - captured;
    const excess = total - captured;
    clear(summaryBox);
    summaryBox.appendChild(h("strong", {}, `Charge ${formatCurrency(captured)} and release ${formatCurrency(released)}`));
    if (excess > 0) summaryBox.appendChild(h("p", { style: "margin:6px 0 0;color:var(--talus-red)" }, `${formatCurrency(excess)} exceeds the deposit and will be recorded as owed by the customer.`));
    settleButton.dataset.captured = fuel; settleButton.dataset.mileage = mileage; settleButton.dataset.damage = damage;
  }
  for (const input of [fuelInput, mileageInput, damageInput]) input.addEventListener("input", updateSummary);

  const settleKey = `settle:${state.selectedBookingItemId}`;
  const settleButton = h("button", { type: "button", class: "talus-btn talus-btn-primary", style: "margin-top:12px", disabled: isPending(settleKey) }, isPending(settleKey) ? "Settling…" : "Review & settle");
  settleButton.addEventListener("click", () => promptSettleReview(Number(settleButton.dataset.captured || 0), Number(settleButton.dataset.mileage || 0), Number(settleButton.dataset.damage || 0)));
  updateSummary();
  body.append(summaryBox, settleButton);
  card.appendChild(body);
  return card;
}
function reconcileTile(label, value) { return h("div", { class: "ops-reconcile-item" }, [h("label", {}, label), h("b", {}, value)]); }

function promptSettleReview(fuel, mileage, damage) {
  const s = state.returnSummary;
  const hold = Number(s.hold_amount_cents);
  const total = fuel + mileage + damage;
  const captured = Math.min(total, hold);
  const released = hold - captured;
  const panel = h("div", { class: "talus-modal-panel" });
  const modal = h("div", { class: "talus-modal", role: "dialog", "aria-modal": "true", "aria-label": "Confirm settlement", tabindex: "-1" }, panel);
  document.body.appendChild(modal);
  panel.append(
    h("h2", {}, "Confirm settlement"),
    h("p", { style: "font-size:14px;font-weight:700;margin-top:8px" }, `Charge ${formatCurrency(captured)} and release ${formatCurrency(released)}`),
    h("p", { style: "font-size:12.5px;color:var(--talus-muted)" }, `${state.detail.booking_reference} · ${state.detail.customer_name || "Customer"} · ${state.detail.fleet_number || "Unit"}`),
    h("div", { style: "display:flex;gap:8px;justify-content:flex-end;margin-top:16px" }, [
      h("button", { type: "button", class: "talus-btn", onclick: () => dialog.close() }, "Back"),
      h("button", { type: "button", class: "talus-btn talus-btn-primary", onclick: (event) => confirmSettle(event, dialog, fuel, mileage, damage) }, "Confirm settlement"),
    ]),
  );
  const dialog = openDialog(modal, { onClose: () => modal.remove() });
}

async function confirmSettle(event, dialog, fuel, mileage, damage) {
  const key = `settle:${state.selectedBookingItemId}`;
  if (isPending(key)) return;
  event.target.disabled = true; event.target.textContent = "Settling…";
  try {
    await withPending(key, () => api("/api/v1/operations/settle", {
      method: "POST",
      body: { bookingItemId: state.selectedBookingItemId, fuelChargeCents: fuel, mileageChargeCents: mileage, damageChargeCents: damage },
    }));
    toast("Deposit settled.", { kind: "success" });
    dialog.close();
    await loadReturnSummary();
    renderCommandCenter();
    poller.refreshNow();
  } catch (error) {
    toast(`Could not settle: ${error.message}`, { kind: "error" });
    event.target.disabled = false; event.target.textContent = "Confirm settlement";
  }
}

/* ---------------------------------------------------------------------- *
 * Write actions: assign, dispatch, receive return
 * ---------------------------------------------------------------------- */
async function assignMachine() {
  const key = `assign:${state.selectedBookingItemId}`;
  const errorEl = document.querySelector(`#${CSS.escape(key)}-error`);
  if (errorEl) errorEl.textContent = "";
  try {
    await withPending(key, () => api("/api/v1/operations/assign", { method: "POST", body: { bookingItemId: state.selectedBookingItemId, machineId: state.chosenMachineId } }));
    toast("Unit assigned.", { kind: "success" });
    await selectBooking(state.selectedBookingItemId);
    poller.refreshNow();
  } catch (error) {
    const message = error.code === "MACHINE_OCCUPIED"
      ? `${state.machines.find((m) => m.machine_id === state.chosenMachineId)?.fleet_number || "That unit"} was assigned by another staff member. Choose another available vehicle.`
      : `Could not assign: ${error.message}`;
    renderCommandCenter();
    const el = document.querySelector(`#${CSS.escape(key)}-error`);
    if (el) el.textContent = message; else toast(message, { kind: "error" });
    if (error.code === "MACHINE_OCCUPIED") await loadMachines();
  }
}

async function dispatchBooking(fleetNumber) {
  const key = `dispatch:${state.selectedBookingItemId}`;
  try {
    await withPending(key, () => api("/api/v1/operations/dispatch", { method: "POST", body: { bookingItemId: state.selectedBookingItemId, dispatchedAt: new Date().toISOString() } }));
    toast(`${fleetNumber || "Unit"} dispatched.`, { kind: "success" });
    await selectBooking(state.selectedBookingItemId);
    poller.refreshNow();
  } catch (error) {
    renderCommandCenter();
    const el = document.querySelector(`#${CSS.escape(key)}-error`);
    const message = error.code === "DISPATCH_BLOCKED_UNSAFE_INSPECTION" ? "This unit's inspection recorded an unsafe item. Dispatch is blocked until it is serviced." : `Could not dispatch: ${error.message}`;
    if (el) el.textContent = message; else toast(message, { kind: "error" });
  }
}

async function receiveReturn() {
  const key = `return:${state.selectedBookingItemId}`;
  const inbound = state.detail.inspections.find((i) => i.inspection_type === "inbound" && i.status === "completed");
  if (!inbound) { toast("Complete the post-trip inspection first.", { kind: "error" }); return; }
  try {
    await withPending(key, () => api("/api/v1/operations/return", { method: "POST", body: { bookingItemId: state.selectedBookingItemId, inboundInspectionId: inbound.inspection_id, returnedAt: new Date().toISOString() } }));
    toast("Return received.", { kind: "success" });
    await selectBooking(state.selectedBookingItemId);
    poller.refreshNow();
  } catch (error) { toast(`Could not receive return: ${error.message}`, { kind: "error" }); }
}

/* ---------------------------------------------------------------------- *
 * Mobile view toggling
 * ---------------------------------------------------------------------- */
function setMobileView(view) {
  document.querySelector("#queueSection").classList.toggle("is-active-view", view === "queue");
  document.querySelector("#commandCenter").classList.toggle("is-active-view", view === "detail");
}

/* ---------------------------------------------------------------------- *
 * Boot
 * ---------------------------------------------------------------------- */
let poller;

async function boot() {
  state.session = requireSession();
  if (!state.session) return;

  const params = new URLSearchParams(location.search);
  state.date = params.get("date") || todayIso();
  state.filter = params.get("filter") || "all";
  const initialBookingItemId = params.get("bookingItemId");

  document.querySelector("#navSlot").replaceWith(renderNav({ activeKey: "ops", tenantDisplayName: state.session.tenantDisplayName }));
  document.querySelector("#tabbarSlot").replaceWith(renderTabBar({ activeKey: "ops" }));
  document.querySelector("#tenantLabel").textContent = state.session.tenantDisplayName || "—";
  document.querySelector("#logoutButton").appendChild(icon("logout"));
  document.querySelector("#logoutButton").addEventListener("click", logout);
  document.querySelector("#refreshButton").appendChild(icon("refresh-cw"));
  document.querySelector("#refreshButton").addEventListener("click", () => poller.refreshNow());
  document.querySelector("#backToQueue").addEventListener("click", () => setMobileView("queue"));

  const dateInput = document.querySelector("#dateInput");
  dateInput.value = state.date;
  dateInput.addEventListener("change", () => { state.date = dateInput.value; syncUrl(); poller.refreshNow(); });

  poller = createPoller({
    fetchers: { board: () => api(`/api/v1/operations/dispatch-board?date=${encodeURIComponent(state.date)}`) },
    intervalMs: 25000,
    onData: (data) => {
      state.items = data.board.items;
      renderQueue();
      if (state.selectedBookingItemId && !state.items.some((i) => i.booking_item_id === state.selectedBookingItemId)) {
        // Selected item fell out of the current date/filter window -- keep
        // showing its detail (still fetched independently by id) rather
        // than yanking the screen out from under the operator.
      }
    },
    onStateChange: ({ state: connectionState, lastGoodAt }) => {
      const banner = document.querySelector("#connectionBanner");
      if (connectionState === "connected") { banner.hidden = true; return; }
      banner.hidden = false;
      banner.classList.toggle("is-critical", connectionState === "offline");
      clear(banner);
      banner.append(icon("wifi-off"), h("span", {}, `Updates interrupted · Last successful update ${lastGoodAt ? new Date(lastGoodAt).toLocaleTimeString() : "unknown"}`), h("button", { type: "button", class: "talus-btn talus-btn-sm", onclick: () => poller.refreshNow() }, "Retry"));
    },
  });
  poller.start();

  if (initialBookingItemId) await selectBooking(initialBookingItemId);
}

boot().catch((error) => {
  if (error instanceof ApiError) return;
  console.error("Talus dispatch board failed to start", error);
  toast("The dispatch board could not start. Reload the page.", { kind: "error", duration: 0 });
});
