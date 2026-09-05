// NSE trading hours: 9:15 AM – 3:30 PM IST, Monday–Friday.
//
// WHY THIS MATTERS: a naive staleness check (see utils/staleness on the
// frontend) would call a price from 7pm "stale" — technically true by
// the clock, but misleading. The market closed at 3:30pm; that price
// isn't going anywhere until tomorrow's open, and treating it as a red
// warning every evening would be a false alarm most nights of the year.
//
// LIMITATION: this checks day-of-week and time-of-day only — it does
// NOT account for NSE trading holidays (Diwali, Republic Day, etc). A
// full holiday calendar would need an external data source; for now,
// a holiday will incorrectly be treated as a normal weekday. Documented
// here rather than silently wrong.
//
// IST is a fixed UTC+5:30 offset with no daylight saving, so this is
// computed directly rather than relying on any timezone library or the
// server's local timezone setting (which could be anything).

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MARKET_OPEN_MINUTES = 9 * 60 + 15; // 9:15 AM
const MARKET_CLOSE_MINUTES = 15 * 60 + 30; // 3:30 PM

function toIstParts(date) {
  // Shift the absolute instant by the IST offset, then read it back
  // with UTC getters — this gives IST wall-clock values regardless of
  // what timezone the server process itself is running in.
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    dayOfWeek: shifted.getUTCDay(), // 0=Sunday ... 6=Saturday
    minutesSinceMidnight: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

// NSE trading holidays for 2026 (equity segment), sourced from NSE's
// published circular — cross-checked against multiple independent
// listings for consistency. IST calendar dates.
//
// LIMITATION: hardcoded for 2026 only. A real production system would
// pull this from a live calendar API or an admin-maintained table (per
// year) rather than a static list — documented here rather than
// silently wrong once the year rolls over.
const NSE_HOLIDAYS_2026 = new Set([
  "2026-01-26", // Republic Day
  "2026-03-03", // Holi
  "2026-03-26", // Shri Ram Navami
  "2026-03-31", // Shri Mahavir Jayanti
  "2026-04-03", // Good Friday
  "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-05-28", // Bakri Id
  "2026-06-26", // Muharram
  "2026-09-14", // Ganesh Chaturthi
  "2026-10-02", // Mahatma Gandhi Jayanti
  "2026-10-20", // Dussehra
  "2026-11-10", // Diwali-Balipratipada
  "2026-11-24", // Prakash Gurpurb Sri Guru Nanak Dev
  "2026-12-25", // Christmas
]);

function istCalendarDate(date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

function isNseHoliday(date) {
  return NSE_HOLIDAYS_2026.has(istCalendarDate(date));
}

export function isMarketOpen(date = new Date()) {
  const { dayOfWeek, minutesSinceMidnight } = toIstParts(date);
  if (dayOfWeek === 0 || dayOfWeek === 6) return false; // weekend
  if (isNseHoliday(date)) return false;
  return minutesSinceMidnight >= MARKET_OPEN_MINUTES && minutesSinceMidnight < MARKET_CLOSE_MINUTES;
}

export function getMarketStatusLabel(date = new Date()) {
  return isMarketOpen(date) ? "Market open" : "Market closed";
}

/**
 * The IST trading-session date for a given instant — used to bucket
 * "change events" by trading day (see changeEventStore.js), not a raw
 * UTC calendar date. A session runs from one day's market open (9:15 AM
 * IST) until the next day's open: anything before today's open (e.g.
 * 2 AM IST, or even 8 AM IST) is still attributed to YESTERDAY's
 * session, since nothing new has happened yet today — this matters at
 * the exact boundary a naive UTC-date or even a plain IST-calendar-date
 * bucket would get wrong (both would incorrectly start a "new day" at
 * midnight, hours before the market actually opens).
 */
export function getSessionBucket(date = new Date()) {
  const { minutesSinceMidnight } = toIstParts(date);
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);

  if (minutesSinceMidnight < MARKET_OPEN_MINUTES) {
    shifted.setUTCDate(shifted.getUTCDate() - 1); // still yesterday's session — today's open hasn't happened yet
  }

  return shifted.toISOString().slice(0, 10); // "YYYY-MM-DD", the IST trading-session date
}
