// Price service.
//
// Design choices (kept intentionally simple for this first milestone,
// but already shaped the way the full design doc describes):
//
// 1. CACHE-FIRST: a quote fetched in the last CACHE_TTL_MS is reused
//    instead of re-hit the upstream API. This is the lever that matters
//    for scaling — N users watching the same symbol cost one upstream
//    call per TTL window, not N calls.
// 2. LAYERED FALLBACK: Finnhub (real-time, US-market) is tried first.
//    Finnhub's free tier doesn't cover NSE/BSE Indian symbols at all, so
//    for those (or if Finnhub fails for any reason), we try NSE's own
//    direct quote endpoint next — real AND instant, not delayed — and
//    only after that fails too do we try Yahoo Finance's public Indian
//    feed (real, but ~15min-delayed). Only if ALL THREE real sources
//    fail do we fall back to a clearly-labeled simulated feed. The app
//    never shows an error screen — it just steps down this chain.
// 3. HONESTY: every quote is tagged with a `source` field so the
//    frontend can tell the user whether a price is live, cached, or
//    simulated. Never silently show a number without saying where it
//    came from.

import { getIndianQuote } from "./indianMarketService.js";
import { getNseQuote } from "./nseDirectService.js";
import { recordRealPrice } from "./frozenQuoteDetector.js";

const CACHE_TTL_MS = 15_000; // 15s — short enough to feel live, long enough to protect the free API quota
const SIM_SEED_BUCKET_MS = 3_000; // separate, smaller bucket so direct simulateQuote() calls (e.g. the real-time ticker) vary more often than the REST cache does
const cache = new Map(); // symbol -> { data, fetchedAt }

// Base reference prices used only when simulating (all real sources
// failed, or an unknown symbol). Picked to be plausible starting points
// for well-known NSE names, not accurate live data. Indian-only, to
// match this app's real data sources (NSE direct + Yahoo India) — see
// data/stockUniverse.js for why.
const SIM_BASE_PRICES = {
  RELIANCE: 2945.0,
  TCS: 4230.5,
  INFY: 1890.2,
  HDFCBANK: 1720.4,
  ICICIBANK: 1245.8,
  ITC: 468.9,
  SBIN: 812.3,
  TATAMOTORS: 785.6,
  WIPRO: 268.4,
  SUNPHARMA: 1780.2,
  BHARTIARTL: 1580.0,
  ASIANPAINT: 2890.0,
  HCLTECH: 1820.0,
  KOTAKBANK: 1790.0,
  AXISBANK: 1140.0,
  LT: 3650.0,
  MARUTI: 12800.0,
  TITAN: 3420.0,
  ULTRACEMCO: 11200.0,
  NESTLEIND: 2260.0,
  BAJFINANCE: 7100.0,
  ONGC: 265.0,
  POWERGRID: 320.0,
  NTPC: 375.0,
  ADANIENT: 2900.0,
  ADANIPORTS: 1350.0,
  HINDUNILVR: 2450.0,
  TECHM: 1650.0,
  JSWSTEEL: 950.0,
  TATASTEEL: 145.0,
};

function seededRandom(seed) {
  // Classic cheap seeded PRNG: sin() is very sensitive to its input, so
  // even adjacent integer seeds (e.g. consecutive time buckets) produce
  // visibly different output — unlike the simple string hash below, which
  // barely moves between consecutive bucket numbers.
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x); // fractional part, in [0, 1)
}

function simulateQuote(symbol) {
  const base = SIM_BASE_PRICES[symbol] ?? 100 + hashToRange(symbol, 900);
  // Deterministic-ish pseudo-random walk seeded by symbol + a small time
  // bucket, so calls within the same bucket return the same value (avoids
  // jitter from near-simultaneous calls) while still changing noticeably
  // from tick to tick for callers that call this directly and often.
  const bucket = Math.floor(Date.now() / SIM_SEED_BUCKET_MS);
  const symbolSeed = hashToRange(symbol, 100_000);
  const seed = seededRandom(symbolSeed + bucket); // 0..1
  const pctMove = (seed - 0.5) * 0.06; // +/-3% swing per bucket, deterministic per bucket
  const price = +(base * (1 + pctMove)).toFixed(2);
  const change = +(price - base).toFixed(2);
  const changePercent = +((change / base) * 100).toFixed(2);

  return {
    symbol,
    price,
    change,
    changePercent,
    prevClose: base,
    source: "simulated",
    provider: "simulated",
    confidence: "n/a",
    asOf: new Date().toISOString(),
  };
}

function hashToRange(str, range) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h % range;
}

async function fetchFromFinnhub(symbol) {
  if (process.env.FORCE_SIMULATED === "true") return null; // testing override — see .env.example

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return null;

  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();

    // Finnhub returns all zeros for an unknown/unsupported symbol instead of an error.
    if (!data || (data.c === 0 && data.pc === 0)) return null;

    return {
      symbol,
      price: data.c,
      change: +(data.c - data.pc).toFixed(2),
      changePercent: data.pc ? +(((data.c - data.pc) / data.pc) * 100).toFixed(2) : 0,
      prevClose: data.pc,
      source: "live",
      provider: "finnhub",
      confidence: "high",
      asOf: new Date().toISOString(),
    };
  } catch {
    return null; // network error, timeout, or rate limit — caller falls back
  } finally {
    clearTimeout(timeout);
  }
}

// Tries Finnhub first (real-time, but US-market only). For Indian
// symbols, queries NSE and Yahoo AT THE SAME TIME rather than trying one
// then the other — this is what makes a genuine disagreement check
// possible: if both succeed and their prices differ by more than 1%,
// that's real evidence of a data-quality problem worth flagging, not
// something a sequential "stop at first success" approach could ever
// detect (it would just silently use whichever one happened to answer
// first). See crossCheckIndianSources() below.
async function fetchLiveQuote(symbol) {
  const fromFinnhub = await fetchFromFinnhub(symbol);
  if (fromFinnhub) return fromFinnhub;

  return crossCheckIndianSources(symbol);
}

const DISAGREEMENT_THRESHOLD_PCT = 1;

/**
 * Queries NSE and Yahoo simultaneously (not sequentially) and cross-
 * checks the result:
 *   - Both fail -> null (caller falls back to simulated data)
 *   - Only one succeeds -> use it, high confidence
 *   - Both succeed and agree (within 1%) -> use the fresher one (NSE,
 *     when it's actually working, since it's real-time vs Yahoo's
 *     ~15min delay), high confidence
 *   - Both succeed but DISAGREE by more than 1% -> still prefer the
 *     fresher one, but mark confidence LOW and record the disagreement
 *     — this is a real signal that something's off (a stale quote, a
 *     provider glitch), and the app should say so rather than silently
 *     picking a number and moving on.
 */
export async function crossCheckIndianSources(symbol) {
  const [nseResult, yahooResult] = await Promise.allSettled([getNseQuote(symbol), getIndianQuote(symbol)]);
  const nse = nseResult.status === "fulfilled" ? nseResult.value : null;
  const yahoo = yahooResult.status === "fulfilled" ? yahooResult.value : null;

  if (!nse && !yahoo) return null;
  if (nse && !yahoo) return { ...nse, confidence: "high" };
  if (!nse && yahoo) return { ...yahoo, confidence: "high" };

  // Both succeeded — NSE is the fresher source (real-time vs Yahoo's
  // inherent delay) when it's actually working, so it's preferred either way.
  const diffPct = yahoo.price ? (Math.abs(nse.price - yahoo.price) / yahoo.price) * 100 : 0;

  if (diffPct > DISAGREEMENT_THRESHOLD_PCT) {
    console.error(
      `[CrossCheck] ${symbol}: NSE (₹${nse.price}) and Yahoo (₹${yahoo.price}) disagree by ${diffPct.toFixed(2)}% — using NSE (fresher), confidence: low.`
    );
    return {
      ...nse,
      confidence: "low",
      disagreement: { nsePrice: nse.price, yahooPrice: yahoo.price, diffPct: +diffPct.toFixed(2) },
    };
  }

  return { ...nse, confidence: "high" };
}

export async function getQuote(symbol) {
  const clean = symbol.trim().toUpperCase();
  const cached = cache.get(clean);
  const isFresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;

  if (isFresh) {
    return { ...cached.data, source: cached.data.source === "live" ? "cached" : cached.data.source };
  }

  let quote = await fetchLiveQuote(clean);
  if (!quote) quote = simulateQuote(clean);

  // Only real observations feed the frozen-quote detector — a
  // simulated tick moving on its own schedule says nothing about
  // whether the REAL market price has actually stopped moving.
  if (quote.source === "live") {
    recordRealPrice(clean, quote.price);
  }

  cache.set(clean, { data: quote, fetchedAt: Date.now() });
  return quote;
}

export async function getQuotes(symbols) {
  return Promise.all(symbols.map((s) => getQuote(s)));
}

// Exported uncached for callers that want a fresh simulated tick every
// call (e.g. the real-time stream's fallback ticker) rather than the
// 15s-bucketed value used by the REST endpoints.
export { simulateQuote };
