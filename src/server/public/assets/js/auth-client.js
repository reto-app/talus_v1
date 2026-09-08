// Staff session storage + renewal. Replaces reliance on /ops/api/bootstrap:
// a session here always comes from a real POST /auth/login (or a sliding
// POST /auth/refresh), scoped to the staff member who signed in.
const STORAGE_KEY = "talus.staffSession";
const REFRESH_MARGIN_MS = 2 * 60 * 1000; // refresh 2 minutes before expiry

let refreshTimer = null;
const listeners = new Set();

export function getSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function isSessionValid(session = getSession()) {
  return !!session?.token && new Date(session.expiresAt).getTime() > Date.now();
}

export function saveSession(session) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* private mode etc. */ }
  scheduleRefresh();
  listeners.forEach((fn) => fn(session));
}

export function clearSession() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  if (refreshTimer) clearTimeout(refreshTimer);
  listeners.forEach((fn) => fn(null));
}

export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function authHeaders(extra = {}) {
  const session = getSession();
  if (!session) return extra;
  return {
    authorization: `Bearer ${session.token}`,
    "x-tenant-id": session.tenantId,
    "x-actor-kind": "staff",
    "x-actor-id": session.principalId,
    ...extra,
  };
}

export function redirectToLogin(reason) {
  clearSession();
  const returnTo = encodeURIComponent(location.pathname + location.search);
  const reasonParam = reason ? `&reason=${encodeURIComponent(reason)}` : "";
  location.href = `/login?returnTo=${returnTo}${reasonParam}`;
}

export function requireSession() {
  const session = getSession();
  if (!isSessionValid(session)) {
    redirectToLogin(session ? "expired" : undefined);
    return null;
  }
  scheduleRefresh();
  return session;
}

async function refreshNow() {
  const session = getSession();
  if (!session) return;
  try {
    const response = await fetch("/auth/refresh", { method: "POST", headers: authHeaders() });
    if (!response.ok) throw new Error("refresh_failed");
    const body = await response.json();
    saveSession({ ...session, token: body.token, expiresAt: body.expiresAt });
  } catch {
    // Leave the existing (still-valid-for-now) session in place; the next
    // authenticated request that 401s will send the operator to /login with
    // a clear session-expired reason instead of silently failing here.
  }
}

export function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const session = getSession();
  if (!session) return;
  const msUntilRefresh = Math.max(2000, new Date(session.expiresAt).getTime() - Date.now() - REFRESH_MARGIN_MS);
  refreshTimer = setTimeout(refreshNow, msUntilRefresh);
}

export async function logout() {
  try { await fetch("/auth/logout", { method: "POST", headers: authHeaders() }); } catch { /* best-effort */ }
  redirectToLogin();
}
