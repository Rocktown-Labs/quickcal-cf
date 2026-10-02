import { and, eq } from "drizzle-orm";
import type { Database } from "../index";
import { events } from "../schema";

const eventReviewColumns = {
  id: events.id,
  title: events.title,
  description: events.description,
  location: events.location,
  startTime: events.startTime,
  endTime: events.endTime,
  isAllDay: events.isAllDay,
  confidence: events.confidence,
  sourceQuote: events.sourceQuote,
  uploadId: events.uploadId,
} as const;

/** Owner-scoped event fetch for the review/edit endpoints. */
export async function getUserEventById(db: Database, userId: string, eventId: string) {
  const rows = await db
    .select(eventReviewColumns)
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface EventPatch {
  title?: string;
  description?: string | null;
  location?: string | null;
  startTime?: Date;
  endTime?: Date | null;
  isAllDay?: boolean;
}

/** Owner-scoped event update — never touches another user's rows. */
export async function updateUserEvent(
  db: Database,
  userId: string,
  eventId: string,
  patch: EventPatch,
) {
  const clean: EventPatch = {};
  if (patch.title !== undefined) clean.title = patch.title;
  if (patch.description !== undefined) clean.description = patch.description;
  if (patch.location !== undefined) clean.location = patch.location;
  if (patch.startTime !== undefined) clean.startTime = patch.startTime;
  if (patch.endTime !== undefined) clean.endTime = patch.endTime;
  if (patch.isAllDay !== undefined) clean.isAllDay = patch.isAllDay;

  const rows = await db
    .update(events)
    .set({ ...clean, updatedAt: new Date() })
    .where(and(eq(events.id, eventId), eq(events.userId, userId)))
    .returning({ id: events.id, uploadId: events.uploadId });
  return rows[0] ?? null;
}

/** Owner-scoped event delete. Returns the parent uploadId for ics refresh. */
export async function deleteUserEvent(db: Database, userId: string, eventId: string) {
  const rows = await db
    .delete(events)
    .where(and(eq(events.id, eventId), eq(events.userId, userId)))
    .returning({ id: events.id, uploadId: events.uploadId });
  return rows[0] ?? null;
}

/** Every event row owned by a user (aggregate calendar feed). */
export async function getUserEventRows(db: Database, userId: string) {
  return db
    .select({
      title: events.title,
      description: events.description,
      location: events.location,
      startTime: events.startTime,
      endTime: events.endTime,
      isAllDay: events.isAllDay,
    })
    .from(events)
    .where(eq(events.userId, userId))
    .orderBy(events.startTime);
}
