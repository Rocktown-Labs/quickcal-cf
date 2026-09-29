import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import { admin } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";
import { eq, desc } from "drizzle-orm";
import * as authSchema from "@quickcal-cf/db/schema/auth";
import * as billingSchema from "@quickcal-cf/db/schema/billing";
import type { Database } from "@quickcal-cf/db";
import { expo } from "@better-auth/expo";

export type AuthConfig = {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  CORS_ORIGIN: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PREMIUM_PRICE_ID?: string;
  STRIPE_PREMIUM_ANNUAL_PRICE_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ADMIN_USER_IDS?: string;
};

export function createAuth(env: AuthConfig, database: Database, desktopOrigins: readonly string[] = []) {
  const adminUserIds = env.ADMIN_USER_IDS
    ? env.ADMIN_USER_IDS.split(",").map((id) => id.trim()).filter(Boolean)
    : undefined;

  const plugins: BetterAuthPlugin[] = [expo(), admin({ adminUserIds })];

  const stripeKey = env.STRIPE_SECRET_KEY;
  const hasLiveStripeKey =
    typeof stripeKey === "string" &&
    (stripeKey.startsWith("sk_test_") || stripeKey.startsWith("sk_live_"));

  if (hasLiveStripeKey && env.STRIPE_WEBHOOK_SECRET) {
    const stripeClient = new Stripe(stripeKey);

    const fallbackPlans = env.STRIPE_PREMIUM_PRICE_ID
      ? [
          {
            name: "premium",
            priceId: env.STRIPE_PREMIUM_PRICE_ID,
            ...(env.STRIPE_PREMIUM_ANNUAL_PRICE_ID
              ? { annualDiscountPriceId: env.STRIPE_PREMIUM_ANNUAL_PRICE_ID }
              : {}),
            limits: { uploads: 1000 },
          },
        ]
      : undefined;

    plugins.push(
      stripe({
        stripeClient,
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
        createCustomerOnSignUp: true,
        subscription: {
          enabled: true,
          plans: async () => {
            try {
              const rows = await database
                .select()
                .from(billingSchema.plan)
                .where(eq(billingSchema.plan.active, true))
                .orderBy(desc(billingSchema.plan.createdAt));

              if (rows.length > 0) {
                return rows.map((row) => ({
                  name: row.name,
                  priceId: row.priceId,
                  ...(row.annualDiscountPriceId
                    ? { annualDiscountPriceId: row.annualDiscountPriceId }
                    : {}),
                  limits: row.limits ? (JSON.parse(row.limits) as Record<string, number>) : undefined,
                }));
              }
            } catch {
              // fall through to static fallback
            }

            if (!fallbackPlans) {
              throw new Error("No Stripe plans configured. Run the admin sync or set STRIPE_PREMIUM_PRICE_ID.");
            }
            return fallbackPlans;
          },
        },
      }),
    );
  }

  const googleClientId = env.GOOGLE_CLIENT_ID;
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET;
  const hasGoogleOAuth =
    typeof googleClientId === "string" &&
    googleClientId.length > 0 &&
    typeof googleClientSecret === "string" &&
    googleClientSecret.length > 0;

  return betterAuth({
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema: {
        ...authSchema,
        ...billingSchema,
      },
    }),
    trustedOrigins: [
      env.CORS_ORIGIN,
      ...desktopOrigins,
      "quickcal-cf://",
      "exp://",
      "http://localhost:8081",
    ],
    emailAndPassword: { enabled: true },
    socialProviders: hasGoogleOAuth
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
          },
        }
      : undefined,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    advanced: {
      defaultCookieAttributes: {
        sameSite: "none",
        secure: true,
        httpOnly: true,
      },
    },
    plugins,
  });
}

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
