import type { Context } from "hono";
import {
  createUploadRecord,
  events,
  generateICSForAI,
  generateShareToken,
  updateUploadRecord,
} from "@quickcal-cf/db";
import type { Database } from "@quickcal-cf/db";
import { consumeFreeCredit, refundFreeCredit, isPremium } from "@quickcal-cf/db";
import {
  findIdempotentResponse,
  hashIdempotencyKey,
  storeIdempotentResponse,
} from "@quickcal-cf/db";

export interface DirectEventInput {
  title: string;
  date: string;
  time: string;
  endTime: string;
  location: string;
  description: string;
}

export interface DirectEventFiles {
  put(
    key: string,
    data: string | Uint8Array,
    options: { httpMetadata: { contentType: string } },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/**
 * Shared core for "already-parsed" structured events (REST + MCP): builds
 * the .ics + upload record + event rows. Free — no AI, no credit consumed.
 */
export async function createDirectEventsRecord(
  db: Database,
  files: DirectEventFiles,
  userId: string,
  input: { name?: string; events: DirectEventInput[] },
): Promise<{
  uploadId: string;
  status: "completed";
  eventCount: number;
  shareToken: string;
  downloadPath: string;
}> {
  const valid = input.events.filter((e) => e.date.trim() !== "");
  if (valid.length === 0) {
    throw new Error("At least one event with a date is required.");
  }

  const shareToken = generateShareToken();
  const icsKey = `ics/${shareToken}.ics`;
  const icsContent = generateICSForAI(
    valid.map((e) => ({
      date: e.date,
      time: e.time || "",
      endTime: e.endTime || "",
      description: e.title + (e.description ? `\n\n${e.description}` : ""),
      location: e.location || "",
    })),
  );

  await files.put(icsKey, icsContent, { httpMetadata: { contentType: "text/calendar" } });

  const upload = await createUploadRecord(db, {
    fileName: input.name || `Manual events (${valid.length})`,
    fileType: "application/json",
    storageKey: `uploads/${userId}/${Date.now()}-manual-events.json`,
    userId,
    status: "completed",
    icsKey,
    shareToken,
    failureReason: null,
  }).catch(async (error) => {
    await files.delete(icsKey).catch(() => undefined);
    throw error;
  });

  for (const e of valid) {
    const startTime = new Date(`${e.date}T${e.time || "00:00"}:00Z`);
    await db.insert(events).values({
      id: crypto.randomUUID(),
      title: e.title,
      description: e.description || null,
      location: e.location || null,
      startTime,
      endTime: e.time && e.endTime ? new Date(`${e.date}T${e.endTime}:00Z`) : null,
      isAllDay: !e.time,
      uploadId: upload.id,
      userId,
    });
  }

  return {
    uploadId: upload.id,
    status: "completed",
    eventCount: valid.length,
    shareToken,
    downloadPath: `/api/share/${shareToken}/ics`,
  };
}

/** Premium users ingest freely; everyone else burns a free credit. */
export async function requireIngestionAccess(
  db: Database,
  userId: string,
): Promise<"premium" | "credit" | null> {
  if (await isPremium(db, userId)) return "premium";
  if (await consumeFreeCredit(db, userId)) return "credit";
  return null;
}

export function ingestionForbiddenResponse() {
  return {
    message:
      "You've used your free AI extraction. Upgrade to Premium for unlimited AI extractions.",
    code: "free_credits_exhausted",
  };
}

/** Refund the free credit when ingestion fails after it was taken. */
export async function refundIngestion(
  db: Database,
  userId: string,
  access: "premium" | "credit",
): Promise<void> {
  if (access === "credit") {
    await refundFreeCredit(db, userId);
  }
}

/**
 * Valid webhook/callback targets: https anywhere, or http for localhost
 * (local agent development). Callbacks run from the Worker, which has no
 * RFC1918 egress, and this blocks plain-HTTP exfiltration to the open web.
 */
export function validateCallbackUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return url.toString();
  if (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  ) {
    return url.toString();
  }
  return null;
}

export interface IngestSource {
  fileName: string;
  fileType: string;
  storageKey: string;
  sourceType: "file" | "text";
  /** True when a free-trial credit paid for this ingestion. */
  creditUsed?: boolean;
}

interface StartWorkflowFn {
  (input: {
    uploadId: string;
    storageKey: string;
    fileName: string;
    fileType: string;
    userId: string;
    sourceType: "file" | "text";
    creditUsed?: boolean;
  }): Promise<{ id: string }>;
}

/**
 * Creates the upload record and kicks off the processing workflow. Throws
 * on failure so callers can refund the free credit.
 */
export async function startIngestionWorkflow(
  db: Database,
  userId: string,
  source: IngestSource,
  callbackUrl: string | null,
  startWorkflow: StartWorkflowFn,
) {
  const upload = await createUploadRecord(db, {
    fileName: source.fileName,
    fileType: source.fileType,
    storageKey: source.storageKey,
    userId,
    status: "pending",
    callbackUrl,
  });

  try {
    const instance = await startWorkflow({
      uploadId: upload.id,
      storageKey: source.storageKey,
      fileName: source.fileName,
      fileType: source.fileType,
      userId,
      sourceType: source.sourceType,
      creditUsed: source.creditUsed,
    });
    await updateUploadRecord(db, upload.id, {
      workflowRunId: instance.id,
      status: "processing",
      failureReason: null,
    });
    return { uploadId: upload.id, runId: instance.id, status: "processing" as const };
  } catch (error) {
    await updateUploadRecord(db, upload.id, {
      status: "failed",
      failureReason:
        error instanceof Error ? error.message : "Failed to start processing workflow.",
    });
    throw error;
  }
}

/**
 * Wraps an ingestion handler with Idempotency-Key replay: when the same
 * user retries the same key within the TTL, the stored response is replayed
 * verbatim instead of creating a second upload.
 */
export async function withIdempotency<T>(
  c: Context,
  db: Database,
  userId: string,
  produce: () => Promise<T>,
): Promise<T> {
  const rawKey = c.req.header("Idempotency-Key");
  if (!rawKey || rawKey.length < 8 || rawKey.length > 255) {
    return produce();
  }

  const keyHash = await hashIdempotencyKey(rawKey);
  const stored = await findIdempotentResponse(db, userId, keyHash);
  if (stored) {
    c.header("Idempotency-Replayed", "true");
    return JSON.parse(stored) as T;
  }

  const result = await produce();
  await storeIdempotentResponse(db, userId, keyHash, JSON.stringify(result)).catch(() => undefined);
  return result;
}
