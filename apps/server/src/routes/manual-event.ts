import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import jsonContent from "stoker/openapi/helpers/json-content";
import jsonContentRequired from "stoker/openapi/helpers/json-content-required";
import { events, generateICSForManual } from "@quickcal-cf/db";
import { getDb } from "../services";
import { requireAuth, type AuthEnv } from "../lib/auth";
import { manualEventSchema } from "../lib/validators";
import { rateLimit } from "../middleware/rate-limit";

const app = new OpenAPIHono<AuthEnv>();
// NB: scope middleware to "/manual-event" explicitly. This sub-app is mounted
// at "/api" in index.ts, so unscoped `use()` would apply to EVERY /api/*
// request — 401-ing the public share routes and rate-limiting the whole API.
app.use("/manual-event", requireAuth);
app.use("/manual-event", rateLimit({ windowMs: 60_000, maxRequests: 20, keyPrefix: "manual:user" }));

const createManualEvent = createRoute({
  method: "post",
  path: "/manual-event",
  tags: ["Events"],
  summary: "Create a single event and get its .ics",
  request: {
    body: jsonContentRequired(manualEventSchema, "Event details"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(
      z.object({
        eventId: z.string(),
        icsContent: z.string(),
        fileName: z.string(),
      }),
      "Event created",
    ),
  },
});

app.openapi(createManualEvent, async (c) => {
  const userId = c.get("userId");
  const { title, date, time, description } = c.req.valid("json");
  const db = getDb();

  const startTime = new Date(time ? `${date}T${time}:00` : `${date}T00:00:00`);

  const icsContent = generateICSForManual([
    {
      date,
      time: time || "",
      description: title + (description ? `\n\n${description}` : ""),
    },
  ]);

  const [row] = await db
    .insert(events)
    .values({
      id: crypto.randomUUID(),
      title,
      description: description || null,
      startTime,
      isAllDay: false,
      uploadId: null,
      userId,
    })
    .returning({ id: events.id });

  if (!row) {
    throw new Error("Failed to create event");
  }

  const fileName = `${title
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()}.ics`;

  return c.json({ eventId: row.id, icsContent, fileName }, HttpStatusCodes.CREATED);
});

export default app;
