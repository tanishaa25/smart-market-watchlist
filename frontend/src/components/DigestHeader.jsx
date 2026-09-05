const BUCKET_META = {
  attention: { label: "Need Attention", className: "digest-chip digest-attention" },
  notable: { label: "Notable", className: "digest-chip digest-notable" },
  quiet: { label: "Quiet", className: "digest-chip digest-quiet" },
};

export default function DigestHeader({ items, activeBucket, onSelectBucket }) {
  const counts = { attention: 0, notable: 0, quiet: 0 };
  for (const item of items) {
    const bucket = item.significance?.bucket;
    if (bucket && counts[bucket] !== undefined) counts[bucket]++;
  }

  const total = items.length;
  if (total === 0) return null;

  return (
    <div className="digest-header">
      {["attention", "notable", "quiet"].map((bucket) => {
        const meta = BUCKET_META[bucket];
        const count = counts[bucket];
        const isActive = activeBucket === bucket;
        return (
          <button
            key={bucket}
            type="button"
            className={`${meta.className} ${isActive ? "active" : ""} ${count === 0 ? "empty" : ""}`}
            onClick={() => onSelectBucket(isActive ? null : bucket)}
            disabled={count === 0}
          >
            <span className="digest-count">{count}</span> {meta.label}
          </button>
        );
      })}
      {activeBucket && (
        <button type="button" className="digest-clear" onClick={() => onSelectBucket(null)}>
          Show all
        </button>
      )}
    </div>
  );
}
