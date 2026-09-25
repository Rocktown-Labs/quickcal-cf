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
import manualEvent from "./routes/manual-event";
import share from "./routes/share";
import keys from "./routes/keys";
import dashboard from "./routes/stats";

const app = new OpenAPIHono({ defaultHook });

app.use(logger());
app.use(
	"/*",
	cors({
		origin: ENV.CORS_ORIGIN,
		allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		credentials: true,
	})
);
app.use(serveEmojiFavicon("📅"));

app.on(
	["POST", "GET"],
	"/api/auth/*",
	async (c) =>
		(await createAuth()).handler(c.req.raw)
);

app.route("/api/uploads", uploads);
app.route("/api", manualEvent);
app.route("/api/share", share);
app.route("/api/keys", keys);
app.route("/api/dashboard", dashboard);

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

app.notFound(notFound);
app.onError(onError);

export default app;
