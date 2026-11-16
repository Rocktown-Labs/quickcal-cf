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
    storageKey: `uploads/${userId}/${Date.now()}-${crypto.randomUUID()}-manual-events.json`,
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

/**
 * Refund the one-time free credit only when the AI run never started
 * (validation, storage, or workflow-start failure). Once the workflow starts,
 * the credit is spent; see `startIngestionWorkflow`.
 */
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
  // Never send the signed payload to a URL carrying credentials or to a
  // non-public hostname. (Cloudflare has no RFC1918 egress, but a self-hosted
  // deployment would; keep the validation correct on its own.)
  if (url.username || url.password) return null;
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
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
 * Creates the upload record and kicks off the processing workflow.
 *
 * Throws only when the workflow never started, so callers can refund the
 * one-time free credit. Once `startWorkflow` succeeds the credit is spent:
 * a failure to persist the run id is logged and retried by the status
 * reconciler, never turned into a refund.
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

  let instance: { id: string };
  try {
    instance = await startWorkflow({
      uploadId: upload.id,
      storageKey: source.storageKey,
      fileName: source.fileName,
      fileType: source.fileType,
      userId,
      sourceType: source.sourceType,
      creditUsed: source.creditUsed,
    });
  } catch (error) {
    await updateUploadRecord(db, upload.id, {
      status: "failed",
      failureReason:
        error instanceof Error ? error.message : "Failed to start processing workflow.",
    });
    throw error;
  }

  // The workflow is already running. Do not throw (and trigger a refund) if
  // this bookkeeping write fails; the workflow's mark-processing step writes
  // the same run id from event.instanceId, so /by-run/{runId}/status still
  // resolves once the workflow starts.
  await updateUploadRecord(db, upload.id, {
    workflowRunId: instance.id,
    status: "processing",
    failureReason: null,
  }).catch((error) => {
    console.error("[ingest] failed to persist workflow run id", error);
  });

  return { uploadId: upload.id, runId: instance.id, status: "processing" as const };
}

interface StoredIdempotentResponse {
  status: number;
  body: string;
  contentType: string | null;
}

/** Serializes a handler Response (status + body) for replay. */
async function serializeIdempotentResponse(res: Response): Promise<string | null> {
  try {
    const body = await res.clone().text();
    const stored: StoredIdempotentResponse = {
      status: res.status,
      body,
      contentType: res.headers.get("content-type"),
    };
    return JSON.stringify(stored);
  } catch {
    return null;
  }
}

/** Rebuilds a Response from a stored envelope, or null for legacy rows. */
function deserializeIdempotentResponse(raw: string): Response | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredIdempotentResponse>;
    if (typeof parsed.status !== "number" || typeof parsed.body !== "string") return null;
    const headers = new Headers();
    if (parsed.contentType) headers.set("content-type", parsed.contentType);
    headers.set("Idempotency-Replayed", "true");
    return new Response(parsed.body, { status: parsed.status, headers });
  } catch {
    return null;
  }
}

/**
 * Wraps an ingestion handler with Idempotency-Key replay: when the same
 * user retries the same key within the TTL, the stored response is replayed
 * verbatim instead of creating a second upload.
 *
 * Stores the status and body of the `Response` — serializing the Response
 * object itself produced `{}`, so retries previously received an empty 200
 * instead of the original uploadId/runId.
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
    const replay = deserializeIdempotentResponse(stored);
    if (replay) return replay as unknown as T;

    // Legacy rows stored a plain JSON body (and an empty `{}` for Response
    // results). Replay what we have as JSON so old keys don't 500.
    return new Response(stored, {
      status: 200,
      headers: { "content-type": "application/json", "Idempotency-Replayed": "true" },
    }) as unknown as T;
  }

  const result = await produce();
  if (result instanceof Response) {
    const serialized = await serializeIdempotentResponse(result);
    if (serialized) {
      await storeIdempotentResponse(db, userId, keyHash, serialized).catch(() => undefined);
    }
  } else {
    // Non-Response handlers (none today) keep the original JSON behavior.
    await storeIdempotentResponse(db, userId, keyHash, JSON.stringify(result)).catch(
      () => undefined,
    );
  }
  return result;
}
