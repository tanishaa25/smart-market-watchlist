// Adaptive circuit breaker: tracks each data source's REAL recent
// success rate and stops calling it once it's clearly failing, instead
// of blindly retrying every single request forever.
//
// WHY THIS MATTERS: this app's own logs showed NSE failing ~100% of the
// time (TLS fingerprint blocking) — yet without this, every single
// quote request still pays the latency cost of a cookie handshake +
// request attempt that's essentially guaranteed to fail, before falling
// through to Yahoo. This lets the app LEARN that pattern in real time
// and skip straight past a source that's currently dead, without any
// hardcoded assumption about which source is unreliable — if NSE started
// working tomorrow, or Yahoo started failing instead, this adapts
// automatically based on what's actually happening, not a fixed guess.
//
// Design: after CONSECUTIVE_FAILURE_THRESHOLD failures in a row for a
// given source, the circuit "opens" — calls are skipped entirely for
// COOLDOWN_MS. Once the cooldown expires, the next call is allowed
// through as an implicit trial: success closes the circuit (resume
// normal calls), failure re-opens it for another cooldown. No separate
// "half-open" bookkeeping needed — letting cooldown expiry itself gate
// the next attempt is simpler and just as correct.

const CONSECUTIVE_FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30 * 1000; // 30 seconds

const breakers = new Map(); // sourceName -> { consecutiveFailures, openUntil }

function getBreaker(name) {
  if (!breakers.has(name)) {
    breakers.set(name, { consecutiveFailures: 0, openUntil: 0 });
  }
  return breakers.get(name);
}

export function isCircuitOpen(name, now = Date.now()) {
  return now < getBreaker(name).openUntil;
}

export function recordSuccess(name) {
  const breaker = getBreaker(name);
  breaker.consecutiveFailures = 0;
  breaker.openUntil = 0;
}

export function recordFailure(name, now = Date.now()) {
  const breaker = getBreaker(name);
  breaker.consecutiveFailures++;
  if (breaker.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
    breaker.openUntil = now + COOLDOWN_MS;
  }
}

export function getBreakerStatus(name) {
  const breaker = getBreaker(name);
  return {
    open: isCircuitOpen(name),
    consecutiveFailures: breaker.consecutiveFailures,
    openUntil: breaker.openUntil ? new Date(breaker.openUntil).toISOString() : null,
  };
}

// Testing/reset helper — not used in production code paths.
export function _resetForTests(name) {
  breakers.delete(name);
}
