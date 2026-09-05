import { Router } from "express";
import {
  getWatchlistForUser,
  addToWatchlist,
  removeFromWatchlist,
  updateLastSeen,
  markSignificanceReviewed,
  getTrashForUser,
  restoreFromTrash,
  findUserById,
} from "../db.js";
import { subscribeSymbol, unsubscribeSymbol, getStreamedQuote } from "../services/finnhubStream.js";
import { emitWatchlistChange } from "../services/watchlistEvents.js";
import { getQuote } from "../services/priceService.js";
import { computeRawSignals, assembleScore, computeSignificance, getSparklineHistory, meetsBriefingThreshold } from "../services/significanceService.js";
import { getOrUpdateChangeEvent, getChangeEventHistory } from "../services/changeEventStore.js";
import { buildNarrative } from "../services/narrativeService.js";
import { isFrozen } from "../services/frozenQuoteDetector.js";
import { lookupStock } from "../data/stockUniverse.js";
import { authenticate } from "../auth.js";
import { isMarketOpen, getMarketStatusLabel } from "../utils/marketHours.js";
import { rateLimit } from "../utils/rateLimiter.js";
import { detectSourceMismatch } from "../utils/sourceMismatch.js";
import { detectMixedSignal } from "../utils/mixedSignal.js";

export const watchlistRouter = Router();

// If the user's last check-in was more than this long ago, treat this
// load as the start of a new "session": show the diff against the old
// baseline, then reset the baseline to right now. If they're re-loading
// within this window (e.g. right after adding a stock), don't touch the
// baseline — otherwise the diff would vanish before they even see it.
//
// Configurable via SESSION_GAP_MS in .env for testing (e.g. set it to
// 30000 for a 30-second window so you can see the diff appear quickly
// during development) — remove it or leave unset for the real 30-minute
// default before submitting/deploying.
const SESSION_GAP_MS = Number(process.env.SESSION_GAP_MS) || 30 * 60 * 1000;
console.log(`"Since last checked" session gap: ${SESSION_GAP_MS}ms (${SESSION_GAP_MS / 1000}s)`);

watchlistRouter.use(authenticate);

// GET /api/watchlist?listId=... — the watchlist plus "what changed since you last checked."
watchlistRouter.get("/", async (req, res) => {
  try {
    const listId = req.query.listId || "default";
    const items = await getWatchlistForUser(req.userId, listId);
    const now = Date.now();

    // Fetched once per request, not per item — the sensitivity profile
    // scales the BRIEFING trigger threshold only (see
    // significanceService.js's meetsBriefingThreshold); badges, digest
    // counts, and history all keep using the unscaled bucket/score, so
    // they stay comparable across users regardless of this setting.
    const user = await findUserById(req.userId);
    const sensitivity = user?.sensitivity ?? "balanced";

    // Pass 1: resolve today's quote for every item first — needed
    // before per-item significance/narrative, since the narrative's
    // sector-attribution line ("Technology peers moved only +0.8%")
    // compares each stock against its OTHER watchlist peers in the same
    // sector, which requires knowing everyone's move upfront.
    const quotes = await Promise.all(
      items.map((item) => getStreamedQuote(item.symbol) ?? getQuote(item.symbol))
    );

    const sectorChanges = {}; // sector -> [{ symbol, changePercent }]
    items.forEach((item, i) => {
      const info = lookupStock(item.symbol);
      if (info?.sector) {
        (sectorChanges[info.sector] ??= []).push({ symbol: item.symbol, changePercent: quotes[i].changePercent });
      }
    });
    function sectorAvgExcluding(symbol) {
      const info = lookupStock(symbol);
      if (!info?.sector) return null;
      const peers = (sectorChanges[info.sector] || []).filter((p) => p.symbol !== symbol);
      if (peers.length === 0) return null;
      return peers.reduce((sum, p) => sum + p.changePercent, 0) / peers.length;
    }

    const results = await Promise.all(
      items.map(async (item, i) => {
        const quote = quotes[i];

        const baselinePrice = item.lastSeenPrice;
        const baselineAt = item.lastSeenAt;
        const baselineAgeMs = baselineAt ? now - new Date(baselineAt).getTime() : Infinity;
        const isNewCheckIn = baselinePrice == null || baselineAgeMs > SESSION_GAP_MS;

        const sinceLastSeen =
          baselinePrice != null
            ? {
                change: +(quote.price - baselinePrice).toFixed(2),
                changePercent: baselinePrice
                  ? +(((quote.price - baselinePrice) / baselinePrice) * 100).toFixed(2)
                  : 0,
                previousPrice: baselinePrice,
                previousSeenAt: baselineAt,
                // Flags a subtle correctness edge case: if the baseline
                // price came from a different real provider than today's
                // price (e.g. baseline from Yahoo, now reading from
                // NSE), the diff is technically comparing two slightly
                // different methodologies, not a pure like-for-like
                // move. See utils/sourceMismatch.js for the reasoning.
                sourceMismatch: detectSourceMismatch(item.lastSeenProvider, quote.provider),
              }
            : null;

        // "Up today, but still down since you last checked" — an
        // honest ambiguity flag rather than a narrative that silently
        // picks one direction to report. See utils/mixedSignal.js.
        const mixedSignal = detectMixedSignal(quote.changePercent, sinceLastSeen?.changePercent);

        if (isNewCheckIn) {
          await updateLastSeen(req.userId, item.symbol, quote.price, new Date(now).toISOString(), quote.provider ?? null);
        }

        // Statistical significance, via compute-on-write persistence
        // (see changeEventStore.js): the expensive, user-independent
        // raw signals for this (symbol, today) are computed once and
        // stored in Firestore — a real, permanent, deduplicated record,
        // not a number computed fresh and discarded on every request.
        // The final score is still assembled fresh per request, since
        // it depends on THIS user's own daysAway (how long they've
        // personally been away) and current frozen-quote status — both
        // genuinely per-request, unlike the raw signals.
        const daysAway = baselineAt ? baselineAgeMs / (24 * 60 * 60 * 1000) : 1;

        let significance = null;
        try {
          const eventRecord = await getOrUpdateChangeEvent(item.symbol, () =>
            computeRawSignals({ symbol: item.symbol, changePercent: quote.changePercent, currentPrice: quote.price })
          );
          significance = assembleScore({
            rawSignals: eventRecord.rawSignals,
            daysAway,
            frozen: isFrozen(item.symbol),
            sectorAvgChangePercent: sectorAvgExcluding(item.symbol),
          });
          // Exposed for the briefing's staleness-decay ranking (see
          // frontend utils/briefing.js) — how long this significance has
          // actually been standing, not just a live-computed number with
          // no sense of its own age.
          significance.firstComputedAt = eventRecord.firstComputedAt;
          significance.meetsBriefingThreshold = meetsBriefingThreshold(significance.score, sensitivity);
        } catch (err) {
          console.error(`Significance calculation failed for ${item.symbol}:`, err.message);
          // Fall back to the non-persisted all-in-one path rather than
          // showing nothing, if Firestore is having a bad moment.
          try {
            significance = computeSignificance({
              symbol: item.symbol,
              changePercent: quote.changePercent,
              currentPrice: quote.price,
              daysAway,
              frozen: isFrozen(item.symbol),
              sectorAvgChangePercent: sectorAvgExcluding(item.symbol),
            });
            significance.meetsBriefingThreshold = meetsBriefingThreshold(significance.score, sensitivity);
          } catch {
            // Both paths failed — leave significance null, handled gracefully downstream.
          }
        }

        // Templated, deterministic narrative — replaces the earlier
        // Gemini-based explanation by deliberate design decision (see
        // README / narrativeService.js): every claim here is traceable
        // to a stored field, never an invented reason.
        let explanation = null;
        try {
          if (quote.source === "live" && significance) {
            const stockInfo = lookupStock(item.symbol);
            explanation = buildNarrative({
              symbol: item.symbol,
              changePercent: quote.changePercent,
              zScore: significance.zScore,
              volumeRatio: significance.volumeRatio,
              isVolumeSpike: significance.isVolumeSpike,
              gapSignal: significance.signals.gap,
              sector: stockInfo?.sector,
              sectorAvgChangePercent: sectorAvgExcluding(item.symbol),
              nextEarningsDays: significance.nextEarningsDays,
              bucket: significance.bucket,
              mixedSignal,
              sinceLastSeenChangePercent: sinceLastSeen?.changePercent,
            });
          } else if (quote.source === "simulated") {
            explanation =
              "This is a simulated price for practice/demo purposes \u2014 there's no real market event behind this move.";
          }
        } catch (err) {
          console.error(`Narrative generation failed for ${item.symbol}:`, err.message);
        }

        // Cross-device "attention sync": is this significance bucket
        // something the user hasn't acknowledged yet, on ANY device?
        // reviewedBucket is stored in Firestore (not browser storage),
        // so reviewing a flag on one device clears it everywhere else
        // too — the same principle "since you last checked" already
        // uses for price, applied here to alerts specifically. "Quiet"
        // stocks are never flagged as new — there's nothing to review.
        const isNewSignificance =
          significance != null &&
          significance.bucket !== "quiet" &&
          significance.bucket !== item.reviewedBucket;

        return {
          symbol: item.symbol,
          note: item.note,
          addedAt: item.addedAt,
          currentPrice: quote.price,
          sector: lookupStock(item.symbol)?.sector ?? null, // exposed so the frontend can group correlated moves (echo grouping) without duplicating sector data
          sinceLastSeen,
          significance,
          isNewSignificance,
          mixedSignal,
          explanation,
          sparkline: getSparklineHistory(item.symbol, quote.price),
        };
      })
    );

    res.json({
      items: results,
      marketOpen: isMarketOpen(),
      marketStatusLabel: getMarketStatusLabel(),
    });
  } catch (err) {
    console.error("Failed to load watchlist:", err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});

// POST /api/watchlist — add a symbol { symbol, note? }
watchlistRouter.post("/", rateLimit, async (req, res) => {
  const { symbol, note, listId } = req.body || {};
  if (!symbol || typeof symbol !== "string") {
    return res.status(400).json({ error: "A 'symbol' string is required." });
  }
  try {
    const item = await addToWatchlist(req.userId, symbol, note || "", listId || "default");
    await subscribeSymbol(item.symbol); // wait for the initial real-data seed so what we capture below is consistent with what the stream will show
    emitWatchlistChange(req.userId, item.symbol, "add");

    // Capture "last seen price" right now, at the moment of adding — this
    // becomes the baseline for the "since you last checked" diff, rather
    // than waiting for the first GET to establish one. Non-fatal if this
    // fails: the item is still added, and a GET afterward will establish
    // a baseline instead.
    try {
      const quote = getStreamedQuote(item.symbol) ?? (await getQuote(item.symbol));
      await updateLastSeen(req.userId, item.symbol, quote.price, new Date().toISOString(), quote.provider ?? null);
      item.lastSeenPrice = quote.price;
    } catch (err) {
      console.error(`Could not capture initial last-seen price for ${item.symbol}:`, err.message);
    }

    res.status(201).json({ item });
  } catch (err) {
    if (err.code === "DUPLICATE") {
      return res.status(409).json({ error: err.message });
    }
    if (err.code === "LIMIT_REACHED") {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === "INVALID_SYMBOL") {
      return res.status(400).json({ error: err.message });
    }
    if (err.message === "Symbol is required") {
      return res.status(400).json({ error: err.message });
    }
    console.error("Failed to add to watchlist:", err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});

// DELETE /api/watchlist/:symbol — soft-delete a symbol (recoverable — see /trash)
watchlistRouter.delete("/:symbol", rateLimit, async (req, res) => {
  try {
    const removed = await removeFromWatchlist(req.userId, req.params.symbol);
    if (!removed) return res.status(404).json({ error: "Symbol not found in watchlist." });
    unsubscribeSymbol(req.params.symbol);
    emitWatchlistChange(req.userId, req.params.symbol.trim().toUpperCase(), "remove");
    res.status(204).end();
  } catch (err) {
    console.error("Failed to remove from watchlist:", err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});

// POST /api/watchlist/:symbol/review — acknowledge the current
// significance flag for this stock. Cross-device by construction: this
// is a Firestore write, so acknowledging on one device clears the "new"
// state everywhere else too.
watchlistRouter.post("/:symbol/review", rateLimit, async (req, res) => {
  try {
    const clean = req.params.symbol.trim().toUpperCase();
    const quote = getStreamedQuote(clean) ?? (await getQuote(clean));
    const significance = computeSignificance({
      symbol: clean,
      changePercent: quote.changePercent,
      currentPrice: quote.price,
    });
    await markSignificanceReviewed(req.userId, clean, significance.bucket);
    // Cross-device propagation: push this to any other open connection
    // for the same user immediately, over the existing SSE stream —
    // not just reflected on this device's next reload. See routes/
    // stream.js for the corresponding listener.
    emitWatchlistChange(req.userId, clean, "reviewed", { reviewedBucket: significance.bucket });
    res.json({ reviewedBucket: significance.bucket });
  } catch (err) {
    console.error(`Failed to mark ${req.params.symbol} as reviewed:`, err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});

// GET /api/watchlist/:symbol/history — the permanent audit trail
// changeEventStore.js exists to provide: what this app has flagged for
// this stock, day by day. The historical raw signals were persisted
// once each day (compute-on-write); the score shown here is computed
// fresh from those stored facts with daysAway=1 (a "same-day check-in"
// baseline) purely for display — this endpoint doesn't know what any
// specific user's actual absence length was on a past day.
watchlistRouter.get("/:symbol/history", async (req, res) => {
  try {
    const clean = req.params.symbol.trim().toUpperCase();
    const records = await getChangeEventHistory(clean, 30);
    const history = records.map((record) => ({
      dateBucket: record.dateBucket,
      updateCount: record.updateCount,
      ...assembleScore({ rawSignals: record.rawSignals, daysAway: 1 }),
    }));
    res.json({ symbol: clean, history });
  } catch (err) {
    console.error(`Failed to load history for ${req.params.symbol}:`, err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});

// GET /api/watchlist/:symbol/detail — everything a dedicated Stock
// Details page needs in one call: current quote, full significance
// (including the six-signal breakdown), a longer sparkline for the
// page's bigger chart, and how many days of absence should be shaded on
// it. Doesn't require the stock to be on the user's watchlist — this is
// also how Browse Stocks could link into a detail page for any symbol.
watchlistRouter.get("/:symbol/detail", async (req, res) => {
  try {
    const clean = req.params.symbol.trim().toUpperCase();
    const stockInfo = lookupStock(clean);
    const quote = getStreamedQuote(clean) ?? (await getQuote(clean));

    // Reuses the exact same watched-item lookup as the main list, so a
    // stock that IS on the watchlist shows its real "since last check"
    // baseline and absence length here too, not a fresh recompute.
    const watchlistItems = await getWatchlistForUser(req.userId, req.query.listId || "default");
    const watchedItem = watchlistItems.find((i) => i.symbol === clean);

    const now = Date.now();
    const baselineAt = watchedItem?.lastSeenAt;
    const baselineAgeMs = baselineAt ? now - new Date(baselineAt).getTime() : Infinity;
    const daysAway = baselineAt ? baselineAgeMs / (24 * 60 * 60 * 1000) : 1;

    const rawSignals = computeRawSignals({ symbol: clean, changePercent: quote.changePercent, currentPrice: quote.price });
    const significance = assembleScore({ rawSignals, daysAway, frozen: isFrozen(clean) });

    res.json({
      symbol: clean,
      name: stockInfo?.name ?? clean,
      sector: stockInfo?.sector ?? null,
      currentPrice: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
      source: quote.source,
      significance,
      sparkline: getSparklineHistory(clean, quote.price, 30), // a longer window than the row's mini sparkline
      daysAway,
      onWatchlist: Boolean(watchedItem),
    });
  } catch (err) {
    console.error(`Failed to load detail for ${req.params.symbol}:`, err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});

// GET /api/watchlist/trash — recently removed stocks, still within the
// restore window (see db.js TRASH_RETENTION_DAYS).
watchlistRouter.get("/trash", async (req, res) => {
  try {
    const trashed = await getTrashForUser(req.userId);
    res.json({
      items: trashed.map((item) => ({
        symbol: item.symbol,
        note: item.note,
        deletedAt: item.deletedAt,
        daysUntilPurge: item.daysUntilPurge,
      })),
    });
  } catch (err) {
    console.error("Failed to load trash:", err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});

// POST /api/watchlist/:symbol/restore — undo a soft-delete.
watchlistRouter.post("/:symbol/restore", rateLimit, async (req, res) => {
  try {
    const restored = await restoreFromTrash(req.userId, req.params.symbol);
    if (!restored) return res.status(404).json({ error: "Symbol not found in trash." });
    await subscribeSymbol(restored.symbol); // resume real-time streaming for it again
    emitWatchlistChange(req.userId, restored.symbol, "add");
    res.json({ item: restored });
  } catch (err) {
    console.error(`Failed to restore ${req.params.symbol}:`, err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});
