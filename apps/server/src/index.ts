import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import defaultHook from "stoker/openapi/default-hook";
import notFound from "stoker/middlewares/not-found";
import onError from "stoker/middlewares/on-error";
import serveEmojiFavicon from "stoker/middlewares/serve-emoji-favicon";
import { ENV } from "./env.server";
import { createAuth } from "./services";
import uploads from "./routes/uploads";
import delivery from "./routes/delivery";
import manualEvent from "./routes/manual-event";
import share from "./routes/share";
import keys from "./routes/keys";
import dashboard from "./routes/stats";
import me from "./routes/me";
import admin from "./routes/admin";
import events from "./routes/events";
import calendar from "./routes/calendar";
import { mcpApp } from "./mcp";
import { requireAuth } from "./lib/auth";
import { rateLimit } from "./middleware/rate-limit";
import { originCheck } from "./middleware/csrf";

const app = new OpenAPIHono({ defaultHook });

app.use(logger());
app.use(
  "/*",
  cors({
    origin: (origin) => {
      const allowed = ENV.CORS_ORIGIN.split(",")
        .map((o) => o.trim().replace(/\/+$/, ""))
        .filter(Boolean);
      // Allow exact matches or any sub-path of an allowed origin.
      // No match → null → the browser blocks the cross-origin response.
      if (!origin) return null;
      const match = allowed.find((o) => origin === o || origin.startsWith(`${o}/`));
      return match ? origin : null;
    },
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);
app.use(serveEmojiFavicon("📅"));

// CSRF defense — verify Origin on state-changing requests (cookies are
// SameSite=None, so CORS alone doesn't stop cross-site form posts).
app.use(originCheck);

// Rate limits — backed by the RateLimiter Durable Object so counters hold
// across isolates. Falls back to in-memory when the binding is missing.
app.use(rateLimit({ windowMs: 60_000, maxRequests: 120, keyPrefix: "global" }));
app.use("/api/uploads/*", rateLimit({ windowMs: 60_000, maxRequests: 60, keyPrefix: "uploads" }));
app.use("/api/keys/*", rateLimit({ windowMs: 60_000, maxRequests: 20, keyPrefix: "keys" }));
app.use("/api/share/*", rateLimit({ windowMs: 60_000, maxRequests: 60, keyPrefix: "share" }));
app.use("/api/manual-event", rateLimit({ windowMs: 60_000, maxRequests: 30, keyPrefix: "manual" }));

app.use("/api/auth/*", rateLimit({ windowMs: 60_000, maxRequests: 20, keyPrefix: "auth" }));
app.use("/api/admin/*", rateLimit({ windowMs: 60_000, maxRequests: 10, keyPrefix: "admin" }));

// Top-level auth guards. A Hono foot-gun: when two sub-apps share a mount
// prefix, the SECOND sub-app's path-scoped middleware is silently dropped —
// which is exactly how /api/events lost requireAuth in production (unauth
// requests reached the queries and bound undefined as userId). Declaring
// auth on the main app makes it independent of mount order.
app.use("/api/uploads/*", requireAuth);
app.use("/api/events/*", requireAuth);
app.use("/api/manual-event", requireAuth);
app.use("/api/manual-event/*", requireAuth);
app.use("/api/keys/*", requireAuth);
app.use("/api/dashboard/*", requireAuth);
app.use("/api/user/*", requireAuth);
app.use("/api/calendar/rotate", requireAuth);

app.on(["POST", "GET"], "/api/auth/*", async (c) => (await createAuth()).handler(c.req.raw));

app.route("/api/uploads", uploads);
app.route("/api/uploads", delivery);
app.route("/api", manualEvent);
app.route("/api/events", events);
app.route("/api/share", share);
app.route("/api/keys", keys);
app.route("/api/dashboard", dashboard);
app.route("/api/user", me);
app.route("/api/calendar", calendar);
app.route("/api/admin", admin);

// MCP server — stateless streamable-HTTP JSON-RPC for AI agents.
// Same auth as the REST API; requests without a session or qc_ key 401.
app.use("/mcp", requireAuth);
app.use("/mcp", rateLimit({ windowMs: 60_000, maxRequests: 60, keyPrefix: "mcp" }));
app.route("/mcp", mcpApp);

app.doc("/doc", {
  openapi: "3.1.0",
  info: {
    title: "QuickCalAI API",
    version: "1.0.0",
    description:
      "Turn schedules into calendar files. Ingest a file, pasted text, a public URL, or structured JSON events; then poll status, review/edit the extracted events, and download or share the .ics. Also available as an MCP server at POST /mcp (stateless streamable-HTTP JSON-RPC — send `tools/list` for the catalog). Agents authenticate with a user API key as `Authorization: Bearer qc_...` and may send an `Idempotency-Key` header on ingestion requests to make retries safe.",
  },
});

app.get("/reference", (c) =>
  c.html(`<!doctype html>
<html>
<head><title>QuickCalAI API Reference</title><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body><script id="api-reference" data-url="/doc"></script><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script></body>
</html>`),
);

app.get("/", (c) => {
  return c.text("OK");
});

export { CalendarProcessingWorkflow } from "./workflows/calendar-processing";
export { RateLimiter } from "./do/rate-limiter";

app.notFound(notFound);
app.onError(onError);

export default app;
