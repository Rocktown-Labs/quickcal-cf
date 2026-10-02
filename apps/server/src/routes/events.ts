import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import jsonContent from "stoker/openapi/helpers/json-content";
import jsonContentRequired from "stoker/openapi/helpers/json-content-required";
import createMessageObjectSchema from "stoker/openapi/schemas/create-message-object";
import {
  deleteUserEvent,
  generateICSFromRows,
  getUploadById,
  getUploadEventsForReview,
  getUserEventById,
  updateUserEvent,
  updateUploadRecord,
} from "@quickcal-cf/db";
import { ENV } from "../env.server";
import { getDb } from "../services";
import { requireAuth, type AuthEnv } from "../lib/auth";
import { rateLimit } from "../middleware/rate-limit";

const app = new OpenAPIHono<AuthEnv>();
// Scoped — this sub-app mounts at "/api" in index.ts.
app.use("/events", requireAuth);
app.use("/events", rateLimit({ windowMs: 60_000, maxRequests: 60, keyPrefix: "events:user" }));

const timeRegex = /^$|^([01]\d|2[0-3]):[0-5]\d$/;

const eventPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  time: z.string().trim().regex(timeRegex).optional(),
  endTime: z.string().trim().regex(timeRegex).optional(),
  location: z.string().trim().max(300).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});

const eventResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  isAllDay: z.boolean(),
  confidence: z.number().nullable(),
  sourceQuote: z.string().nullable(),
  uploadId: z.string().nullable(),
});

/**
 * Regenerates the upload's .ics from the current event rows after an edit
 * or delete. Editing must never leave the shared file stale. If the last
 * event is deleted, the ics + share token are removed and the upload
 * becomes `no_events`.
 */
async function refreshUploadIcs(userId: string, uploadId: string) {
  const db = getDb();
  const upload = await getUploadById(db, uploadId);
  if (!upload || upload.userId !== userId) return;

  const rows = await getUploadEventsForReview(db, userId, uploadId);

  // Last event removed → the calendar file and share link go with it.
  if (rows.length === 0) {
    if (upload.icsKey) {
      await ENV.FILES.delete(upload.icsKey).catch(() => undefined);
    }
    await updateUploadRecord(db, uploadId, {
      icsKey: null,
      shareToken: null,
      status: "no_events",
      failureReason: null,
    });
    return;
  }

  if (!upload.icsKey) return;

  const icsContent = generateICSFromRows(rows);
  await ENV.FILES.put(upload.icsKey, icsContent, {
    httpMetadata: { contentType: "text/calendar" },
  });
}

const updateEvent = createRoute({
  method: "patch",
  path: "/events/{id}",
  tags: ["Events"],
  summary: "Edit one of your events (review flow)",
  description:
    "Times are document-local: send `date` (YYYY-MM-DD) with `time`/`endTime` as HH:MM (empty string = all-day). The parent upload's .ics is regenerated automatically.",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: jsonContentRequired(eventPatchSchema, "Fields to update"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(eventResponseSchema, "Updated event"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createMessageObjectSchema("Invalid input"),
      "End time before start time",
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema("Not found"),
      "Event not found",
    ),
  },
});

app.openapi(updateEvent, async (c) => {
  const { id } = c.req.valid("param");
  const userId = c.get("userId");
  const db = getDb();

  const existing = await getUserEventById(db, userId, id);
  if (!existing) {
    return c.json({ message: "Event not found" }, HttpStatusCodes.NOT_FOUND);
  }

  const body = c.req.valid("json");

  // Build the new wall-clock time from the patched fields.
  const currentDate = new Date(existing.startTime);
  const pad = (n: number) => String(n).padStart(2, "0");
  const existingDate = `${currentDate.getUTCFullYear()}-${pad(currentDate.getUTCMonth() + 1)}-${pad(currentDate.getUTCDate())}`;
  const existingTime = existing.isAllDay
    ? ""
    : `${pad(currentDate.getUTCHours())}:${pad(currentDate.getUTCMinutes())}`;

  const date = body.date ?? existingDate;
  const time = body.time !== undefined ? body.time : existingTime;
  const endTimeRaw = body.endTime !== undefined ? body.endTime : null;

  if (time && endTimeRaw && endTimeRaw <= time) {
    return c.json(
      { message: "End time must be after the start time." },
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  const startTime = new Date(`${date}T${time || "00:00"}:00Z`);
  const endTime = time && endTimeRaw ? new Date(`${date}T${endTimeRaw}:00Z`) : null;

  const updated = await updateUserEvent(db, userId, id, {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.location !== undefined ? { location: body.location } : {}),
    startTime,
    endTime,
    isAllDay: !time,
  });

  if (!updated) {
    return c.json({ message: "Event not found" }, HttpStatusCodes.NOT_FOUND);
  }
  if (updated.uploadId) {
    await refreshUploadIcs(userId, updated.uploadId);
  }

  const row = await getUserEventById(db, userId, id);
  if (!row) {
    return c.json({ message: "Event not found" }, HttpStatusCodes.NOT_FOUND);
  }

  return c.json(
    {
      ...row,
      startTime: row.startTime.toISOString(),
      endTime: row.endTime?.toISOString() ?? null,
    },
    HttpStatusCodes.OK,
  );
});

const deleteEvent = createRoute({
  method: "delete",
  path: "/events/{id}",
  tags: ["Events"],
  summary: "Delete one of your events",
  description: "The parent upload's .ics is regenerated automatically.",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(createMessageObjectSchema("Deleted"), "Event deleted"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema("Not found"),
      "Event not found",
    ),
  },
});

app.openapi(deleteEvent, async (c) => {
  const { id } = c.req.valid("param");
  const userId = c.get("userId");
  const db = getDb();

  const deleted = await deleteUserEvent(db, userId, id);
  if (!deleted) {
    return c.json({ message: "Event not found" }, HttpStatusCodes.NOT_FOUND);
  }
  if (deleted.uploadId) {
    await refreshUploadIcs(userId, deleted.uploadId);
  }

  return c.json({ message: "Event deleted" }, HttpStatusCodes.OK);
});

export default app;
