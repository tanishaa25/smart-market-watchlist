import { useState } from "react";
import { Link } from "react-router-dom";
import Sparkline from "./Sparkline.jsx";
import StalenessDot from "./StalenessDot.jsx";
import { markReviewed } from "../api.js";

const SOURCE_LABEL = {
  live: { text: "Live", className: "badge badge-live" },
  cached: { text: "Cached", className: "badge badge-cached" },
  simulated: { text: "Simulated", className: "badge badge-simulated" },
};

function timeAgo(isoString) {
  if (!isoString) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const SIGNIFICANCE_LABEL = {
  quiet: null, // don't clutter the row for the common/expected case
  notable: { text: "Notable", className: "sig-badge sig-notable" },
  attention: { text: "Needs Attention", className: "sig-badge sig-attention" },
};

export default function StockRow({ item, quote, onRemove, removing, onReviewed, marketOpen, onShowHistory, onShowScoreBreakdown }) {
  const [reviewing, setReviewing] = useState(false);
  const displayPrice = quote ? quote.price : item.currentPrice;
  const hasLiveChange = Boolean(quote);
  const isUp = quote && quote.change >= 0;
  const sourceInfo = quote ? SOURCE_LABEL[quote.source] ?? SOURCE_LABEL.simulated : null;

  const sls = item.sinceLastSeen;
  const slsUp = sls && sls.change >= 0;

  const sig = item.significance;
  const sigLabel = sig ? SIGNIFICANCE_LABEL[sig.bucket] : null;

  async function handleMarkReviewed() {
    setReviewing(true);
    try {
      await markReviewed(item.symbol);
      onReviewed?.(item.symbol);
    } catch {
      // Non-critical — worst case the "new" pill just stays until the next successful attempt.
    } finally {
      setReviewing(false);
    }
  }

  return (
    <tr>
      <td>
        <div className="symbol-cell">
          <div className="symbol-line">
            <Link to={`/stock/${item.symbol}`} className="symbol">
              {item.symbol}
            </Link>
            {sigLabel && (
              <button
                type="button"
                className={`${sigLabel.className} sig-badge-btn`}
                onClick={() => onShowScoreBreakdown?.(item.symbol, sig)}
                title="Tap to see the score breakdown"
              >
                {sigLabel.text}
                {item.isNewSignificance && <span className="new-dot" title="New — not yet reviewed" />}
              </button>
            )}
            {sig?.isVolumeSpike && (
              <span className="sig-badge sig-volume" title={`Volume is ${sig.volumeRatio}x normal today`}>
                📊 {sig.volumeRatio}x volume
              </span>
            )}
            {item.isNewSignificance && (
              <button className="review-btn" onClick={handleMarkReviewed} disabled={reviewing}>
                {reviewing ? "..." : "Got it"}
              </button>
            )}
          </div>
          {item.note && <span className="note">{item.note}</span>}
          <button type="button" className="history-link" onClick={() => onShowHistory?.(item.symbol)}>
            History
          </button>
        </div>
      </td>
      <td className="price-cell">
        {quote && <StalenessDot asOf={quote.asOf} marketOpen={marketOpen} />}
        {displayPrice != null ? `₹${displayPrice.toFixed(2)}` : "—"}
      </td>
      <td>
        <Sparkline data={item.sparkline} absencePoints={sig?.daysAway ?? 0} />
      </td>
      <td className={`change-cell ${hasLiveChange ? (isUp ? "up" : "down") : ""}`}>
        {hasLiveChange
          ? `${isUp ? "+" : ""}${quote.change.toFixed(2)} (${isUp ? "+" : ""}${quote.changePercent.toFixed(2)}%)`
          : "—"}
      </td>
      <td>
        {sls ? (
          <span className={`since-badge ${slsUp ? "up" : "down"}`}>
            {slsUp ? "+" : ""}
            {sls.change.toFixed(2)} ({slsUp ? "+" : ""}
            {sls.changePercent.toFixed(2)}%)
            <span className="since-when"> since {timeAgo(sls.previousSeenAt)}</span>
            {sls.sourceMismatch && (
              <span
                className="mismatch-note"
                title="This diff compares prices from two different data providers — treat it as approximate."
              >
                ⚠ approx.
              </span>
            )}
          </span>
        ) : (
          <span className="since-badge neutral">First time watching</span>
        )}
      </td>
      <td>
        {sourceInfo && <span className={sourceInfo.className}>{sourceInfo.text}</span>}
        {quote?.confidence === "low" && (
          <span
            className="confidence-low"
            title={
              quote.disagreement
                ? `NSE says ₹${quote.disagreement.nsePrice}, Yahoo says ₹${quote.disagreement.yahooPrice} (${quote.disagreement.diffPct}% apart) — sources disagree right now.`
                : "Data sources disagree right now."
            }
          >
            ⚠ low confidence
          </span>
        )}
        {item.significance?.frozen && (
          <span className="confidence-low" title="Price hasn't changed in 10+ minutes — treated as unreliable for scoring right now.">
            🧊 frozen
          </span>
        )}
        {quote && <span className="updated-at">{timeAgo(quote.asOf)}</span>}
      </td>
      <td>
        <button
          className="remove-btn"
          onClick={() => onRemove(item.symbol)}
          disabled={removing}
          title={removing ? "Removing..." : "Remove from watchlist"}
        >
          {removing ? "…" : "✕"}
        </button>
      </td>
    </tr>
  );
}
