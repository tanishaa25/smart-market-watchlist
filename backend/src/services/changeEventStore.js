// Persistent, deduplicated "change event" storage — Firestore-backed
// (kept as Firestore, not migrated to a relational DB). Implements
// Meridian's compute-on-write principle: the EXPENSIVE, user-independent
// raw signals for a (symbol, day) are written once and read back on
// every subsequent request that day — a real, permanent, deduplicated
// record, not a number computed fresh and thrown away on every request.
//
// WHAT'S DIFFERENT FROM A LITERAL READING OF MERIDIAN'S OWN SCHEMA, AND
// WHY: their change_events store a fully-computed, shared score. This
// app's final score is absence-scaled PER USER (daysAway) — which
// actually matches Meridian's OWN stated formula ("Score(E, W) for user
// u over absence window W"), just not their literal storage shape. So
// what's persisted here is the shared, user-independent RAW signal
// facts (volatility, volume ratio, 52-week extremum, regime, gap,
// catalyst, today's real price/change) — the expensive, deterministic-
// per-day part — and the final absence-scaled score is assembled per
// user at read time (see significanceService.js's assembleScore) by
// combining these stored facts with that user's own daysAway. This is
// the same "assembled from stored events, no re-computation" principle
// their read path describes, adapted for the one part of their own
// model that's genuinely per-user rather than shared.
//
// DEDUPLICATION: the Firestore document ID itself IS the dedup key
// (`{symbol}_{sessionBucket}`) — unlike SQL, which needs an explicit
// UNIQUE constraint, a deterministic document ID makes "insert or
// update the existing one" automatic; there's no way to accidentally
// create a second record for the same (symbol, session). The session
// bucket is tied to NSE's actual IST market open (see
// utils/marketHours.js's getSessionBucket) — not a raw UTC calendar
// date — so pre-market hours correctly attribute to the PREVIOUS day's
// session, matching how a real trading day is bounded.
//
// MERGE-ON-UPDATE: if a stock moves further later the same day,
// Meridian's spec says to keep the stronger reading rather than
// overwrite with a weaker one ("keep the max score, extend window,
// accumulate evidence"). This keeps whichever reading had the larger
// absolute price change so far today.
//
// HONEST NOTE ON WHAT THIS DOES AND DOESN'T SAVE: this app's raw-signal
// computation is a synthetic JS calculation, not a network call — it's
// already cheap, so this isn't primarily a performance optimization.
// The real value delivered here is the one Meridian's design is
// actually about: a genuine, permanent, queryable audit trail of what
// the app has flagged over time, deduplicated by day — which a
// recompute-and-discard-on-every-request model can never provide,
// regardless of how fast that recomputation is.

import { getFirestore } from "firebase-admin/firestore";
import { getSessionBucket } from "../utils/marketHours.js";

const CHANGE_EVENTS = "changeEvents";
const RETENTION_DAYS = 90; // matches Meridian's own retention window for their comparable time-series data

function eventDocId(symbol, dateBucket) {
  return `${symbol}_${dateBucket}`;
}

/**
 * Returns today's persisted raw-signal record for a symbol — creating
 * it (compute-on-write) if today's record doesn't exist yet, or
 * updating it if today's move is larger than whatever was recorded so
 * far today (the "keep the stronger reading" merge rule).
 *
 * @param {string} symbol
 * @param {() => object} computeFreshRawSignals - the caller's
 *   significanceService.computeRawSignals() call, invoked here (not by
 *   the caller directly) so this function controls exactly when a write
 *   happens.
 */
export async function getOrUpdateChangeEvent(symbol, computeFreshRawSignals) {
  const db = getFirestore();
  const dateBucket = getSessionBucket();
  const ref = db.collection(CHANGE_EVENTS).doc(eventDocId(symbol, dateBucket));

  const existing = await ref.get();
  const freshRawSignals = computeFreshRawSignals();

  if (!existing.exists) {
    const record = {
      symbol,
      dateBucket,
      firstComputedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      updateCount: 1,
      rawSignals: freshRawSignals,
    };
    await ref.set(record);
    return record;
  }

  const existingData = existing.data();
  const isStrongerReading =
    Math.abs(freshRawSignals.changePercent) > Math.abs(existingData.rawSignals.changePercent);

  const updated = {
    ...existingData,
    lastUpdatedAt: new Date().toISOString(),
    updateCount: (existingData.updateCount ?? 1) + 1,
    rawSignals: isStrongerReading ? freshRawSignals : existingData.rawSignals,
  };
  await ref.set(updated);
  return updated;
}

/**
 * The permanent audit trail this whole mechanism exists to provide:
 * "what did the app flag for this symbol, on which days" — a real
 * historical record, queryable after the fact, not something only
 * visible while it's fresh.
 *
 * Also lazily purges records older than RETENTION_DAYS for this symbol
 * — same "cleanup happens whenever someone looks, no scheduler needed"
 * pattern already used for the watchlist Trash (see db.js). Unbounded
 * growth is still a real operational concern even for small per-day
 * records, especially once multiplied across every symbol any user has
 * ever watched — this keeps that bounded without needing infrastructure
 * this app doesn't have (a cron job / scheduled function).
 */
export async function getChangeEventHistory(symbol, limit = 30) {
  const db = getFirestore();
  // Deliberately no .orderBy() here — combining a .where() equality
  // filter with .orderBy() on a DIFFERENT field requires a Firestore
  // composite index that doesn't exist by default in a fresh project,
  // and fails with an opaque error until you manually create one in the
  // console. Same "avoid composite-index requirements, sort in code
  // instead" pattern already used elsewhere in this app (see
  // getWatchlistForUser's deletedAt filtering) — small collections like
  // this don't need Firestore to do the sorting for us.
  const snap = await db.collection(CHANGE_EVENTS).where("symbol", "==", symbol).get();

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cutoffBucket = cutoff.toISOString().slice(0, 10);

  const kept = [];
  const expiredRefs = [];
  snap.docs.forEach((doc) => {
    const data = doc.data();
    if (data.dateBucket < cutoffBucket) {
      expiredRefs.push(doc.ref);
    } else {
      kept.push(data);
    }
  });

  if (expiredRefs.length > 0) {
    await Promise.all(expiredRefs.map((ref) => ref.delete()));
  }

  kept.sort((a, b) => (a.dateBucket < b.dateBucket ? 1 : -1)); // newest first
  return kept.slice(0, limit);
}
