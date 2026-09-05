import { useState } from "react";

export default function AddStockForm({ onAdd, isSubmitting }) {
  const [symbol, setSymbol] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!symbol.trim()) {
      setError("Enter a ticker symbol, e.g. RELIANCE");
      return;
    }
    try {
      await onAdd(symbol.trim(), note.trim());
      setSymbol("");
      setNote("");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <form className="add-form" onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="NSE ticker (e.g. RELIANCE, TCS, INFY)"
        value={symbol}
        onChange={(e) => setSymbol(e.target.value)}
        maxLength={12}
      />
      <input
        type="text"
        placeholder="Why are you watching this? (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={80}
      />
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Adding..." : "Add to watchlist"}
      </button>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}
