// Detects when the "since you last checked" diff is comparing prices
// from two DIFFERENT real data providers (e.g., the baseline came from
// Yahoo, but today's price came from NSE) — a subtle correctness issue
// that's almost impossible to notice without deliberately looking for
// it. Different providers can have small methodology differences
// (after-hours handling, rounding, exchange conventions), so blending
// them into one diff number can be silently misleading even though
// neither individual number is "wrong."
//
// Only flagged when BOTH sides are real data. A comparison involving
// simulated data is already labeled as such elsewhere in the app and
// isn't a "provider mismatch" in the same sense — there's no real
// methodology to disagree about.
export function detectSourceMismatch(baselineProvider, currentProvider) {
  if (!baselineProvider || !currentProvider) return false;
  if (baselineProvider === "simulated" || currentProvider === "simulated") return false;
  return baselineProvider !== currentProvider;
}
