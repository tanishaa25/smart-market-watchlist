// Generic short-TTL in-memory cache — applies the same "N requests, one
// real fetch" principle already used for external price APIs to the
// app's OWN Firestore reads. Rapid reloads, accidental double-clicks, or
// several requests landing close together shouldn't each pay a real
// database read when the data was just fetched a moment ago.
//
// Kept intentionally generic (not tied to watchlists specifically) so
// it's independently testable with injectable time, same pattern as
// circuitBreaker.js and marketHours.js.

export function createTtlCache(ttlMs) {
  const store = new Map(); // key -> { value, fetchedAt }

  return {
    get(key, now = Date.now()) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (now - entry.fetchedAt >= ttlMs) {
        store.delete(key); // expired — clean up rather than leaving stale entries around
        return undefined;
      }
      return entry.value;
    },
    set(key, value, now = Date.now()) {
      store.set(key, { value, fetchedAt: now });
    },
    invalidate(key) {
      store.delete(key);
    },
  };
}
