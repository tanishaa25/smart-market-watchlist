import { Fragment } from "react";
import StockRow from "./StockRow.jsx";

export default function WatchlistTable({ items, quotesBySymbol, onRemove, removingSymbol, emptyMessage, onReviewed, marketOpen, onShowHistory, onShowScoreBreakdown }) {
  if (items.length === 0) {
    return (
      <div className="empty-state">
        <p>{emptyMessage || "Your watchlist is empty."}</p>
        {!emptyMessage && <p className="muted">Add a ticker above to start tracking it.</p>}
      </div>
    );
  }

  return (
    <table className="watchlist-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Price</th>
          <th>Trend</th>
          <th>Today</th>
          <th>Since Last Check</th>
          <th>Data</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <Fragment key={item.symbol}>
            <StockRow
              item={item}
              quote={quotesBySymbol[item.symbol]}
              onRemove={onRemove}
              removing={removingSymbol === item.symbol}
              onReviewed={onReviewed}
              marketOpen={marketOpen}
              onShowHistory={onShowHistory}
              onShowScoreBreakdown={onShowScoreBreakdown}
            />
            {item.explanation && (
              <tr className="insight-row">
                <td colSpan={7}>
                  <span className="insight-icon">💡</span>
                  <span className="insight-text">{item.explanation}</span>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
