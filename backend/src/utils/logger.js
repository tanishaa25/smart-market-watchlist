// Structured JSON logging via pino — real logs a log-aggregation tool
// (Datadog, CloudWatch, etc.) can actually parse and query, instead of
// plain console.log text. Kept as a thin wrapper so the rest of the app
// imports one `logger` object rather than configuring pino everywhere.
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  // Pretty-printed in local dev (readable in a terminal); raw JSON lines
  // in production (what a real log aggregator actually wants).
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
});
