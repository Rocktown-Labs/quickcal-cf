// Alchemy validates deployment inputs with Varlock; Workers use native env bindings.
import type { PublicCoercedEnvSchema } from "./env";

function getPublicServerUrl(): string {
  const value = (import.meta.env.PUBLIC_SERVER_URL as string | undefined) ?? "";
  if (value) return value;
  if (import.meta.env.DEV) return "http://localhost:3000";
  throw new Error("PUBLIC_SERVER_URL is required");
}

export const ENV = {
  PUBLIC_SERVER_URL: getPublicServerUrl(),
} satisfies Pick<PublicCoercedEnvSchema, "PUBLIC_SERVER_URL">;
