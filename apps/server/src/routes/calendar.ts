import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import jsonContent from "stoker/openapi/helpers/json-content";
import createMessageObjectSchema from "stoker/openapi/schemas/create-message-object";
import {
  generateICSFromRows,
  getUserByCalToken,
  getUserEventRows,
  rotateCalToken,
} from "@quickcal-cf/db";
import { getDb } from "../services";
import { requireAuth, type AuthEnv } from "../lib/auth";
import { rateLimit } from "../middleware/rate-limit";

const app = new OpenAPIHono<AuthEnv>();

const getFeed = createRoute({
  method: "get",
  path: "/{token}",
  tags: ["Calendar"],
  summary: "Subscribe to every event you own (public by secret token)",
  description:
    "Serves text/calendar. Replace https:// with webcal:// to subscribe in Apple Calendar / Google Calendar (/settings has the URL and a rotate button). One feed, all events — new extractions appear automatically.",
  request: {
    params: z.object({ token: z.string().min(20) }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: { "text/calendar": { schema: z.string() } },
      description: "The aggregate .ics feed",
    },
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema("Not found"),
      "Feed not found",
    ),
  },
});

app.openapi(getFeed, async (c) => {
  const { token } = c.req.valid("param");
  const db = getDb();

  const user = await getUserByCalToken(db, token);
  if (!user) {
    return c.json({ message: "Calendar feed not found" }, HttpStatusCodes.NOT_FOUND);
  }

  const rows = await getUserEventRows(db, user.id);
  if (rows.length === 0) {
    return c.json({ message: "No events in your calendar yet." }, HttpStatusCodes.NOT_FOUND);
  }

  const ics = generateICSFromRows(rows);
  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header("Content-Disposition", 'inline; filename="quickcalai.ics"');
  c.header("Cache-Control", "no-store");
  return c.body(ics);
});

// ─── Owner management (auth'd) ───────────────────────────────────────────────

app.use("/rotate", requireAuth);
app.use("/rotate", rateLimit({ windowMs: 60_000, maxRequests: 5, keyPrefix: "calfeed:user" }));

const rotateFeed = createRoute({
  method: "post",
  path: "/rotate",
  tags: ["Calendar"],
  summary: "Rotate your calendar feed token (invalidates old subscription URLs)",
  request: {},
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ feedPath: z.string() }), "The new feed path"),
  },
});

app.openapi(rotateFeed, async (c) => {
  const userId = c.get("userId");
  const db = getDb();
  const token = await rotateCalToken(db, userId);
  return c.json({ feedPath: `/api/calendar/${token}` }, HttpStatusCodes.OK);
});

export default app;
