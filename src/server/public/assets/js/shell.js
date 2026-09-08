import { authHeaders, redirectToLogin } from "./auth-client.js";
import { iconMarkup } from "./icons.js";

/* ---------------------------------------------------------------------- *
 * Safe DOM construction. Every render function in the app builds elements
 * with this instead of innerHTML-ing server data, so a customer name, alert
 * message, or API error can never execute as HTML.
 * ---------------------------------------------------------------------- */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "html") el.innerHTML = value; // only ever passed a local icon/static string, never server data
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null || child === false) continue;
    el.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return el;
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
export function replaceChildren(el, nodes) { clear(el); for (const n of nodes) el.appendChild(n); }
export function icon(name, opts) { const span = h("span", { class: "talus-icon", "aria-hidden": "true" }); span.innerHTML = iconMarkup(name, opts); return span; }

/* ---------------------------------------------------------------------- *
 * Formatting
 * ---------------------------------------------------------------------- */
export function formatCurrency(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(cents) / 100);
}
export function formatDateTime(value, options) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...options }).format(new Date(value));
}
export function formatElapsed(value) {
  if (!value) return "No recent signal";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
export function startClock(target, { live = true } = {}) {
  const render = () => { target.textContent = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: live ? "2-digit" : undefined }).format(new Date()); };
  render();
  return setInterval(render, 1000);
}

/* ---------------------------------------------------------------------- *
 * API client: attaches staff auth headers, redirects to /login on 401,
 * and normalizes errors to {status, code, message}.
 * ---------------------------------------------------------------------- */
export class ApiError extends Error {
  constructor(status, code, message) { super(message || code || `Request failed (${status})`); this.status = status; this.code = code; }
}
export async function api(path, { method = "GET", body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: authHeaders(body ? { "content-type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (networkError) {
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the Talus server. Check your connection.");
  }
  if (response.status === 401) {
    redirectToLogin("expired");
    throw new ApiError(401, "SESSION_EXPIRED", "Your session expired.");
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new ApiError(response.status, data.code, data.message || data.code);
  return data;
}

/* ---------------------------------------------------------------------- *
 * Toasts
 * ---------------------------------------------------------------------- */
let toastRegion = null;
export function toast(message, { kind = "info", duration = 5000 } = {}) {
  if (!toastRegion) {
    toastRegion = h("div", { class: "talus-toast-region", role: "status", "aria-live": "polite" });
    document.body.appendChild(toastRegion);
  }
  const node = h("div", { class: `talus-toast${kind === "error" ? " is-error" : kind === "success" ? " is-success" : ""}` }, [
    h("span", {}, message),
    h("button", { type: "button", "aria-label": "Dismiss", onclick: () => node.remove() }, "×"),
  ]);
  toastRegion.appendChild(node);
  if (duration) setTimeout(() => node.remove(), duration);
  return node;
}

/* ---------------------------------------------------------------------- *
 * Focus-trapped dialog/drawer helper.
 * ---------------------------------------------------------------------- */
const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';
export function openDialog(panelEl, { onClose } = {}) {
  const trigger = document.activeElement;
  const backdrop = h("div", { class: "talus-dialog-backdrop", onclick: () => close() });
  document.body.appendChild(backdrop);
  panelEl.hidden = false;
  // Deliberately NOT reparenting panelEl to <body>: a drawer that lives in
  // static HTML (e.g. the fleet map's vehicle drawer) relies on CSS scoped
  // to its original container to stay contained within that region instead
  // of covering sibling panels. Callers building a panel from scratch
  // (e.g. a confirmation modal) are responsible for placing it in the DOM
  // themselves before calling openDialog.
  const previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  function focusableEls() { return [...panelEl.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null); }
  const first = focusableEls()[0];
  (first || panelEl).focus({ preventScroll: true });

  function onKeydown(event) {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab") return;
    const els = focusableEls();
    if (!els.length) return;
    const firstEl = els[0]; const lastEl = els[els.length - 1];
    if (event.shiftKey && document.activeElement === firstEl) { event.preventDefault(); lastEl.focus(); }
    else if (!event.shiftKey && document.activeElement === lastEl) { event.preventDefault(); firstEl.focus(); }
  }
  panelEl.addEventListener("keydown", onKeydown);

  function close() {
    panelEl.removeEventListener("keydown", onKeydown);
    panelEl.hidden = true;
    backdrop.remove();
    document.body.style.overflow = previousBodyOverflow;
    if (trigger && document.contains(trigger)) trigger.focus();
    onClose?.();
  }
  return { close };
}

/* ---------------------------------------------------------------------- *
 * Shared navigation shell
 * ---------------------------------------------------------------------- */
const NAV_ITEMS = [
  { group: "OPERATIONS", href: "/fleet", label: "Live Fleet", iconName: "map", key: "fleet" },
  { group: "OPERATIONS", href: "/ops", label: "Dispatch Board", iconName: "clipboard-list", key: "ops" },
  { group: "OPERATIONS", label: "Reservations", iconName: "calendar-range", disabled: true },
  { group: "MANAGEMENT", label: "Fleet & Service", iconName: "wrench", disabled: true },
  { group: "MANAGEMENT", label: "Customers", iconName: "users", disabled: true },
  { group: "MANAGEMENT", label: "Settings", iconName: "settings", disabled: true },
];
const TAB_ITEMS = [
  { href: "/fleet", label: "Map", iconName: "map", key: "fleet-map" },
  { href: "/fleet#fleet-list", label: "Fleet", iconName: "car-front", key: "fleet-list" },
  { href: "/fleet#incidents", label: "Incidents", iconName: "siren", key: "incidents" },
  { href: "/ops", label: "Dispatch", iconName: "clipboard-list", key: "ops" },
];

export function renderNav({ activeKey, tenantDisplayName, connectionState = "connected" }) {
  const groups = new Map();
  for (const item of NAV_ITEMS) { if (!groups.has(item.group)) groups.set(item.group, []); groups.get(item.group).push(item); }

  const groupNodes = [...groups.entries()].map(([group, items]) => h("div", { class: "talus-nav-group" }, [
    h("div", { class: "talus-nav-label" }, group),
    ...items.map((item) => item.disabled
      ? h("span", { class: "talus-nav-item is-disabled", "aria-disabled": "true" }, [icon(item.iconName), h("span", {}, item.label), h("span", { class: "talus-soon" }, "Soon")])
      : h("a", { class: "talus-nav-item", href: item.href, "aria-current": item.key === activeKey ? "page" : undefined }, [icon(item.iconName), h("span", {}, item.label)])),
  ]));

  const dotClass = connectionState === "connected" ? "" : connectionState === "degraded" ? " is-degraded" : " is-offline";
  const connectionLabel = connectionState === "connected" ? "Telemetry link up" : connectionState === "degraded" ? "Updates interrupted" : "Offline";

  return h("nav", { class: "talus-nav", "aria-label": "Primary" }, [
    h("a", { class: "talus-brand", href: "/fleet" }, [
      h("img", { src: "/assets/talus-logo.png", alt: "Talus logo", width: "40", height: "40" }),
      h("span", { class: "talus-brand-copy" }, [h("b", { class: "talus-condensed" }, "TALUS"), h("small", {}, "FLEET OS")]),
    ]),
    ...groupNodes,
    h("div", { class: "talus-nav-spacer" }),
    h("div", { class: "talus-nav-footer" }, [
      h("span", { class: `talus-connection-dot${dotClass}` }),
      h("span", {}, connectionLabel),
      h("div", { class: "talus-nav-footer-copy", style: "margin-top:6px" }, tenantDisplayName || "Loading tenant…"),
    ]),
  ]);
}

export function renderTabBar({ activeKey }) {
  return h("nav", { class: "talus-tabbar", "aria-label": "Primary" }, [
    h("div", { class: "talus-tabbar-list" }, TAB_ITEMS.map((item) =>
      h("a", { class: "talus-tabbar-item", href: item.href, "aria-current": item.key === activeKey ? "page" : undefined }, [icon(item.iconName, { size: 20 }), h("span", {}, item.label)]))),
  ]);
}

/* ---------------------------------------------------------------------- *
 * Polling manager: keeps the last successfully loaded payload on failure
 * and reports connection state instead of clearing valid data.
 * ---------------------------------------------------------------------- */
export function createPoller({ fetchers, intervalMs = 20000, onData, onStateChange }) {
  let timer = null;
  let running = false;
  let lastGoodAt = null;
  let auto = true;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const entries = Object.entries(fetchers);
      const results = await Promise.all(entries.map(([, fn]) => fn()));
      const data = Object.fromEntries(entries.map(([key], index) => [key, results[index]]));
      lastGoodAt = new Date();
      onData(data);
      onStateChange({ state: "connected", lastGoodAt });
    } catch (error) {
      onStateChange({ state: lastGoodAt ? "degraded" : "offline", lastGoodAt, error });
    } finally {
      running = false;
    }
  }

  function start() { tick(); timer = setInterval(() => { if (auto) tick(); }, intervalMs); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function refreshNow() { return tick(); }
  function setAuto(value) { auto = value; }
  function isAuto() { return auto; }

  return { start, stop, refreshNow, setAuto, isAuto, get lastGoodAt() { return lastGoodAt; } };
}
