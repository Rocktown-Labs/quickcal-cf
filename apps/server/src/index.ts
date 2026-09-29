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
import { rateLimit } from "./middleware/rate-limit";

const app = new OpenAPIHono({ defaultHook });

app.use(logger());
app.use(
	"/*",
	cors({
		origin: (origin) => {
			const allowed = ENV.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
			// Allow exact matches or any sub-path of an allowed origin.
			if (!origin) return allowed[0];
			const match = allowed.find((o) => origin === o || origin.startsWith(`${o}/`));
			return match ? origin : allowed[0];
		},
		allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		credentials: true,
	})
);
app.use(serveEmojiFavicon("📅"));

// Rate limits — in-memory per IP/per user. Swap for Cloudflare Rate Limiting
// or a Durable Object once you scale beyond a single Worker isolate.
app.use(rateLimit({ windowMs: 60_000, maxRequests: 120, keyPrefix: "global" }));
app.use("/api/uploads/*", rateLimit({ windowMs: 60_000, maxRequests: 10, keyPrefix: "uploads" }));
app.use("/api/keys/*", rateLimit({ windowMs: 60_000, maxRequests: 20, keyPrefix: "keys" }));
app.use("/api/share/*", rateLimit({ windowMs: 60_000, maxRequests: 60, keyPrefix: "share" }));
app.use("/api/manual-event", rateLimit({ windowMs: 60_000, maxRequests: 30, keyPrefix: "manual" }));

app.use("/api/auth/*", rateLimit({ windowMs: 60_000, maxRequests: 20, keyPrefix: "auth" }));
app.use("/api/admin/*", rateLimit({ windowMs: 60_000, maxRequests: 10, keyPrefix: "admin" }));

app.on(
	["POST", "GET"],
	"/api/auth/*",
	async (c) =>
		(await createAuth()).handler(c.req.raw)
);

app.route("/api/uploads", uploads);
app.route("/api/uploads", delivery);
app.route("/api", manualEvent);
app.route("/api/share", share);
app.route("/api/keys", keys);
app.route("/api/dashboard", dashboard);
app.route("/api/user", me);
app.route("/api/admin", admin);

app.doc("/doc", {
	openapi: "3.1.0",
	info: {
		title: "QuickCalAI API",
		version: "1.0.0",
		description:
			"Upload schedule documents, extract calendar events, and manage API keys. Agents authenticate with a user API key as `Authorization: Bearer qc_...`.",
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

app.notFound(notFound);
app.onError(onError);

export default app;
