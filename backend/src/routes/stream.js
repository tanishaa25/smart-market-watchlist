import { Router } from "express";
import { getSnapshot, onUpdate } from "../services/finnhubStream.js";
import { onWatchlistChange } from "../services/watchlistEvents.js";
import { authenticateFromQuery } from "../auth.js";
import { getWatchlistForUser } from "../db.js";

export const streamRouter = Router();

// GET /api/stream?token=... — Server-Sent Events, scoped to the
// authenticated user's own watchlist.
//
// EventSource (the browser API used to consume this) can't set custom
// headers, so auth here comes via a query param instead of the usual
// Authorization header — see authenticateFromQuery in auth.js.
streamRouter.get("/", authenticateFromQuery, async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const myItems = await getWatchlistForUser(req.userId);
  const mySymbols = new Set(myItems.map((i) => i.symbol));

  // Send everything we currently know about this user's symbols
  // immediately, so the UI isn't blank while waiting for the next tick.
  const snapshot = getSnapshot().filter((q) => mySymbols.has(q.symbol));
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  const unsubscribeQuotes = onUpdate((quote) => {
    if (mySymbols.has(quote.symbol)) {
      res.write(`event: quote\ndata: ${JSON.stringify(quote)}\n\n`);
    }
  });

  // Keep this connection's symbol filter in sync with live add/remove
  // actions from the same user, without touching Firestore again — pure
  // in-memory bookkeeping for the life of the connection. Also forwards
  // "reviewed" acknowledgements as their own SSE event, so a dashboard
  // open on another device clears its "new" flag immediately, rather
  // than only on that device's next reload.
  const unsubscribeWatchlistChanges = onWatchlistChange(({ userId, symbol, action, reviewedBucket }) => {
    if (userId !== req.userId) return;
    if (action === "add") mySymbols.add(symbol);
    else if (action === "remove") mySymbols.delete(symbol);
    else if (action === "reviewed") {
      res.write(`event: reviewed\ndata: ${JSON.stringify({ symbol, reviewedBucket })}\n\n`);
    }
  });

  // Keep intermediate proxies (and some browsers) from timing out an
  // idle-looking connection.
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribeQuotes();
    unsubscribeWatchlistChanges();
  });
});
