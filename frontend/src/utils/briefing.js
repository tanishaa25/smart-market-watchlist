// Pure logic for the "Since You Were Away" briefing — kept separate from
// the React component (same pattern as utils/staleness.js) so it's
// directly testable with plain Node, no JSX/DOM involved.
//
// Deliberately derives everything from the SAME significance data
// GET /api/watchlist already returns per item, rather than adding a
// second backend endpoint that recomputes the same scores again — one
// source of truth, no duplicate Firestore/quote work.

// --- Briefing priority: staleness decay + sibling-dismissal damping ---
//
// Raw score alone would let a stale 0.56 that's been sitting for days
// permanently outrank a fresh 0.55 — staleness_decay pulls old-but-still-
// technically-qualifying events back down over time. Separately, a stock
// whose CURRENT bucket the user has already acknowledged (reviewedBucket
// matches significance.bucket) gets a small priority penalty — an
// adaptation of "sibling-dismissal damping" using the reviewed-state
// this app already tracks, since the briefing here doesn't have
// individual per-card dismissal within one session the way the source
// blueprint's model does.

const DECAY_FACTOR = 0.85;
const DECAY_GRACE_HOURS = 72;
const DAMPING_PENALTY = 0.05;

export function computeStalenessDecay(ageHours) {
  if (ageHours == null || ageHours <= DECAY_GRACE_HOURS) return 1;
  const fullDaysPastGrace = Math.floor((ageHours - DECAY_GRACE_HOURS) / 24);
  return Math.pow(DECAY_FACTOR, fullDaysPastGrace);
}

export function computeBriefingPriority(item, now = Date.now()) {
  const sig = item.significance;
  const ageHours = sig.firstComputedAt ? (now - new Date(sig.firstComputedAt).getTime()) / (60 * 60 * 1000) : 0;
  const decay = computeStalenessDecay(ageHours);
  // isNewSignificance is already computed server-side as "bucket !== quiet
  // AND bucket !== reviewedBucket" — so its inverse (for a non-quiet
  // item) already means exactly "this current bucket has been
  // acknowledged before," without needing a separate field exposed.
  const alreadyReviewed = item.isNewSignificance === false;
  return sig.score * decay - (alreadyReviewed ? DAMPING_PENALTY : 0);
}

export function rankByBriefingPriority(items, now = Date.now()) {
  return items
    .filter((i) => i.significance && i.significance.meetsBriefingThreshold)
    .slice()
    .sort((a, b) => computeBriefingPriority(b, now) - computeBriefingPriority(a, now));
}

// --- Per-type and window caps --------------------------------------------

/**
 * Caps how many "catalyst-driven" cards (earnings proximity is the
 * DOMINANT signal, not just a contributing one) can appear in the
 * briefing at once — closest earnings first. Without this, a watchlist
 * with several stocks all reporting earnings the same week could fill
 * the entire attention budget with reminders and crowd out genuine
 * price-driven events.
 */
export function capCatalystCards(rankedItems, maxCatalystCards = 2) {
  const isCatalystDriven = (item) => {
    const s = item.significance.signals;
    if (!s.catalyst || s.catalyst <= 0) return false;
    const maxOther = Math.max(s.priceZScore, s.volume, s.extremum52w, s.regime, s.gap);
    return s.catalyst >= maxOther;
  };

  const catalystItems = rankedItems
    .filter(isCatalystDriven)
    .slice()
    .sort((a, b) => a.significance.nextEarningsDays - b.significance.nextEarningsDays);
  const excessCatalystSymbols = new Set(catalystItems.slice(maxCatalystCards).map((i) => i.symbol));

  return rankedItems.filter((item) => !excessCatalystSymbols.has(item.symbol));
}

/**
 * How long the user has genuinely been away, for the whole briefing —
 * the longest per-stock absence across the watchlist (individual stocks
 * can have slightly different "last checked" times, but the briefing as
 * a whole is framed around the longest gap).
 */
export function getMaxDaysAway(items) {
  return items.reduce((max, item) => Math.max(max, item.significance?.daysAway ?? 0), 0);
}

export const LONG_ABSENCE_DAYS = 30;

export function splitQuiet(items) {
  // Aligned with the SAME sensitivity-aware criterion used for flagging
  // (meetsBriefingThreshold), not the raw bucket — otherwise a "notable"
  // item that doesn't clear a stricter (Calm) threshold would be
  // invisible everywhere: not flagged as a card, but also not counted
  // here since its bucket literally isn't "quiet." Every item must land
  // in exactly one bucket: flagged, or counted as quiet.
  return items.filter((i) => !i.significance || !i.significance.meetsBriefingThreshold);
}

/**
 * Finds the watchlist item with the soonest simulated earnings date,
 * for the briefing's "Next catalyst: X earnings in Y days" line.
 * Returns null if no item has earnings-proximity data yet.
 */
export function findNextCatalyst(items) {
  let best = null;
  for (const item of items) {
    const days = item.significance?.nextEarningsDays;
    if (days == null) continue;
    if (!best || days < best.days) best = { symbol: item.symbol, days };
  }
  return best;
}

/**
 * Collapses correlated moves into one "sector echo" card — the worst
 * fatigue case (a market-wide selloff -> a dozen near-duplicate cards)
 * becomes one honest card instead. A defensible simplification of the
 * source blueprint's real-correlation approach (no sector-ETF price
 * data available here): "moved together" = at least 3 flagged holdings
 * in the same sector, all moving the SAME direction on the same request.
 *
 * Returns { echoGroups, remainingIndividual } — remainingIndividual is
 * every flagged item NOT swept into a group, to be ranked/capped as
 * normal; each echo group counts as ONE slot toward the attention budget.
 */
export function groupEchoes(flaggedItems) {
  const bySector = {};
  for (const item of flaggedItems) {
    if (!item.sector) continue;
    (bySector[item.sector] ??= []).push(item);
  }

  const echoGroups = [];
  const usedSymbols = new Set();

  for (const [sector, members] of Object.entries(bySector)) {
    if (members.length < 3) continue;

    const firstSign = Math.sign(members[0].significance.changePercent);
    const allSameDirection = firstSign !== 0 && members.every((m) => Math.sign(m.significance.changePercent) === firstSign);
    if (!allSameDirection) continue;

    members.forEach((m) => usedSymbols.add(m.symbol));
    const avgChangePercent = members.reduce((sum, m) => sum + m.significance.changePercent, 0) / members.length;
    const maxScoreMember = members.reduce((best, m) => (m.significance.score > best.significance.score ? m : best));

    echoGroups.push({
      sector,
      members: members.map((m) => m.symbol),
      avgChangePercent,
      maxScore: maxScoreMember.significance.score,
      representativeSymbol: maxScoreMember.symbol,
    });
  }

  const remainingIndividual = flaggedItems.filter((item) => !usedSymbols.has(item.symbol));
  return { echoGroups, remainingIndividual };
}
