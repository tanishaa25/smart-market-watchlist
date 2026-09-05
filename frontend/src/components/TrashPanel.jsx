import { useState } from "react";

export default function TrashPanel({ trashedItems, onRestore }) {
  const [expanded, setExpanded] = useState(false);
  const [restoringSymbol, setRestoringSymbol] = useState(null);

  if (trashedItems.length === 0) return null;

  async function handleRestore(symbol) {
    setRestoringSymbol(symbol);
    try {
      await onRestore(symbol);
    } finally {
      setRestoringSymbol(null);
    }
  }

  return (
    <div className="trash-panel">
      <button type="button" className="trash-toggle" onClick={() => setExpanded(!expanded)}>
        🗑️ Recently removed ({trashedItems.length}) {expanded ? "▲" : "▼"}
      </button>
      {expanded && (
        <ul className="trash-list">
          {trashedItems.map((item) => (
            <li key={item.symbol} className="trash-item">
              <span className="trash-symbol">{item.symbol}</span>
              <span className="trash-expiry">
                {item.daysUntilPurge === 0
                  ? "removed today — gone for good tomorrow"
                  : `gone for good in ${item.daysUntilPurge} day${item.daysUntilPurge === 1 ? "" : "s"}`}
              </span>
              <button
                type="button"
                className="trash-restore-btn"
                onClick={() => handleRestore(item.symbol)}
                disabled={restoringSymbol === item.symbol}
              >
                {restoringSymbol === item.symbol ? "Restoring..." : "Restore"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
