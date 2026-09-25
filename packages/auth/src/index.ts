import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import * as schema from "@quickcal-cf/db/schema/auth";
import type { Database } from "@quickcal-cf/db";
import { expo } from "@better-auth/expo";

export type AuthConfig = {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  CORS_ORIGIN: string;
};

export function createAuth(env: AuthConfig, database: Database, desktopOrigins: readonly string[] = []) {
  return betterAuth({
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema,
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
        expo()
    ],
  });
}

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
