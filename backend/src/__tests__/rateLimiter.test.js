import { describe, it, expect, beforeEach } from "vitest";
import { isRateLimited, _resetForTests } from "../utils/rateLimiter.js";

describe("rateLimiter", () => {
  beforeEach(() => {
    _resetForTests("user1");
  });

  it("allows requests under the limit", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 29; i++) {
      expect(isRateLimited("user1", t0 + i)).toBe(false);
    }
  });

  it("blocks the 31st request within the same window", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) isRateLimited("user1", t0 + i);
    expect(isRateLimited("user1", t0 + 30)).toBe(true);
  });

  it("allows requests again once the sliding window has passed", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) isRateLimited("user1", t0 + i);
    expect(isRateLimited("user1", t0 + 30)).toBe(true); // still limited
    expect(isRateLimited("user1", t0 + 61_000)).toBe(false); // a full minute later, window has slid
  });

  it("tracks different keys independently", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) isRateLimited("user1", t0 + i);
    expect(isRateLimited("user1", t0 + 30)).toBe(true);
    expect(isRateLimited("user2", t0 + 30)).toBe(false); // a different user is unaffected
  });
});
