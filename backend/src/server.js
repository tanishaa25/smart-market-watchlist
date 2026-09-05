import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { authRouter } from "./routes/auth.js";
import { watchlistRouter } from "./routes/watchlist.js";
import { quotesRouter } from "./routes/quotes.js";
import { stocksRouter } from "./routes/stocks.js";
import { streamRouter } from "./routes/stream.js";
import { briefingRouter } from "./routes/briefing.js";
import { listsRouter } from "./routes/lists.js";
import { profileRouter } from "./routes/profile.js";
import { subscribeSymbol } from "./services/finnhubStream.js";
import { getAllDistinctSymbols } from "./db.js";
import { logger } from "./utils/logger.js";
import { incrementCounter, recordDuration, renderPrometheusText } from "./utils/metrics.js";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
// Security headers (CSP, X-Content-Type-Options, etc.) — low-risk here
// since this server only serves JSON, not HTML/scripts, so helmet's
// default policy doesn't need the careful per-script tuning it would on
// an HTML-serving app.
app.use(helmet());
app.use(cookieParser());
app.use(express.json());

// Lightweight request tracing: a unique ID per request (for correlating
// log lines across a single request's lifecycle — the practical part of
// what full distributed tracing would give at larger scale, without
// pulling in a full OpenTelemetry collector for a project this size)
// plus structured start/end log lines and metrics.
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  const startedAt = Date.now();
  logger.info({ reqId: req.id, method: req.method, path: req.path }, "request started");

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    recordDuration(durationMs);
    incrementCounter("requests");
    if (res.statusCode >= 500) incrementCounter("server_errors");
    else if (res.statusCode >= 400) incrementCounter("client_errors");
    logger.info(
      { reqId: req.id, method: req.method, path: req.path, statusCode: res.statusCode, durationMs },
      "request finished"
    );
  });

  next();
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    liveDataConfigured: Boolean(process.env.FINNHUB_API_KEY),
  });
});

// Readiness is distinct from liveness: liveness ("/health") just means
// the process is up; readiness means its actual dependencies (Firestore,
// in this app) are reachable right now — the check a load balancer or
// orchestrator should use before routing real traffic to this instance.
// A hard timeout matters here more than almost anywhere else in the
// app: a readiness check that can hang indefinitely on a slow/dead
// dependency is worse than one that fails fast, since it ties up a
// connection an orchestrator is polling on a tight interval.
const READYZ_TIMEOUT_MS = 3000;

app.get("/api/readyz", async (req, res) => {
  try {
    await Promise.race([
      getAllDistinctSymbols(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Readiness check timed out")), READYZ_TIMEOUT_MS)),
    ]);
    res.json({ status: "ready" });
  } catch (err) {
    res.status(503).json({ status: "not ready", reason: err.message });
  }
});

app.get("/api/metrics", (req, res) => {
  res.set("Content-Type", "text/plain; version=0.0.4");
  res.send(renderPrometheusText());
});

app.use("/api/auth", authRouter);
app.use("/api/watchlist", watchlistRouter);
app.use("/api/quotes", quotesRouter);
app.use("/api/stocks", stocksRouter);
app.use("/api/stream", streamRouter);
app.use("/api/briefing", briefingRouter);
app.use("/api/lists", listsRouter);
app.use("/api/profile", profileRouter);

app.listen(PORT, async () => {
  logger.info({ port: PORT }, "Watchlist backend running");
  if (!process.env.FINNHUB_API_KEY) {
    logger.warn("No FINNHUB_API_KEY set — serving simulated prices. See .env.example.");
  }

  // Resume real-time streaming for anything already saved across every
  // user's watchlist, from before this restart.
  try {
    const symbols = await getAllDistinctSymbols();
    for (const symbol of symbols) {
      subscribeSymbol(symbol);
    }
    if (symbols.length > 0) {
      logger.info({ count: symbols.length }, "Resumed streaming for previously-saved symbols");
    }
  } catch (err) {
    logger.error({ err: err.message }, "Could not resume streaming from saved watchlists");
  }
});
