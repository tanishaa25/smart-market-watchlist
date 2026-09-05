// Staleness decay: instead of a flat "Live"/"Cached" label, this gives a
// glanceable, continuously-decaying sense of "how much can I trust this
// price right now" — bright green when very fresh, fading to amber, then
// red as the data ages, without the user needing to read any text.
//
// Thresholds are deliberately generous relative to the app's own refresh
// cadences (15s REST cache, 10s real-data stream poll, 4s simulated
// tick) — a quote should almost always read "fresh" under normal
// operation, and only turn amber/red if something's actually gone stale
// (a dropped connection, a slow provider, etc).

const FRESH_THRESHOLD_SECONDS = 30;
const AGING_THRESHOLD_SECONDS = 120;

export function stalenessColor(asOfIso, now = Date.now(), marketOpen = true) {
  // When the market is closed, today's closing price is SUPPOSED to
  // stay fixed for hours — that's not staleness, it's just closed. A
  // naive time-based check would show a red "stale" warning every
  // single evening, which is a false alarm, not a real signal.
  if (!marketOpen) return "closed";

  if (!asOfIso) return "gray"; // no timestamp at all — unknown, not necessarily bad
  const ageSeconds = (now - new Date(asOfIso).getTime()) / 1000;
  if (ageSeconds < 0) return "green"; // clock skew edge case — treat as fresh rather than erroring
  if (ageSeconds < FRESH_THRESHOLD_SECONDS) return "green";
  if (ageSeconds < AGING_THRESHOLD_SECONDS) return "amber";
  return "red";
}

export function stalenessLabel(asOfIso, now = Date.now(), marketOpen = true) {
  if (!marketOpen) return "Market closed";
  if (!asOfIso) return "Unknown age";
  const ageSeconds = Math.max(0, (now - new Date(asOfIso).getTime()) / 1000);
  if (ageSeconds < 60) return `${Math.round(ageSeconds)}s old`;
  return `${Math.round(ageSeconds / 60)}m old`;
}
