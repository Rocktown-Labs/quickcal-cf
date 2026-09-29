import { createMiddleware } from "hono/factory";
import type { AuthEnv } from "../lib/auth";
import { ENV } from "../env.server";

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

// In-memory fallback — used when the Durable Object binding is not
// available (unit tests, standalone Node runtimes). Per-isolate only.
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

function isLimitedInMemory(key: string, windowMs: number, maxRequests: number): boolean {
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

async function isLimited(
  identifier: string,
  options: RateLimitOptions,
): Promise<{ limited: boolean; retryAfter: number }> {
  const namespace = (
    ENV as unknown as {
      RATE_LIMITER?: {
        idFromName: (name: string) => { toString(): string };
        get: (id: unknown) => {
          check: (
            key: string,
            limit: number,
            windowMs: number,
          ) => Promise<{ ok: boolean; retryAfter: number }>;
        };
      };
    }
  ).RATE_LIMITER;

  if (namespace) {
    try {
      const stub = namespace.get(namespace.idFromName(identifier));
      const result = await stub.check(options.keyPrefix, options.maxRequests, options.windowMs);
      return { limited: !result.ok, retryAfter: result.retryAfter };
    } catch {
      // Fall back to in-memory if the DO call fails.
    }
  }

  return {
    limited: isLimitedInMemory(
      `${options.keyPrefix}:${identifier}`,
      options.windowMs,
      options.maxRequests,
    ),
    retryAfter: Math.ceil(options.windowMs / 1000),
  };
}

export function rateLimit(options: RateLimitOptions) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const identifier = getClientIdentifier(c);

    const { limited, retryAfter } = await isLimited(identifier, options);
    if (limited) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many requests. Please slow down and try again later." }, 429);
    }

    await next();
  });
}
