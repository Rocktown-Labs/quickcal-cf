// Alchemy validates deployment inputs with Varlock; Workers use native env bindings.
import type { PublicCoercedEnvSchema } from "./env";

function getPublicServerUrl(): string {
  const raw = ((import.meta.env.PUBLIC_SERVER_URL as string | undefined) ?? "").trim();
  const value = raw.replace(/\/+$/, "");
  if (!value) {
    if (import.meta.env.DEV) return "http://localhost:3000";
    throw new Error("PUBLIC_SERVER_URL is required");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_SERVER_URL must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("PUBLIC_SERVER_URL must use http(s)");
  }
  return value;
}

export const ENV = {
  PUBLIC_SERVER_URL: getPublicServerUrl(),
} satisfies Pick<PublicCoercedEnvSchema, "PUBLIC_SERVER_URL">;
