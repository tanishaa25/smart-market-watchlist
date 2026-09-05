import { describe, it, expect } from "vitest";
import {
  groupEchoes,
  findNextCatalyst,
  splitQuiet,
  rankByBriefingPriority,
  computeStalenessDecay,
  computeBriefingPriority,
  capCatalystCards,
  getMaxDaysAway,
  LONG_ABSENCE_DAYS,
} from "../utils/briefing.js";
import { stalenessColor, stalenessLabel } from "../utils/staleness.js";

describe("groupEchoes", () => {
  it("collapses 3+ same-sector, same-direction moves into one echo group", () => {
    const items = [
      { symbol: "TCS", sector: "Technology", significance: { changePercent: 4.1, score: 0.6 } },
      { symbol: "INFY", sector: "Technology", significance: { changePercent: 3.8, score: 0.55 } },
      { symbol: "WIPRO", sector: "Technology", significance: { changePercent: 4.5, score: 0.7 } },
      { symbol: "RELIANCE", sector: "Energy", significance: { changePercent: 2.0, score: 0.5 } },
    ];
    const { echoGroups, remainingIndividual } = groupEchoes(items);
    expect(echoGroups).toHaveLength(1);
    expect(echoGroups[0].members.sort()).toEqual(["INFY", "TCS", "WIPRO"]);
    expect(remainingIndividual.map((i) => i.symbol)).toEqual(["RELIANCE"]);
  });

  it("does not group fewer than 3 members in the same sector", () => {
    const items = [
      { symbol: "TCS", sector: "Technology", significance: { changePercent: 4.1, score: 0.6 } },
      { symbol: "INFY", sector: "Technology", significance: { changePercent: 3.8, score: 0.55 } },
    ];
    expect(groupEchoes(items).echoGroups).toHaveLength(0);
  });

  it("does not group same-sector moves in opposite directions", () => {
    const items = [
      { symbol: "TCS", sector: "Technology", significance: { changePercent: 4.1, score: 0.6 } },
      { symbol: "INFY", sector: "Technology", significance: { changePercent: -3.8, score: 0.55 } },
      { symbol: "WIPRO", sector: "Technology", significance: { changePercent: 4.5, score: 0.7 } },
    ];
    expect(groupEchoes(items).echoGroups).toHaveLength(0);
  });
});

describe("capCatalystCards", () => {
  it("caps catalyst-dominant cards to the closest N earnings, never touching price-driven cards", () => {
    const catalyst = (symbol, days) => ({
      symbol,
      significance: { signals: { priceZScore: 0.1, volume: 0.1, extremum52w: 0, regime: 0, gap: 0, catalyst: 0.9 }, nextEarningsDays: days },
    });
    const priceItem = { symbol: "PRICE", significance: { signals: { priceZScore: 0.8, volume: 0.7, extremum52w: 0, regime: 0, gap: 0, catalyst: 0 }, nextEarningsDays: 60 } };
    const items = [catalyst("D", 10), catalyst("A", 1), catalyst("C", 5), catalyst("B", 3), priceItem];
    const capped = capCatalystCards(items, 2);
    expect(capped.map((i) => i.symbol).sort()).toEqual(["A", "B", "PRICE"]);
  });
});

describe("splitQuiet / rankByBriefingPriority — every item accounted for exactly once", () => {
  it("an item never disappears between flagged and quiet regardless of sensitivity", () => {
    const makeItem = (meetsThreshold) => [
      { symbol: "TCS", isNewSignificance: true, significance: { bucket: "notable", score: 0.6, meetsBriefingThreshold: meetsThreshold, firstComputedAt: new Date().toISOString() } },
    ];
    const underActive = makeItem(true);
    const underCalm = makeItem(false);

    expect(rankByBriefingPriority(underActive).length + splitQuiet(underActive).length).toBe(1);
    expect(rankByBriefingPriority(underCalm).length + splitQuiet(underCalm).length).toBe(1);
  });
});

describe("computeStalenessDecay", () => {
  it("matches the spec's exact 0.85-per-full-day-past-72h formula", () => {
    expect(computeStalenessDecay(0)).toBe(1);
    expect(computeStalenessDecay(71)).toBe(1);
    expect(computeStalenessDecay(96)).toBeCloseTo(0.85, 5);
    expect(computeStalenessDecay(120)).toBeCloseTo(0.7225, 5);
  });
});

describe("computeBriefingPriority — combined ranking", () => {
  it("a fresh lower score can outrank a stale higher score", () => {
    const now = Date.now();
    const stale = { symbol: "STALE", isNewSignificance: true, significance: { score: 0.6, firstComputedAt: new Date(now - 120 * 60 * 60 * 1000).toISOString() } };
    const fresh = { symbol: "FRESH", isNewSignificance: true, significance: { score: 0.55, firstComputedAt: new Date(now - 1 * 60 * 60 * 1000).toISOString() } };
    expect(computeBriefingPriority(fresh, now)).toBeGreaterThan(computeBriefingPriority(stale, now));
  });

  it("an already-reviewed item ranks below an equal-score unreviewed one", () => {
    const now = Date.now();
    const reviewed = { symbol: "SEEN", isNewSignificance: false, significance: { score: 0.5, firstComputedAt: new Date(now).toISOString() } };
    const unreviewed = { symbol: "NEW", isNewSignificance: true, significance: { score: 0.5, firstComputedAt: new Date(now).toISOString() } };
    expect(computeBriefingPriority(unreviewed, now)).toBeGreaterThan(computeBriefingPriority(reviewed, now));
  });
});

describe("getMaxDaysAway", () => {
  it("finds the longest absence across the whole watchlist", () => {
    const items = [{ significance: { daysAway: 2 } }, { significance: { daysAway: 35 } }, { significance: { daysAway: 10 } }];
    expect(getMaxDaysAway(items)).toBe(35);
    expect(getMaxDaysAway(items) > LONG_ABSENCE_DAYS).toBe(true);
  });
});

describe("findNextCatalyst", () => {
  it("finds the soonest earnings date across ALL items, not just flagged ones", () => {
    const items = [
      { symbol: "A", significance: { nextEarningsDays: 40 } },
      { symbol: "B", significance: { nextEarningsDays: 3 } },
      { symbol: "C", significance: null },
    ];
    expect(findNextCatalyst(items)).toEqual({ symbol: "B", days: 3 });
  });
});

describe("stalenessColor", () => {
  it("decays green -> amber -> red at the correct time boundaries", () => {
    const now = Date.now();
    const secondsAgo = (s) => new Date(now - s * 1000).toISOString();
    expect(stalenessColor(secondsAgo(5), now)).toBe("green");
    expect(stalenessColor(secondsAgo(31), now)).toBe("amber");
    expect(stalenessColor(secondsAgo(121), now)).toBe("red");
  });

  it("overrides to a neutral 'closed' state when the market is closed, regardless of age", () => {
    const now = Date.now();
    expect(stalenessColor(new Date(now - 10 * 60 * 1000).toISOString(), now, false)).toBe("closed");
  });
});
