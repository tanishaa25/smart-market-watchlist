import { describe, it, expect } from "vitest";
import { buildNarrative } from "../services/narrativeService.js";
import { recordRealPrice, isFrozen, _resetForTests } from "../services/frozenQuoteDetector.js";

describe("buildNarrative — determinism", () => {
  it("produces byte-identical output for identical inputs, unlike an LLM call", () => {
    const inputs = {
      symbol: "ITC",
      bucket: "attention",
      changePercent: 2.1,
      zScore: 2.5,
      volumeRatio: 2.2,
      isVolumeSpike: true,
      gapSignal: 0.6,
      sector: "Consumer Staples",
      sectorAvgChangePercent: 0.2,
      nextEarningsDays: 2,
    };
    expect(buildNarrative(inputs)).toBe(buildNarrative(inputs));
  });

  it("states both legs explicitly for a mixed-signal move", () => {
    const text = buildNarrative({
      symbol: "TCS",
      bucket: "notable",
      changePercent: 1.2,
      zScore: 1.5,
      volumeRatio: 1.2,
      isVolumeSpike: false,
      gapSignal: 0.2,
      mixedSignal: true,
      sinceLastSeenChangePercent: -3.8,
    });
    expect(text).toContain("up 1.2% today");
    expect(text).toContain("down 3.8% since you last checked");
  });

  it("never invents a reason for a quiet stock", () => {
    const text = buildNarrative({ symbol: "RELIANCE", bucket: "quiet", changePercent: 0.3 });
    expect(text).toContain("within its normal range");
  });
});

describe("frozenQuoteDetector", () => {
  const t0 = 1_000_000;

  it("is not frozen with fewer than 2 samples, or too short a time span", () => {
    _resetForTests("A");
    recordRealPrice("A", 100, t0);
    expect(isFrozen("A")).toBe(false);

    _resetForTests("B");
    recordRealPrice("B", 100, t0);
    recordRealPrice("B", 100, t0 + 60_000); // only 1 minute
    expect(isFrozen("B")).toBe(false);
  });

  it("flags as frozen once the same price has held for 10+ minutes", () => {
    _resetForTests("C");
    recordRealPrice("C", 100, t0);
    recordRealPrice("C", 100, t0 + 11 * 60_000);
    expect(isFrozen("C")).toBe(true);
  });

  it("does not flag as frozen if the price genuinely moved partway through the window", () => {
    _resetForTests("D");
    recordRealPrice("D", 100, t0);
    recordRealPrice("D", 100, t0 + 5 * 60_000);
    recordRealPrice("D", 101, t0 + 8 * 60_000);
    recordRealPrice("D", 101, t0 + 11 * 60_000);
    expect(isFrozen("D")).toBe(false); // only 3 min at the new price
  });
});
