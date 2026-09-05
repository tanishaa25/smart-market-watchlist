// Frozen-quote detection: tracks the last N REAL (non-simulated) price
// observations per symbol, and flags a quote as "frozen" if the VALUE
// itself hasn't changed for 10+ minutes — a real data-quality problem,
// distinct from simple staleness. A timestamp can look fresh (the
// provider answered just now) while still serving the same cached
// number it hasn't actually refreshed — this catches that case
// specifically, by watching the number itself, not just the clock.
//
// This feeds a genuine penalty into the significance score (see
// significanceService.js), not just a cosmetic UI color: if the current
// price can't be trusted to reflect what's actually happening right
// now, price-derived signals (the z-score move, the gap) shouldn't be
// allowed to drive the score.

const FROZEN_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const MAX_HISTORY_PER_SYMBOL = 40; // generous headroom above what 10 minutes of polling would produce

const priceHistory = new Map(); // symbol -> [{ price, at }], oldest first

export function recordRealPrice(symbol, price, atMs = Date.now()) {
  const clean = symbol.trim().toUpperCase();
  const history = priceHistory.get(clean) ?? [];
  history.push({ price, at: atMs });
  while (history.length > MAX_HISTORY_PER_SYMBOL) history.shift();
  priceHistory.set(clean, history);
}

/**
 * Returns true if this symbol's real price has held the exact same
 * value for at least FROZEN_THRESHOLD_MS, measured as the duration of
 * the unbroken run of identical prices ending at the most recent sample
 * — not "any 10-minute window," but "how long has it actually been
 * stuck at this exact number."
 */
export function isFrozen(symbol) {
  const clean = symbol.trim().toUpperCase();
  const history = priceHistory.get(clean);
  if (!history || history.length < 2) return false;

  const latest = history[history.length - 1];
  let streakStart = latest;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].price !== latest.price) break;
    streakStart = history[i];
  }

  const streakDurationMs = latest.at - streakStart.at;
  return streakDurationMs >= FROZEN_THRESHOLD_MS;
}

// Testing/reset helper — not used in production code paths.
export function _resetForTests(symbol) {
  priceHistory.delete(symbol.trim().toUpperCase());
}
