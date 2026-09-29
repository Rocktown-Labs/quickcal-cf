import { and, count, desc, eq } from "drizzle-orm";
import type { Database } from "../index";
import { events, uploads, user } from "../schema";

// Public-facing columns only — never leak internal storage keys.
const uploadSummaryColumns = {
  id: uploads.id,
  fileName: uploads.fileName,
  fileType: uploads.fileType,
  status: uploads.status,
  shareToken: uploads.shareToken,
  createdAt: uploads.createdAt,
} as const;

export async function getUserUploads(db: Database, userId: string, limit = 20) {
  return db
    .select(uploadSummaryColumns)
    .from(uploads)
    .where(eq(uploads.userId, userId))
    .orderBy(desc(uploads.createdAt))
    .limit(limit);
}

export async function getUserEvents(db: Database, userId: string) {
  return db
    .select({
      id: events.id,
      title: events.title,
      description: events.description,
      location: events.location,
      startTime: events.startTime,
      endTime: events.endTime,
      isAllDay: events.isAllDay,
      uploadId: events.uploadId,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(eq(events.userId, userId))
    .orderBy(desc(events.createdAt));
}

export async function getUploadEvents(db: Database, uploadId: string) {
  return db
    .select({
      id: events.id,
      title: events.title,
      description: events.description,
      location: events.location,
      startTime: events.startTime,
      endTime: events.endTime,
      isAllDay: events.isAllDay,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(eq(events.uploadId, uploadId))
    .orderBy(desc(events.createdAt));
}

export async function deleteUpload(db: Database, uploadId: string) {
  return db.delete(uploads).where(eq(uploads.id, uploadId));
}

export async function getUserProfile(db: Database, userId: string) {
  const rows = await db
    .select({
      email: user.email,
      name: user.name,
      phoneNumber: user.phoneNumber,
      isOnboarded: user.isOnboarded,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  return rows[0] ?? null;
}

export async function updateUserProfile(
  db: Database,
  userId: string,
  updates: {
    phoneNumber?: string;
    isOnboarded?: boolean;
  },
) {
  return db
    .update(user)
    .set({ ...updates })
    .where(eq(user.id, userId));
}

export async function getDashboardStats(db: Database, userId: string) {
  const [total] = await db.select({ n: count() }).from(uploads).where(eq(uploads.userId, userId));
  const [completed] = await db
    .select({ n: count() })
    .from(uploads)
    .where(and(eq(uploads.userId, userId), eq(uploads.status, "completed")));
  const [eventsRow] = await db.select({ n: count() }).from(events).where(eq(events.userId, userId));

  return {
    totalUploads: total?.n ?? 0,
    completedUploads: completed?.n ?? 0,
    totalEvents: eventsRow?.n ?? 0,
  };
}
