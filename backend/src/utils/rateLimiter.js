// App-level rate limiting — protects this app's OWN endpoints from being
// hammered (e.g. rapid repeated add/remove calls), independent of the
// per-provider circuit breaker (which protects against NSE/Yahoo/Finnhub
// being unreliable — a different concern entirely). In-memory, matching
// every other stateful pattern in this app (circuit breaker, TTL cache,
// watchlist events) — no Redis needed at this scale.
//
// Sliding window per key (by default, the authenticated user's ID, so
// one user's heavy usage can't block another user sharing the same IP).

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30;

const requestLog = new Map(); // key -> array of request timestamps within the current window

export function isRateLimited(key, now = Date.now()) {
  const timestamps = requestLog.get(key) ?? [];
  const recent = timestamps.filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    requestLog.set(key, recent); // still prune, even though we're rejecting this one
    return true;
  }

  recent.push(now);
  requestLog.set(key, recent);
  return false;
}

/**
 * Express middleware — applies the limiter keyed by the authenticated
 * user (req.userId, set by the `authenticate` middleware, which must
 * run first) so it protects per-account, not just per-IP.
 */
export function rateLimit(req, res, next) {
  const key = req.userId ?? req.ip;
  if (isRateLimited(key)) {
    return res.status(429).json({ error: "Too many requests — please slow down and try again shortly." });
  }
  next();
}

// Testing/reset helper — not used in production code paths.
export function _resetForTests(key) {
  requestLog.delete(key);
}
