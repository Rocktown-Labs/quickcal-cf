import { DurableObject } from "cloudflare:workers";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets (present when limited). */
  retryAfter: number;
}

/**
 * Fixed-window rate limiter backed by a Durable Object.
 *
 * Each client key gets its own object instance (via `idFromName`), so
 * counters are shared across all Worker isolates — unlike an in-memory
 * limiter, which resets whenever a new isolate spins up. Counters live in
 * instance memory; an alarm purges expired buckets so idle objects stay
 * tiny. Losing in-memory state (e.g. after hibernation) makes the limiter
 * briefly more lenient, never more strict.
 */
export class RateLimiter extends DurableObject {
  private buckets = new Map<string, Bucket>();

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
      await this.ctx.storage.setAlarm(bucket.resetAt);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }
    return { ok: true, retryAfter: 0 };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | undefined;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      } else if (next === undefined || bucket.resetAt < next) {
        next = bucket.resetAt;
      }
    }
    if (next !== undefined) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}
