// In local dev, Vite's dev-server proxy forwards "/api" to the backend
// (see vite.config.js) — no configuration needed. In a production build
// (no dev server, no proxy), set VITE_API_BASE_URL at build time to the
// real backend URL (e.g. https://your-backend.onrender.com/api) — see
// deployment notes in README.md.
const BASE = import.meta.env.VITE_API_BASE_URL || "/api";

const TOKEN_KEY = "watchlist_auth_token";
const EMAIL_KEY = "watchlist_user_email";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredEmail() {
  return localStorage.getItem(EMAIL_KEY) || "";
}

function setSession(token, email) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EMAIL_KEY, email);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Registered by App.jsx so a 401 on any protected call (session expired,
// token invalid) can drop the user back to the login screen from
// anywhere, without every call site needing to know how to do that.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function handle(res) {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // ignore parse error, use default message
    }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Used for calls that require a valid session — treats a 401 as "your
// session ended," not just "this one request failed."
async function handleProtected(res) {
  if (res.status === 401) onUnauthorized();
  return handle(res);
}

// --- Auth --------------------------------------------------------------

export async function register(email, password) {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await handle(res); // a 401/409 here is a normal form error, not a session issue
  setSession(data.token, data.user.email);
  return data;
}

export async function login(email, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await handle(res);
  setSession(data.token, data.user.email);
  return data;
}

export function logout() {
  clearSession();
}

// Anonymous-first auth: called silently by App.jsx on first load when no
// session exists yet — real value before any signup, never a login wall.
export async function startAnonymousSession() {
  const res = await fetch(`${BASE}/auth/anonymous`, { method: "POST" });
  const data = await handle(res);
  setSession(data.token, ""); // no email yet — this session is anonymous
  return data;
}

// Attaches email+password to the CURRENT session in place — same
// watchlists, same everything, now also loginable by email elsewhere.
export async function upgradeAccount(email, password) {
  const res = await fetch(`${BASE}/auth/upgrade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ email, password }),
  });
  const data = await handleProtected(res);
  localStorage.setItem(EMAIL_KEY, data.user.email); // keep the token, just attach the email now
  return data;
}

export async function fetchSensitivity() {
  const res = await fetch(`${BASE}/profile`, { headers: authHeaders() });
  return handleProtected(res);
}

export async function updateSensitivity(sensitivity) {
  const res = await fetch(`${BASE}/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ sensitivity }),
  });
  return handleProtected(res);
}

// --- Watchlist (protected) -----------------------------------------------

export async function fetchWatchlist(listId = "default") {
  const res = await fetch(`${BASE}/watchlist?listId=${encodeURIComponent(listId)}`, {
    headers: authHeaders(),
  });
  return handleProtected(res);
}

export async function addSymbol(symbol, note, listId = "default") {
  const res = await fetch(`${BASE}/watchlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ symbol, note, listId }),
  });
  return handleProtected(res);
}

export async function fetchLists() {
  const res = await fetch(`${BASE}/lists`, { headers: authHeaders() });
  return handleProtected(res);
}

export async function createList(name) {
  const res = await fetch(`${BASE}/lists`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  return handleProtected(res);
}

export async function renameList(listId, name) {
  const res = await fetch(`${BASE}/lists/${encodeURIComponent(listId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  return handleProtected(res);
}

export async function deleteList(listId) {
  const res = await fetch(`${BASE}/lists/${encodeURIComponent(listId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return handleProtected(res);
}

export async function reorderList(listId, direction) {
  const res = await fetch(`${BASE}/lists/${encodeURIComponent(listId)}/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ direction }),
  });
  return handleProtected(res);
}

export async function removeSymbol(symbol) {
  const res = await fetch(`${BASE}/watchlist/${encodeURIComponent(symbol)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return handleProtected(res);
}

// Acknowledges the current significance flag for a stock — cross-device
// by construction, since it's a server-side write, not local storage.
export async function markReviewed(symbol) {
  const res = await fetch(`${BASE}/watchlist/${encodeURIComponent(symbol)}/review`, {
    method: "POST",
    headers: authHeaders(),
  });
  return handleProtected(res);
}

export async function fetchTrash() {
  const res = await fetch(`${BASE}/watchlist/trash`, { headers: authHeaders() });
  return handleProtected(res);
}

export async function restoreSymbol(symbol) {
  const res = await fetch(`${BASE}/watchlist/${encodeURIComponent(symbol)}/restore`, {
    method: "POST",
    headers: authHeaders(),
  });
  return handleProtected(res);
}

// EventSource can't set custom headers, so the token travels as a query
// param for this one connection instead of an Authorization header.
export function streamUrl() {
  return `${BASE}/stream?token=${encodeURIComponent(getToken() || "")}`;
}

// Explicit dismissal of the "Since You Were Away" briefing modal —
// advances a real server-side anchor (see routes/briefing.js), not just
// local component state, so it's a genuine cross-device acknowledgement.
export async function markBriefingOpened() {
  const res = await fetch(`${BASE}/briefing/opened`, {
    method: "POST",
    headers: authHeaders(),
  });
  return handleProtected(res);
}

// The audit trail changeEventStore.js persists server-side — what this
// app has flagged for a stock, day by day.
export async function fetchStockHistory(symbol) {
  const res = await fetch(`${BASE}/watchlist/${encodeURIComponent(symbol)}/history`, {
    headers: authHeaders(),
  });
  return handleProtected(res);
}

export async function fetchStockDetail(symbol) {
  const res = await fetch(`${BASE}/watchlist/${encodeURIComponent(symbol)}/detail`, {
    headers: authHeaders(),
  });
  return handleProtected(res);
}

// --- Public market data (no auth needed) ----------------------------------

export async function fetchStocks(query = "") {
  const url = query ? `${BASE}/stocks?query=${encodeURIComponent(query)}` : `${BASE}/stocks`;
  const res = await fetch(url);
  return handle(res);
}

export async function fetchQuotes(symbols) {
  if (symbols.length === 0) return { quotes: [] };
  const res = await fetch(`${BASE}/quotes?symbols=${symbols.map(encodeURIComponent).join(",")}`);
  return handle(res);
}
