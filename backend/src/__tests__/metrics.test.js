import { describe, it, expect, beforeEach } from "vitest";
import { incrementCounter, recordDuration, getMetricsSnapshot, renderPrometheusText, _resetForTests } from "../utils/metrics.js";

describe("metrics", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("counts increments correctly per named metric", () => {
    incrementCounter("requests");
    incrementCounter("requests");
    incrementCounter("errors");
    const snap = getMetricsSnapshot();
    expect(snap.counters.requests).toBe(2);
    expect(snap.counters.errors).toBe(1);
  });

  it("computes a correct average duration", () => {
    recordDuration(10);
    recordDuration(20);
    recordDuration(30);
    expect(getMetricsSnapshot().avgDurationMs).toBe(20);
  });

  it("renders valid Prometheus text exposition format", () => {
    incrementCounter("requests");
    incrementCounter("requests");
    recordDuration(15);
    const text = renderPrometheusText();
    expect(text).toContain("# TYPE app_requests_total counter");
    expect(text).toContain("app_requests_total 2");
    expect(text).toContain("# TYPE app_request_duration_avg_ms gauge");
    expect(text).toContain("app_request_duration_avg_ms 15");
  });

  it("handles zero recorded durations without dividing by zero", () => {
    expect(getMetricsSnapshot().avgDurationMs).toBe(0);
  });
});
