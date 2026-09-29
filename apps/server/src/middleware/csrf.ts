import { createMiddleware } from "hono/factory";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { ENV } from "../env.server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function allowedOrigins(): string[] {
  return ENV.CORS_ORIGIN.split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * CSRF defense for the app's own (non-Better-Auth) routes.
 *
 * Session cookies are `SameSite=None` (required because the web app and the
 * API live on different Workers origins), so browsers will attach them to
 * cross-site form/fetch POSTs. Multipart form data counts as a CORS "simple
 * request", meaning the request executes even though the response is
 * blocked — so CORS alone does not stop state-changing cross-site calls.
 *
 * Browsers always send an `Origin` header on cross-site requests, so
 * rejecting state-changing requests whose `Origin` is not in the allow list
 * closes the hole. Requests *without* an `Origin` header are non-browser
 * clients (native apps, servers, CLI tools) and are allowed — they are not
 * vulnerable to CSRF because the attacker's browser cannot strip the header.
 */
export const originCheck = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
    return next();
  }

  const origin = c.req.header("origin");
  if (!origin) {
    return next();
  }

  const allowed = allowedOrigins();
  const ok = allowed.some((o) => origin === o || origin.startsWith(`${o}/`));
  if (!ok) {
    return c.json({ message: "Forbidden — cross-origin request" }, HttpStatusCodes.FORBIDDEN);
  }

  return next();
});
