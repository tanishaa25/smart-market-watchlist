import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import Sparkline from "../components/Sparkline.jsx";
import { fetchStockDetail, fetchStockHistory } from "../api.js";

const SIGNAL_META = {
  priceZScore: "Price Move",
  volume: "Volume",
  extremum52w: "52-Week Range",
  regime: "Trend Reversal",
  gap: "Overnight Gap",
  catalyst: "Earnings Proximity",
};

export default function StockDetails() {
  const { symbol } = useParams();
  const [detail, setDetail] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setHistory(null);
    setError("");

    fetchStockDetail(symbol)
      .then((data) => !cancelled && setDetail(data))
      .catch((err) => !cancelled && setError(err.message));

    fetchStockHistory(symbol)
      .then((data) => !cancelled && setHistory(data.history))
      .catch(() => {}); // non-critical for the page — the history section just stays empty

    return () => {
      cancelled = true;
    };
  }, [symbol]);

  if (error) {
    return (
      <div className="page">
        <Link to="/" className="back-link">
          ← Back to Dashboard
        </Link>
        <div className="error-banner">{error}</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="page">
        <Link to="/" className="back-link">
          ← Back to Dashboard
        </Link>
        <p className="muted">Loading {symbol}...</p>
      </div>
    );
  }

  const sig = detail.significance;
  const isUp = detail.change >= 0;

  return (
    <div className="page">
      <Link to="/" className="back-link">
        ← Back to Dashboard
      </Link>

      <header className="stock-detail-header">
        <h1>
          {detail.symbol} {detail.name !== detail.symbol && <span className="stock-detail-name">{detail.name}</span>}
        </h1>
        {detail.sector && <span className="badge badge-cached">{detail.sector}</span>}
      </header>

      <div className="stock-detail-price-row">
        <span className="stock-detail-price">₹{detail.currentPrice.toFixed(2)}</span>
        <span className={`change-cell ${isUp ? "up" : "down"}`}>
          {isUp ? "+" : ""}
          {detail.change.toFixed(2)} ({isUp ? "+" : ""}
          {detail.changePercent.toFixed(2)}%)
        </span>
        {!detail.onWatchlist && <span className="muted">Not on your watchlist</span>}
      </div>

      <div className="stock-detail-chart">
        <Sparkline data={detail.sparkline} width={600} height={140} absencePoints={detail.daysAway} />
      </div>

      <section className="stock-detail-section">
        <h2>Why this matters</h2>
        <p className="muted" style={{ marginBottom: 12 }}>
          Score {Math.round(sig.score * 100)} · {sig.confirmingSignalCount} signal
          {sig.confirmingSignalCount === 1 ? "" : "s"} confirming · {sig.confluenceMultiplier}× confluence
          {sig.betaExplained ? " · mostly sector-driven" : ""}
        </p>
        {Object.entries(SIGNAL_META).map(([key, label]) => (
          <div key={key} className="signal-row">
            <div className="signal-row-top">
              <span className="signal-label">{label}</span>
              <span className="signal-value">{(sig.signals[key] ?? 0).toFixed(2)}</span>
            </div>
            <div className="signal-bar-track">
              <div className="signal-bar-fill" style={{ width: `${Math.round((sig.signals[key] ?? 0) * 100)}%` }} />
            </div>
          </div>
        ))}
      </section>

      {sig.nextEarningsDays != null && (
        <section className="stock-detail-section">
          <h2>Catalyst</h2>
          <p className="muted">
            {detail.symbol} reports earnings in {sig.nextEarningsDays} day{sig.nextEarningsDays === 1 ? "" : "s"}.
          </p>
        </section>
      )}

      <section className="stock-detail-section">
        <h2>Recent history</h2>
        {history === null && <p className="muted">Loading history...</p>}
        {history?.length === 0 && <p className="muted">No history recorded yet for this stock.</p>}
        {history?.map((day) => (
          <div key={day.dateBucket} className="trash-item">
            <span className="trash-symbol">{day.dateBucket}</span>
            <span className="trash-expiry">
              Score {Math.round(day.score * 100)} · {day.bucket}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
