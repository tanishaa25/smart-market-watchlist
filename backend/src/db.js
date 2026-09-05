// Persistence layer — Cloud Firestore, via the Firebase Admin SDK.
//
// SETUP REQUIRED (this app cannot run without it):
//   1. Create a Firebase project at https://console.firebase.google.com
//   2. Enable Firestore (Build > Firestore Database > Create database).
//   3. Project settings > Service accounts > Generate new private key.
//      This downloads a JSON file — keep it out of version control.
//   4. Point the app at it one of two ways (see .env.example):
//        GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json
//      or, if you can't use a file (e.g. some hosting platforms):
//        FIREBASE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'
//
// DATA MODEL:
//   users/{email}                          <- doc id is the lowercased email
//     { email, passwordHash, passwordSalt, createdAt }
//   users/{email}/watchlist/{symbol}       <- doc id is the ticker symbol
//     { symbol, note, addedAt, lastSeenPrice, lastSeenAt, lastSeenProvider,
//       reviewedBucket, reviewedAt, deletedAt }
//
// "lastSeenPrice" / "lastSeenAt" are exactly the mechanism the "since you
// last checked" diff (routes/watchlist.js) is built on: the price at the
// moment we last considered the user to have "checked in," so a later
// load can show how far the price has moved since then. Because this
// lives in Firestore (not browser storage), it's already cross-device by
// construction — checking a stock on your phone updates the same record
// your laptop reads next.
//
// "reviewedBucket" / "reviewedAt" extend that same cross-device principle
// to significance alerts specifically: once a user acknowledges a
// "Notable"/"Needs Attention" flag (on any device), it's recorded here,
// so it stops showing as new everywhere — not just on the device that
// saw it first.
//
// "deletedAt" implements soft-delete: removing a stock sets this instead
// of actually deleting the document, giving a restore window (see
// TRASH_RETENTION_DAYS below) before it's gone for good.

import fs from "node:fs";
import crypto from "node:crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createTtlCache } from "./utils/ttlCache.js";
import { isValidSymbolFormat } from "./utils/symbolValidation.js";

function initFirebaseApp() {
  if (getApps().length > 0) return;

  const inlineKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  let credentials;
  if (inlineKey) {
    credentials = JSON.parse(inlineKey);
  } else if (keyPath && fs.existsSync(keyPath)) {
    credentials = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  } else {
    throw new Error(
      "Firestore isn't configured. Set GOOGLE_APPLICATION_CREDENTIALS (path to your service account JSON) " +
        "or FIREBASE_SERVICE_ACCOUNT_KEY (the JSON itself) in backend/.env — see the comment at the top of db.js."
    );
  }

  initializeApp({ credential: cert(credentials) });
}

initFirebaseApp();
const db = getFirestore();

const USERS = "users";
const WATCHLIST = "watchlist";
const LISTS = "lists";
const DEFAULT_LIST_ID = "default";

// Short-lived cache for watchlist reads — the same "one real fetch per
// window, no matter how many requests ask" principle already used for
// external price APIs (NSE/Yahoo/Finnhub), applied here to the app's own
// database reads. Rapid reloads or several requests landing close
// together (e.g. the dashboard's initial load plus an immediate
// re-check) shouldn't each cost a real Firestore read. Invalidated
// explicitly on every write so nobody ever sees stale data after their
// own action — see the various write functions below.
const WATCHLIST_CACHE_TTL_MS = 8000;
const watchlistCache = createTtlCache(WATCHLIST_CACHE_TTL_MS);

// A cap on stocks per watchlist — without one, a single user could hold
// open unlimited real-time subscriptions and trigger unbounded per-stock
// work (significance scoring, sparkline generation, AI explanations) on
// every request, degrading the shared backend for every other user too.
// Real broker platforms enforce similar caps for the same reason.
const MAX_WATCHLIST_SIZE = 50;

function docIdForEmail(email) {
  return email.trim().toLowerCase();
}

// --- Users -----------------------------------------------------------------

export async function createUser(email, passwordHash, passwordSalt) {
  const id = docIdForEmail(email);
  const ref = db.collection(USERS).doc(id);

  const existing = await ref.get();
  if (existing.exists) {
    const err = new Error("An account with that email already exists.");
    err.code = "DUPLICATE";
    throw err;
  }

  const createdAt = new Date().toISOString();
  await ref.set({ email: id, passwordHash, passwordSalt, isAnonymous: false, createdAt });
  return { id, email: id };
}

// Anonymous-first auth: creates a fully-functional account with no
// email/password at all — a device gets real value immediately, with
// signup offered later as an upgrade, never a gate. The doc ID here is
// a random string, not an email — every other function in this file
// (and every route built on top of it) already treats `userId` as an
// opaque path segment, so this needs zero changes anywhere else.
export async function createAnonymousUser() {
  const id = `anon_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
  const createdAt = new Date().toISOString();
  await db
    .collection(USERS)
    .doc(id)
    .set({ email: null, passwordHash: null, passwordSalt: null, isAnonymous: true, createdAt });
  return { id, isAnonymous: true };
}

/**
 * Attaches an email + password to an EXISTING anonymous account,
 * upgrading it in place — same document ID, same watchlists, same
 * everything, just now loginable by email from another device. Because
 * this doesn't move any data to a new doc, every list/item/history
 * record the anonymous session already created is preserved automatically.
 */
export async function upgradeAnonymousUser(userId, email, passwordHash, passwordSalt) {
  const cleanEmail = email.trim().toLowerCase();
  const existingWithEmail = await findUserByEmail(cleanEmail);
  if (existingWithEmail) {
    const err = new Error("An account with that email already exists.");
    err.code = "DUPLICATE";
    throw err;
  }

  const ref = db.collection(USERS).doc(userId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error("Session not found.");
    err.code = "NOT_FOUND";
    throw err;
  }

  await ref.update({ email: cleanEmail, passwordHash, passwordSalt, isAnonymous: false });
  return { id: userId, email: cleanEmail };
}

// A query, not a direct doc-ID lookup — necessary because an upgraded
// anonymous account keeps its ORIGINAL random doc ID forever (see
// upgradeAnonymousUser above), so its email won't match its doc ID the
// way a normal signup's does. Backward-compatible with existing normal
// accounts too, since createUser already stores `email` as a real field
// (not just as the doc ID), not a new requirement introduced here.
export async function findUserByEmail(email) {
  const cleanEmail = email.trim().toLowerCase();
  const snap = await db.collection(USERS).where("email", "==", cleanEmail).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

export async function findUserById(id) {
  const snap = await db.collection(USERS).doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

// Sensitivity profile ("calm" | "balanced" | "active") scales how much
// has to happen before the "Since You Were Away" briefing interrupts
// the user — see significanceService.js's meetsBriefingThreshold. Badges
// and history stay identical regardless of this setting; only the
// briefing trigger shifts.
export async function updateSensitivity(userId, sensitivity) {
  if (!["calm", "balanced", "active"].includes(sensitivity)) {
    throw new Error("Invalid sensitivity value");
  }
  await db.collection(USERS).doc(userId).update({ sensitivity });
}

// Records that the user explicitly dismissed the "Since You Were Away"
// briefing — a real, server-side, cross-device anchor, matching how
// every other "have I seen this" concept in this app works
// (reviewedBucket, lastSeenAt), not just client-side session state.
export async function updateLastBriefingOpened(userId, openedAtIso) {
  await db.collection(USERS).doc(userId).update({ lastBriefingOpenedAt: openedAtIso });
}

// --- Named Watchlists --------------------------------------------------------
//
// A user can organize their stocks into multiple named lists ("Long-term
// holds", "Earnings plays") — list metadata lives in its own collection;
// each item in the existing WATCHLIST collection just carries a `listId`
// field (see above). A symbol still lives in exactly one list at a time
// (see addToWatchlist's comment) — a deliberate scope decision that
// avoids redesigning every other route's :symbol-based doc-ID scheme.

export async function getListsForUser(userId) {
  const snap = await db.collection(USERS).doc(userId).collection(LISTS).get();
  let lists = snap.docs.map((d) => d.data());

  if (lists.length === 0) {
    // Every user always has at least one list — auto-create the default
    // on first access rather than requiring an explicit setup step, so
    // existing behavior (one flat list) keeps working with zero
    // migration needed for anyone using the app before this feature existed.
    const defaultList = { id: DEFAULT_LIST_ID, name: "My Watchlist", position: 0, createdAt: new Date().toISOString() };
    await db.collection(USERS).doc(userId).collection(LISTS).doc(DEFAULT_LIST_ID).set(defaultList);
    lists = [defaultList];
  }

  lists.sort((a, b) => a.position - b.position);
  return lists;
}

export async function createList(userId, name) {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("List name is required");

  const existingLists = await getListsForUser(userId);
  const id = `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const position = existingLists.length ? Math.max(...existingLists.map((l) => l.position)) + 1 : 0;

  const list = { id, name: trimmedName, position, createdAt: new Date().toISOString() };
  await db.collection(USERS).doc(userId).collection(LISTS).doc(id).set(list);
  return list;
}

export async function renameList(userId, listId, name) {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("List name is required");
  await db.collection(USERS).doc(userId).collection(LISTS).doc(listId).update({ name: trimmedName });
}

/**
 * Deletes a list. Refuses to delete the user's only remaining list — an
 * account must always have somewhere for a newly-added stock to go.
 * Any items still in the deleted list are soft-deleted (sent to Trash,
 * same as removing them individually) rather than silently orphaned.
 */
export async function deleteList(userId, listId) {
  const lists = await getListsForUser(userId);
  if (lists.length <= 1) {
    const err = new Error("You need at least one watchlist — create another before deleting this one.");
    err.code = "LAST_LIST";
    throw err;
  }

  const itemsInList = await getWatchlistForUser(userId, listId);
  await Promise.all(
    itemsInList.map((item) =>
      db.collection(USERS).doc(userId).collection(WATCHLIST).doc(item.symbol).update({ deletedAt: new Date().toISOString() })
    )
  );
  watchlistCache.invalidate(userId);

  await db.collection(USERS).doc(userId).collection(LISTS).doc(listId).delete();
}

/**
 * Reorders a list by swapping its position with the adjacent list in
 * the given direction — a simple, reliable alternative to full
 * drag-and-drop that still satisfies "reorder" functionally.
 */
export async function reorderList(userId, listId, direction) {
  const lists = await getListsForUser(userId);
  const index = lists.findIndex((l) => l.id === listId);
  if (index === -1) return null;

  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= lists.length) return lists; // already at the edge — no-op, not an error

  const current = lists[index];
  const swapWith = lists[swapIndex];

  await Promise.all([
    db.collection(USERS).doc(userId).collection(LISTS).doc(current.id).update({ position: swapWith.position }),
    db.collection(USERS).doc(userId).collection(LISTS).doc(swapWith.id).update({ position: current.position }),
  ]);

  return getListsForUser(userId);
}

// --- Watchlist ---------------------------------------------------------------

const TRASH_RETENTION_DAYS = 7;

export async function getWatchlistForUser(userId, listId = DEFAULT_LIST_ID) {
  // Caches the user's FULL item set (across every list), not per-list —
  // keeps every existing cache-invalidation call site elsewhere in this
  // file unchanged (they all invalidate by plain `userId`). List
  // filtering happens as a cheap in-memory step after the cached fetch,
  // not as a second cache dimension.
  let allItems = watchlistCache.get(userId);
  if (!allItems) {
    const snap = await db.collection(USERS).doc(userId).collection(WATCHLIST).orderBy("addedAt", "asc").get();
    // Firestore has no efficient "field does not exist" filter combined
    // with an orderBy on a different field without a composite index —
    // simplest and plenty fast at this scale (a personal watchlist, not
    // millions of rows) is to fetch and filter in code.
    allItems = snap.docs.map((d) => d.data()).filter((item) => !item.deletedAt);
    watchlistCache.set(userId, allItems);
  }
  return allItems.filter((item) => (item.listId ?? DEFAULT_LIST_ID) === listId);
}

export async function addToWatchlist(userId, symbol, note = "", listId = DEFAULT_LIST_ID) {
  const clean = symbol.trim().toUpperCase();
  if (!clean) throw new Error("Symbol is required");
  if (!isValidSymbolFormat(clean)) {
    const err = new Error("That doesn't look like a valid ticker symbol.");
    err.code = "INVALID_SYMBOL";
    throw err;
  }

  const ref = db.collection(USERS).doc(userId).collection(WATCHLIST).doc(clean);
  const existing = await ref.get();
  if (existing.exists && !existing.data().deletedAt) {
    // A symbol lives in exactly one list at a time (the doc ID is the
    // bare symbol, shared across every list for this user) — so this
    // error fires even if the symbol is on a DIFFERENT one of the
    // user's lists, not just the current one. A real, documented
    // simplification: it keeps every other route's :symbol-based
    // lookups (review, restore, history, etc.) unchanged, rather than
    // requiring a much larger redesign to support the same symbol
    // appearing on multiple lists simultaneously.
    const err = new Error(`${clean} is already on one of your watchlists`);
    err.code = "DUPLICATE";
    throw err;
  }

  // Benefits from the same cache as everywhere else — checking the
  // count doesn't cost an extra real read if the list was just fetched.
  const currentItems = await getWatchlistForUser(userId, listId);
  if (currentItems.length >= MAX_WATCHLIST_SIZE) {
    const err = new Error(
      `You've reached the ${MAX_WATCHLIST_SIZE}-stock watchlist limit. Remove a stock to add another.`
    );
    err.code = "LIMIT_REACHED";
    throw err;
  }

  const addedAt = new Date().toISOString();
  const data = {
    symbol: clean,
    note,
    listId,
    addedAt,
    lastSeenPrice: null,
    lastSeenAt: null,
    lastSeenProvider: null,
    reviewedBucket: null,
    reviewedAt: null,
    deletedAt: null,
  };
  await ref.set(data); // overwrites a previously soft-deleted doc for this symbol too — re-adding "undoes" an old deletion cleanly
  watchlistCache.invalidate(userId);
  return { symbol: clean, note, addedAt, listId };
}

// Soft-delete: marks the item as removed (and hidden from the normal
// watchlist) without actually deleting it, so it can be restored within
// TRASH_RETENTION_DAYS. See permanentlyPurgeExpiredTrash for the actual
// cleanup, which runs lazily rather than needing a background job.
export async function removeFromWatchlist(userId, symbol) {
  const clean = symbol.trim().toUpperCase();
  const ref = db.collection(USERS).doc(userId).collection(WATCHLIST).doc(clean);
  const existing = await ref.get();
  if (!existing.exists || existing.data().deletedAt) return false;
  await ref.update({ deletedAt: new Date().toISOString() });
  watchlistCache.invalidate(userId);
  return true;
}

export async function restoreFromTrash(userId, symbol) {
  const clean = symbol.trim().toUpperCase();
  const ref = db.collection(USERS).doc(userId).collection(WATCHLIST).doc(clean);
  const existing = await ref.get();
  if (!existing.exists || !existing.data().deletedAt) return null;
  await ref.update({ deletedAt: null });
  watchlistCache.invalidate(userId);
  return existing.data();
}

// Returns soft-deleted items still within the retention window, and
// lazily purges (actually deletes) anything past it — no background job
// needed for an app at this scale; the cleanup just happens whenever
// someone looks at their trash.
export async function getTrashForUser(userId) {
  const snap = await db.collection(USERS).doc(userId).collection(WATCHLIST).get();
  const cutoffMs = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const kept = [];
  const expiredRefs = [];

  snap.docs.forEach((doc) => {
    const data = doc.data();
    if (!data.deletedAt) return;
    const deletedAtMs = new Date(data.deletedAt).getTime();
    if (deletedAtMs < cutoffMs) {
      expiredRefs.push(doc.ref);
    } else {
      const daysLeft = Math.max(
        0,
        Math.ceil((deletedAtMs - cutoffMs) / (24 * 60 * 60 * 1000))
      );
      kept.push({ ...data, daysUntilPurge: daysLeft });
    }
  });

  await Promise.all(expiredRefs.map((ref) => ref.delete()));
  return kept;
}

export async function updateLastSeen(userId, symbol, price, seenAtIso, provider = null) {
  const clean = symbol.trim().toUpperCase();
  const ref = db.collection(USERS).doc(userId).collection(WATCHLIST).doc(clean);
  await ref.update({ lastSeenPrice: price, lastSeenAt: seenAtIso, lastSeenProvider: provider });
  watchlistCache.invalidate(userId);
}

// Records that the user has acknowledged the CURRENT significance bucket
// for this stock (e.g. "Needs Attention") — stored server-side, so
// reviewing it on one device marks it reviewed on every device.
export async function markSignificanceReviewed(userId, symbol, bucket) {
  const clean = symbol.trim().toUpperCase();
  const ref = db.collection(USERS).doc(userId).collection(WATCHLIST).doc(clean);
  await ref.update({ reviewedBucket: bucket, reviewedAt: new Date().toISOString() });
  watchlistCache.invalidate(userId);
}

export async function isSymbolInUserWatchlist(userId, symbol) {
  const clean = symbol.trim().toUpperCase();
  const snap = await db.collection(USERS).doc(userId).collection(WATCHLIST).doc(clean).get();
  return snap.exists && !snap.data().deletedAt;
}

// Distinct symbols across every user's watchlist — used on server startup
// to resume real-time streaming for everything already saved. Firestore
// has no native "distinct," so we collect unique values from a
// collection-group query across every user's "watchlist" subcollection.
// Soft-deleted (trashed) items are excluded — no need to keep streaming
// something hidden from the user's active list.
export async function getAllDistinctSymbols() {
  const snap = await db.collectionGroup(WATCHLIST).get();
  const symbols = new Set();
  snap.forEach((doc) => {
    const data = doc.data();
    if (!data.deletedAt) symbols.add(data.symbol);
  });
  return Array.from(symbols);
}
