import { describe, it, expect, beforeEach } from "vitest";
import { isCircuitOpen, recordSuccess, recordFailure, getBreakerStatus, _resetForTests } from "../utils/circuitBreaker.js";
import { createTtlCache } from "../utils/ttlCache.js";
import { isMarketOpen, getSessionBucket } from "../utils/marketHours.js";
import { detectSourceMismatch } from "../utils/sourceMismatch.js";
import { detectMixedSignal } from "../utils/mixedSignal.js";

describe("circuitBreaker", () => {
  const t0 = 1_000_000;

  beforeEach(() => {
    _resetForTests("test-source");
  });

  it("stays closed below the failure threshold", () => {
    for (let i = 0; i < 4; i++) recordFailure("test-source", t0);
    expect(isCircuitOpen("test-source", t0)).toBe(false);
  });

  it("opens on the 5th consecutive failure and closes again after the cooldown", () => {
    for (let i = 0; i < 5; i++) recordFailure("test-source", t0);
    expect(isCircuitOpen("test-source", t0)).toBe(true);
    expect(isCircuitOpen("test-source", t0 + 29_000)).toBe(true);
    expect(isCircuitOpen("test-source", t0 + 30_000)).toBe(false);
  });

  it("a success immediately resets the failure count and closes the circuit", () => {
    for (let i = 0; i < 5; i++) recordFailure("test-source", t0);
    recordSuccess("test-source");
    expect(isCircuitOpen("test-source", t0)).toBe(false);
    expect(getBreakerStatus("test-source").consecutiveFailures).toBe(0);
  });
});

describe("createTtlCache", () => {
  it("returns a cached value within the TTL window and expires it after", () => {
    const cache = createTtlCache(8000);
    const t0 = 1_000_000;
    cache.set("key", ["A", "B"], t0);
    expect(cache.get("key", t0 + 7999)).toEqual(["A", "B"]);
    expect(cache.get("key", t0 + 8000)).toBeUndefined();
  });

  it("invalidate() clears a value immediately, even within the TTL", () => {
    const cache = createTtlCache(8000);
    cache.set("key", "value");
    cache.invalidate("key");
    expect(cache.get("key")).toBeUndefined();
  });
});

describe("isMarketOpen / getSessionBucket", () => {
  it("is open during NSE market hours on a weekday", () => {
    expect(isMarketOpen(new Date("2026-09-07T05:30:00Z"))).toBe(true); // Mon 11:00 AM IST
  });

  it("is closed before the 9:15 AM IST open and exactly at the 3:30 PM IST close", () => {
    expect(isMarketOpen(new Date("2026-09-07T03:44:00Z"))).toBe(false); // 9:14 AM IST
    expect(isMarketOpen(new Date("2026-09-07T10:00:00Z"))).toBe(false); // exactly 3:30 PM IST
  });

  it("is closed on weekends", () => {
    expect(isMarketOpen(new Date("2026-09-05T06:30:00Z"))).toBe(false); // Saturday
    expect(isMarketOpen(new Date("2026-09-06T06:30:00Z"))).toBe(false); // Sunday
  });

  it("is closed on real NSE trading holidays, even mid-day on an otherwise normal weekday", () => {
    expect(isMarketOpen(new Date("2026-01-26T05:30:00Z"))).toBe(false); // Republic Day, Mon 11 AM IST
    expect(isMarketOpen(new Date("2026-12-25T05:30:00Z"))).toBe(false); // Christmas, Fri 11 AM IST
  });

  it("resumes normal trading the day immediately after a holiday", () => {
    expect(isMarketOpen(new Date("2026-01-27T05:30:00Z"))).toBe(true); // day after Republic Day
  });

  it("attributes pre-open hours to the PREVIOUS trading session, not a fresh day at midnight", () => {
    expect(getSessionBucket(new Date("2026-09-07T02:30:00Z"))).toBe("2026-09-06"); // 8:00 AM IST, before open
    expect(getSessionBucket(new Date("2026-09-07T03:45:00Z"))).toBe("2026-09-07"); // exactly 9:15 AM IST, at open
  });
});

describe("detectSourceMismatch", () => {
  it("flags a real disagreement between two different real providers", () => {
    expect(detectSourceMismatch("yahoo", "nse")).toBe(true);
  });

  it("does not flag when either side is simulated or missing", () => {
    expect(detectSourceMismatch("simulated", "yahoo")).toBe(false);
    expect(detectSourceMismatch(null, "yahoo")).toBe(false);
  });

  it("does not flag when both sides are the same provider", () => {
    expect(detectSourceMismatch("yahoo", "yahoo")).toBe(false);
  });
});

describe("detectMixedSignal", () => {
  it("flags when today's direction and the since-last-check direction disagree", () => {
    expect(detectMixedSignal(1.2, -4.0)).toBe(true);
    expect(detectMixedSignal(-0.5, 2.1)).toBe(true);
  });

  it("does not flag when both directions agree, or either side is exactly zero", () => {
    expect(detectMixedSignal(1.2, 3.0)).toBe(false);
    expect(detectMixedSignal(-1.2, -3.0)).toBe(false);
    expect(detectMixedSignal(0, -3.0)).toBe(false);
    expect(detectMixedSignal(1.2, null)).toBe(false);
  });
});
