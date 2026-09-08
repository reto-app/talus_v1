// Small inline-SVG icon set. Vendored locally (no CDN) so a third-party
// outage never breaks icon-only controls. Every icon is 24x24 viewBox,
// stroke-based, currentColor -- callers set color via CSS.
const PATHS = {
  map: '<path d="M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2Z"/><path d="M9 3v16M15 5v16"/>',
  "clipboard-list": '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 10h6M9 14h6M9 18h3"/>',
  "calendar-range": '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/><path d="M8 15h2M14 15h2"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.8-.6-.6-2.8Z"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9" r="2.6"/><path d="M15.5 13.2a5.3 5.3 0 0 1 6 5.3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V19a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H5a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H11a1.7 1.7 0 0 0 1-1.5V5a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V11a1.7 1.7 0 0 0 1.5 1H19a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  "car-front": '<path d="M5 17h14M5 17a2 2 0 1 1-4 0v-3l2-5a3 3 0 0 1 2.8-2h8.4A3 3 0 0 1 17 9l2 5v3a2 2 0 1 1-4 0"/><path d="M7 7l-1 4h12l-1-4"/><circle cx="7.5" cy="17" r="0" /><path d="M4 12h16"/>',
  "shield-check": '<path d="M12 3 4 6v6c0 5 3.4 7.8 8 9 4.6-1.2 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  "circle-dollar-sign": '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1-3 2.3 1.3 1.9 3 2.2 3 .9 3 2.2-1.3 2.3-3 2.3-3-1.1-3-2.5"/>',
  "corner-down-left": '<path d="M20 4v6a4 4 0 0 1-4 4H5"/><path d="m9 10-4 4 4 4"/>',
  "badge-check": '<path d="m12 2 2.4 1.3 2.7-.3 1.3 2.4 2.4 1.3-.3 2.7 1.3 2.4-1.6 2.2.3 2.7-2.6.9-1.6 2.2-2.7-.5L12 22l-2.2-1.7-2.7.5-1.6-2.2-2.6-.9.3-2.7L1.6 12.6 3 10.4l-.3-2.7L4 5.3l2.7.3L9.6 3.3 12 2Z"/><path d="m9 12 2 2 4-4"/>',
  "refresh-cw": '<path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"/><path d="M3 21v-5h5M21 3v5h-5"/>',
  "map-pin": '<path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  "calendar-days": '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/><path d="M7 13h.01M12 13h.01M17 13h.01M7 17h.01M12 17h.01"/>',
  "calendar-x": '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/><path d="m9.5 13.5 5 5m0-5-5 5"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  "key-round": '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7 2 2-1.5 1.5 2 2-2.3 2.3-2-2-2.4 2.4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  "file-signature": '<path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/><path d="m15.5 15.5 3-3 1.5 1.5-3 3H15.5v-1.5Z"/><path d="M15 20c1.5-1.5 3 1.5 4.5 0"/>',
  "credit-card": '<rect x="2.5" y="5.5" width="19" height="13" rx="2"/><path d="M2.5 10h19"/><path d="M6 15h4"/>',
  "clipboard-check": '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="m9.5 13 1.8 1.8L14.5 11"/>',
  "terminal-square": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m8 10 3 2-3 2"/><path d="M13 14h3"/>',
  "alert-triangle": '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4"/><path d="M12 17.5h.01"/>',
  siren: '<path d="M12 3a5 5 0 0 1 5 5v6H7V8a5 5 0 0 1 5-5Z"/><path d="M5 19a7 7 0 0 1 14 0"/><path d="M12 3V1M4 8H2M22 8h-2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4L4 5Z"/>',
  satellite: '<path d="m13 7 4 4-1.5 1.5-4-4L13 7Z"/><path d="m17 11 3 3-2 2-3-3"/><path d="m7.5 12.5-4 4 2 2 4-4"/><path d="m9 3 2 2-3 3-2-2 3-3Z"/>',
  road: '<path d="M8 3 4 21M16 3l4 18M12 3v3M12 10v3M12 17v3"/>',
  battery: '<rect x="2" y="8" width="18" height="8" rx="2"/><path d="M22 11v2"/><path d="M6 11v2"/>',
  fuel: '<path d="M4 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15"/><path d="M4 11h8"/><path d="M14 8h1.5L19 11v6a2 2 0 0 1-2 2h-.5"/><circle cx="17" cy="16" r=".01"/><path d="M2 21h14"/>',
  gauge: '<circle cx="12" cy="13" r="8"/><path d="M12 13 15 9"/><path d="M8 6l1-2M16 6l-1-2"/>',
  phone: '<path d="M6.5 3h3l1.5 5-2 1.5a12 12 0 0 0 5.5 5.5L16 13l5 1.5v3a2 2 0 0 1-2.2 2C10 19 5 14 4.5 5.2A2 2 0 0 1 6.5 3Z"/>',
  logout: '<path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  "circle-x": '<circle cx="12" cy="12" r="9"/><path d="m9.5 9.5 5 5m0-5-5 5"/>',
  "wifi-off": '<path d="M2 8.8a16 16 0 0 1 4-2.5M22 8.8a16 16 0 0 0-6.4-3.4M6.4 12.2a10 10 0 0 1 4.8-2M17.6 12.2a10 10 0 0 0-2.8-1.8"/><path d="M9.5 16a5 5 0 0 1 5 0"/><path d="M12 20h.01"/><path d="M2 2l20 20"/>',
  "pause-circle": '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  crosshair: '<circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="14" r="3.5"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
};

export function iconMarkup(name, { size = 18 } = {}) {
  const path = PATHS[name];
  if (!path) return "";
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export function setIcon(el, name, opts) {
  if (!el) return;
  el.innerHTML = iconMarkup(name, opts);
}
