// Flags when a stock's move today and its move since the user's last
// check-in point in OPPOSITE directions — e.g. up 1% today, but still
// down 4% since the user last looked because of a bigger drop earlier
// in the absence window. Left unflagged, a narrative built only from
// "today's" direction would tell a misleadingly one-sided story. This
// is a trust feature: state both legs honestly rather than picking one
// direction to report.
export function detectMixedSignal(todayChangePercent, sinceLastSeenChangePercent) {
  if (todayChangePercent == null || sinceLastSeenChangePercent == null) return false;
  if (todayChangePercent === 0 || sinceLastSeenChangePercent === 0) return false;
  return Math.sign(todayChangePercent) !== Math.sign(sinceLastSeenChangePercent);
}
