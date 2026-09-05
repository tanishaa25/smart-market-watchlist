# Smart Market Watchlist — Design Document

## 1. The core idea in one line

> A watchlist that tells you **what changed and whether it matters**, in plain language you can trust — not another table of tickers and percentages.

Most watchlists show *state*. This one shows *the diff since you last looked*, filtered through a judgment layer so noise doesn't drown out signal — and translated into language a first-time investor understands, not a trading terminal.

## 2. Why this interpretation (Product & Problem Interpretation)

The brief explicitly says "don't build the obvious watchlist" and asks what counts as *meaningful* change. The obvious build is a live-updating price table. That fails the brief on two counts:

- It shows the same %-change number every stock has always shown — no judgment applied.
- It assumes the user already knows how to read raw market data — which contradicts what Groww has built its entire product around: making investing simple, jargon-free, and accessible to people who are *not* finance experts.

So the product decision is: **do real quantitative work under the hood, but never surface it as jargon.** Depth in the engine, simplicity on the screen. That combination — not either alone — is the actual differentiator, because most hackathon teams pick one side or the other (either a shallow "big movers" list, or a stats-heavy dashboard that reads like a Bloomberg terminal).

## 3. What counts as "meaningful change" (the core logic)

A change is meaningful if it is **unusual for that specific stock**, not just large in absolute terms. A flat threshold like "flag if move > 3%" is naive — 3% is nothing for a volatile small-cap and huge for a stable blue chip.

**Significance score, per stock, per session:**

```
z = (today's % move) / (stock's own trailing 30-day volatility)
```

- `|z| < 1` → Quiet, no action needed
- `1 ≤ |z| < 2` → Notable
- `|z| ≥ 2`, or unusual volume, or fresh relevant news → Needs attention

Volume spikes and news-event presence add to the score independently of price move — a stock can be "quiet" on price but flagged because volume is 4x normal, which often precedes a price move.

**Translation layer:** the score and its inputs are never shown raw. They're converted into one plain sentence, e.g.:

- *"This kind of move is unusual for Reliance — worth a look."*
- *"HDFC Bank moved 2%, which is normal for it — nothing to act on."*

This is the "buddy, not a terminal" principle, taken directly from Groww's own stated design philosophy.

## 4. What information is surfaced (per item)

- Current price + a **confidence label** on the data (see §6), never a bare number with no context
- Plain-language reason for the day's move where available (top related headline, summarized in one line)
- The bucket: Needs Attention / Notable / Quiet (default sort — not alphabetical, not by ticker)
- The user's own note on *why* they added this stock, resurfaced when something changes (closes the loop between intent and outcome)
- Sector-level rollup insight when relevant, e.g. *"4 of your 6 IT stocks are down today — looks sector-wide, not company-specific."*

## 5. How "since you last checked" actually works

Every session end, store a snapshot per user: `{ticker, price, volume, timestamp}`. On next login, diff **current state vs that user's own last-seen snapshot** — not against yesterday's market close. Two users opening the app at different times get an honest, personalized "what changed for you" view rather than a shared static summary.

This is the mechanism that makes the product genuinely different in *daily use*, not just in a demo: it behaves like an inbox, not a ticker tape.

## 6. Staleness, delays, and conflicting data (Edge Cases & Resilience)

Real market data APIs rate-limit, lag, and occasionally disagree between sources. The system never silently shows a possibly-wrong number.

- **Cache-first with TTL:** prices are cached server-side for a short window (e.g. 30–60s) to absorb API rate limits and reduce duplicate calls across users watching the same ticker.
- **Fallback chain:** live fetch → short-term cache → last-known-good value from DB, in that order. Every response carries a confidence label:
  - "Live" (fetched within TTL)
  - "Delayed" (served from cache, timestamp shown)
  - "Unavailable — showing last known price" (API failure, explicit and honest, never hidden)
- **Reconciliation rule (if multiple sources are used):** prefer the most recently-timestamped source; log disagreements above a small tolerance instead of averaging them silently.
- **Concurrency safety:** watchlist edits carry a version/updated-at check, so a stale write from an old device session cannot silently overwrite a newer one from another device — last-write-wins is explicit and logged, not accidental.

This is demoed live, not just described: kill the API key mid-demo, show graceful degradation with an honest "last known price" label, restore it, show recovery.

## 7. Persistence & multi-device sync

- Real user accounts (email/password is enough for a hackathon) — not localStorage-only, since that fails "across devices" by construction.
- Postgres tables: `users`, `watchlist_items` (ticker, note, tag, added_at), `price_snapshots`, `session_diffs`.
- On login from any device, the server is the source of truth; the diff engine runs server-side against the user's last snapshot, so the experience is identical whether they check from phone or laptop.

## 8. Scaling story (kept honest, not hand-wavy)

- Shared price-fetch + cache layer means N users watching the same ticker cost one API call per TTL window, not N calls — this is the actual lever that matters, not the web server layer.
- Snapshot/diff computation is per-user but cheap (simple arithmetic over a small row set) — this scales linearly and stays fast well past hackathon scale.
- Background refresh, not per-request polling of the upstream API — keeps behavior predictable regardless of how many users are online at once.
- Explicitly *not* doing: microservices, Kafka, websocket fan-out. For a watchlist, 30–60s staleness is imperceptible to a retail investor, so this is a deliberate simplicity choice, not a missed one (Code Quality & Simplicity).

## 9. Tech stack (intentionally boring)

- **Backend:** Node/Express (or FastAPI) — REST, not GraphQL, no infra novelty for its own sake
- **DB:** PostgreSQL
- **Cache:** in-memory TTL cache (Redis only if time allows — not required to prove the concept)
- **Market data:** one free-tier API (Finnhub / Twelve Data / Alpha Vantage)
- **Frontend:** React, polling every 30–60s
- **Auth:** simple email/password, JWT session

## 10. How this maps to the judging rubric

| Rubric row | Where it shows up here |
|---|---|
| Engineering Depth | Snapshot/diff architecture, caching layer, fallback chain, DB schema |
| Product & Problem Interpretation | Significance scoring vs flat thresholds; plain-language translation layer |
| Edge Cases & Resilience | Live-demoable API failure handling, reconciliation rule, concurrency-safe writes |
| Code Quality & Simplicity | Deliberately no websockets/microservices; documented reasoning for every "kept simple" choice |
| Originality & Thoughtfulness | Depth-underneath / simplicity-on-top philosophy, directly aligned to Groww's own stated values (customer obsession, jargon-free, "buddy not terminal") — argued here, demonstrated in the demo |

## 11. Build priority order (if time runs short)

1. Core CRUD watchlist + persistence + auth
2. Price fetch with caching + confidence labels (this alone covers a full rubric row — do not skip)
3. Significance scoring (z-score vs flat threshold) + bucketing
4. Session snapshot/diff engine ("what changed since you checked")
5. Plain-language sentence generation for changes
6. Sector rollup insight + personal notes-on-tickers
7. Live failure-mode demo polish

Everything below step 4 is a nice-to-have; everything from step 1–4 is the actual submission.
