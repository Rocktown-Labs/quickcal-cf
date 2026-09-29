import { createMiddleware } from "hono/factory";
import type { AuthEnv } from "../lib/auth";

export interface RateLimitOptions {
  /** Time window in milliseconds. */
  windowMs: number;
  /** Maximum number of requests allowed in the window. */
  maxRequests: number;
  /** Prefix used to namespace rate-limit counters. */
  keyPrefix: string;
}

interface WindowEntry {
  timestamps: number[];
}

// In-memory store. In a multi-isolate runtime (Cloudflare Workers) this is
// per-isolate, not global. For production traffic you should switch to
// Cloudflare Rate Limiting rules or a Durable Object.
const store = new Map<string, WindowEntry>();
const MAX_STORE_KEYS = 2000;

function getClientIdentifier(c: {
  req: { header: (name: string) => string | undefined };
  var: { userId?: string };
}): string {
  const userId = c.var.userId;
  if (userId) {
    return `u:${userId}`;
  }

  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) {
    return `ip:${cfIp}`;
  }

  const forwarded = c.req.header("x-forwarded-for");
  const forwardedIp = forwarded?.split(",")[0]?.trim();
  if (forwardedIp) {
    return `ip:${forwardedIp}`;
  }

  return "ip:unknown";
}

function pruneStore() {
  if (store.size <= MAX_STORE_KEYS) return;
  const cutoff = Date.now();
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => cutoff - t < 86_400_000);
    if (entry.timestamps.length === 0) {
      store.delete(key);
    }
  }
}

function isLimited(key: string, windowMs: number, maxRequests: number): boolean {
  const now = Date.now();
  const entry = store.get(key) ?? { timestamps: [] };

  const recent = entry.timestamps.filter((t) => now - t < windowMs);
  if (recent.length >= maxRequests) {
    store.set(key, { timestamps: recent });
    return true;
  }

  recent.push(now);
  store.set(key, { timestamps: recent });

  if (store.size > MAX_STORE_KEYS) {
    pruneStore();
  }

  return false;
}

export function rateLimit(options: RateLimitOptions) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const identifier = getClientIdentifier(c);
    const key = `${options.keyPrefix}:${identifier}`;

    if (isLimited(key, options.windowMs, options.maxRequests)) {
      const retryAfter = Math.ceil(options.windowMs / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { error: "Too many requests. Please slow down and try again later." },
        429,
      );
    }

    await next();
  });
}
