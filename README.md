# Smart Market Watchlist

Real accounts, a real-time price stream, and a persisted "what changed
since you last checked" diff — built on Firestore.

**Scope: NSE-listed Indian stocks only.** This app's real (non-simulated)
data sources — NSE's own direct quote feed and Yahoo's Indian-market
endpoint — only cover Indian equities, so the curated stock list, the
simulated-fallback prices, and the AI change explanations are all
Indian-only by design. See "How the real-time part works" below for why.

## What's here

- **backend/** — Express API:
  - Email/password auth (JWT sessions)
  - Per-user watchlists stored in **Cloud Firestore**
  - A **real-time price stream** with a layered real-data fallback chain
    for Indian stocks (Finnhub → NSE direct → Yahoo → simulated)
  - A **"since you last checked" diff**, computed from a `lastSeenPrice`
    stored per watchlist item
  - An **AI-generated plain-language explanation** of each stock's move
    (via Gemini), shown alongside — never instead of — the raw % change
  - A stocks browse/search endpoint over a curated Indian ticker list
- **frontend/** — React (Vite), two pages behind a login screen:
  - **Dashboard** (`/`) — your watchlist, live-updating prices, the
    "Since Last Check" diff, and a 💡 plain-language explanation of each
    move
  - **Browse Stocks** (`/browse`) — search a curated list and add
    anything to your watchlist

## Why Firestore (not SQL, not another NoSQL option)

The data here — a user, their watchlist items, each item's last-seen
price — is naturally relational. A SQL database would model it just as
well. Firestore was chosen specifically at your request; its document
model maps cleanly here as `users/{email}/watchlist/{symbol}` (see the
comment at the top of `backend/src/db.js` for the exact schema).

**One real trade-off worth knowing**: Firestore bills per document
read/write. The stream route avoids re-querying Firestore on every price
tick — it keeps an in-memory filter per connection, updated instantly via
a small pub-sub (`services/watchlistEvents.js`) when you add/remove a
symbol, rather than hitting the database on every tick. `GET
/api/watchlist` does one read per watchlist item per load, which is the
one place cost scales with usage — fine at hackathon/personal scale,
worth watching if this ever has many users checking very frequently.

## Required setup: Firestore

1. Create a project at https://console.firebase.google.com
2. **Build > Firestore Database > Create database** (test mode is fine
   for development).
3. **Project settings (gear icon) > Service accounts > Generate new
   private key.** This downloads a JSON file.
4. Point the backend at it — see `backend/.env.example` for the two ways
   to do this (a file path, or pasting the JSON directly).

**I could not test an actual live Firestore connection** while building
this — this sandbox's network doesn't allow reaching `firestore.googleapis.com`,
and I don't have a real Firebase project. What I *did* verify:
- The app fails with a clear, specific error (not a crash) if Firestore
  credentials are missing.
- The credential-loading code runs correctly with a structurally valid
  key (parses and initializes without error).
- A real Firestore call against fake credentials fails cleanly and the
  server stays up — logged clearly, not a silent hang.

Please verify the actual reads/writes work once you've set up your real
project — I'm confident in the code against Firestore's documented API,
but haven't watched a real request succeed end-to-end.

## How the "since you last checked" diff works

Each watchlist item stores `lastSeenPrice` + `lastSeenAt` in Firestore.
Every time you load the Dashboard:
1. The server compares the current price to `lastSeenPrice` and returns
   that as `sinceLastSeen` — this is what renders in the "Since Last
   Check" column.
2. If your last check-in was **more than 30 minutes ago**, the server
   resets the baseline to right now, for next time.
3. If you're re-loading within that 30-minute window (e.g. right after
   adding a stock), the baseline is **not** touched — otherwise the diff
   would vanish before you even saw it.

This is separate from the live-ticking price/change shown elsewhere in
the row — that's today's intraday change, pushed in real time. "Since
Last Check" is a slower-moving, session-to-session comparison.

## How the real-time part works

- The backend keeps **one persistent WebSocket connection** to Finnhub
  and subscribes (with reference counting, since multiple users can
  watch the same symbol) to every symbol anyone has on their watchlist.
- **Layered fallback for real data** — this matters most for Indian
  stocks:
  1. **Finnhub WebSocket** — real-time, tick-by-tick, but US-market only.
  2. **NSE's own direct quote endpoint** — real AND instant (no
     artificial delay) for NSE-listed symbols (`RELIANCE`, `TCS`,
     `INFY`, etc.) — the same internal API nseindia.com's own live quote
     widget uses. This is unofficial and bot-sensitive: it requires a
     cookie handshake and is rate-limited to ~3 requests/second, which
     `services/nseDirectService.js` self-throttles for. **In practice,
     this layer may fail consistently even with correct headers and
     valid cookies** — NSE's anti-bot protection likely fingerprints the
     TLS handshake itself, which is a browser-level signature plain
     Node.js `fetch` cannot fully replicate no matter how the HTTP
     headers are tuned. This is a known limitation of every unofficial
     NSE-scraping approach, not a bug specific to this app. If this
     layer fails, the app automatically drops to the next one — Yahoo —
     without breaking.
  3. **Yahoo Finance's public Indian-market endpoint** — real trades,
     but typically ~15 minutes delayed, and more tolerant/reliable as a
     fallback-of-a-fallback than direct NSE scraping.
  4. **Simulated ticker** — only if all three real sources fail for a
     symbol. Always honestly labeled `simulated`, never presented as
     real.
- The frontend uses `EventSource`, authenticated via a `?token=` query
  param (EventSource can't set custom headers), which reconnects
  automatically if dropped.

## How the AI change explanation works (Gemini)

Each stock in your watchlist can show a one-sentence, plain-language
explanation of its price movement — not just "+2.2%," but something like
*"This is a moderate move for RELIANCE, and slightly steeper than its usual
day-to-day swings."*

**Only generated for `live` quotes, never `simulated` ones.** A simulated
price is a synthetic random walk — there's no real cause behind it, so
asking an LLM to "explain" it would mean either inventing a plausible-
sounding reason or overstating confidence in something fake. Simulated
symbols get an honest static message instead: *"This is a simulated
price for practice/demo purposes — there's no real market event behind
this move."*

**What goes into the prompt** (see `services/geminiExplainer.js` for the
exact text): the stock's name/sector, today's change, a magnitude bucket
(small/moderate/large) computed in code — not left for the model to
invent, since we don't have real historical volatility data to back up a
more precise claim — the "since you last checked" diff, and the user's
own note on why they're watching that stock, when they've written one.

**What the prompt explicitly forbids**: investment advice (buy/sell/hold
— this app displays information, it isn't a financial advisor), inventing
a specific news event it can't verify, and jargon aimed at non-experts.

**Setup**: get a free key at https://aistudio.google.com/apikey and set
`GEMINI_API_KEY` in `.env`. Without a key, this feature is silently
skipped — everything else in the app works exactly the same.

**Two real Google free-tier limits worth knowing about**, both hit
during development and fixed in code:
1. **Per-day cap** (as low as 20 requests/day on some models) — once
   exhausted, the app backs off for 30 minutes rather than retrying on
   every page load and wasting further quota once it's available again.
2. **Per-minute cap** (as low as 5/minute) — a watchlist with more
   stocks than that, all requesting explanations in the same page load,
   would blow straight through it in under a second if fired
   concurrently. Fixed with a self-throttle (`services/geminiExplainer.js`)
   that spaces outbound calls ~13s apart using atomic slot reservation
   (not a naive "check the last call time" pattern, which has a race
   condition when several calls start at the same moment).
   **Consequence**: explanation generation is fully non-blocking —
   `GET /api/watchlist` never waits on it. If an explanation isn't
   cached yet, generation kicks off in the background and the price/diff
   data returns immediately regardless; the explanation appears on a
   subsequent reload once it's ready.

## How cross-device state persistence works

Three features, all built on the same principle: **write it to Firestore, not the browser** — so anything that happens on one device is instantly true on every device, with zero sync code needed.

1. **"Since you last checked" diff** (existing) — `lastSeenPrice`/`lastSeenAt` per watchlist item.
2. **Cross-device alert review** (new) — each watchlist item also stores `reviewedBucket`/`reviewedAt`. When a stock gets flagged "Notable" or "Needs Attention," it's marked as new (a red dot + a "Got it" button) until acknowledged — on *any* device. Acknowledging it on your phone means your laptop won't show it as new an hour later. `POST /api/watchlist/:symbol/review` records this.
3. **Soft-delete with a 7-day restore window** (new) — removing a stock sets `deletedAt` instead of actually deleting the Firestore document. `GET /api/watchlist/trash` lists recoverable items with days-remaining; `POST /api/watchlist/:symbol/restore` undoes it. Expired trash (>7 days) is purged lazily whenever trash is viewed — no background job needed at this scale.

## Stale/conflicting data — the deeper layer

Beyond the basic Live/Cached/Simulated labeling, four additions target
subtler correctness and UX issues in how staleness and multi-source data
actually behave in practice:

1. **Staleness decay dot** (`utils/staleness.js`, frontend) — instead of a
   flat "Live" label, a small dot fades green → amber → red as a quote
   ages (30s / 2min thresholds), continuously, without needing new data
   to arrive to update.
2. **Market-hours awareness** (`utils/marketHours.js`, backend) — NSE
   trading hours are 9:15 AM–3:30 PM IST, Monday–Friday. Outside those
   hours, the staleness dot is deliberately overridden to a neutral
   "Market closed" state instead of turning red — a naive time-only
   check would show a false "stale" warning every single evening, since
   today's closing price is *supposed* to stay fixed until tomorrow's
   open. (Known limitation: doesn't account for NSE trading holidays.)
3. **Source-mismatch detection** (`utils/sourceMismatch.js`, backend) —
   each quote now carries a `provider` field (`finnhub`/`nse`/`yahoo`/
   `simulated`), and the "since you last checked" baseline stores which
   provider produced it. If the baseline came from one real source and
   today's price comes from a different one, the diff is flagged
   `sourceMismatch: true` and shown with a "⚠ approx." note — different
   providers can have small methodology differences (after-hours
   handling, rounding), so silently blending them into one diff number
   would be subtly misleading without ever looking wrong.
4. **Adaptive circuit breaker** (`utils/circuitBreaker.js`, backend) —
   NSE fails almost 100% of the time in practice (TLS fingerprint
   blocking — see the layered-fallback section above), yet every quote
   request was still paying the latency cost of a doomed attempt before
   falling through to Yahoo. After 5 consecutive failures, the breaker
   opens and skips that source entirely for 2 minutes, then allows one
   trial call through — success closes it, failure re-opens it. This is
   learned from the app's own real-time behavior, not a hardcoded
   assumption about which source is unreliable; if NSE started working,
   or Yahoo started failing instead, it adapts automatically either way.
   **Verified with a real integration test**, not just isolated logic: a
   mocked always-failing source was called 10 times in a row — the
   breaker let the first 5 real attempts through (opening on the 5th),
   then correctly skipped the network call entirely for calls 6–10.

## Scaling additions

Two changes aimed at what actually matters as usage grows — read cost
and shared-resource fairness — not premature infrastructure:

1. **Watchlist read caching** (`utils/ttlCache.js`, `db.js`) — the same
   "one real fetch per short window, no matter how many requests ask"
   principle already used for external price APIs, applied to the app's
   own Firestore reads. An 8-second cache is invalidated immediately on
   any write (add/remove/restore/review/last-seen update), so nobody
   ever sees stale data after their own action, but rapid reloads or
   near-simultaneous requests don't each cost a real database read.
   **Verified with a simulated integration test**: 5 rapid reloads
   produced exactly 1 real read; a write correctly forced a fresh read
   on the next call, then subsequent reads went back to hitting cache.
2. **Per-user watchlist size cap** (50 stocks, `db.js`) — without one, a
   single user could hold open unlimited real-time subscriptions and
   trigger unbounded per-stock work (significance scoring, sparklines,
   AI explanations) on every request, degrading the shared backend for
   every other user. Real broker platforms enforce similar caps for
   the same reason.

**Bigger scaling work, deliberately not built (documented instead):**
this app's real-time state — the price cache, the circuit breaker's
failure counts, the Gemini rate-limit throttle — currently lives in one
Node process's memory. Running multiple backend servers behind a load
balancer would need that state moved to a shared store (e.g. Redis) so
every server sees the same truth — otherwise two servers could each
independently think they have their own full Gemini rate-limit budget,
quietly doubling real usage against Google's actual per-project limit.
This is a real, known next step, intentionally scoped out of this build
rather than half-implemented.

## Resolving two design gaps against Meridian, without changing Firestore

Two places where the earlier build did something real but simpler than
Meridian's design — closed properly, keeping Firestore throughout (no
migration to a relational database):

1. **Compute-on-write event storage** (`services/changeEventStore.js`) —
   replaces "recompute significance fresh on every request." The
   expensive, user-independent raw signals for a (symbol, day) are now
   computed once and persisted in a `changeEvents` Firestore collection,
   deduplicated by a deterministic `{symbol}_{date}` document ID (no SQL
   UNIQUE constraint needed — the doc ID *is* the dedup key), with a
   "keep the stronger reading" merge if the stock moves further later
   the same day. The one adaptation from a literal reading of Meridian's
   own schema: their score is absence-scaled *per user* (their own
   spec says so — "Score(E, W) for user u"), so what's persisted here is
   the shared raw signals, and the final score is assembled per-request
   from those stored facts plus that user's own `daysAway` — same
   "assembled from stored events, no recomputation" principle their read
   path describes, correctly handling the one genuinely per-user part.
   `significanceService.js` is now split into `computeRawSignals()`
   (expensive, persisted) and `assembleScore()` (cheap, per-request) —
   **verified byte-identical output** against the original all-in-one
   function before wiring the split in.
2. **Templated narratives, replacing Gemini** (`services/narrativeService.js`) —
   this was a genuine philosophical disagreement, resolved by adopting
   Meridian's stated position: "deterministic, testable, free, and
   honest — 'why it matters' from data we actually have," rather than an
   LLM call that could hallucinate a cause. Every sentence is built from
   already-computed signals (magnitude, volume, sector-relative
   attribution, earnings proximity) — **verified fully deterministic**:
   identical inputs produce byte-identical output, unlike an LLM call.
   The Gemini integration still exists in the codebase but is no longer
   the active path.

**Three follow-up gaps, since closed:**
- **Real IST trading-session boundary** (`utils/marketHours.js`'s
  `getSessionBucket`) — replaced a naive UTC-calendar-day bucket with
  one tied to NSE's actual 9:15 AM IST open: pre-market hours correctly
  attribute to the *previous* day's session, not a fresh one starting at
  midnight. **Verified at the exact minute boundary** (9:14 AM → still
  yesterday's session; 9:15 AM → today's).
- **Retention/cleanup for `changeEvents`** — a lazy purge (same pattern
  already used for the watchlist Trash) deletes records older than 90
  days whenever a stock's history is viewed, so per-symbol storage stays
  bounded without needing a scheduler this app doesn't have.
- **A real History view** — `GET /api/watchlist/:symbol/history` plus a
  `StockHistoryModal`, so the persisted audit trail is actually visible
  in the app (click "History" under any stock), not just sitting in
  Firestore with no UI on top of it.

## Four more Meridian gaps closed

1. **Anonymous-first auth** (`routes/auth.js`, `db.js`) — `POST /api/auth/anonymous`
   creates a fully-functional session with no email/password at all;
   the frontend calls this silently on first load, never showing a
   login wall. `POST /api/auth/upgrade` attaches email+password to that
   *same* session in place (same document ID, same watchlists, same
   history) so it becomes loginable from another device — no data
   migration needed. Required switching `findUserByEmail` from a direct
   doc-ID lookup to a query, verified backward-compatible with existing
   accounts since `email` was already stored as a real field, not just
   the doc ID. **Verified**: 1000 generated anonymous IDs with zero
   collisions, and a direct JWT round-trip test confirming auth works
   identically for a non-email-shaped user ID.
2. **Multiple named watchlists** (`routes/lists.js`, `db.js`) — create,
   rename, delete, and reorder lists via a tab switcher. Scoped
   deliberately: a symbol lives in exactly one list at a time (the
   existing per-symbol document ID stays unchanged), keeping every other
   route's `:symbol`-based lookups (review, restore, history) untouched
   rather than requiring a much larger redesign. **Verified**: the
   reorder swap logic against 3 cases including both top/bottom boundary
   no-ops, and the list auto-creation/sorting logic.
3. **Score transparency UI** (`ScoreBreakdownModal.jsx`) — tapping a
   significance badge now opens the actual six-signal breakdown with
   plain-language explanations, reusing data the backend already
   computed but never displayed. **Verified**: the "z = 2.69 (move
   +4.30%, daily volatility 1.60%, 1.0 day away)" explanation format
   matches the source blueprint's own example precisely.
4. **Absence-window shading on sparklines** (`Sparkline.jsx`) — the
   trailing portion of each mini-chart corresponding to "how long you've
   been away" is now visually shaded, not just implied by a separate
   text column. A documented approximation: the underlying history is a
   fixed synthetic series, not literal calendar dates, so this shades
   "roughly how much of this window you were away for," not a
   precisely-dated region. **Verified**: 6 boundary cases (zero absence,
   normal case, over-length clamping, fractional-day rounding).

## Four more Meridian gaps closed — caps, honesty, polish, and a real detail page

1. **Per-type and window caps** (`utils/briefing.js`) — at most 2
   catalyst-driven cards in a briefing (closest earnings first, so a
   week with several earnings reports doesn't crowd out real
   price-driven events), and a 30-trading-day absence cap that switches
   the "N more" expander to a message pointing at the full History
   instead of expanding inline. **Verified** with the exact worked
   scenario (4 catalyst items capped to the 2 closest, a genuine price
   mover never touched by the cap).
2. **Data-gap disclosure** — the briefing now honestly flags when any
   flagged stock is currently running on simulated data because a real
   source wasn't available, rather than silently blending it in. A
   documented simplification: this detects a *live* gap right now, not
   a historical gap during the specific absence window, since the
   original design's per-day gap tracking isn't part of this app's data
   model.
3. **Skeleton loading states** (`SkeletonRows.jsx`) — replaced the plain
   "Loading..." text with shimmering placeholder rows matching the real
   table's shape, so the layout doesn't jump once data arrives.
4. **A real Stock Details page** (`/stock/:symbol`) — a dedicated route,
   not just a modal: a bigger absence-shaded chart, the full six-signal
   breakdown, catalyst info, and recent history, all from one new
   `GET /api/watchlist/:symbol/detail` endpoint. Reachable by clicking
   any stock's symbol directly from the Dashboard.

## Infrastructure and process gaps, closed

1. **Real automated test suite** — 53 backend tests + 12 frontend tests,
   all committed as actual files (`src/__tests__/`), running via a real
   `npm test` in both directories (Vitest). Not interactive scripts —
   genuinely repeatable, CI-verified tests covering the confluence
   multiplier (exact match to the source blueprint's own worked
   example), absence scaling, frozen-quote detection, the circuit
   breaker, market hours (including real 2026 NSE holidays), echo
   grouping, staleness decay, and cookie/header auth precedence.
2. **App-level rate limiting** (`utils/rateLimiter.js`) — a sliding
   window (30 req/min per user) on every mutation endpoint and every
   auth endpoint, independent of the per-provider circuit breaker.
3. **Security hardening**: `helmet` security headers (CSP, X-Frame-
   Options, HSTS — **verified live** via `curl` against a booted
   server); httpOnly cookie auth as a genuine additive option alongside
   the existing Bearer-token flow (header takes priority, cookie is a
   real fallback — 4 tests covering all combinations); strict symbol
   validation blocking real injection/path-traversal attempts before
   they ever reach Firestore.
4. **Real NSE holiday calendar** for 2026 (cross-checked against 9
   independent sources) — market-hours logic now correctly treats
   Republic Day, Diwali, Christmas, etc. as closed even mid-day on an
   otherwise ordinary weekday.
5. **Observability** — structured JSON logs (pino) replacing plain
   `console.log`; a request-ID + duration tracing middleware; a real
   `GET /api/metrics` endpoint in Prometheus text format; a
   `GET /api/readyz` readiness check distinct from liveness. **A real
   bug was caught and fixed via live testing here**: the initial
   readiness check could hang indefinitely on a slow/unreachable
   Firestore — added an explicit 3-second timeout, verified live that
   it now fails fast instead of hanging.
6. **Docker + CI/CD** — a `Dockerfile` for each service (backend:
   Node/Alpine; frontend: multi-stage Vite build served via nginx, with
   SPA routing and an `/api` proxy), a `docker-compose.yml` for a
   one-command local demo, and a GitHub Actions workflow. **The CI
   workflow's exact commands were actually run** (`npm ci`, `npm test`,
   `npm run build`, in both directories) to confirm it would genuinely
   pass — Docker itself isn't available in this build environment, so
   the Dockerfiles follow standard practice but couldn't be build-tested
   directly.

## Run it

**1. Backend**

```bash
cd backend
npm install
cp .env.example .env
# fill in your Firestore credentials and (optionally) FINNHUB_API_KEY — see above
npm start
```

**2. Frontend** (in a second terminal)

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`, register an account, and add a few tickers.

## What's intentionally not here yet (see DESIGN.md)

Significance scoring (statistical "is this move actually unusual"
detection) and plain-language change summaries are the next layer on top
of this — the persistence and diffing groundwork for them is now in
place.
