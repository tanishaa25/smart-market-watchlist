export default function SkeletonRows({ count = 4 }) {
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
        {Array.from({ length: count }).map((_, i) => (
          <tr key={i} className="skeleton-row">
            <td>
              <div className="skeleton-bar skeleton-symbol-bar" />
            </td>
            <td>
              <div className="skeleton-bar skeleton-price-bar" />
            </td>
            <td>
              <div className="skeleton-bar skeleton-sparkline-bar" />
            </td>
            <td>
              <div className="skeleton-bar skeleton-change-bar" />
            </td>
            <td>
              <div className="skeleton-bar skeleton-change-bar" />
            </td>
            <td>
              <div className="skeleton-bar skeleton-badge-bar" />
            </td>
            <td>
              <div className="skeleton-bar skeleton-icon-bar" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
