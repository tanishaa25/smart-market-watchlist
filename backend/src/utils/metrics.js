// In-memory metrics — the same "no Redis/external service needed at
// this scale" pattern already used for the circuit breaker, TTL cache,
// and watchlist events. Not a substitute for real Prometheus + Grafana
// at production scale, but a genuine, scrapable /metrics endpoint
// instead of nothing at all.

const counters = new Map(); // metric name -> count
const durations = []; // recent request durations in ms, for a simple average

const MAX_DURATION_SAMPLES = 500; // bounded, so this never grows unbounded over a long-running process

export function incrementCounter(name) {
  counters.set(name, (counters.get(name) ?? 0) + 1);
}

export function recordDuration(ms) {
  durations.push(ms);
  if (durations.length > MAX_DURATION_SAMPLES) durations.shift();
}

export function getMetricsSnapshot() {
  const avgDurationMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  return {
    counters: Object.fromEntries(counters),
    avgDurationMs: +avgDurationMs.toFixed(2),
    sampledRequests: durations.length,
  };
}

/**
 * Renders the current metrics in Prometheus's plain-text exposition
 * format — the shape a real Prometheus server would scrape from
 * GET /api/metrics.
 */
export function renderPrometheusText() {
  const snapshot = getMetricsSnapshot();
  const lines = [];

  for (const [name, value] of Object.entries(snapshot.counters)) {
    const metricName = `app_${name}_total`;
    lines.push(`# TYPE ${metricName} counter`);
    lines.push(`${metricName} ${value}`);
  }

  lines.push("# TYPE app_request_duration_avg_ms gauge");
  lines.push(`app_request_duration_avg_ms ${snapshot.avgDurationMs}`);

  return lines.join("\n") + "\n";
}

// Testing/reset helper — not used in production code paths.
export function _resetForTests() {
  counters.clear();
  durations.length = 0;
}
