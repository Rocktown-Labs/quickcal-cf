import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/cloudflare";
import { webSentryOptions } from "./lib/sentry-server";
import { safePath } from "@quickcal-cf/observability";

/**
 * Baseline response hardening for the SSR pages. The app escapes all
 * user/AI-controlled values at the render site; these headers add
 * defense-in-depth (no MIME sniffing, no framing, no referrer leakage of
 * share/reset tokens, and no access to device capabilities we don't use).
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const rawCanonical = (env as { CANONICAL_WEB_ORIGIN?: string }).CANONICAL_WEB_ORIGIN;
  let canonicalOrigin: string | null = null;
  if (rawCanonical) {
    try {
      canonicalOrigin = new URL(rawCanonical).origin;
    } catch {
      console.warn("[middleware] CANONICAL_WEB_ORIGIN is not a valid URL", rawCanonical);
    }
  }
  if (canonicalOrigin && context.url.origin !== canonicalOrigin) {
    const target = new URL(canonicalOrigin);
    target.pathname = context.url.pathname;
    target.search = context.url.search;
    // 308 preserves the method and body for non-GET requests.
    return Response.redirect(target.href, 308);
  }
  const handler = Sentry.withSentry(webSentryOptions, {
    async fetch(_request: Request, _env: typeof env, _ctx: ExecutionContext) {
      Sentry.getCurrentScope().setTransactionName(
        `${context.request.method} ${safePath(context.url.pathname)}`,
      );
      const response = await next();
      if (response.status >= 500) Sentry.captureMessage("Astro server rendering failed", "error");
      return response;
    },
  });
  const response = await handler.fetch(context.request, env, context.locals.cfContext);
  // Some runtime responses have immutable headers; clone before hardening.
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});
