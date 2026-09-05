// Real (delayed) Indian market quotes — via Yahoo Finance's public chart
// endpoint. This exists specifically to cover the gap Finnhub can't:
// Finnhub's free tier is US-market only, so NSE/BSE symbols (RELIANCE,
// TCS, INFY, etc.) never get real trade data from it — see
// finnhubStream.js. This service is what lets those symbols show real
// prices instead of falling straight to simulated data.
//
// IMPORTANT HONESTY NOTES:
//
// 1. UNOFFICIAL: this endpoint isn't a published, contractually
//    supported API — Yahoo doesn't document it. It's the same underlying
//    data source the widely-used `yfinance` Python library relies on,
//    and it's free with no signup, but it could change or start blocking
//    requests at any time without notice. If it fails, every caller of
//    this module already treats a null return as "try the next fallback"
//    — see priceService.js and finnhubStream.js — so the app itself
//    never breaks, it just drops one level further down the fallback
//    chain (eventually to simulated data, worst case).
//
// 2. DELAYED, NOT TICK-BY-TICK: free/public Indian market feeds are
//    typically ~15 minutes behind the true live tape, unlike Finnhub's
//    real-time WebSocket for US stocks. We still tag these quotes
//    "live" (they ARE real trades, not synthetic) rather than inventing
//    a fourth source tag — but they update on a slower poll interval
//    than the WebSocket path, by design (see REAL_POLL_INTERVAL_MS in
//    finnhubStream.js) rather than pretending to be sub-second.

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const TIMEOUT_MS = 6000;

import { isCircuitOpen, recordSuccess, recordFailure } from "../utils/circuitBreaker.js";
const BREAKER_NAME = "yahoo";

/**
 * Fetches a real quote for an Indian-listed symbol.
 * @param {string} symbol - bare ticker, e.g. "RELIANCE" (no exchange suffix)
 * @param {string} exchangeSuffix - ".NS" for NSE (default) or ".BO" for BSE
 * @returns the quote object, or null if unavailable (unknown symbol,
 *          network failure, endpoint blocked, etc.) — never throws.
 */
async function attemptIndianQuote(symbol, exchangeSuffix = ".NS") {
  if (process.env.FORCE_SIMULATED === "true") return null; // testing override — see .env.example

  const clean = symbol.trim().toUpperCase();
  const yahooSymbol = `${clean}${exchangeSuffix}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(
      `${YAHOO_CHART_URL}/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`,
      {
        signal: controller.signal,
        headers: {
          // This endpoint rejects requests with no User-Agent.
          "User-Agent": "Mozilla/5.0 (compatible; SmartMarketWatchlist/1.0)",
        },
      }
    );
    if (!res.ok) {
      console.error(`[Yahoo] Quote fetch for ${yahooSymbol} failed with status ${res.status}.`);
      return null;
    }

    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) {
      const errorInfo = data?.chart?.error;
      console.error(
        `[Yahoo] Quote response for ${yahooSymbol} had no usable price.${errorInfo ? ` API error: ${JSON.stringify(errorInfo)}` : ""}`
      );
      return null;
    }

    const price = meta.regularMarketPrice;
    const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
    const change = +(price - prevClose).toFixed(2);
    const changePercent = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;

    console.log(`[Yahoo] Got real quote for ${clean}: ₹${price}`);

    return {
      symbol: clean,
      price,
      change,
      changePercent,
      prevClose,
      source: "live",
      provider: "yahoo",
      asOf: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`[Yahoo] Quote fetch for ${yahooSymbol} threw: ${err.message}`);
    return null; // network error, timeout, unknown symbol, endpoint blocked — caller falls back
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Public entry point — wraps attemptIndianQuote() with an adaptive
 * circuit breaker (see utils/circuitBreaker.js). If Yahoo has been
 * failing consistently, this skips the attempt entirely instead of
 * paying the latency cost of a request very likely to fail, and
 * automatically resumes trying once its cooldown expires.
 */
export async function getIndianQuote(symbol, exchangeSuffix = ".NS") {
  if (isCircuitOpen(BREAKER_NAME)) return null;

  const result = await attemptIndianQuote(symbol, exchangeSuffix);
  if (result) {
    recordSuccess(BREAKER_NAME);
  } else {
    recordFailure(BREAKER_NAME);
  }
  return result;
}
