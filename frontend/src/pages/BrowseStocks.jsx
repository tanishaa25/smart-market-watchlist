import { useCallback, useEffect, useState } from "react";
import { fetchStocks, fetchWatchlist, addSymbol, fetchQuotes } from "../api.js";

export default function BrowseStocks() {
  const [stocks, setStocks] = useState([]);
  const [quotesBySymbol, setQuotesBySymbol] = useState({});
  const [watchlistedSymbols, setWatchlistedSymbols] = useState(new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [addingSymbol, setAddingSymbol] = useState(null);
  const [error, setError] = useState("");

  const loadWatchlistSymbols = useCallback(async () => {
    try {
      const { items } = await fetchWatchlist();
      setWatchlistedSymbols(new Set(items.map((i) => i.symbol)));
    } catch {
      // Non-fatal for this page — worst case, buttons don't reflect
      // current watchlist state until the next successful load.
    }
  }, []);

  const loadStocks = useCallback(async (query) => {
    setLoading(true);
    setError("");
    try {
      const { stocks: results } = await fetchStocks(query);
      setStocks(results);
      if (results.length > 0) {
        const { quotes } = await fetchQuotes(results.map((s) => s.symbol));
        const map = {};
        quotes.forEach((q) => (map[q.symbol] = q));
        setQuotesBySymbol(map);
      } else {
        setQuotesBySymbol({});
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWatchlistSymbols();
  }, [loadWatchlistSymbols]);

  // Debounce search-as-you-type so we don't fire a request per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => loadStocks(search), 250);
    return () => clearTimeout(handle);
  }, [search, loadStocks]);

  async function handleAdd(symbol) {
    setAddingSymbol(symbol);
    setError("");
    try {
      await addSymbol(symbol, "");
      setWatchlistedSymbols((prev) => new Set(prev).add(symbol));
    } catch (err) {
      setError(err.message);
    } finally {
      setAddingSymbol(null);
    }
  }

  return (
    <div className="page">
      <header>
        <h1>Browse Stocks</h1>
        <p className="tagline">Search the full list and add anything you want to track.</p>
      </header>

      <input
        type="text"
        className="search-input"
        placeholder="Search by symbol or company name..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus
      />

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <p className="muted">Loading stocks...</p>
      ) : stocks.length === 0 ? (
        <div className="empty-state">
          <p>No stocks match "{search}".</p>
        </div>
      ) : (
        <table className="watchlist-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Company</th>
              <th>Sector</th>
              <th>Price</th>
              <th>Change</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {stocks.map((stock) => {
              const quote = quotesBySymbol[stock.symbol];
              const isUp = quote && quote.change >= 0;
              const isWatchlisted = watchlistedSymbols.has(stock.symbol);
              return (
                <tr key={stock.symbol}>
                  <td className="symbol">{stock.symbol}</td>
                  <td>{stock.name}</td>
                  <td className="muted">{stock.sector}</td>
                  <td className="price-cell">{quote ? `₹${quote.price.toFixed(2)}` : "—"}</td>
                  <td className={`change-cell ${quote ? (isUp ? "up" : "down") : ""}`}>
                    {quote
                      ? `${isUp ? "+" : ""}${quote.change.toFixed(2)} (${isUp ? "+" : ""}${quote.changePercent.toFixed(2)}%)`
                      : "—"}
                  </td>
                  <td>
                    <button
                      className={isWatchlisted ? "added-btn" : "add-btn"}
                      onClick={() => handleAdd(stock.symbol)}
                      disabled={isWatchlisted || addingSymbol === stock.symbol}
                      title={isWatchlisted ? "Already on your watchlist" : "Add to watchlist"}
                    >
                      {isWatchlisted ? "✓" : addingSymbol === stock.symbol ? "…" : "+"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
