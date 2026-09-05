import { describe, it, expect } from "vitest";
import { computeSignificance, computeConfluenceMultiplier, assembleScore, meetsBriefingThreshold } from "../services/significanceService.js";

describe("computeConfluenceMultiplier", () => {
  it("applies no adjustment when nothing crosses the confirmation threshold (n=0)", () => {
    const r = computeConfluenceMultiplier({ priceZScore: 0.2, volume: 0.3, extremum52w: 0, regime: 0, gap: 0, catalyst: 0 });
    expect(r.n).toBe(0);
    expect(r.multiplier).toBe(1);
  });

  it("applies no bonus for a single confirming signal (n=1)", () => {
    const r = computeConfluenceMultiplier({ priceZScore: 0.7, volume: 0.3, extremum52w: 0, regime: 0, gap: 0, catalyst: 0 });
    expect(r.n).toBe(1);
    expect(r.multiplier).toBe(1);
  });

  it("matches the source blueprint's own worked Example A exactly (S1+S2 firing -> 1.35)", () => {
    const r = computeConfluenceMultiplier({ priceZScore: 0.67, volume: 0.93, extremum52w: 0, regime: 0, gap: 0.3, catalyst: 0 });
    expect(r.n).toBe(2);
    expect(r.multiplier).toBeCloseTo(1.35, 5);
  });

  it("caps the multiplier at 1.7 even with 4+ confirming signals plus the pair bonus", () => {
    const r = computeConfluenceMultiplier({ priceZScore: 0.8, volume: 0.7, extremum52w: 0.6, regime: 0.55, gap: 0, catalyst: 0 });
    expect(r.multiplier).toBe(1.7);
  });

  it("never lets catalyst proximity alone manufacture confluence", () => {
    const r = computeConfluenceMultiplier({ priceZScore: 0.2, volume: 0.2, extremum52w: 0, regime: 0, gap: 0, catalyst: 0.9 });
    expect(r.n).toBe(0);
    expect(r.multiplier).toBe(1);
  });

  it("does count catalyst when at least one other signal also fires", () => {
    const r = computeConfluenceMultiplier({ priceZScore: 0.6, volume: 0.2, extremum52w: 0, regime: 0, gap: 0, catalyst: 0.9 });
    expect(r.n).toBe(2);
  });
});

describe("meetsBriefingThreshold (sensitivity profiles)", () => {
  it("the identical score qualifies under Active but not under Calm or Balanced", () => {
    expect(meetsBriefingThreshold(0.6, "calm")).toBe(false);
    expect(meetsBriefingThreshold(0.6, "balanced")).toBe(false);
    expect(meetsBriefingThreshold(0.6, "active")).toBe(true);
  });

  it("a high score qualifies under every sensitivity", () => {
    expect(meetsBriefingThreshold(0.9, "calm")).toBe(true);
    expect(meetsBriefingThreshold(0.9, "balanced")).toBe(true);
    expect(meetsBriefingThreshold(0.9, "active")).toBe(true);
  });
});

describe("computeSignificance — absence scaling (sqrt(t))", () => {
  it("the SAME raw % move scores dramatically less significant after a longer absence", () => {
    const shortAbsence = computeSignificance({ symbol: "RELIANCE", changePercent: 3, currentPrice: 1322, daysAway: 20 / (60 * 24) });
    const longAbsence = computeSignificance({ symbol: "RELIANCE", changePercent: 3, currentPrice: 1322, daysAway: 30 });
    expect(Math.abs(shortAbsence.zScore)).toBeGreaterThan(Math.abs(longAbsence.zScore));
    expect(shortAbsence.signals.priceZScore).toBeGreaterThan(longAbsence.signals.priceZScore);
  });
});

describe("computeSignificance — sanity properties (score bounds, monotonicity)", () => {
  it("score is always within [0, 1]", () => {
    const scenarios = [
      { changePercent: 0.1, daysAway: 1 },
      { changePercent: 15, daysAway: 0.01 },
      { changePercent: -8, daysAway: 90 },
    ];
    for (const s of scenarios) {
      const r = computeSignificance({ symbol: "TESTSTOCK", currentPrice: 500, ...s });
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("a larger absolute move (all else equal) never produces a lower score", () => {
    const small = computeSignificance({ symbol: "TESTSTOCK", changePercent: 1, currentPrice: 500, daysAway: 1 });
    const large = computeSignificance({ symbol: "TESTSTOCK", changePercent: 5, currentPrice: 500, daysAway: 1 });
    expect(large.score).toBeGreaterThanOrEqual(small.score);
  });
});

describe("assembleScore — frozen quote penalty", () => {
  it("a frozen quote produces a lower score than the identical unfrozen inputs, with weights renormalized to sum to 1", () => {
    const rawSignals = {
      symbol: "TEST",
      changePercent: 4.5,
      dailyVolatilityPct: 0.8,
      volumeRatio: 1,
      isVolumeSpike: false,
      price: 100,
      signals: { volume: 0.1, extremum52w: 0, regime: 0, gap: 0.4, catalyst: 0 },
    };
    const normal = assembleScore({ rawSignals, daysAway: 1 });
    const frozen = assembleScore({ rawSignals, daysAway: 1, frozen: true });

    expect(frozen.score).toBeLessThan(normal.score);
    const weightSum = Object.values(frozen.weights).reduce((a, b) => a + b, 0);
    expect(weightSum).toBeCloseTo(1, 5);
  });
});

describe("assembleScore — sector modifier", () => {
  it("boosts the price signal for an idiosyncratic move and dampens it for a beta-explained one", () => {
    const rawSignals = {
      symbol: "TEST",
      changePercent: 2,
      dailyVolatilityPct: 1,
      volumeRatio: 1,
      isVolumeSpike: false,
      price: 100,
      signals: { volume: 0.1, extremum52w: 0, regime: 0, gap: 0.1, catalyst: 0 },
    };
    const baseline = assembleScore({ rawSignals, daysAway: 1, sectorAvgChangePercent: null });
    const idiosyncratic = assembleScore({ rawSignals, daysAway: 1, sectorAvgChangePercent: 0.1 });
    const betaExplained = assembleScore({ rawSignals, daysAway: 1, sectorAvgChangePercent: 1.6 });

    expect(idiosyncratic.signals.priceZScore).toBeGreaterThan(baseline.signals.priceZScore);
    expect(betaExplained.signals.priceZScore).toBeLessThan(baseline.signals.priceZScore);
    expect(betaExplained.betaExplained).toBe(true);
    expect(idiosyncratic.betaExplained).toBe(false);
  });
});
