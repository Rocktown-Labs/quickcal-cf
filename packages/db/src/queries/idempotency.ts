import { and, eq, lt } from "drizzle-orm";
import type { Database } from "../index";
import { idempotencyKeys } from "../schema";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
  // Opportunistic cleanup — keeps the table tiny without a cron.
  await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, new Date()))
    .catch(() => undefined);

  const rows = await db
    .select({ responseJson: idempotencyKeys.responseJson })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.keyHash, keyHash)))
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
  await db
    .insert(idempotencyKeys)
    .values({
      id: crypto.randomUUID(),
      userId,
      keyHash,
      responseJson,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    })
    .onConflictDoNothing();
}
