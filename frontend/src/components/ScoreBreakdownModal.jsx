const SIGNAL_META = {
  priceZScore: { label: "Price Move", key: "priceZScore" },
  volume: { label: "Volume", key: "volume" },
  extremum52w: { label: "52-Week Range", key: "extremum52w" },
  regime: { label: "Trend Reversal", key: "regime" },
  gap: { label: "Overnight Gap", key: "gap" },
  catalyst: { label: "Earnings Proximity", key: "catalyst" },
};

function explainSignal(key, sig) {
  switch (key) {
    case "priceZScore":
      return `z = ${sig.zScore.toFixed(2)} (move ${sig.changePercent >= 0 ? "+" : ""}${sig.changePercent.toFixed(
        2
      )}%, daily volatility ${sig.dailyVolatilityPct.toFixed(2)}%, ${sig.daysAway.toFixed(1)} day${
        sig.daysAway === 1 ? "" : "s"
      } away)`;
    case "volume":
      return `${sig.volumeRatio.toFixed(1)}\u00d7 the typical daily volume${sig.isVolumeSpike ? " \u2014 a real spike" : ""}`;
    case "extremum52w":
      return sig.signals.extremum52w >= 0.6 ? "trading near a 52-week high or low" : "within its normal 52-week range";
    case "regime":
      return sig.signals.regime > 0 ? "a short/long trend crossover was detected recently" : "no trend reversal detected";
    case "gap":
      return sig.signals.gap >= 0.5 ? "most of today's move happened at the open" : "little of today's move was an opening gap";
    case "catalyst":
      return sig.nextEarningsDays != null ? `earnings in ${sig.nextEarningsDays} day${sig.nextEarningsDays === 1 ? "" : "s"}` : "no upcoming earnings data";
    default:
      return "";
  }
}

export default function ScoreBreakdownModal({ symbol, significance, onClose }) {
  const sig = significance;

  return (
    <div className="briefing-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="briefing-panel" onClick={(e) => e.stopPropagation()}>
        <div className="briefing-header">
          <h2>{symbol} Score Breakdown</h2>
          <p className="briefing-subtitle">
            Score {Math.round(sig.score * 100)} \u00b7 {sig.confirmingSignalCount} signal
            {sig.confirmingSignalCount === 1 ? "" : "s"} confirming \u00b7 {sig.confluenceMultiplier}\u00d7 confluence
            {sig.betaExplained ? " \u00b7 mostly sector-driven" : ""}
          </p>
        </div>

        <div className="briefing-body">
          {Object.entries(SIGNAL_META).map(([key, meta]) => {
            const value = sig.signals[key] ?? 0;
            return (
              <div key={key} className="signal-row">
                <div className="signal-row-top">
                  <span className="signal-label">{meta.label}</span>
                  <span className="signal-value">{value.toFixed(2)}</span>
                </div>
                <div className="signal-bar-track">
                  <div className="signal-bar-fill" style={{ width: `${Math.round(value * 100)}%` }} />
                </div>
                <p className="signal-explanation">{explainSignal(key, sig)}</p>
              </div>
            );
          })}
        </div>

        <button type="button" className="briefing-dismiss-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
