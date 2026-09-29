import { eq, desc } from "drizzle-orm";
import type { Database } from "../index";
import { plan } from "../schema";

export type PlanInput = {
  name: string;
  displayName: string;
  description?: string | null;
  stripeProductId?: string | null;
  priceId: string;
  annualDiscountPriceId?: string | null;
  currency?: string;
  limits?: Record<string, number>;
  active?: boolean;
};

export async function getPlans(db: Database) {
  return db
    .select()
    .from(plan)
    .where(eq(plan.active, true))
    .orderBy(desc(plan.createdAt));
}

export async function upsertPlan(db: Database, input: PlanInput) {
  const id = crypto.randomUUID();
  const limits = input.limits ? JSON.stringify(input.limits) : null;

  await db
    .insert(plan)
    .values({
      id,
      name: input.name,
      displayName: input.displayName,
      description: input.description ?? null,
      stripeProductId: input.stripeProductId ?? null,
      priceId: input.priceId,
      annualDiscountPriceId: input.annualDiscountPriceId ?? null,
      currency: input.currency ?? "usd",
      limits,
      active: input.active ?? true,
    })
    .onConflictDoUpdate({
      target: plan.name,
      set: {
        displayName: input.displayName,
        description: input.description ?? null,
        stripeProductId: input.stripeProductId ?? null,
        priceId: input.priceId,
        annualDiscountPriceId: input.annualDiscountPriceId ?? null,
        currency: input.currency ?? "usd",
        limits,
        active: input.active ?? true,
        updatedAt: new Date(),
      },
    });

  const rows = await db.select().from(plan).where(eq(plan.name, input.name)).limit(1);
  return rows[0];
}
