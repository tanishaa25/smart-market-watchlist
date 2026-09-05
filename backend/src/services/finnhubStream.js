// Real-time price stream.
//
// Upstream: Finnhub's free WebSocket API (wss://ws.finnhub.io) pushes a
// message the instant a trade happens, for symbols it covers. Docs:
// https://finnhub.io/docs/api/websocket-trades
//
// IMPORTANT SCOPE NOTE: Finnhub's free-tier real-time trade feed covers
// US-listed symbols (plus forex/crypto pairs) — it does not push live
// trades for NSE/BSE-listed Indian stocks. So per symbol, this module:
//
//   1. Subscribes on Finnhub's WebSocket and waits briefly for a real
//      trade to arrive.
//   2. If one arrives -> that symbol is genuinely "live": every trade
//      event updates its price instantly, pushed to the browser as it
//      happens.
//   3. If nothing arrives within PENDING_LIVE_TIMEOUT_MS (symbol not
//      covered by Finnhub, no key configured, or market is closed) ->
//      try NSE's own direct quote endpoint (real AND instant, not
//      delayed) — see nseDirectService.js. If that's blocked/fails, try
//      Yahoo Finance's public Indian-market endpoint next (real, but
//      ~15min-delayed) — see indianMarketService.js.
//   4. Only if all real sources fail does a symbol fall back to a fully
//      synthetic simulated ticker — always honestly labeled as such.
//
// Downstream: routes/stream.js exposes this over Server-Sent Events so
// the browser gets pushed updates instead of polling.

import { EventEmitter } from "node:events";
import { getQuote, simulateQuote, crossCheckIndianSources } from "./priceService.js";
import { recordRealPrice } from "./frozenQuoteDetector.js";

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

const WS_URL = "wss://ws.finnhub.io";
const CONNECT_TIMEOUT_MS = 8000; // don't let a hung connection attempt block forever
const PENDING_LIVE_TIMEOUT_MS = 8000; // how long to wait for a real Finnhub trade before trying the next fallback
const SIM_TICK_INTERVAL_MS = 4000; // fully synthetic data — safe to tick fast, it's not a real network call
const REAL_POLL_INTERVAL_MS = 10_000; // real Indian-market data — NSE direct is genuinely fresh, not artificially delayed, so a tighter interval is safe; still well under NSE's self-throttled rate limit (see nseDirectService.js)

let ws = null;
let wsReady = false;
let reconnectDelay = 2000;

const subscribedSymbols = new Map(); // symbol -> reference count (how many users are watching it)
const state = new Map(); // symbol -> latest quote object shown to clients
const prevCloseBySymbol = new Map(); // symbol -> baseline for computing change on live ticks
const pendingLiveTimers = new Map(); // symbol -> timer waiting to see if a real trade shows up
const simTickTimers = new Map(); // symbol -> interval id for the simulated fallback

function isFinnhubConfigured() {
  return Boolean(process.env.FINNHUB_API_KEY);
}

function publish(symbol) {
  const quote = state.get(symbol);
  if (quote) emitter.emit("update", quote);
}

function stopSimTicking(symbol) {
  const id = simTickTimers.get(symbol);
  if (id) {
    clearInterval(id);
    simTickTimers.delete(symbol);
  }
}

function startSyntheticTicking(symbol) {
  const tick = () => {
    // Calls the uncached simulator directly so each tick actually moves,
    // instead of returning the same value repeatedly within priceService's
    // REST cache window.
    const quote = simulateQuote(symbol);
    state.set(symbol, quote);
    publish(symbol);
  };
  tick();
  simTickTimers.set(symbol, setInterval(tick, SIM_TICK_INTERVAL_MS));
}

// Called once Finnhub's WebSocket has had its chance and produced
// nothing for this symbol. Tries NSE's direct feed (real, instant),
// then Yahoo's Indian feed (real, delayed), before giving up on real
// data and falling back to fully synthetic ticking.
async function startFallbackTicking(symbol) {
  stopSimTicking(symbol); // clear any prior timer of either kind first

  const real = await crossCheckIndianSources(symbol);
  if (real) {
    state.set(symbol, real);
    if (real.source === "live") recordRealPrice(symbol, real.price);
    publish(symbol);
    startRealPolling(symbol);
  } else {
    // Neither Finnhub, NSE direct, nor the Yahoo fallback has this
    // symbol — last resort, clearly labeled as such.
    startSyntheticTicking(symbol);
  }
}

// Begins the ongoing poll for a symbol already confirmed to have real
// data available — does NOT re-attempt NSE/Yahoo immediately, since the
// caller already has a fresh real quote in hand. Avoids redundantly
// hitting NSE/Yahoo twice in a row for the same symbol at subscribe time.
function startRealPolling(symbol) {
  const tryRealQuote = async () => {
    const real = await crossCheckIndianSources(symbol);
    if (real) {
      state.set(symbol, real);
      if (real.source === "live") recordRealPrice(symbol, real.price);
      publish(symbol);
    }
  };
  simTickTimers.set(symbol, setInterval(tryRealQuote, REAL_POLL_INTERVAL_MS));
}

function handleTrade(symbol, price, timestampMs) {
  if (!subscribedSymbols.has(symbol)) return;

  // A real trade arrived — this symbol is genuinely live. Cancel any
  // "is this symbol even covered" timer and stop simulated ticking.
  const pending = pendingLiveTimers.get(symbol);
  if (pending) {
    clearTimeout(pending);
    pendingLiveTimers.delete(symbol);
  }
  stopSimTicking(symbol);

  const prevClose = prevCloseBySymbol.get(symbol) ?? price;
  const change = +(price - prevClose).toFixed(2);
  const changePercent = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;

  state.set(symbol, {
    symbol,
    price,
    change,
    changePercent,
    prevClose,
    source: "live",
    provider: "finnhub",
    asOf: new Date(timestampMs).toISOString(),
  });
  recordRealPrice(symbol, price);
  publish(symbol);
}

function connectUpstream() {
  if (!isFinnhubConfigured() || ws) return;

  ws = new WebSocket(`${WS_URL}?token=${process.env.FINNHUB_API_KEY}`);

  const connectTimeout = setTimeout(() => {
    if (!wsReady) {
      try {
        ws?.close();
      } catch {
        // already closed/closing — nothing to do
      }
    }
  }, CONNECT_TIMEOUT_MS);

  ws.addEventListener("open", () => {
    clearTimeout(connectTimeout);
    wsReady = true;
    reconnectDelay = 2000;
    for (const symbol of subscribedSymbols.keys()) {
      ws.send(JSON.stringify({ type: "subscribe", symbol }));
    }
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "trade" && Array.isArray(msg.data)) {
        for (const trade of msg.data) {
          handleTrade(trade.s, trade.p, trade.t);
        }
      }
    } catch {
      // Malformed/unexpected frame — ignore rather than crash the stream.
    }
  });

  ws.addEventListener("close", () => {
    clearTimeout(connectTimeout);
    wsReady = false;
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // 'close' fires right after and handles cleanup/reconnect.
  });
}

function scheduleReconnect() {
  if (!isFinnhubConfigured() || subscribedSymbols.size === 0) return;
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000); // back off up to 30s
    connectUpstream();
  }, reconnectDelay);
}

export async function subscribeSymbol(symbol) {
  const clean = symbol.trim().toUpperCase();
  const currentCount = subscribedSymbols.get(clean) ?? 0;
  subscribedSymbols.set(clean, currentCount + 1);

  if (currentCount > 0) return; // already actively streaming this symbol for another user

  // Seed an immediate value (and the prevClose baseline for live-tick math)
  // from the existing REST/simulated path so the UI isn't empty while we
  // wait to find out if real trades are coming.
  const initial = await getQuote(clean);
  prevCloseBySymbol.set(clean, initial.prevClose);
  state.set(clean, initial);
  publish(clean);

  if (isFinnhubConfigured()) {
    connectUpstream();
    if (wsReady) ws.send(JSON.stringify({ type: "subscribe", symbol: clean }));
    const timer = setTimeout(() => startFallbackTicking(clean), PENDING_LIVE_TIMEOUT_MS);
    pendingLiveTimers.set(clean, timer);
  } else if (initial.source === "live") {
    // The seed fetch above already tried the full Finnhub→NSE→Yahoo
    // chain and succeeded — start polling directly rather than
    // redundantly re-attempting NSE/Yahoo again immediately, which was
    // needlessly doubling real requests to already-rate-limited/
    // bot-sensitive endpoints for no benefit.
    startRealPolling(clean);
  } else {
    // No Finnhub key, and the seed came back simulated — give the real
    // sources one more explicit try before committing to synthetic
    // ticking (covers the case where NSE/Yahoo were only transiently
    // unavailable a moment ago).
    startFallbackTicking(clean);
  }
}

export function unsubscribeSymbol(symbol) {
  const clean = symbol.trim().toUpperCase();
  const currentCount = subscribedSymbols.get(clean) ?? 0;
  if (currentCount <= 1) {
    subscribedSymbols.delete(clean);
  } else {
    subscribedSymbols.set(clean, currentCount - 1);
    return; // someone else is still watching this symbol — keep streaming it
  }

  state.delete(clean);
  prevCloseBySymbol.delete(clean);

  const pending = pendingLiveTimers.get(clean);
  if (pending) clearTimeout(pending);
  pendingLiveTimers.delete(clean);
  stopSimTicking(clean);

  if (ws && wsReady) {
    ws.send(JSON.stringify({ type: "unsubscribe", symbol: clean }));
  }
}

export function getSnapshot() {
  return Array.from(state.values());
}

// Single-symbol lookup into the same in-memory state the stream pushes
// from. Callers (like routes/watchlist.js) should prefer this over
// calling priceService.getQuote() independently — that would mean two
// uncoordinated code paths separately hitting the same rate-limited/
// bot-sensitive external APIs (NSE, Yahoo) for the same symbol, which
// can legitimately disagree with each other (one succeeds, one gets
// throttled) and show inconsistent data for the same stock in the UI.
// Returns null if the symbol isn't actively subscribed/streaming yet.
export function getStreamedQuote(symbol) {
  return state.get(symbol.trim().toUpperCase()) ?? null;
}

export function onUpdate(listener) {
  emitter.on("update", listener);
  return () => emitter.off("update", listener);
}
