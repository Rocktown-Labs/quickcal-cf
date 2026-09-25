import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../index";
import { subscription } from "../schema";

const ACTIVE_STATUSES = ["active", "trialing"];

/** Premium = an active or trialing Stripe subscription for this user. */
export async function isPremium(db: Database, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: subscription.id })
    .from(subscription)
    .where(
      and(
        eq(subscription.referenceId, userId),
        inArray(subscription.status, ACTIVE_STATUSES),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

export async function getActiveSubscription(db: Database, userId: string) {
  const rows = await db
    .select()
    .from(subscription)
    .where(
      and(
        eq(subscription.referenceId, userId),
        inArray(subscription.status, ACTIVE_STATUSES),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
