export default function Sparkline({ data, width = 64, height = 24, absencePoints = 0 }) {
  if (!data || data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1; // avoid divide-by-zero on a perfectly flat line

  const xFor = (i) => (i / (data.length - 1)) * width;

  const points = data
    .map((value, i) => {
      const y = height - ((value - min) / range) * height;
      return `${xFor(i).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const isUp = data[data.length - 1] >= data[0];
  const stroke = isUp ? "#1a8a4a" : "#c0392b";

  // Shades the trailing portion of the sparkline corresponding to "the
  // period since you last checked" — the user's absence drawn directly
  // on the chart, not just implied by a separate text column. The
  // underlying history is a fixed synthetic series (see
  // significanceService.js), not literal calendar dates, so this is an
  // honest visual approximation of "roughly how much of this recent
  // window you were away for," not a precise date-aligned shading.
  const clampedAbsence = Math.max(0, Math.min(Math.round(absencePoints), data.length - 1));
  const shadeStartX = clampedAbsence > 0 ? xFor(data.length - 1 - clampedAbsence) : null;

  return (
    <svg width={width} height={height} className="sparkline" viewBox={`0 0 ${width} ${height}`}>
      {shadeStartX != null && (
        <rect x={shadeStartX} y={0} width={width - shadeStartX} height={height} fill="#f5a623" fillOpacity="0.18" />
      )}
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
