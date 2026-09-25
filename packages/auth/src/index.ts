import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";
import * as authSchema from "@quickcal-cf/db/schema/auth";
import * as billingSchema from "@quickcal-cf/db/schema/billing";
import type { Database } from "@quickcal-cf/db";
import { expo } from "@better-auth/expo";

export type AuthConfig = {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  CORS_ORIGIN: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PREMIUM_PRICE_ID: string;
  STRIPE_PREMIUM_ANNUAL_PRICE_ID?: string;
};

export function createAuth(env: AuthConfig, database: Database, desktopOrigins: readonly string[] = []) {
  const stripeClient = new Stripe(env.STRIPE_SECRET_KEY);

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
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    advanced: {
      defaultCookieAttributes: {
        sameSite: "none",
        secure: true,
        httpOnly: true,
      },
    },
    plugins: [
        expo(),
        stripe({
          stripeClient,
          stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
          createCustomerOnSignUp: true,
          subscription: {
            enabled: true,
            plans: [
              {
                name: "premium",
                priceId: env.STRIPE_PREMIUM_PRICE_ID,
                ...(env.STRIPE_PREMIUM_ANNUAL_PRICE_ID
                  ? { annualDiscountPriceId: env.STRIPE_PREMIUM_ANNUAL_PRICE_ID }
                  : {}),
                limits: {
                  uploads: 1000,
                },
              },
            ],
          },
        }),
    ],
  });
}

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
