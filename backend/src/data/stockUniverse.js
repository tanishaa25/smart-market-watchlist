// A curated list of well-known NSE-listed stocks to power the "Browse
// all stocks" page, its search, and the AI explainer's company/sector
// context. This is intentionally a static list, not a live symbol-search
// API call — it's simple, has zero rate-limit risk, and is enough to
// demonstrate search + browse + add-to-watchlist end to end.
//
// INDIAN-ONLY BY DESIGN: this app's real (non-simulated) data sources —
// NSE's direct quote endpoint and Yahoo's Indian-market feed (see
// services/nseDirectService.js and services/indianMarketService.js) —
// only cover NSE/BSE-listed equities. Finnhub (US-market real-time) is
// still tried first in the fallback chain for opportunistic coverage if
// someone manually adds a non-Indian symbol, but this curated list only
// surfaces stocks the app can realistically get real, live data for.
//
// Swap this for a real symbol-search API later without touching any
// other part of the app — routes/stocks.js is the only place that reads
// this file.

export const STOCK_UNIVERSE = [
  { symbol: "RELIANCE", name: "Reliance Industries Ltd.", sector: "Energy" },
  { symbol: "TCS", name: "Tata Consultancy Services Ltd.", sector: "Technology" },
  { symbol: "INFY", name: "Infosys Ltd.", sector: "Technology" },
  { symbol: "HDFCBANK", name: "HDFC Bank Ltd.", sector: "Financials" },
  { symbol: "ICICIBANK", name: "ICICI Bank Ltd.", sector: "Financials" },
  { symbol: "ITC", name: "ITC Ltd.", sector: "Consumer Staples" },
  { symbol: "SBIN", name: "State Bank of India", sector: "Financials" },
  { symbol: "TATAMOTORS", name: "Tata Motors Ltd.", sector: "Consumer Discretionary" },
  { symbol: "WIPRO", name: "Wipro Ltd.", sector: "Technology" },
  { symbol: "SUNPHARMA", name: "Sun Pharmaceutical Industries Ltd.", sector: "Healthcare" },
  { symbol: "BHARTIARTL", name: "Bharti Airtel Ltd.", sector: "Communication Services" },
  { symbol: "ASIANPAINT", name: "Asian Paints Ltd.", sector: "Materials" },
  { symbol: "HCLTECH", name: "HCL Technologies Ltd.", sector: "Technology" },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank Ltd.", sector: "Financials" },
  { symbol: "AXISBANK", name: "Axis Bank Ltd.", sector: "Financials" },
  { symbol: "LT", name: "Larsen & Toubro Ltd.", sector: "Industrials" },
  { symbol: "MARUTI", name: "Maruti Suzuki India Ltd.", sector: "Consumer Discretionary" },
  { symbol: "TITAN", name: "Titan Company Ltd.", sector: "Consumer Discretionary" },
  { symbol: "ULTRACEMCO", name: "UltraTech Cement Ltd.", sector: "Materials" },
  { symbol: "NESTLEIND", name: "Nestle India Ltd.", sector: "Consumer Staples" },
  { symbol: "BAJFINANCE", name: "Bajaj Finance Ltd.", sector: "Financials" },
  { symbol: "ONGC", name: "Oil and Natural Gas Corporation Ltd.", sector: "Energy" },
  { symbol: "POWERGRID", name: "Power Grid Corporation of India Ltd.", sector: "Utilities" },
  { symbol: "NTPC", name: "NTPC Ltd.", sector: "Utilities" },
  { symbol: "ADANIENT", name: "Adani Enterprises Ltd.", sector: "Industrials" },
  { symbol: "ADANIPORTS", name: "Adani Ports and Special Economic Zone Ltd.", sector: "Industrials" },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever Ltd.", sector: "Consumer Staples" },
  { symbol: "TECHM", name: "Tech Mahindra Ltd.", sector: "Technology" },
  { symbol: "JSWSTEEL", name: "JSW Steel Ltd.", sector: "Materials" },
  { symbol: "TATASTEEL", name: "Tata Steel Ltd.", sector: "Materials" },
];

// Quick lookup for symbols outside the curated browse list — used to give
// the AI explainer real company/sector context when available, without
// needing a separate lookup service. Returns null (not an object with
// blank fields) when unknown, so callers can omit that context cleanly.
const BY_SYMBOL = new Map(STOCK_UNIVERSE.map((s) => [s.symbol, s]));

export function lookupStock(symbol) {
  return BY_SYMBOL.get(symbol.trim().toUpperCase()) ?? null;
}
