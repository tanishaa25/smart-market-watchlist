// Six-signal weighted significance score — replaces the earlier
// single-signal (price z-score only) approach.
//
// A change is scored as a weighted combination of six independent
// signals, each normalized to [0,1] and computed against the STOCK'S
// OWN history, not a flat threshold applied identically to everyone:
//
//   1. Price z-score      — today's move vs this stock's own volatility,
//                            scaled by how long the user has been away
//                            (absence-scaled — see ABSENCE SCALING below)
//   2. Volume              — today's volume vs this stock's own average
//   3. 52-week extremum    — how close price is to its own 52-week range
//   4. Trend-reversal regime — has a short/long moving-average crossover
//                            happened recently (a "regime change")
//   5. Overnight gap       — how much of today's move happened at the
//                            open vs drifted intraday
//   6. Earnings-catalyst proximity — how close the next earnings date is
//
// WEIGHTS (sum to 1.0) — price movement is still the primary signal,
// but no longer the only one:
//   priceZScore 0.30 · volume 0.20 · extremum52w 0.15 ·
//   regime 0.15 · gap 0.10 · catalyst 0.10
//
// ABSENCE SCALING: under a random-walk model, the price move you'd
// EXPECT to see just by chance grows with the square root of elapsed
// time (σ·√t). So the same raw % move means different things depending
// on how long the user was away: 3% during a 20-minute check-in is a
// real outlier; 3% after being away a month is unremarkable, since a
// month of ordinary drift could easily produce that. This function
// divides by volatility scaled by √(days away) — a longer absence
// raises the bar for what counts as "surprising," matching that model.
//
// DATA SOURCE: simulated historical data (~1 trading year), generated
// deterministically per symbol — same principle as the rest of the
// app's simulated feed. Two of the six signals (52-week extremum, trend
// regime) are computed from the real price series; two (gap, earnings
// proximity) are themselves simulated placeholders, since this app has
// no real intraday-open or earnings-calendar data source yet — clearly
// flagged as such below, not silently presented as real.
//
// SWAPPING IN REAL DATA LATER: replace getHistory() with a real 1-year
// daily-bar fetch (Yahoo's chart endpoint supports range=1y) and wire a
// real earnings-calendar API into getNextEarningsDays() — every signal
// function downstream operates on the same {closes, volumes} shape and
// wouldn't need to change.

const HISTORY_DAYS = 252; // ~1 trading year — needed for 52-week extremum + trend regime, not just 30-day volatility
const VOLATILITY_WINDOW_DAYS = 30;
const VOLUME_SPIKE_THRESHOLD = 2;

const WEIGHTS = {
  priceZScore: 0.3,
  volume: 0.2,
  extremum52w: 0.15,
  regime: 0.15,
  gap: 0.1,
  catalyst: 0.1,
};

function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function hashToRange(str, range) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % range;
}

// Deterministic per-stock "personality" — some stocks are naturally
// calmer or heavier-volume than others, same as in reality.
function stockProfile(symbol) {
  const dailyVolatilityPct = 0.8 + hashToRange(symbol, 1800) / 1000; // ~0.8%–2.6% typical daily swing
  const avgVolume = 200_000 + hashToRange(symbol + "vol", 4_000_000); // ~200k–4.2M shares/day
  return { dailyVolatilityPct, avgVolume };
}

/**
 * Simulated ~1-year {closes, volumes} history — deterministic per
 * symbol, rescaled so the series ends consistent with today's REAL
 * price (avoids the classic bug of mixing an arbitrary synthetic scale
 * with a real number — the same fix already applied to the sparkline).
 */
function getHistory(symbol, currentPrice) {
  const { dailyVolatilityPct, avgVolume } = stockProfile(symbol);
  const closes = [100];
  const volumes = [];

  for (let day = 1; day <= HISTORY_DAYS; day++) {
    const seed = hashToRange(symbol, 100_000) + day * 7.3;
    const returnPct = (seededRandom(seed) - 0.5) * 2 * dailyVolatilityPct;
    const prevClose = closes[closes.length - 1];
    closes.push(prevClose * (1 + returnPct / 100));

    const volumeNoise = 0.6 + seededRandom(seed + 1.7) * 0.8; // 0.6x–1.4x typical
    volumes.push(Math.round(avgVolume * volumeNoise));
  }

  if (currentPrice != null) {
    const lastHistorical = closes[closes.length - 1];
    const scaleFactor = lastHistorical ? currentPrice / lastHistorical : 1;
    for (let i = 0; i < closes.length; i++) closes[i] *= scaleFactor;
  }

  return { closes, volumes, dailyVolatilityPct, avgVolume };
}

function standardDeviation(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// --- Signal 1: absence-scaled price z-score ---------------------------

function computePriceZScore(changePercent, dailyVolatilityPct, daysAway) {
  const effectiveDays = Math.max(daysAway, 1 / 24); // floor at 1 hour — avoids a divide-by-near-zero blowup on an instant recheck
  const scaledVolatility = dailyVolatilityPct * Math.sqrt(effectiveDays);
  return scaledVolatility ? +(changePercent / scaledVolatility).toFixed(2) : 0;
}

function normalizeZScoreSignal(absZ) {
  return clamp01(absZ / 3); // z=0 -> 0, z=3+ -> 1 (a 3-sigma+ move maxes out this signal)
}

// --- Signal 2: volume ---------------------------------------------------

function normalizeVolumeSignal(volumeRatio) {
  return clamp01((volumeRatio - 1) / 3); // 1x (normal) -> 0, 4x+ -> 1
}

// --- Signal 3: 52-week extremum distance -------------------------------

function compute52WeekExtremumSignal(currentPrice, closes) {
  const yearSlice = closes.slice(-252);
  const min = Math.min(...yearSlice);
  const max = Math.max(...yearSlice);
  const range = max - min || 1;
  // Distance from the NEARER extreme, as a fraction of the year's range
  // — closer to either a 52-week high or low scores higher.
  const distFromHigh = (max - currentPrice) / range;
  const distFromLow = (currentPrice - min) / range;
  const nearerDistance = Math.min(distFromHigh, distFromLow);
  return clamp01(1 - nearerDistance * 2); // within top/bottom ~10% of the range scores meaningfully
}

// --- Signal 4: trend-reversal regime (EMA crossover) --------------------

function ema(series, period) {
  const k = 2 / (period + 1);
  const result = [series[0]];
  for (let i = 1; i < series.length; i++) {
    result.push(series[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function computeRegimeSignal(closes) {
  if (closes.length < 35) return 0; // not enough history for a stable EMA30 yet
  const ema10 = ema(closes, 10);
  const ema30 = ema(closes, 30);

  const diffs = ema10.map((v, i) => v - ema30[i]);
  // EMAs are lagging indicators — a real trend reversal doesn't resolve
  // into a sign change instantly. A too-narrow window (5 days) misses
  // crossovers that already happened a bit earlier; verified directly:
  // a hand-built reversal series crossed 11 days before the series end,
  // which a 5-day window completely missed. 15 days balances "recent
  // enough to matter" against "wide enough to actually catch one."
  const recentWindow = diffs.slice(-15);
  const signChanged = recentWindow.some((d, i) => i > 0 && Math.sign(d) !== Math.sign(recentWindow[i - 1]) && d !== 0);
  if (!signChanged) return 0;

  // Strength = how far apart the averages have moved apart since crossing, relative to price level
  const latestDiffPct = Math.abs(diffs[diffs.length - 1]) / closes[closes.length - 1];
  return clamp01(latestDiffPct * 40); // scaled so a ~2.5% separation maxes the signal
}

// --- Signal 5: overnight gap (simulated approximation) -------------------
//
// This app has no real intraday open/close granularity (only end-of-day-
// style quotes), so "how much of today's move happened at the open" is
// approximated: a deterministic, symbol-seeded fraction of today's total
// move is attributed to "gap." This is clearly a placeholder for real
// intraday OHLC data, not a real measurement — documented here rather
// than presented as more precise than it is.

function simulateGapFraction(symbol) {
  const bucket = Math.floor(Date.now() / (24 * 60 * 60 * 1000)); // stable for a whole day
  const roll = seededRandom(hashToRange(symbol, 100_000) + bucket * 5.7);
  return 0.3 + roll * 0.5; // 30%–80% of today's move attributed to the "gap" component
}

function computeGapSignal(symbol, changePercent, dailyVolatilityPct) {
  const gapFraction = simulateGapFraction(symbol);
  const gapPct = Math.abs(changePercent) * gapFraction;
  return dailyVolatilityPct ? clamp01(gapPct / (dailyVolatilityPct * 2)) : 0;
}

// --- Signal 6: earnings-catalyst proximity (simulated approximation) -----
//
// This app has no real earnings-calendar data source yet. Each symbol is
// deterministically assigned a cycling ~75-day earnings schedule so the
// signal has something real to compute against — same "simulate clearly,
// document clearly" principle as the rest of the app, not presented as a
// real calendar feed.

function getNextEarningsDays(symbol) {
  const cycleDays = 75 + hashToRange(symbol, 20); // ~75-94 day cycle, per symbol
  const daysSinceEpoch = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const offset = hashToRange(symbol + "earnings", cycleDays);
  const position = (daysSinceEpoch + offset) % cycleDays;
  return cycleDays - position; // days remaining until the next simulated earnings date
}

function catalystSignalFromDays(days) {
  if (days <= 3) return 1;
  if (days >= 30) return 0;
  return clamp01(1 - (days - 3) / 27);
}

function bucketForScore(score) {
  if (score < 0.33) return "quiet";
  if (score < 0.66) return "notable";
  return "attention";
}

// Sensitivity profiles scale the BRIEFING trigger threshold only — the
// raw score/bucket stays identical for every user (so badges, digest
// counts, and history stay comparable across users), but whether a
// given score is considered "worth interrupting the user for" shifts:
// Calm raises the bar (fewer briefing cards), Active lowers it.
const SENSITIVITY_MULTIPLIERS = { calm: 1.25, balanced: 1.0, active: 0.8 };
const BRIEFING_BASE_THRESHOLD = 0.66; // matches the existing "attention" bucket cutoff

export function meetsBriefingThreshold(score, sensitivity = "balanced") {
  const multiplier = SENSITIVITY_MULTIPLIERS[sensitivity] ?? 1;
  return score >= BRIEFING_BASE_THRESHOLD * multiplier;
}

/**
 * Computes the EXPENSIVE, user-independent raw signals for a stock —
 * everything except the price z-score, which is the one signal that
 * genuinely depends on a specific user's absence length (see
 * ABSENCE SCALING above). This is the part worth persisting once per
 * (symbol, day) rather than recomputing on every request — see
 * changeEventStore.js, which does exactly that.
 */
export function computeRawSignals({ symbol, changePercent, volume, currentPrice }) {
  const { closes, avgVolume } = getHistory(symbol, currentPrice);

  const trailing = closes.slice(-VOLATILITY_WINDOW_DAYS - 1);
  const returns = [];
  for (let i = 1; i < trailing.length; i++) {
    returns.push(((trailing[i] - trailing[i - 1]) / trailing[i - 1]) * 100);
  }
  const dailyVolatilityPct = standardDeviation(returns) || 1;

  const todayVolume = volume ?? simulateTodayVolume(symbol);
  const volumeRatio = avgVolume ? +(todayVolume / avgVolume).toFixed(2) : 1;
  const isVolumeSpike = volumeRatio >= VOLUME_SPIKE_THRESHOLD;

  const resolvedPrice = currentPrice ?? closes[closes.length - 1];
  const nextEarningsDays = getNextEarningsDays(symbol);

  return {
    symbol,
    changePercent,
    price: resolvedPrice,
    dailyVolatilityPct: +dailyVolatilityPct.toFixed(2),
    volumeRatio,
    isVolumeSpike,
    todayVolume: Math.round(todayVolume),
    avgVolume: Math.round(avgVolume),
    nextEarningsDays,
    signals: {
      volume: normalizeVolumeSignal(volumeRatio),
      extremum52w: compute52WeekExtremumSignal(resolvedPrice, closes),
      regime: computeRegimeSignal(closes),
      gap: computeGapSignal(symbol, changePercent, dailyVolatilityPct),
      catalyst: catalystSignalFromDays(nextEarningsDays),
    },
  };
}

/**
 * Assembles the final score from already-computed raw signals plus the
 * two genuinely per-request inputs: how long THIS user has been away
 * (daysAway) and whether the quote is currently frozen. Cheap — no
 * history generation, just arithmetic — which is exactly why it's safe
 * to run fresh on every request even when the raw signals themselves
 * came from a cached/persisted record.
 */
// --- Confluence multiplier ---------------------------------------------
//
// The blueprint's own general formula (mult = 1 + 0.25·(n−1)) gives 0.75
// at n=0 — but its own worked example ("a quiet Coca-Cola day", n=0)
// explicitly states mult=1. These two statements in the same source
// document contradict each other at n=0. We follow the worked example:
// zero confirming signals should mean "no confluence adjustment," not a
// penalty multiplier — the weighted sum is already low in that case, and
// multiplying it further down for no stated reason would double-count
// the absence of evidence. n≥1 follows the general formula exactly,
// which DOES reproduce their worked Example A precisely (n=2 with S1 &
// S2 both firing → 1.25 + 0.10 pair bonus = 1.35, matching their number
// exactly) — verified directly, see tests.

const CONFLUENCE_THRESHOLD = 0.5;
const CONFLUENCE_STEP = 0.25;
const CONFLUENCE_CAP = 1.7;
const PRICE_VOLUME_PAIR_BONUS = 0.1;

export function computeConfluenceMultiplier(signals) {
  const otherKeys = ["priceZScore", "volume", "extremum52w", "regime", "gap"];
  const nOther = otherKeys.filter((k) => signals[k] >= CONFLUENCE_THRESHOLD).length;
  // Catalyst proximity alone should never manufacture confluence — it's
  // context, not evidence, and only counts if something else corroborates it.
  const catalystCounts = signals.catalyst >= CONFLUENCE_THRESHOLD && nOther >= 1;
  const n = nOther + (catalystCounts ? 1 : 0);

  let multiplier = n === 0 ? 1 : 1 + CONFLUENCE_STEP * (n - 1);
  if (signals.priceZScore >= CONFLUENCE_THRESHOLD && signals.volume >= CONFLUENCE_THRESHOLD) {
    multiplier += PRICE_VOLUME_PAIR_BONUS;
  }
  multiplier = Math.min(multiplier, CONFLUENCE_CAP);

  return { multiplier, n };
}

/**
 * Assembles the final score from already-computed raw signals plus the
 * two genuinely per-request inputs: how long THIS user has been away
 * (daysAway) and whether the quote is currently frozen. Cheap — no
 * history generation, just arithmetic — which is exactly why it's safe
 * to run fresh on every request even when the raw signals themselves
 * came from a cached/persisted record.
 *
 * @param {number|null} [sectorAvgChangePercent] - the average % move of
 *   this stock's OTHER sector peers on the same watchlist, if known (see
 *   routes/watchlist.js). Feeds a real adjustment to the price signal
 *   itself — not just narrative text — per the blueprint's §5.2 sector
 *   modifier: idiosyncratic moves (far from the sector's own move) score
 *   higher; moves mostly explained by the sector moving together score
 *   lower and get flagged `betaExplained`.
 */
export function assembleScore({ rawSignals, daysAway = 1, frozen = false, sectorAvgChangePercent = null }) {
  const zScore = computePriceZScore(rawSignals.changePercent, rawSignals.dailyVolatilityPct, daysAway);
  const signals = {
    priceZScore: normalizeZScoreSignal(Math.abs(zScore)),
    ...rawSignals.signals,
  };

  let betaExplained = false;

  // Sector modifier — adjusts the price signal itself, not just what
  // gets said about it in the narrative. Skipped when frozen: the price
  // signal is already zeroed in that case, so adjusting it first would
  // be pointless work with no effect.
  if (!frozen && sectorAvgChangePercent != null) {
    const effectiveVolatility = rawSignals.dailyVolatilityPct * Math.sqrt(Math.max(daysAway, 1 / 24));
    const sectorZ = effectiveVolatility ? sectorAvgChangePercent / effectiveVolatility : 0;

    if (Math.abs(zScore - sectorZ) > 1.5) {
      signals.priceZScore = Math.min(1, signals.priceZScore * 1.2); // idiosyncratic — rarer, more informative
    }

    const sameDirection =
      rawSignals.changePercent !== 0 && Math.sign(rawSignals.changePercent) === Math.sign(sectorAvgChangePercent);
    const explainedRatio = rawSignals.changePercent !== 0 ? sectorAvgChangePercent / rawSignals.changePercent : 0;
    if (sameDirection && explainedRatio >= 0.7) {
      signals.priceZScore *= 0.8; // mostly beta, not alpha — dampen
      betaExplained = true;
    }
  }

  let effectiveWeights = WEIGHTS;
  if (frozen) {
    signals.priceZScore = 0;
    signals.gap = 0;
    const remainingWeight = WEIGHTS.volume + WEIGHTS.extremum52w + WEIGHTS.regime + WEIGHTS.catalyst;
    effectiveWeights = {
      priceZScore: 0,
      gap: 0,
      volume: WEIGHTS.volume / remainingWeight,
      extremum52w: WEIGHTS.extremum52w / remainingWeight,
      regime: WEIGHTS.regime / remainingWeight,
      catalyst: WEIGHTS.catalyst / remainingWeight,
    };
  }

  const weightedSum =
    signals.priceZScore * effectiveWeights.priceZScore +
    signals.volume * effectiveWeights.volume +
    signals.extremum52w * effectiveWeights.extremum52w +
    signals.regime * effectiveWeights.regime +
    signals.gap * effectiveWeights.gap +
    signals.catalyst * effectiveWeights.catalyst;

  // Confluence: independent confirming signals compound the score
  // rather than just adding — joint evidence is stronger than the sum
  // of its parts. See computeConfluenceMultiplier above.
  const { multiplier, n: confirmingSignalCount } = computeConfluenceMultiplier(signals);
  const combinedScore = Math.min(1, weightedSum * multiplier);

  return {
    score: +combinedScore.toFixed(3),
    bucket: bucketForScore(combinedScore),
    zScore,
    daysAway: +daysAway.toFixed(2), // exposed for the score-transparency UI's "z=2.7 because... N days away" explanation
    changePercent: rawSignals.changePercent,
    dailyVolatilityPct: rawSignals.dailyVolatilityPct,
    volumeRatio: rawSignals.volumeRatio,
    isVolumeSpike: rawSignals.isVolumeSpike,
    avgVolume: rawSignals.avgVolume,
    todayVolume: rawSignals.todayVolume,
    nextEarningsDays: rawSignals.nextEarningsDays,
    frozen,
    betaExplained,
    confluenceMultiplier: +multiplier.toFixed(3),
    confirmingSignalCount,
    signals: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, +v.toFixed(3)])),
    weights: effectiveWeights,
  };
}

/**
 * Backward-compatible all-in-one entry point — computes raw signals
 * fresh every call and immediately assembles the score. The main
 * watchlist GET handler instead calls computeRawSignals + assembleScore
 * directly, routing the raw-signal step through changeEventStore.js so
 * it's persisted once per (symbol, day) rather than silently discarded.
 *
 * @param {number} [currentPrice] - today's real price, used to align the simulated history's scale
 * @param {boolean} [frozen] - if true, the current price has been stuck
 *   at the same value for 10+ minutes (see frozenQuoteDetector.js).
 */
export function computeSignificance({
  symbol,
  changePercent,
  volume,
  daysAway = 1,
  currentPrice,
  frozen = false,
  sectorAvgChangePercent = null,
}) {
  const rawSignals = computeRawSignals({ symbol, changePercent, volume, currentPrice });
  return assembleScore({ rawSignals, daysAway, frozen, sectorAvgChangePercent });
}

/**
 * Simulated "today's volume" for a symbol — deterministic per symbol and
 * current 15s time bucket (matching the rest of the app's simulated-tick
 * pattern), with roughly 1-in-6 buckets deliberately producing a spike so
 * the feature has real spikes to demonstrate, not just steady-state noise.
 */
export function simulateTodayVolume(symbol) {
  const { avgVolume } = stockProfile(symbol);
  const bucket = Math.floor(Date.now() / 15_000);
  const roll = seededRandom(hashToRange(symbol, 100_000) + bucket * 3.1);
  const multiplier = roll > 0.83 ? 2.2 + roll * 2 : 0.6 + roll * 0.8;
  return Math.round(avgVolume * multiplier);
}

/**
 * A short recent-price series for drawing a small inline trend line —
 * reuses the same deterministic simulated history as the significance
 * calculation above.
 *
 * @param {string} symbol
 * @param {number} [currentPrice] - today's actual price, appended as the
 *   final point so the line ends at what's currently on screen.
 * @param {number} [points] - how many recent days to include (default 14).
 */
export function getSparklineHistory(symbol, currentPrice, points = 14) {
  const { closes } = getHistory(symbol, currentPrice);
  const recent = closes.slice(-points);
  return currentPrice != null ? [...recent.slice(0, -1), currentPrice] : recent;
}
