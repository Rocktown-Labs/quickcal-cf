import { ENV } from "./env.server";
import { createAuth } from "./services";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

const app = new Hono();

app.use(logger());
app.use(
	"/*",
	cors({
		origin: ENV.CORS_ORIGIN,
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		credentials: true,
	})
);

app.on(
	["POST", "GET"],
	"/api/auth/*",
	async (c) =>
		(await createAuth()).handler(c.req.raw)
);





app.get("/", (c) => {
	return c.text("OK");
});

export default app;
