import { useEffect, useState } from "react";
import { fetchStockHistory } from "../api.js";

const BUCKET_LABEL = {
  attention: "Needs Attention",
  notable: "Notable",
  quiet: "Quiet",
};

export default function StockHistoryModal({ symbol, onClose }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { history: records } = await fetchStockHistory(symbol);
        if (!cancelled) setHistory(records);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return (
    <div className="briefing-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="briefing-panel" onClick={(e) => e.stopPropagation()}>
        <div className="briefing-header">
          <h2>{symbol} History</h2>
          <p className="briefing-subtitle">What this app has flagged, day by day</p>
        </div>

        <div className="briefing-body">
          {error && <div className="error-banner">{error}</div>}
          {!error && history === null && <p className="muted">Loading history...</p>}
          {!error && history?.length === 0 && <p className="muted">No history recorded yet for this stock.</p>}
          {history?.map((day) => (
            <div key={day.dateBucket} className={`briefing-card briefing-${day.bucket}`}>
              <div className="briefing-card-top">
                <span className="briefing-symbol">{day.dateBucket}</span>
                <span className="briefing-bucket-label">{BUCKET_LABEL[day.bucket]}</span>
                <span className="briefing-score">{Math.round(day.score * 100)}</span>
              </div>
              <p className="briefing-explanation">
                {day.zScore >= 0 ? "+" : ""}
                {day.zScore.toFixed(1)}σ move · {day.volumeRatio.toFixed(1)}× volume
                {day.updateCount > 1 ? ` · checked ${day.updateCount}×` : ""}
              </p>
            </div>
          ))}
        </div>

        <button type="button" className="briefing-dismiss-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
