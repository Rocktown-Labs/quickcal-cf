import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import { admin, jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";
import { eq, desc } from "drizzle-orm";
import * as authSchema from "@quickcal-cf/db/schema/auth";
import * as billingSchema from "@quickcal-cf/db/schema/billing";
import type { Database } from "@quickcal-cf/db";
import { expo } from "@better-auth/expo";
import { sendAuthEmail, sendWelcomeEmail } from "./emails";
import { password } from "./password";

export type AuthConfig = {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  CORS_ORIGIN: string;
  NODE_ENV?: string;
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
  const origin = env.CORS_ORIGIN.split(",")[0]?.trim().replace(/\/+$/, "");
  if (!origin) {
    console.warn("[auth] CORS_ORIGIN is empty — email links will use BETTER_AUTH_URL");
    return env.BETTER_AUTH_URL;
  }
  return origin;
}

/**
 * The issuer Better-Auth puts in its JWTs. Better-Auth appends its default
 * `/api/auth` base path to a bare origin, so the issuer must include it or
 * `verifyJWT` (which checks `iss`) rejects every token the OAuth provider
 * mints.
 */
export function authIssuerFor(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`BETTER_AUTH_URL is not a valid absolute URL: ${baseURL}`);
  }
  return url.pathname && url.pathname !== "/" ? trimmed : `${trimmed}/api/auth`;
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

  // The web app and the auth server are separate origins in production, so
  // the OAuth pages must be absolute web URLs, not paths on the API worker.
  const webOrigin = webOriginFrom(env);
  const mcpResource = `${env.BETTER_AUTH_URL.replace(/\/+$/, "")}/mcp`;
  // Bind every JWT this server signs (and verifies) to the MCP resource.
  // Without an explicit audience, `verifyJWT` falls back to the bare auth
  // origin while the OAuth provider signs tokens with `aud = <resource>`, so
  // every OAuth 2.1 access token would be rejected at /mcp. The issuer is
  // pinned for the same reason (Better-Auth's base path is part of `iss`).
  const jwtIssuer = authIssuerFor(env.BETTER_AUTH_URL);
  const plugins: BetterAuthPlugin[] = [
    expo(),
    admin({ adminUserIds }),
    jwt({ jwt: { issuer: jwtIssuer, audience: mcpResource } }),
    mcp({
      loginPage: `${webOrigin}/login`,
      consentPage: `${webOrigin}/consent`,
      resource: mcpResource,
    }),
  ];

  const stripeKey = env.STRIPE_SECRET_KEY;
  const hasLiveStripeKey =
    typeof stripeKey === "string" &&
    (stripeKey.startsWith("sk_test_") || stripeKey.startsWith("sk_live_"));

  if (stripeKey && !hasLiveStripeKey) {
    console.warn(
      "[auth] STRIPE_SECRET_KEY is set but is not an sk_test_/sk_live_ key — billing disabled",
    );
  } else if (hasLiveStripeKey && !env.STRIPE_WEBHOOK_SECRET) {
    console.warn("[auth] STRIPE_WEBHOOK_SECRET is missing — billing disabled");
  }

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
                return rows.map((row) => {
                  let limits: Record<string, number> | undefined;
                  if (row.limits) {
                    try {
                      limits = JSON.parse(row.limits) as Record<string, number>;
                    } catch (error) {
                      // One malformed row must not discard every DB plan.
                      console.warn(`[auth] invalid plan limits for ${row.name}`, error);
                    }
                  }
                  return {
                    name: row.name,
                    priceId: row.priceId,
                    ...(row.annualDiscountPriceId
                      ? { annualDiscountPriceId: row.annualDiscountPriceId }
                      : {}),
                    ...(limits ? { limits } : {}),
                  };
                });
              }
            } catch (error) {
              console.warn("[auth] could not load DB-managed plans — using fallback", error);
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
      ...env.CORS_ORIGIN.split(",")
        .map((origin) => origin.trim().replace(/\/+$/, ""))
        .filter(Boolean),
      ...desktopOrigins,
      "quickcal-cf://",
      // Dev-client origins are broad (`exp://` can be claimed by any Expo
      // client) — never trust them in production.
      ...(env.NODE_ENV === "production" ? [] : ["exp://", "http://localhost:8081"]),
    ],
    emailAndPassword: {
      enabled: true,
      password,
      minPasswordLength: 8,
      // Send verification emails, but keep sign-in friction low — an
      // unverified user can still sign in and is reminded in the app.
      requireEmailVerification: false,
      sendResetPassword: async ({ user, token }) => {
        const url = `${webOrigin}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
        let sent = false;
        try {
          sent = await sendAuthEmail(emailConfig, {
            to: user.email,
            subject: "Reset your QuickCalAI password",
            heading: "Reset your password",
            bodyHtml:
              "We received a request to reset the password for your QuickCalAI account. If you didn't make this request, you can safely ignore this email.",
            actionUrl: url,
            actionLabel: "Choose a new password",
            fallbackNote: "This link expires in 1 hour. For security, it can only be used once.",
          });
        } catch (error) {
          console.warn("[auth] password reset email failed", error);
          throw new Error("Could not send the reset email. Please try again.");
        }
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
        try {
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
        } catch (error) {
          // A provider failure must not abort sign-up.
          console.warn("[auth] verification email failed", error);
        }
      },
    },
    databaseHooks: {
      user: {
        create: {
          // The old Clerk app sent a welcome email from its user.created
          // webhook. Better-Auth's create hook is the equivalent seam. A
          // provider failure must never roll back or block account creation.
          after: async (user) => {
            try {
              await sendWelcomeEmail(emailConfig, {
                to: user.email,
                name: user.name,
              });
            } catch (error) {
              console.warn("[auth] welcome email failed", error);
            }
          },
        },
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
        // Only link a Google identity to a local account whose email has
        // been verified — prevents pre-hijacking of an unverified signup.
        requireLocalEmailVerified: true,
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
    onAPIError: { errorURL: `${webOrigin}/login` },
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
