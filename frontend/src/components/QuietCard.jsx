export default function QuietCard({ quietCount, totalCount, nextCatalyst }) {
  return (
    <div className="quiet-card">
      <div className="quiet-icon">✓</div>
      <p className="quiet-message">
        {quietCount} of {totalCount} name{totalCount === 1 ? "" : "s"} moved within{" "}
        {totalCount === 1 ? "its" : "their"} normal range.
      </p>
      {nextCatalyst && (
        <p className="quiet-catalyst">
          Next catalyst: {nextCatalyst.symbol} earnings in {nextCatalyst.days} day
          {nextCatalyst.days === 1 ? "" : "s"}.
        </p>
      )}
    </div>
  );
}
