import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import Stripe from "stripe";
import { createAuth, getDb } from "../services";
import { upsertPlan } from "@quickcal-cf/db";
import { ENV } from "../env.server";
import * as HttpStatusCodes from "stoker/http-status-codes";

const router = new Hono();

export const requireAdmin = createMiddleware(async (c, next) => {
  const auth = await createAuth();
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const user = session?.user as { role?: string } | undefined;
  const roles = (user?.role ?? "").split(",").map((r) => r.trim());
  if (!roles.includes("admin")) {
    return c.json({ message: "Forbidden — admin required" }, HttpStatusCodes.FORBIDDEN);
  }
  await next();
});

router.use(requireAdmin);

const syncSchema = z.object({
  stripeSecretKey: z.string().min(1).optional(),
});

const CENTS = {
  premiumMonthly: 1299,
  premiumAnnual: 7188,
};

async function getOrCreateProduct(
  stripe: Stripe,
  key: string,
  name: string,
  description: string,
): Promise<Stripe.Product> {
  const matches: Stripe.Product[] = [];
  const productList = await stripe.products.list({ active: true, limit: 100 });
  for (const p of productList.data) {
    if (p.metadata?.appKey === key) {
      matches.push(p);
    }
  }

  if (matches.length > 0) {
    return matches[0]!;
  }

  return stripe.products.create({
    name,
    description,
    metadata: { appKey: key },
  });
}

async function getOrCreatePrice(
  stripe: Stripe,
  productId: string,
  amount: number,
  interval: "month" | "year",
): Promise<Stripe.Price> {
  const existing = await stripe.prices.list({
    product: productId,
    active: true,
    limit: 10,
  });
  const match = existing.data.find(
    (p: Stripe.Price) =>
      p.unit_amount === amount && p.recurring?.interval === interval && p.currency === "usd",
  );
  if (match) return match;

  return stripe.prices.create(
    {
      product: productId,
      unit_amount: amount,
      currency: "usd",
      recurring: { interval },
    },
    { idempotencyKey: `${productId}:${amount}:${interval}` },
  );
}

router.post("/stripe/sync", async (c) => {
  const raw = await c.req.json();
  const parsed = syncSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { message: "Invalid request", issues: parsed.error.flatten() },
      HttpStatusCodes.BAD_REQUEST,
    );
  }

  const stripeKey = parsed.data.stripeSecretKey ?? ENV.STRIPE_SECRET_KEY;

  if (!stripeKey || (!stripeKey.startsWith("sk_test_") && !stripeKey.startsWith("sk_live_"))) {
    return c.json(
      { message: "A valid Stripe secret key is required" },
      HttpStatusCodes.BAD_REQUEST,
    );
  }

  const stripe = new Stripe(stripeKey);

  const product = await getOrCreateProduct(
    stripe,
    "quickcalai:premium",
    "QuickCalAI Premium",
    "Unlimited AI calendar extraction, email & SMS delivery, and public share links.",
  );

  const [monthlyPrice, annualPrice] = await Promise.all([
    getOrCreatePrice(stripe, product.id, CENTS.premiumMonthly, "month"),
    getOrCreatePrice(stripe, product.id, CENTS.premiumAnnual, "year"),
  ]);

  const db = getDb();
  const plan = await upsertPlan(db, {
    name: "premium",
    displayName: "Premium",
    description: "AI extraction on demand",
    stripeProductId: product.id,
    priceId: monthlyPrice.id,
    annualDiscountPriceId: annualPrice.id,
    currency: "usd",
    limits: { uploads: 1000 },
    active: true,
  });

  return c.json({
    ok: true,
    product: {
      id: product.id,
      name: product.name,
    },
    prices: {
      monthly: monthlyPrice.id,
      annual: annualPrice.id,
    },
    plan: {
      name: plan!.name,
      priceId: plan!.priceId,
      annualDiscountPriceId: plan!.annualDiscountPriceId,
    },
  });
});

export default router;
