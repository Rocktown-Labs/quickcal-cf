import { and, count, desc, eq } from "drizzle-orm";
import type { Database } from "../index";
import { uploads, events, type UploadStatus } from "../schema";

export function generateShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function newId(): string {
  return crypto.randomUUID();
}

export async function createUploadRecord(
  db: Database,
  input: {
    fileName: string;
    fileType: string;
    storageKey: string;
    userId: string;
    status?: UploadStatus;
    workflowRunId?: string | null;
    failureReason?: string | null;
  },
) {
  const result = await db
    .insert(uploads)
    .values({
      id: newId(),
      fileName: input.fileName,
      fileType: input.fileType,
      storageKey: input.storageKey,
      userId: input.userId,
      status: input.status ?? "pending",
      workflowRunId: input.workflowRunId ?? null,
      failureReason: input.failureReason ?? null,
    })
    .returning({
      id: uploads.id,
      status: uploads.status,
      workflowRunId: uploads.workflowRunId,
    });

  if (!result[0]) {
    throw new Error("Failed to create upload record");
  }

  return result[0];
}

export async function updateUploadRecord(
  db: Database,
  uploadId: string,
  updates: {
    status?: UploadStatus;
    workflowRunId?: string | null;
    icsKey?: string | null;
    shareToken?: string | null;
    failureReason?: string | null;
  },
) {
  return db
    .update(uploads)
    .set({
      ...(updates.status ? { status: updates.status } : {}),
      ...(updates.workflowRunId !== undefined
        ? { workflowRunId: updates.workflowRunId }
        : {}),
      ...(updates.icsKey !== undefined ? { icsKey: updates.icsKey } : {}),
      ...(updates.shareToken !== undefined
        ? { shareToken: updates.shareToken }
        : {}),
      ...(updates.failureReason !== undefined
        ? { failureReason: updates.failureReason }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(uploads.id, uploadId));
}

const uploadColumns = {
  id: uploads.id,
  fileName: uploads.fileName,
  fileType: uploads.fileType,
  storageKey: uploads.storageKey,
  icsKey: uploads.icsKey,
  shareToken: uploads.shareToken,
  workflowRunId: uploads.workflowRunId,
  failureReason: uploads.failureReason,
  status: uploads.status,
  userId: uploads.userId,
  createdAt: uploads.createdAt,
  updatedAt: uploads.updatedAt,
} as const;

export async function getUploadById(db: Database, uploadId: string) {
  const result = await db
    .select(uploadColumns)
    .from(uploads)
    .where(eq(uploads.id, uploadId))
    .limit(1);

  return result[0] ?? null;
}

export async function getUploadByWorkflowRunId(
  db: Database,
  workflowRunId: string,
) {
  const result = await db
    .select(uploadColumns)
    .from(uploads)
    .where(eq(uploads.workflowRunId, workflowRunId))
    .limit(1);

  return result[0] ?? null;
}

export async function getUserUploadByWorkflowRunId(
  db: Database,
  userId: string,
  workflowRunId: string,
) {
  const result = await db
    .select(uploadColumns)
    .from(uploads)
    .where(
      and(eq(uploads.userId, userId), eq(uploads.workflowRunId, workflowRunId)),
    )
    .limit(1);

  return result[0] ?? null;
}

export async function getUploadEventCount(db: Database, uploadId: string) {
  const result = await db
    .select({ count: count(events.id) })
    .from(events)
    .where(eq(events.uploadId, uploadId));

  return result[0]?.count ?? 0;
}

export async function getRecentUploads(
  db: Database,
  userId: string,
  limit = 5,
) {
  return db
    .select({
      id: uploads.id,
      fileName: uploads.fileName,
      status: uploads.status,
      failureReason: uploads.failureReason,
      createdAt: uploads.createdAt,
    })
    .from(uploads)
    .where(eq(uploads.userId, userId))
    .orderBy(desc(uploads.createdAt))
    .limit(limit);
}

export async function getUploadByShareToken(db: Database, shareToken: string) {
  const result = await db
    .select({
      id: uploads.id,
      fileName: uploads.fileName,
      fileType: uploads.fileType,
      icsKey: uploads.icsKey,
      shareToken: uploads.shareToken,
      status: uploads.status,
      userId: uploads.userId,
      createdAt: uploads.createdAt,
    })
    .from(uploads)
    .where(eq(uploads.shareToken, shareToken))
    .limit(1);

  return result[0] ?? null;
}
