import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import jsonContent from "stoker/openapi/helpers/json-content";
import createMessageObjectSchema from "stoker/openapi/schemas/create-message-object";
import { getUploadByShareToken, getUploadEvents } from "@quickcal-cf/db";
import { ENV } from "../env.server";
import { getDb } from "../services";

const app = new OpenAPIHono();

const tokenParams = z.object({ token: z.string().min(1) });

const sharedEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  isAllDay: z.boolean(),
});

const getShare = createRoute({
  method: "get",
  path: "/{token}",
  tags: ["Share"],
  summary: "View a shared schedule (public)",
  request: { params: tokenParams },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        fileName: z.string(),
        eventCount: z.number(),
        events: z.array(sharedEventSchema),
        downloadPath: z.string(),
      }),
      "Shared schedule",
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema("Not found"),
      "Share link is invalid or expired",
    ),
  },
});

app.openapi(getShare, async (c) => {
  const { token } = c.req.valid("param");
  const db = getDb();

  const upload = await getUploadByShareToken(db, token);
  if (!upload || upload.status !== "completed") {
    return c.json({ message: "Schedule not found" }, HttpStatusCodes.NOT_FOUND);
  }

  const rows = await getUploadEvents(db, upload.id);
  return c.json(
    {
      fileName: upload.fileName,
      eventCount: rows.length,
      events: rows.map((e) => ({
        ...e,
        startTime: e.startTime.toISOString(),
        endTime: e.endTime?.toISOString() ?? null,
      })),
      downloadPath: `/api/share/${token}/ics`,
    },
    HttpStatusCodes.OK,
  );
});

const getShareIcs = createRoute({
  method: "get",
  path: "/{token}/ics",
  tags: ["Share"],
  summary: "Download the shared .ics file (public, subscribable)",
  description:
    "Serves text/calendar. Replace https:// with webcal:// to subscribe in Apple Calendar and other clients.",
  request: { params: tokenParams },
  responses: {
    [HttpStatusCodes.OK]: {
      content: { "text/calendar": { schema: z.string() } },
      description: "The .ics file",
    },
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema("Not found"),
      "Share link is invalid or the file is not ready",
    ),
  },
});

app.openapi(getShareIcs, async (c) => {
  const { token } = c.req.valid("param");
  const db = getDb();

  const upload = await getUploadByShareToken(db, token);
  if (!upload || upload.status !== "completed" || !upload.icsKey) {
    return c.json({ message: "Calendar file not found" }, HttpStatusCodes.NOT_FOUND);
  }

  const object = await ENV.FILES.get(upload.icsKey);
  if (!object) {
    return c.json({ message: "Calendar file not found" }, HttpStatusCodes.NOT_FOUND);
  }

  const baseName =
    upload.fileName.replace(/\.[^/.]+$/, "") || "calendar-events";
  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${baseName}.ics"`);
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(await object.arrayBuffer());
});

export default app;
