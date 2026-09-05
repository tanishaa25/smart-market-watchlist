// Real, INSTANT (not delayed) Indian market quotes — straight from NSE's
// own internal API, the same one nseindia.com's live quote widget uses.
//
// This is a step up from indianMarketService.js (Yahoo Finance): Yahoo's
// public feed is real but typically ~15 minutes delayed. NSE's own
// endpoint reflects the live tape directly, with no artificial delay —
// which is what "real AND instant" actually requires for Indian stocks,
// short of paying for a broker's market-data API (e.g. Groww's Trading
// API, which does the same thing but costs ₹499+/month and needs a real
// trading account).
//
// THE CATCH — why this isn't simply the only Indian data source in the
// app, and why indianMarketService.js still exists as a fallback behind
// it:
//
//   1. UNOFFICIAL & BOT-SENSITIVE: nseindia.com actively guards this
//      endpoint against non-browser traffic. It requires first visiting
//      the site to receive session cookies, then replaying those
//      cookies + browser-like headers on the actual quote request. NSE
//      can and does tighten this at any time without notice, and can
//      block requests from datacenter/server IPs specifically (as
//      opposed to a home internet connection) more aggressively.
//   2. RATE LIMITED: NSE throttles this to roughly 3 requests/second
//      *total*, not per symbol. This module self-throttles with a
//      minimum gap between outbound calls so a burst of adds (or a
//      server restart re-subscribing to many saved symbols at once)
//      can't trip that limit on its own.
//   3. NO SLA: there's no support contract behind this. If NSE changes
//      their anti-bot measures, this stops working — and the app must
//      keep working anyway. That's why every caller treats a null
//      return as "try the next fallback," landing on Yahoo's delayed
//      feed, and only simulated data as the final resort.

import { isCircuitOpen, recordSuccess, recordFailure } from "../utils/circuitBreaker.js";

const NSE_BASE = "https://www.nseindia.com";
const REQUEST_TIMEOUT_MS = 6000;
const COOKIE_TTL_MS = 10 * 60 * 1000; // refresh the session cookies every 10 minutes
const MIN_CALL_GAP_MS = 350; // self-throttle: stays comfortably under NSE's ~3 req/sec limit

const BROWSER_HEADERS_BASE = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

let cookieJar = null; // string like "name1=value1; name2=value2"
let cookieFetchedAt = 0;
let lastCallAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const wait = MIN_CALL_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

async function refreshCookies() {
  await throttle();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(NSE_BASE, {
      signal: controller.signal,
      headers: BROWSER_HEADERS_BASE,
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length === 0) {
      console.error(`[NSE] Cookie handshake got no Set-Cookie headers (status ${res.status}).`);
      return false;
    }

    cookieJar = setCookie.map((c) => c.split(";")[0]).join("; ");
    cookieFetchedAt = Date.now();
    return true;
  } catch (err) {
    console.error(`[NSE] Cookie handshake failed: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureCookies() {
  const isStale = !cookieJar || Date.now() - cookieFetchedAt > COOKIE_TTL_MS;
  if (isStale) await refreshCookies();
  return cookieJar;
}

/**
 * Fetches a real, undelayed quote directly from NSE for an equity
 * symbol. Returns null on any failure (blocked, rate-limited, unknown
 * symbol, network error) — never throws. Callers should fall back to
 * indianMarketService.js's Yahoo-based quote next.
 */
async function attemptNseQuote(symbol) {
  if (process.env.FORCE_SIMULATED === "true") return null; // testing override — see .env.example

  const clean = symbol.trim().toUpperCase();
  const cookies = await ensureCookies();
  if (!cookies) {
    console.error(`[NSE] No cookies available — skipping quote fetch for ${clean}.`);
    return null;
  }

  await throttle();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${NSE_BASE}/api/quote-equity?symbol=${encodeURIComponent(clean)}`, {
      signal: controller.signal,
      headers: {
        ...BROWSER_HEADERS_BASE,
        Referer: `${NSE_BASE}/get-quotes/equity?symbol=${encodeURIComponent(clean)}`,
        Cookie: cookies,
      },
    });

    if (res.status === 401 || res.status === 403) {
      console.error(`[NSE] Blocked fetching ${clean} (status ${res.status}) — will refresh cookies next attempt.`);
      // Session likely expired/blocked — force a fresh cookie handshake
      // on the next call rather than repeatedly failing with stale ones.
      cookieJar = null;
      return null;
    }
    if (!res.ok) {
      console.error(`[NSE] Quote fetch for ${clean} failed with status ${res.status}.`);
      return null;
    }

    const data = await res.json();
    const priceInfo = data?.priceInfo;
    if (!priceInfo || priceInfo.lastPrice == null) {
      console.error(`[NSE] Quote response for ${clean} had no usable priceInfo. Keys received: ${Object.keys(data || {}).join(", ")}`);
      return null;
    }

    const price = priceInfo.lastPrice;
    const prevClose = priceInfo.previousClose ?? price;
    const change = priceInfo.change ?? +(price - prevClose).toFixed(2);
    const changePercent = priceInfo.pChange ?? (prevClose ? +((change / prevClose) * 100).toFixed(2) : 0);

    console.log(`[NSE] Got real quote for ${clean}: ₹${price}`);

    return {
      symbol: clean,
      price,
      change,
      changePercent,
      prevClose,
      source: "live",
      provider: "nse",
      asOf: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`[NSE] Quote fetch for ${clean} threw: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

const BREAKER_NAME = "nse";

/**
 * Public entry point — wraps attemptNseQuote() with an adaptive circuit
 * breaker (see utils/circuitBreaker.js). If NSE has been failing
 * consistently, this skips the attempt entirely rather than paying the
 * latency cost of a cookie handshake + request that's very likely to
 * fail anyway, and automatically resumes trying once its cooldown
 * expires — no hardcoded assumption about NSE's reliability, purely
 * based on this app's own recent real-world experience calling it.
 */
export async function getNseQuote(symbol) {
  if (isCircuitOpen(BREAKER_NAME)) return null;

  const result = await attemptNseQuote(symbol);
  if (result) {
    recordSuccess(BREAKER_NAME);
  } else {
    recordFailure(BREAKER_NAME);
  }
  return result;
}
