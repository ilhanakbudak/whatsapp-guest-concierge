import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "../src/lib/rate-limit.js";

describe("TokenBucketLimiter", () => {
  it("allows up to capacity then refuses", () => {
    const limiter = new TokenBucketLimiter(3, 3, () => 0);

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("tracks each key independently", () => {
    const limiter = new TokenBucketLimiter(1, 1, () => 0);

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("refills over time", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(2, 60, () => now);

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);

    now += 1000; // one second at 60/min == one token
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("never refills beyond capacity", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(2, 60, () => now);

    limiter.check("a");
    now += 600_000; // ten minutes of refill for a two-token bucket

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("reports a usable retry-after", () => {
    const limiter = new TokenBucketLimiter(1, 60, () => 0);

    limiter.check("a");
    const decision = limiter.check("a");

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(1);
  });

  it("prunes fully-refilled buckets so the map cannot grow unbounded", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(5, 60, () => now);

    limiter.check("a");
    limiter.check("b");

    expect(limiter.prune()).toBe(0); // both still partially drained

    now += 600_000;
    expect(limiter.prune()).toBe(2);
  });
});
