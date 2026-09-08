import { requireSession, logout } from "./auth-client.js";
import { h, clear, icon, api, ApiError, toast, openDialog, formatCurrency, formatDateTime, formatElapsed, startClock, renderNav, renderTabBar, createPoller } from "./shell.js";

const FRESHNESS_COPY = {
  current: "GPS current",
  delayed: "GPS delayed",
  offline: "GPS offline",
  never_reported: "GPS unavailable",
};
const SERVICE_COPY = { in_service: "In service", maintenance: "Maintenance", out_of_service: "Out of service" };
const RENTAL_COPY = { on_rent: "On rent", ready: "Ready to dispatch", unassigned: "Unassigned" };
const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };

const state = {
  session: null,
  map: null, roadLayer: null, satelliteLayer: null,
  markers: new Map(),
  clusterMarkers: [],
  geofencePolygons: [],
  machines: [],
  machinesById: new Map(),
  incidents: [],
  incidentFilter: "open",
  selectedMachineId: null,
  scope: "all",
  searchQuery: "",
  summaryFilter: null,
  listViewActive: false,
  mapInitError: null,
  tilesFailed: false,
  hasFitOnce: false,
  poller: null,
  connectionState: "connected",
  lastGoodAt: null,
  detailContext: null, // {kind:'machine'|'incident', id}
};

function machineBucket(machine) {
  const urgent = ["critical", "high"].includes(machine.highest_open_incident_severity);
  const stale = ["delayed", "offline", "never_reported"].includes(machine.connectivity_state);
  const maintenance = machine.service_state !== "in_service";
  if (urgent) return "urgent";
  if (stale) return "stale";
  if (maintenance) return "maintenance";
  return "normal";
}

function matchesScope(machine) {
  if (state.scope === "all") return true;
  if (state.scope === "service") return machine.service_state !== "in_service";
  if (state.scope === "yard") return machine.service_state === "in_service" && machine.rental_state !== "on_rent";
  return machine.rental_state === "on_rent"; // "rented"
}
function matchesSummaryFilter(machine) {
  switch (state.summaryFilter) {
    case "on_rent": return machine.rental_state === "on_rent";
    case "overdue": return machine.is_overdue;
    case "attention": return !!machine.highest_open_incident_severity;
    case "gps_stale": return ["delayed", "offline", "never_reported"].includes(machine.connectivity_state);
    default: return true;
  }
}
function matchesSearch(machine) {
  if (!state.searchQuery) return true;
  const q = state.searchQuery.toLowerCase();
  return (machine.fleet_number || "").toLowerCase().includes(q) || (machine.display_name || "").toLowerCase().includes(q);
}
function visibleMachines() {
  return state.machines.filter((m) => matchesScope(m) && matchesSummaryFilter(m) && matchesSearch(m));
}

/* ---------------------------------------------------------------------- *
 * Map
 * ---------------------------------------------------------------------- */
function initMap() {
  const mapStatus = document.querySelector("#mapStatus");
  if (typeof L === "undefined") {
    state.mapInitError = "The map library failed to load.";
    showMapFallback(true);
    return;
  }
  try {
    state.map = L.map("map", { zoomControl: false, attributionControl: true }).setView([39.5, -98.35], 4);
    L.control.zoom({ position: "bottomright" }).addTo(state.map);
    state.roadLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" });
    state.satelliteLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles © Esri" });
    state.roadLayer.addTo(state.map);

    let tileErrorCount = 0;
    state.roadLayer.on("tileerror", () => {
      tileErrorCount += 1;
      if (tileErrorCount > 4 && !state.tilesFailed) { state.tilesFailed = true; showMapFallback(true, "Map tiles could not be loaded. Showing the fleet list instead."); }
    });
    state.roadLayer.on("load", () => { tileErrorCount = 0; });

    state.map.on("moveend zoomend", () => { state.hasFitOnce = true; });
    mapStatus.classList.add("is-hidden");
  } catch (error) {
    state.mapInitError = error.message;
    showMapFallback(true, "The map could not start. Showing the fleet list instead.");
  }

  document.querySelector("#roadLayerBtn").addEventListener("click", () => setLayer("road"));
  document.querySelector("#satelliteLayerBtn").addEventListener("click", () => setLayer("satellite"));
}

function setLayer(which) {
  if (!state.map) return;
  const satellite = which === "satellite";
  if (satellite) { state.map.removeLayer(state.roadLayer); state.satelliteLayer.addTo(state.map); }
  else { state.map.removeLayer(state.satelliteLayer); state.roadLayer.addTo(state.map); }
  document.querySelector("#roadLayerBtn").setAttribute("aria-pressed", String(!satellite));
  document.querySelector("#satelliteLayerBtn").setAttribute("aria-pressed", String(satellite));
}

function showMapFallback(show, message) {
  const panel = document.querySelector("#listPanel");
  const mapEl = document.querySelector("#map");
  if (show) {
    if (message) toast(message, { kind: "error", duration: 8000 });
    mapEl.hidden = true;
    panel.hidden = false;
    renderListView();
  } else if (!state.listViewActive) {
    mapEl.hidden = false;
    panel.hidden = true;
  }
}

function markerIcon(machine, { selected = false } = {}) {
  const bucket = machineBucket(machine);
  const classes = ["vehicle-pin", bucket !== "normal" ? `is-${bucket === "urgent" ? "urgent" : bucket}` : "", selected ? "is-selected" : ""].filter(Boolean).join(" ");
  const wrapper = document.createElement("div");
  wrapper.className = classes;
  const dot = document.createElement("i");
  const label = document.createElement("span");
  label.textContent = machine.fleet_number || machine.display_name || "Unit";
  wrapper.append(dot, label);
  return L.divIcon({ className: "vehicle-marker", html: wrapper.outerHTML, iconAnchor: [8, 8] });
}

function syncMarkers() {
  if (!state.map) return;
  const visible = visibleMachines().filter((m) => m.latitude != null && m.longitude != null);
  const seen = new Set();
  for (const machine of visible) {
    seen.add(machine.machine_id);
    const existing = state.markers.get(machine.machine_id);
    const latLng = [machine.latitude, machine.longitude];
    if (existing) {
      existing.setLatLng(latLng);
      existing.setIcon(markerIcon(machine, { selected: machine.machine_id === state.selectedMachineId }));
    } else {
      const marker = L.marker(latLng, { icon: markerIcon(machine, { selected: machine.machine_id === state.selectedMachineId }) })
        .addTo(state.map)
        .on("click", () => openMachineDetail(machine.machine_id));
      marker.bindTooltip(machine.fleet_number || machine.display_name, { direction: "top", offset: [0, -10] });
      state.markers.set(machine.machine_id, marker);
    }
  }
  for (const [id, marker] of [...state.markers.entries()]) {
    if (!seen.has(id)) { marker.remove(); state.markers.delete(id); }
  }
  if (!state.hasFitOnce && visible.length) {
    fitFleet();
    state.hasFitOnce = true;
  }
}

function fitFleet() {
  if (!state.map) return;
  const points = [...state.markers.values()].map((m) => m.getLatLng());
  if (points.length) state.map.fitBounds(points, { padding: [70, 70], maxZoom: 14 });
}

// Geofences change rarely, so they are loaded once rather than on every
// poll cycle. Both Polygon and MultiPolygon GeoJSON geometry are supported
// -- a MultiPolygon's outer array-of-rings-of-polygons is flattened to the
// same [ring, ring, ...] shape Leaflet expects for either geometry type.
async function loadGeofences() {
  if (!state.map) return;
  try {
    const { geofences } = await api("/api/v1/fleet/geofences");
    for (const polygon of state.geofencePolygons) polygon.remove();
    state.geofencePolygons = [];
    for (const fence of geofences) {
      const coordinates = fence.geometry?.coordinates;
      if (!coordinates) continue;
      const rings = fence.geometry.type === "Polygon" ? coordinates : fence.geometry.type === "MultiPolygon" ? coordinates.flat() : null;
      if (!rings) continue;
      const latLngRings = rings.map((ring) => ring.map(([lng, lat]) => [lat, lng]));
      const polygon = L.polygon(latLngRings, { color: "#4ad89c", weight: 2, dashArray: "8 8", fillColor: "#34c98b", fillOpacity: 0.08 }).addTo(state.map);
      polygon.bindTooltip(fence.display_name, { direction: "center" });
      state.geofencePolygons.push(polygon);
    }
  } catch {
    // Geofence overlays are supplementary to the live fleet view; a failed
    // fetch should not block markers/incidents from rendering.
  }
}

/* ---------------------------------------------------------------------- *
 * Summary strip
 * ---------------------------------------------------------------------- */
const SUMMARY_DEFS = [
  { key: null, label: "Total fleet", field: "total" },
  { key: "on_rent", label: "On rent", field: "onTrip" },
  { key: "overdue", label: "Overdue", field: "overdue" },
  { key: "attention", label: "Needs attention", field: "needsAttention" },
  { key: "gps_stale", label: "GPS stale", field: "gpsStale" },
];
function renderSummaryStrip(summary, loading = false) {
  const strip = document.querySelector("#summaryStrip");
  clear(strip);
  for (const def of SUMMARY_DEFS) {
    const btn = h("button", {
      type: "button",
      class: `fleet-stat${loading ? " is-loading" : ""}`,
      "aria-pressed": state.summaryFilter === def.key ? "true" : "false",
      onclick: () => { state.summaryFilter = state.summaryFilter === def.key ? null : def.key; render(); },
    }, [
      h("b", {}, loading ? "0" : String(summary?.[def.field] ?? 0)),
      h("small", {}, def.label.toUpperCase()),
    ]);
    strip.appendChild(btn);
  }
}

/* ---------------------------------------------------------------------- *
 * Incident rail
 * ---------------------------------------------------------------------- */
function renderIncidentRail() {
  const list = document.querySelector("#incidentList");
  clear(list);
  const items = state.incidents;
  if (!items.length) {
    list.appendChild(h("div", { class: "talus-empty" }, [
      icon("shield-check", { size: 28 }),
      h("p", {}, state.incidentFilter === "open" ? "No open incidents. The fleet is quiet." : "No resolved incidents yet."),
    ]));
    return;
  }
  for (const incident of items) {
    const severityClass = incident.severity === "critical" ? "is-critical" : incident.severity === "high" ? "is-high" : "";
    const card = h("article", { class: `incident-card ${severityClass}` }, [
      h("div", { class: "incident-card-top" }, [
        h("b", {}, `${incident.fleet_number || "Unit"} · ${incident.alert_kind ? incident.alert_kind.replaceAll("_", " ").toUpperCase() : "INCIDENT"}`),
        h("time", {}, formatElapsed(incident.opened_at)),
      ]),
      h("p", {}, [
        h("span", { class: `talus-badge talus-badge-${incident.severity === "critical" || incident.severity === "high" ? "red" : "amber"}` }, incident.severity.toUpperCase()),
        document.createTextNode(`  ${incident.status.replaceAll("_", " ")} · ${incident.assigned_display_name ? `Responding: ${incident.assigned_display_name}` : "Unassigned"}`),
      ]),
      h("div", { class: "incident-card-actions" }, [
        h("button", { type: "button", class: "talus-btn talus-btn-sm talus-btn-primary", onclick: () => openIncidentDetail(incident.incident_id) }, "Review incident"),
        h("button", { type: "button", class: "talus-btn talus-btn-sm", onclick: () => locateMachine(incident.machine_id) }, "Locate vehicle"),
      ]),
    ]);
    list.appendChild(card);
  }
}

function locateMachine(machineId) {
  const machine = state.machinesById.get(machineId);
  if (!machine) { toast("That vehicle is not in the current view.", { kind: "error" }); return; }
  if (state.listViewActive) toggleListView(false);
  if (machine.latitude != null && state.map) state.map.panTo([machine.latitude, machine.longitude]);
  openMachineDetail(machineId);
}

/* ---------------------------------------------------------------------- *
 * List view (accessible non-map alternative + tile-failure fallback)
 * ---------------------------------------------------------------------- */
function renderListView() {
  const panel = document.querySelector("#listPanel");
  clear(panel);
  const machines = visibleMachines();
  if (!machines.length) {
    panel.appendChild(h("div", { class: "talus-empty" }, [icon("car-front", { size: 28 }), h("p", {}, "No vehicles match the current filters.")]));
    return;
  }
  const table = h("table", { class: "fleet-list-table" }, [
    h("thead", {}, h("tr", {}, [
      h("th", {}, "Unit"), h("th", {}, "Rental"), h("th", {}, "Connectivity"), h("th", {}, "Service"), h("th", {}, "Incident"),
    ])),
  ]);
  const tbody = h("tbody");
  for (const machine of machines) {
    const row = h("tr", { class: "fleet-list-row", tabindex: "0", role: "button", "aria-label": `Open ${machine.fleet_number || machine.display_name}`, onclick: () => openMachineDetail(machine.machine_id), onkeydown: (event) => { if (event.key === "Enter") openMachineDetail(machine.machine_id); } }, [
      h("td", {}, machine.fleet_number || machine.display_name),
      h("td", {}, RENTAL_COPY[machine.rental_state] || machine.rental_state),
      h("td", {}, badgeForConnectivity(machine.connectivity_state)),
      h("td", {}, badgeForService(machine.service_state)),
      h("td", {}, machine.highest_open_incident_severity ? h("span", { class: "talus-badge talus-badge-red" }, machine.highest_open_incident_severity.toUpperCase()) : "—"),
    ]);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  panel.appendChild(table);
}

function badgeForConnectivity(connectivityState) {
  const cls = connectivityState === "current" ? "green" : connectivityState === "delayed" ? "amber" : "red";
  return h("span", { class: `talus-badge talus-badge-${cls}` }, FRESHNESS_COPY[connectivityState] || connectivityState);
}
function badgeForService(serviceState) {
  const cls = serviceState === "in_service" ? "green" : serviceState === "maintenance" ? "amber" : "red";
  return h("span", { class: `talus-badge talus-badge-${cls}` }, SERVICE_COPY[serviceState] || serviceState);
}

// Small-screen tab bar (Map / Fleet / Incidents / Dispatch) drives which
// region is visible via a URL hash, so the browser back button and deep
// links both work; the tab bar itself is pure CSS/markup from shell.js.
function syncMobileTab() {
  const tab = location.hash === "#incidents" ? "incidents" : location.hash === "#fleet-list" ? "fleet-list" : "fleet-map";
  document.querySelector("#tabbarSlot")?.remove();
  const bar = renderTabBar({ activeKey: tab });
  bar.id = "tabbarSlot";
  document.body.appendChild(bar);
  document.querySelector("#mapRegion").classList.toggle("is-active-tab", tab !== "incidents");
  document.querySelector("#incidentRail").classList.toggle("is-active-tab", tab === "incidents");
  toggleListView(tab === "fleet-list");
}

function toggleListView(force) {
  state.listViewActive = force != null ? force : !state.listViewActive;
  document.querySelector("#toggleListView").setAttribute("aria-pressed", String(state.listViewActive));
  document.querySelector("#map").hidden = state.listViewActive;
  document.querySelector("#listPanel").hidden = !state.listViewActive;
  if (state.listViewActive) renderListView();
}

/* ---------------------------------------------------------------------- *
 * Vehicle detail drawer
 * ---------------------------------------------------------------------- */
let activeDialog = null;

async function openMachineDetail(machineId) {
  state.selectedMachineId = machineId;
  syncMarkers();
  const drawer = document.querySelector("#detailDrawer");
  document.querySelector("#drawerTitle").textContent = "Loading…";
  document.querySelector("#drawerSubtitle").textContent = "";
  clear(document.querySelector("#drawerBody"));
  document.querySelector("#drawerBody").appendChild(h("div", { class: "talus-empty" }, "Loading vehicle telemetry…"));
  activeDialog?.close();
  activeDialog = openDialog(drawer, { onClose: () => { state.selectedMachineId = null; syncMarkers(); } });

  try {
    const detail = await api(`/api/v1/fleet/machines/${machineId}`);
    renderMachineDetail(detail);
  } catch (error) {
    document.querySelector("#drawerBody").replaceChildren(h("div", { class: "talus-empty" }, `Could not load vehicle detail: ${error.message}`));
  }
}

function renderMachineDetail(detail) {
  const m = detail.machine;
  document.querySelector("#drawerTitle").textContent = m.fleet_number || m.display_name;
  document.querySelector("#drawerSubtitle").textContent = m.display_name;
  const body = document.querySelector("#drawerBody");
  clear(body);

  // 1. identity + location already in header. 2. rental state.
  body.appendChild(h("div", {}, [
    h("span", { class: `talus-badge talus-badge-${m.rental_state === "on_rent" ? "blue" : m.rental_state === "ready" ? "green" : "neutral"}` }, RENTAL_COPY[m.rental_state]),
    document.createTextNode(" "),
    badgeForConnectivity(m.connectivity_state),
    document.createTextNode(" "),
    badgeForService(m.service_state),
  ]));
  if (m.is_overdue) body.appendChild(h("p", { style: "color:var(--talus-red);font-weight:700;font-size:12.5px;margin-top:10px" }, `Overdue — was due back ${formatDateTime(m.trip_scheduled_end_at)}`));

  // 3. GPS/telemetry freshness.
  body.appendChild(h("div", { class: "talus-section-title" }, "TELEMETRY FRESHNESS"));
  body.appendChild(h("p", { style: "font-size:12.5px;color:var(--talus-muted);margin:0" }, m.last_seen_at ? `Last received ${formatElapsed(m.last_seen_at)} (${formatDateTime(m.last_seen_at)})` : "No telemetry has ever been received for this unit."));

  // 4. Open incident + owner.
  if (m.open_incident_id) {
    body.appendChild(h("div", { class: "talus-section-title" }, "OPEN INCIDENT"));
    body.appendChild(h("div", { class: "incident-card is-critical" }, [
      h("p", { style: "margin:0" }, `${m.highest_open_incident_severity.toUpperCase()} · opened ${formatElapsed(m.incident_opened_at)}`),
      h("div", { class: "incident-card-actions", style: "margin-top:10px" }, [
        h("button", { type: "button", class: "talus-btn talus-btn-sm talus-btn-primary", onclick: () => openIncidentDetail(m.open_incident_id) }, "Review incident"),
      ]),
    ]));
  }

  // 5. Primary actions.
  body.appendChild(h("div", { class: "talus-section-title" }, "ACTIONS"));
  body.appendChild(h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [
    h("a", { class: "talus-btn talus-btn-sm", href: `/ops` }, "Open in Dispatch Board"),
    m.latitude != null ? h("button", { type: "button", class: "talus-btn talus-btn-sm", onclick: () => { activeDialog?.close(); if (state.listViewActive) toggleListView(false); state.map?.panTo([m.latitude, m.longitude]); } }, "Locate on map") : null,
  ].filter(Boolean)));

  // 6. Speed / fuel / battery / hours.
  body.appendChild(h("div", { class: "talus-section-title" }, "LIVE READINGS"));
  body.appendChild(h("div", { class: "vehicle-metrics" }, [
    metricBox("SPEED", m.speed_mph != null ? `${m.speed_mph} mph` : "—"),
    metricBox("ENGINE HRS", m.engine_hours ?? "—"),
    metricBox("LAST PING", m.last_seen_at ? formatElapsed(m.last_seen_at) : "—"),
  ]));
  body.appendChild(gaugeRow("Fuel level", m.fuel_pct, "%"));
  body.appendChild(gaugeRow("Tracker battery", m.battery_level_bp == null ? null : Math.round(m.battery_level_bp / 100), "%"));

  // 7. Telemetry history + activity timeline.
  body.appendChild(h("div", { class: "talus-section-title" }, detail.speedLimitMph ? `SPEED OVER RECENT PINGS · LIMIT ${detail.speedLimitMph} MPH` : "SPEED OVER RECENT PINGS"));
  body.appendChild(speedChart(detail.telemetryHistory, detail.speedLimitMph));

  body.appendChild(h("div", { class: "talus-section-title" }, "RECENT ALERTS"));
  if (!detail.alerts.length) body.appendChild(h("p", { style: "font-size:12px;color:var(--talus-muted)" }, "No alerts recorded for this unit."));
  for (const alert of detail.alerts.slice(0, 8)) {
    body.appendChild(h("div", { class: "vehicle-timeline-row" }, [
      h("b", {}, alert.alert_kind.replaceAll("_", " ").toUpperCase()),
      h("br"),
      h("span", {}, `${formatElapsed(alert.triggered_at)} · ${alert.severity}`),
    ]));
  }
}

function metricBox(label, value) {
  return h("div", { class: "vehicle-metric" }, [h("label", {}, label), h("b", {}, String(value))]);
}
function gaugeRow(label, value, suffix) {
  const known = value != null;
  const pct = known ? Math.max(0, Math.min(100, value)) : 0;
  return h("div", { class: "vehicle-gauge" }, [
    h("div", { class: "vehicle-gauge-row" }, [h("span", {}, label), h("b", {}, known ? `${value}${suffix}` : "—")]),
    h("div", { class: `vehicle-bar${known && value < 25 ? " is-warn" : ""}` }, h("span", { style: `width:${pct}%` })),
  ]);
}

function speedChart(history, speedLimitMph) {
  if (!history || history.length < 2) return h("p", { style: "font-size:12px;color:var(--talus-muted)" }, "No speed history is available yet for this window.");
  const times = history.map((p) => new Date(p.recorded_at).getTime());
  const minT = Math.min(...times); const maxT = Math.max(...times);
  const span = Math.max(1, maxT - minT);
  const maxSpeed = Math.max(1, speedLimitMph || 0, ...history.map((p) => Number(p.speed_mph || 0)));
  const points = history.map((p) => `${((new Date(p.recorded_at).getTime() - minT) / span) * 300},${96 - (Number(p.speed_mph || 0) / maxSpeed) * 82}`).join(" ");
  const limitY = speedLimitMph ? 96 - (speedLimitMph / maxSpeed) * 82 : null;
  const wrap = h("div", { class: "vehicle-chart" });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 300 110");
  svg.setAttribute("preserveAspectRatio", "none");
  if (limitY != null) {
    const line = document.createElementNS(svg.namespaceURI, "line");
    line.setAttribute("x1", "0"); line.setAttribute("x2", "300"); line.setAttribute("y1", String(limitY)); line.setAttribute("y2", String(limitY));
    line.setAttribute("stroke", "#b86050"); line.setAttribute("stroke-dasharray", "5 5");
    svg.appendChild(line);
  }
  const poly = document.createElementNS(svg.namespaceURI, "polyline");
  poly.setAttribute("points", points);
  poly.setAttribute("fill", "none"); poly.setAttribute("stroke", "#317a9b"); poly.setAttribute("stroke-width", "3");
  poly.setAttribute("stroke-linejoin", "round"); poly.setAttribute("stroke-linecap", "round");
  svg.appendChild(poly);
  wrap.appendChild(svg);
  const caption = h("p", { style: "font-size:11px;color:var(--talus-muted);margin:6px 0 0" }, `${formatDateTime(history[0].recorded_at)} – ${formatDateTime(history[history.length - 1].recorded_at)} · peak ${Math.max(...history.map((p) => Number(p.speed_mph || 0)))} mph`);
  const container = h("div", {}, [wrap, caption]);
  return container;
}

/* ---------------------------------------------------------------------- *
 * Incident detail drawer
 * ---------------------------------------------------------------------- */
async function openIncidentDetail(incidentId) {
  const drawer = document.querySelector("#detailDrawer");
  document.querySelector("#drawerTitle").textContent = "Loading…";
  document.querySelector("#drawerSubtitle").textContent = "";
  clear(document.querySelector("#drawerBody"));
  document.querySelector("#drawerBody").appendChild(h("div", { class: "talus-empty" }, "Loading incident…"));
  activeDialog?.close();
  activeDialog = openDialog(drawer);

  try {
    const detail = await api(`/api/v1/fleet/incidents/${incidentId}`);
    renderIncidentDetail(detail);
  } catch (error) {
    document.querySelector("#drawerBody").replaceChildren(h("div", { class: "talus-empty" }, `Could not load incident: ${error.message}`));
  }
}

function renderIncidentDetail(detail) {
  const incident = detail.incident;
  document.querySelector("#drawerTitle").textContent = `${incident.fleet_number || "Unit"} incident`;
  document.querySelector("#drawerSubtitle").textContent = `Opened ${formatDateTime(incident.opened_at)}`;
  const body = document.querySelector("#drawerBody");
  clear(body);

  body.appendChild(h("div", {}, [
    h("span", { class: `talus-badge talus-badge-${incident.status === "resolved" ? "green" : "red"}` }, incident.status.replaceAll("_", " ").toUpperCase()),
    document.createTextNode(" "),
    h("span", { class: "talus-badge talus-badge-amber" }, incident.severity.toUpperCase()),
  ]));
  body.appendChild(h("p", { style: "font-size:12.5px;color:var(--talus-muted);margin-top:10px" }, incident.assigned_display_name ? `Responding: ${incident.assigned_display_name}` : "Unassigned — no one has taken this incident yet."));

  body.appendChild(h("div", { class: "talus-section-title" }, "ACTIONS"));
  const actions = h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" });
  if (incident.status === "new") actions.appendChild(actionButton("Acknowledge", () => transitionIncident(incident.incident_id, "acknowledge")));
  if (incident.status !== "in_progress" && incident.status !== "resolved") actions.appendChild(actionButton("Start responding", () => transitionIncident(incident.incident_id, "start")));
  if (incident.status !== "resolved") actions.appendChild(actionButton("Resolve…", () => promptResolve(incident.incident_id), "talus-btn-primary"));
  actions.appendChild(h("button", { type: "button", class: "talus-btn talus-btn-sm", onclick: () => locateMachine(incident.machine_id) }, "Locate vehicle"));
  body.appendChild(actions);

  body.appendChild(h("div", { class: "talus-section-title" }, "ADD NOTE"));
  const noteForm = h("form", { style: "display:flex;gap:8px" });
  const noteInput = h("input", { class: "talus-input", style: "margin-top:0", placeholder: "What did you do or observe?", "aria-label": "Add a note" });
  noteForm.append(noteInput, h("button", { type: "submit", class: "talus-btn talus-btn-sm" }, "Add"));
  noteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!noteInput.value.trim()) return;
    try {
      const updated = await api(`/api/v1/fleet/incidents/${incident.incident_id}/notes`, { method: "POST", body: { body: noteInput.value.trim() } });
      toast("Note added.", { kind: "success" });
      renderIncidentDetail(await api(`/api/v1/fleet/incidents/${incident.incident_id}`));
    } catch (error) { toast(`Could not add note: ${error.message}`, { kind: "error" }); }
  });
  body.appendChild(noteForm);

  body.appendChild(h("div", { class: "talus-section-title" }, `NOTES & ACTIVITY (${formatElapsed(incident.opened_at)} open)`));
  const events = [
    ...detail.notes.map((n) => ({ at: n.created_at, text: `${n.author_display_name || "Staff"}: ${n.body}` })),
    ...detail.statusHistory.map((e) => ({ at: e.occurred_at, text: `${e.actor_display_name || "Staff"} moved to ${e.to_status.replaceAll("_", " ")}${e.reason ? ` — ${e.reason}` : ""}` })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  if (!events.length) body.appendChild(h("p", { style: "font-size:12px;color:var(--talus-muted)" }, "No activity recorded yet."));
  for (const event of events) {
    body.appendChild(h("div", { class: "vehicle-timeline-row" }, [h("span", {}, formatDateTime(event.at)), h("br"), document.createTextNode(event.text)]));
  }
}
function actionButton(label, onclick, extraClass = "") {
  return h("button", { type: "button", class: `talus-btn talus-btn-sm ${extraClass}`.trim(), onclick }, label);
}

async function transitionIncident(incidentId, action) {
  try {
    await api(`/api/v1/fleet/incidents/${incidentId}/${action}`, { method: "POST", body: {} });
    toast("Incident updated.", { kind: "success" });
    renderIncidentDetail(await api(`/api/v1/fleet/incidents/${incidentId}`));
    poller.refreshNow();
  } catch (error) { toast(`Could not update incident: ${error.message}`, { kind: "error" }); }
}

function promptResolve(incidentId) {
  const panel = h("div", { class: "talus-modal-panel", role: "document" });
  const modal = h("div", { class: "talus-modal", role: "dialog", "aria-modal": "true", "aria-label": "Resolve incident", tabindex: "-1" }, panel);
  document.body.appendChild(modal);
  const reasonInput = h("textarea", { class: "talus-textarea", required: true, "aria-label": "Resolution reason" });
  panel.append(
    h("h2", {}, "Resolve incident"),
    h("p", { style: "font-size:12.5px;color:var(--talus-muted);margin:0 0 12px" }, "Describe what was found and how it was resolved. This is kept in the incident's permanent history."),
    h("label", { class: "talus-field" }, ["Resolution reason", reasonInput]),
    h("div", { style: "display:flex;gap:8px;justify-content:flex-end;margin-top:16px" }, [
      h("button", { type: "button", class: "talus-btn", onclick: () => dialog.close() }, "Cancel"),
      h("button", { type: "button", class: "talus-btn talus-btn-primary", onclick: async (event) => {
        if (!reasonInput.value.trim()) { reasonInput.focus(); return; }
        event.target.disabled = true; event.target.textContent = "Resolving…";
        try {
          await api(`/api/v1/fleet/incidents/${incidentId}/resolve`, { method: "POST", body: { resolutionReason: reasonInput.value.trim() } });
          toast("Incident resolved.", { kind: "success" });
          dialog.close();
          renderIncidentDetail(await api(`/api/v1/fleet/incidents/${incidentId}`));
          poller.refreshNow();
        } catch (error) { toast(`Could not resolve: ${error.message}`, { kind: "error" }); event.target.disabled = false; event.target.textContent = "Resolve"; }
      } }, "Resolve"),
    ]),
  );
  const dialog = openDialog(modal, { onClose: () => modal.remove() });
}

/* ---------------------------------------------------------------------- *
 * Connection banner
 * ---------------------------------------------------------------------- */
function renderConnectionBanner() {
  const banner = document.querySelector("#connectionBanner");
  if (state.connectionState === "connected") { banner.hidden = true; return; }
  banner.hidden = false;
  banner.classList.toggle("is-critical", state.connectionState === "offline");
  clear(banner);
  const lastGood = state.lastGoodAt ? formatElapsed(state.lastGoodAt) : "unknown";
  banner.append(
    icon("wifi-off"),
    h("span", {}, state.connectionState === "offline"
      ? `Offline · Last successful update ${lastGood}`
      : `Updates interrupted · Last successful update ${lastGood}`),
    h("button", { type: "button", class: "talus-btn talus-btn-sm", onclick: () => poller.refreshNow() }, "Retry"),
  );
}

/* ---------------------------------------------------------------------- *
 * Boot
 * ---------------------------------------------------------------------- */
let poller;

function render() {
  const summary = state.machines.length ? computeSummaryFromMachines() : null;
  renderSummaryStrip(summary, !state.machines.length && state.connectionState === "connected" && !state.lastGoodAt);
  syncMarkers();
  renderIncidentRail();
  if (state.listViewActive || state.tilesFailed) renderListView();
  renderConnectionBanner();
}
function computeSummaryFromMachines() {
  return state.machines.reduce((acc, m) => {
    acc.total += 1;
    if (m.rental_state === "on_rent") acc.onTrip += 1;
    if (m.is_overdue) acc.overdue += 1;
    if (m.service_state !== "in_service") acc.maintenance += 1;
    if (m.highest_open_incident_severity) acc.needsAttention += 1;
    if (["delayed", "offline", "never_reported"].includes(m.connectivity_state)) acc.gpsStale += 1;
    return acc;
  }, { total: 0, onTrip: 0, overdue: 0, maintenance: 0, needsAttention: 0, gpsStale: 0 });
}

async function boot() {
  state.session = requireSession();
  if (!state.session) return;

  document.querySelector("#navSlot").replaceWith(renderNav({ activeKey: "fleet", tenantDisplayName: state.session.tenantDisplayName, connectionState: state.connectionState }));
  syncMobileTab();
  window.addEventListener("hashchange", syncMobileTab);
  document.querySelector("#tenantLabel").textContent = state.session.tenantDisplayName || "—";
  document.querySelector("#logoutButton").innerHTML = "";
  document.querySelector("#logoutButton").appendChild(icon("logout"));
  document.querySelector("#logoutButton").addEventListener("click", logout);
  startClock(document.querySelector("#clock"));

  initMap();
  loadGeofences();

  document.querySelector("#fitFleetButton").addEventListener("click", fitFleet);
  document.querySelector("#refreshButton").addEventListener("click", () => poller.refreshNow());
  document.querySelector("#autoRefreshButton").addEventListener("click", (event) => {
    const next = !poller.isAuto();
    poller.setAuto(next);
    event.currentTarget.setAttribute("aria-pressed", String(next));
    event.currentTarget.textContent = `Live: ${next ? "on" : "paused"}`;
  });
  document.querySelector("#toggleListView").addEventListener("click", () => toggleListView());
  document.querySelector("#closeDrawerButton").addEventListener("click", () => activeDialog?.close());
  document.querySelector("#fleetSearch").addEventListener("input", (event) => { state.searchQuery = event.target.value; render(); });
  for (const chip of document.querySelectorAll(".fleet-chip")) {
    chip.addEventListener("click", () => {
      state.scope = chip.dataset.scope;
      for (const c of document.querySelectorAll(".fleet-chip")) c.setAttribute("aria-pressed", String(c === chip));
      render();
    });
  }
  document.querySelector("#incidentFilterOpen").addEventListener("click", () => setIncidentFilter("open"));
  document.querySelector("#incidentFilterResolved").addEventListener("click", () => setIncidentFilter("resolved"));

  poller = createPoller({
    fetchers: {
      live: () => api("/api/v1/fleet/live"),
      incidents: () => api(`/api/v1/fleet/incidents?status=${state.incidentFilter}`),
    },
    intervalMs: 20000,
    onData: (data) => {
      state.machines = data.live.machines;
      state.machinesById = new Map(state.machines.map((m) => [m.machine_id, m]));
      state.incidents = data.incidents.incidents;
      render();
    },
    onStateChange: ({ state: connectionState, lastGoodAt }) => {
      state.connectionState = connectionState;
      state.lastGoodAt = lastGoodAt;
      renderConnectionBanner();
    },
  });
  poller.start();
}

function setIncidentFilter(filter) {
  state.incidentFilter = filter;
  document.querySelector("#incidentFilterOpen").setAttribute("aria-pressed", String(filter === "open"));
  document.querySelector("#incidentFilterResolved").setAttribute("aria-pressed", String(filter === "resolved"));
  poller.refreshNow();
}

boot().catch((error) => {
  if (error instanceof ApiError) return;
  console.error("Talus fleet console failed to start", error);
  toast("The fleet console could not start. Reload the page.", { kind: "error", duration: 0 });
});
