import { defineMiddleware } from "astro:middleware";

/**
 * Baseline response hardening for the SSR pages. The app escapes all
 * user/AI-controlled values at the render site; these headers add
 * defense-in-depth (no MIME sniffing, no framing, no referrer leakage of
 * share/reset tokens, and no access to device capabilities we don't use).
 */
export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  return response;
});
