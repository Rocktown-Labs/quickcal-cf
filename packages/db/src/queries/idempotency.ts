import { and, eq, gt, lt } from "drizzle-orm";
import type { Database } from "../index";
import { idempotencyKeys } from "../schema";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanupAt = 0;

export async function hashIdempotencyKey(rawKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Returns the stored response for this (userId, key) pair, if fresh. */
export async function findIdempotentResponse(
  db: Database,
  userId: string,
  keyHash: string,
): Promise<string | null> {
  // Opportunistic cleanup, throttled per isolate — a global DELETE on every
  // lookup takes a write lock on the hot path.
  const now = new Date();
  if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) {
    lastCleanupAt = Date.now();
    await db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.expiresAt, now))
      .catch((err) => console.warn("idempotency cleanup failed", err));
  }

  const rows = await db
    .select({ responseJson: idempotencyKeys.responseJson })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.keyHash, keyHash),
        // Correctness must not depend on the best-effort cleanup above.
        gt(idempotencyKeys.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0]?.responseJson ?? null;
}

/** Stores the response for replay. Best-effort — a race simply results in
 * two processed requests, which is the pre-existing behavior. */
export async function storeIdempotentResponse(
  db: Database,
  userId: string,
  keyHash: string,
  responseJson: string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
  await db
    .insert(idempotencyKeys)
    .values({
      id: crypto.randomUUID(),
      userId,
      keyHash,
      responseJson,
      expiresAt,
    })
    // Refresh only an expired row; a live row keeps its original response.
    .onConflictDoUpdate({
      target: [idempotencyKeys.userId, idempotencyKeys.keyHash],
      set: { responseJson, expiresAt },
      setWhere: lt(idempotencyKeys.expiresAt, new Date()),
    });
}
