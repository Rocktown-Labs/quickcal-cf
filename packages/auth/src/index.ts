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
import { sendAuthEmail } from "./emails";

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
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
};

function webOriginFrom(env: AuthConfig): string {
  return env.CORS_ORIGIN.split(",")[0]?.trim().replace(/\/+$/, "") || env.BETTER_AUTH_URL;
}

export function createAuth(
  env: AuthConfig,
  database: Database,
  desktopOrigins: readonly string[] = [],
) {
  const adminUserIds = env.ADMIN_USER_IDS
    ? env.ADMIN_USER_IDS.split(",")
        .map((id) => id.trim())
        .filter(Boolean)
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
                  limits: row.limits
                    ? (JSON.parse(row.limits) as Record<string, number>)
                    : undefined,
                }));
              }
            } catch {
              // fall through to static fallback
            }

            if (!fallbackPlans) {
              throw new Error(
                "No Stripe plans configured. Run the admin sync or set STRIPE_PREMIUM_PRICE_ID.",
              );
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

  const webOrigin = webOriginFrom(env);
  const emailConfig = {
    RESEND_API_KEY: env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: env.RESEND_FROM_EMAIL,
    WEB_ORIGIN: webOrigin,
  };

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
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // Send verification emails, but keep sign-in friction low — an
      // unverified user can still sign in and is reminded in the app.
      requireEmailVerification: false,
      sendResetPassword: async ({ user, token }) => {
        const url = `${webOrigin}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
        const sent = await sendAuthEmail(emailConfig, {
          to: user.email,
          subject: "Reset your QuickCalAI password",
          heading: "Reset your password",
          bodyHtml:
            "We received a request to reset the password for your QuickCalAI account. If you didn't make this request, you can safely ignore this email.",
          actionUrl: url,
          actionLabel: "Choose a new password",
          fallbackNote: "This link expires in 1 hour. For security, it can only be used once.",
        });
        if (!sent) {
          throw new Error(
            "Password reset emails are not configured on the server. Contact support.",
          );
        }
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24, // 24 hours
      sendVerificationEmail: async ({ user, token }) => {
        const url = `${webOrigin}/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
        const sent = await sendAuthEmail(emailConfig, {
          to: user.email,
          subject: "Verify your QuickCalAI email",
          heading: "Confirm your email address",
          bodyHtml:
            "Welcome to QuickCalAI! Confirm your email address to finish setting up your account.",
          actionUrl: url,
          actionLabel: "Verify my email",
          fallbackNote: "Didn't sign up for QuickCalAI? You can ignore this email.",
        });
        // Degrade gracefully when email isn't configured — sign-up should
        // still succeed; the app surfaces a "resend" option later.
        if (!sent) {
          console.warn("[auth] RESEND_API_KEY not configured — skipping verification email");
        }
      },
    },
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
