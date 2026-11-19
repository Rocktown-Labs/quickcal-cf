import { and, eq, gt, lt, ne } from "drizzle-orm";
import type { Database } from "../index";
import { idempotencyKeys } from "../schema";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const IDEMPOTENCY_PENDING_TTL_MS = 60 * 1000; // claim lease; orphaned claims are reclaimable
const IDEMPOTENCY_PENDING = "__pending__";

const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanupAt = 0;

export interface IdempotencyClaim {
  /** True when this caller owns the claim and must run the operation. */
  claimed: boolean;
  /** Stored response when another caller already completed the operation. */
  responseJson: string | null;
  /** True when another caller is still running the operation. */
  pending: boolean;
}

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
        ne(idempotencyKeys.responseJson, IDEMPOTENCY_PENDING),
      ),
    )
    .limit(1);
  return rows[0]?.responseJson ?? null;
}

/**
 * Atomically claims an Idempotency-Key. The unique index on
 * (user_id, key_hash) makes exactly one concurrent caller the winner.
 */
export async function claimIdempotencyKey(
  db: Database,
  userId: string,
  keyHash: string,
): Promise<IdempotencyClaim> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_PENDING_TTL_MS);

  const inserted = await db
    .insert(idempotencyKeys)
    .values({
      id: crypto.randomUUID(),
      userId,
      keyHash,
      responseJson: IDEMPOTENCY_PENDING,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });
  if (inserted.length > 0) return { claimed: true, responseJson: null, pending: false };

  const read = () =>
    db
      .select({
        responseJson: idempotencyKeys.responseJson,
        expiresAt: idempotencyKeys.expiresAt,
      })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.keyHash, keyHash)))
      .limit(1);

  const row = (await read())[0];
  // Deleted between the insert attempt and the read: treat as claimable.
  if (!row) return { claimed: true, responseJson: null, pending: false };

  if (row.expiresAt <= now) {
    const updated = await db
      .update(idempotencyKeys)
      .set({ responseJson: IDEMPOTENCY_PENDING, expiresAt })
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.keyHash, keyHash),
          lt(idempotencyKeys.expiresAt, now),
        ),
      )
      .returning({ id: idempotencyKeys.id });
    if (updated.length > 0) return { claimed: true, responseJson: null, pending: false };
  }

  const current = (await read())[0];
  if (!current || current.responseJson === IDEMPOTENCY_PENDING) {
    return { claimed: false, responseJson: null, pending: true };
  }
  return { claimed: false, responseJson: current.responseJson, pending: false };
}

/** Stores the response and releases the claim for replay. */
export async function storeIdempotentResponse(
  db: Database,
  userId: string,
  keyHash: string,
  responseJson: string,
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ responseJson, expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS) })
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.keyHash, keyHash),
        eq(idempotencyKeys.responseJson, IDEMPOTENCY_PENDING),
      ),
    );
}

/** Removes a pending claim so a failed operation can be retried. */
export async function releaseIdempotentClaim(
  db: Database,
  userId: string,
  keyHash: string,
): Promise<void> {
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.keyHash, keyHash),
        eq(idempotencyKeys.responseJson, IDEMPOTENCY_PENDING),
      ),
    );
}
