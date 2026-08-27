export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the next token is available. 0 when allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Per-key token bucket, in memory.
 *
 * Deliberately not Redis: this guards against one guest spamming the bot, and a
 * single Railway instance is the whole deployment. If it ever runs multi-instance
 * the limit becomes per-instance, which is a documented and acceptable weakening
 * rather than a silent bug.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateLimitDecision {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefill: now };

    const elapsedMinutes = (now - bucket.lastRefill) / 60_000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedMinutes * this.refillPerMinute);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    this.buckets.set(key, bucket);
    const tokensNeeded = 1 - bucket.tokens;
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((tokensNeeded / this.refillPerMinute) * 60),
    };
  }

  /** Drops buckets that have fully refilled, so the map can't grow unbounded. */
  prune(): number {
    const now = this.now();
    let removed = 0;

    for (const [key, bucket] of this.buckets) {
      const elapsedMinutes = (now - bucket.lastRefill) / 60_000;
      if (bucket.tokens + elapsedMinutes * this.refillPerMinute >= this.capacity) {
        this.buckets.delete(key);
        removed++;
      }
    }

    return removed;
  }

  reset(): void {
    this.buckets.clear();
  }
}
