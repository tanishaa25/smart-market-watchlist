// Deterministic, templated narrative generation — replaces the earlier
// Gemini-based explanation. This is a deliberate design decision, not a
// downgrade: matches Meridian's own explicitly stated position
// ("Templated, not LLM... deterministic, testable, free, and honest —
// 'why it matters' from data we actually have").
//
// Every sentence built here comes ONLY from numbers this app has
// actually computed (the six significance signals, today's real price
// change, sector peers' moves) — never an invented cause an LLM might
// hallucinate. The trade-off, honestly stated: these read more mechanically
// than an LLM's prose, and can't reference real-world news the way a
// (correct) LLM narrative sometimes could — but every claim here is
// directly traceable to a stored field, which is the property Meridian's
// design explicitly optimizes for over conversational polish.

function magnitudeTier(absChangePercent) {
  if (absChangePercent < 1) return "small";
  if (absChangePercent < 3) return "moderate";
  return "large";
}

// One fixed verb per (direction, tier) — deliberately not randomized.
// Determinism is the point: the same inputs always produce the exact
// same sentence, which is what makes this testable with plain equality
// checks, unlike an LLM call.
const VERB_BANK = {
  up: { small: "ticked up", moderate: "rose", large: "jumped" },
  down: { small: "ticked down", moderate: "fell", large: "dropped sharply" },
};

function buildHeadline({ symbol, changePercent, isVolumeSpike }) {
  const direction = changePercent >= 0 ? "up" : "down";
  const tier = magnitudeTier(Math.abs(changePercent));
  const verb = VERB_BANK[direction][tier];
  const volumeClause = isVolumeSpike ? " on unusually high volume" : "";
  return `${symbol} ${verb} ${Math.abs(changePercent).toFixed(1)}%${volumeClause} today.`;
}

function buildDetailLine({ zScore, volumeRatio, gapSignal }) {
  const parts = [`${Math.abs(zScore).toFixed(1)}\u03c3 move`, `${volumeRatio.toFixed(1)}\u00d7 volume`];
  if (gapSignal >= 0.5) parts.push("mostly gapped at the open");
  return parts.join(" \u00b7 ") + "."; // terminal punctuation so this reads as its own sentence, not run-on into the next line
}

/**
 * Compares this stock's move to the average move of OTHER stocks in the
 * same sector on the same watchlist (real numbers computed in the same
 * request, not a real market-wide sector index — a documented
 * simplification, same "simulate/approximate clearly" principle as the
 * rest of this app).
 */
function buildAttributionLine({ changePercent, sectorAvgChangePercent, sector }) {
  if (sectorAvgChangePercent == null) return null;
  const sectorLabel = sector ? `${sector} peers` : "Other sector peers";
  const diff = Math.abs(changePercent - sectorAvgChangePercent);
  const sectorPctText = `${sectorAvgChangePercent >= 0 ? "+" : ""}${sectorAvgChangePercent.toFixed(1)}%`;
  if (diff < 0.5) {
    return `${sectorLabel} moved about the same (${sectorPctText}) \u2014 likely sector-wide, not company-specific.`;
  }
  return `${sectorLabel} moved only ${sectorPctText} \u2014 mostly idiosyncratic to this stock.`;
}

function buildCatalystLine({ nextEarningsDays, symbol }) {
  if (nextEarningsDays == null || nextEarningsDays > 7) return null;
  return `${symbol} reports earnings in ${nextEarningsDays} day${nextEarningsDays === 1 ? "" : "s"}.`;
}

/**
 * States both legs explicitly when today's direction and the
 * since-last-check direction disagree — e.g. up today, but still down
 * over the whole absence window because of a bigger earlier drop. A
 * trust feature: never silently pick one direction to report when the
 * two genuinely point opposite ways.
 */
function buildMixedSignalLine({ symbol, changePercent, sinceLastSeenChangePercent }) {
  const todayDir = changePercent >= 0 ? "up" : "down";
  const sinceDir = sinceLastSeenChangePercent >= 0 ? "up" : "down";
  return `Mixed signal: ${todayDir} ${Math.abs(changePercent).toFixed(1)}% today, but ${sinceDir} ${Math.abs(
    sinceLastSeenChangePercent
  ).toFixed(1)}% since you last checked.`;
}

/**
 * Assembles the full narrative for one stock from already-computed
 * signals — no network call, no randomness, same inputs always produce
 * the same output.
 */
export function buildNarrative({
  symbol,
  changePercent,
  zScore,
  volumeRatio,
  isVolumeSpike,
  gapSignal,
  sector,
  sectorAvgChangePercent,
  nextEarningsDays,
  bucket,
  mixedSignal = false,
  sinceLastSeenChangePercent = null,
}) {
  if (bucket === "quiet") {
    return `${symbol} is trading within its normal range today \u2014 nothing unusual to report.`;
  }

  const lines = [
    buildHeadline({ symbol, changePercent, isVolumeSpike }),
    buildDetailLine({ zScore, volumeRatio, gapSignal }),
    buildAttributionLine({ changePercent, sectorAvgChangePercent, sector }),
    buildCatalystLine({ nextEarningsDays, symbol }),
  ];

  if (mixedSignal && sinceLastSeenChangePercent != null) {
    lines.push(buildMixedSignalLine({ symbol, changePercent, sinceLastSeenChangePercent }));
  }

  return lines.filter(Boolean).join(" ");
}
