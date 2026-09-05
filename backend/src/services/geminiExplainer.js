// Plain-language change explanations, via the Gemini API.
//
// https://ai.google.dev/api/generate-content
//
// DESIGN PRINCIPLE — THIS IS THE IMPORTANT PART:
// This only generates an explanation for `live` quotes (a real trade
// actually happened). For `simulated` quotes, there is no real cause
// behind the number — it's a synthetic random walk — so asking an LLM to
// "explain" it would mean either hallucinating a plausible-sounding
// reason or overstating confidence in something fake. Simulated symbols
// get an honest static message instead. This mirrors the project's core
// rule: never show a claim with more confidence than the data supports.
//
// WHAT GOES INTO THE PROMPT (deliberately, not just the % change):
//   - symbol, company name, sector (context for "is this normal for a
//     company like this")
//   - today's change, in both amount and percent
//   - a magnitude bucket (small/moderate/large) computed in code, NOT
//     asked of the model — we don't have real historical volatility data
//     per stock, so we don't let the model invent false precision about
//     "how unusual" a move is; we only tell it the coarse bucket we can
//     actually justify.
//   - the "since you last checked" diff, if any — multi-day context most
//     stock apps don't have, since this app already tracks it per user.
//   - the user's own note on why they're watching this stock, if they
//     wrote one — lets the explanation connect to their actual reason
//     for watching, not just describe the ticker in the abstract.
//
// WHAT THE PROMPT EXPLICITLY FORBIDS:
//   - investment advice (buy/sell/hold) — this app displays quotes, it
//     is not a financial advisor, and Groww's own product carries this
//     exact disclaimer.
//   - inventing a specific news event/cause it cannot verify — it may
//     describe the pattern of the move, never fabricate a reason.
//   - jargon aimed at non-experts (this app's whole premise).

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — explanations don't need to regenerate every page load
const QUOTA_BACKOFF_MS = 30 * 60 * 1000; // once we know the daily quota is exhausted, stop retrying for a while — retrying instantly on every page load just wastes more of an already-exhausted budget
const cache = new Map(); // symbol -> { text, fetchedAt }

// Google's free tier for this model also caps requests PER MINUTE (as
// low as 5/min, seen in production) on top of the per-day cap. A
// watchlist with more stocks than that limit, all requested in the same
// page load, blows straight through it in under a second if fired
// concurrently. This self-throttle spaces out actual outbound calls so a
// larger watchlist naturally trickles through under the limit instead of
// bursting past it — 13s between calls keeps us at ~4.6/min, comfortably
// under 5.
const MIN_CALL_GAP_MS = 13_000;

// Tracks symbols currently being generated in the background, so a
// second request for the same symbol (e.g. another page load before the
// first finishes) doesn't kick off a duplicate call.
const inFlight = new Set();

let quotaExhaustedUntil = 0; // 0 = not currently known to be exhausted

const SIMULATED_MESSAGE =
  "This is a simulated price for practice/demo purposes — there's no real market event behind this move.";

function isGeminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function magnitudeBucket(absChangePercent) {
  if (absChangePercent < 1) return "a small, unremarkable";
  if (absChangePercent < 3) return "a moderate";
  return "a fairly large";
}

// Prefers the real statistical bucket (from significanceService.js —
// this stock's own trailing volatility, not a flat percentage rule)
// when available, falling back to the coarser heuristic only if
// significance data wasn't provided.
function describeMagnitude(absChangePercent, significance) {
  if (significance) {
    const { bucket, zScore } = significance;
    if (bucket === "quiet") return `a small move for this stock specifically (it's typically about this volatile day-to-day)`;
    if (bucket === "notable") return `a somewhat larger move than usual for this specific stock`;
    return `a considerably larger move than usual for this specific stock (about ${Math.abs(zScore)}x its normal daily swing)`;
  }
  return `${magnitudeBucket(absChangePercent)} move for a typical stock`;
}

function buildPrompt({ symbol, name, sector, price, change, changePercent, sinceLastSeen, note, significance }) {
  const direction = change >= 0 ? "up" : "down";
  const magnitudeDescription = describeMagnitude(Math.abs(changePercent), significance);

  const lines = [
    `Stock: ${symbol}${name ? ` (${name})` : ""}${sector ? `, sector: ${sector}` : ""}`,
    `Current price: ₹${price.toFixed(2)}`,
    `Today's change: ${change >= 0 ? "+" : ""}${change.toFixed(2)} (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%) — ${direction}`,
    `For context, this is ${magnitudeDescription}.`,
  ];

  if (significance?.isVolumeSpike) {
    lines.push(
      `Also notable: today's trading volume is about ${significance.volumeRatio}x this stock's normal daily volume — meaningfully more trading interest than usual, independent of the price move.`
    );
  }

  if (sinceLastSeen) {
    lines.push(
      `Since the user last checked this stock, the price has moved ${sinceLastSeen.change >= 0 ? "+" : ""}${sinceLastSeen.change.toFixed(2)} (${sinceLastSeen.changePercent >= 0 ? "+" : ""}${sinceLastSeen.changePercent.toFixed(2)}%).`
    );
  }

  if (note) {
    lines.push(`The user's own note on why they're watching this stock: "${note}"`);
  }

  lines.push(
    "",
    "Write ONE short, plain-English sentence (max ~25 words) explaining this movement for a beginner investor with no financial background.",
    "Rules you must follow:",
    "- Do not recommend buying, selling, or holding — describe, don't advise.",
    "- Do not invent a specific news event or cause you cannot verify. Describe the pattern of the move (size, direction, context) instead of a fabricated reason.",
    "- Avoid jargon (no 'volatility', 'beta', 'RSI', etc.) — plain words only.",
    "- If a user note was given, connect your sentence to it where relevant.",
    "- Keep the tone calm and neutral, not alarmist or hyped."
  );

  return lines.join("\n");
}

// Self-throttle: never let two actual outbound calls happen closer
// together than MIN_CALL_GAP_MS, regardless of how many are requested
// at once. Uses slot reservation rather than "check the last call time,
// then wait" — the naive version has a race: if several calls start
// around the same moment (e.g. a 6-stock watchlist all requesting
// explanations at once), they'd all read the same stale "last call"
// value before any of them updates it, compute the same wait time, and
// still burst together after that wait instead of trickling through one
// at a time. Reserving a slot synchronously (no `await` before the
// reservation itself) is atomic within JS's single-threaded execution,
// so concurrent callers correctly queue up at 0s, 13s, 26s, 39s... apart.
let nextAllowedCallAt = 0;
function reserveCallSlot() {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextAllowedCallAt);
  nextAllowedCallAt = scheduledAt + MIN_CALL_GAP_MS;
  return scheduledAt;
}

async function callGemini(prompt) {
  const scheduledAt = reserveCallSlot();
  const wait = scheduledAt - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        // Header form is Google's current documented standard, and more
        // likely to work correctly across different API key formats
        // than the older `?key=` URL query parameter.
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          // Newer "flash" models can spend part of the output token
          // budget on internal reasoning before writing the visible
          // answer — with too small a budget, the real answer can come
          // back truncated (first seen as "just the bare symbol name"
          // at 100 tokens; then as a sentence cut off mid-word at 400).
          // 800 leaves generous headroom for that plus a full sentence.
          maxOutputTokens: 800,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Gemini request failed (${res.status}): ${body}`);
      err.isQuotaError = res.status === 429;
      throw err;
    }

    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;

    if (!text) {
      // Log the full candidate (finishReason etc.) rather than just
      // failing silently — this is exactly what's needed to diagnose
      // cases like a safety block or a truncated/empty response.
      console.error("Gemini response had no text content. Full candidate:", JSON.stringify(candidate));
      throw new Error("Gemini response had no text content.");
    }

    const trimmed = text.trim();

    // finishReason "MAX_TOKENS" means the model was cut off mid-answer
    // — even a longer maxOutputTokens can still hit this on an unlucky
    // response. Logged always so we can see it happening; treated as
    // invalid output below regardless of length.
    if (candidate.finishReason && candidate.finishReason !== "STOP") {
      console.error(`[Gemini] Non-STOP finishReason for this response: ${candidate.finishReason}. Text so far: "${trimmed}"`);
    }

    // Sanity checks: a real explanation is one complete, full sentence.
    // Anything this short (e.g. just the bare symbol name) or that
    // doesn't end with terminal punctuation (a direct sign of being cut
    // off mid-sentence, as happened here — text ending in "...a" with no
    // period) is broken output — never cache or show it, treat it the
    // same as a failed call so the caller falls back to nothing rather
    // than a visibly incomplete sentence.
    const endsCleanly = /[.!?]["')]?$/.test(trimmed);
    if (trimmed.length < 20 || !endsCleanly) {
      console.error(
        `Gemini returned incomplete/invalid output (finishReason: ${candidate.finishReason}): "${trimmed}". Full response:`,
        JSON.stringify(data)
      );
      throw new Error("Gemini response was incomplete or too short to be a real explanation.");
    }

    return trimmed;
  } finally {
    clearTimeout(timeout);
  }
}

export { buildPrompt };

/**
 * Returns a plain-language explanation for a stock's movement — but
 * NEVER waits on the network to do it. This is deliberate: Gemini calls
 * are now self-throttled to ~13s apart (see MIN_CALL_GAP_MS), and a
 * watchlist with several stocks needing fresh explanations could
 * otherwise take a minute or more to respond if this blocked the
 * caller — price data and the "since you last checked" diff should
 * never wait on a slow/throttled AI call.
 *
 * Instead: if a cached (and still-fresh) explanation exists, return it
 * immediately. Otherwise, kick off generation in the background (not
 * awaited) and return null for THIS request — a later request for the
 * same symbol (e.g. the next page reload) will find it cached once the
 * background generation completes.
 */
export function getExplanation(quoteContext) {
  const { symbol, source } = quoteContext;

  if (source !== "live") {
    return SIMULATED_MESSAGE;
  }

  if (!isGeminiConfigured()) {
    return null; // feature simply isn't available without a key — not an error
  }

  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.text;
  }

  // If we already know the quota is exhausted, or a background fetch
  // for this symbol is already running, don't kick off another one —
  // hammering it every page load only wastes further quota once it's
  // available again, and duplicate in-flight calls waste the tight
  // per-minute budget for no benefit.
  if (Date.now() < quotaExhaustedUntil || inFlight.has(symbol)) {
    return null;
  }

  inFlight.add(symbol);
  (async () => {
    try {
      const prompt = buildPrompt(quoteContext);
      const text = await callGemini(prompt);
      console.log(`[Gemini] Explanation for ${symbol}: "${text}"`);
      cache.set(symbol, { text, fetchedAt: Date.now() });
    } catch (err) {
      console.error(`Gemini explanation failed for ${symbol}:`, err.message);
      if (err.isQuotaError) {
        quotaExhaustedUntil = Date.now() + QUOTA_BACKOFF_MS;
        console.error(
          `[Gemini] Quota exhausted — pausing all explanation requests for ${QUOTA_BACKOFF_MS / 60000} minutes.`
        );
      }
    } finally {
      inFlight.delete(symbol);
    }
  })();

  return null; // not ready yet this round — will be cached for the next request
}
