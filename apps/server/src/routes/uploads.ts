import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import jsonContent from "stoker/openapi/helpers/json-content";
import jsonContentRequired from "stoker/openapi/helpers/json-content-required";
import createMessageObjectSchema from "stoker/openapi/schemas/create-message-object";
import {
  deleteUpload,
  getUploadById,
  getUploadEventCount,
  getUploadEventsForReview,
  getUserUploadByWorkflowRunId,
  getUserUploads,
  updateUploadRecord,
  type UploadStatus,
} from "@quickcal-cf/db";
import { ENV } from "../env.server";
import { getDb } from "../services";
import { requireAuth, type AuthEnv } from "../lib/auth";
import { rateLimit } from "../middleware/rate-limit";
import { MAX_UPLOAD_FILE_SIZE_BYTES, detectMimeType } from "../lib/validators";
import {
  createDirectEventsRecord,
  ingestionForbiddenResponse,
  refundIngestion,
  requireIngestionAccess,
  startIngestionWorkflow,
  validateCallbackUrl,
  withIdempotency,
} from "../lib/ingest";
import { fetchIngestDocument, IngestUrlError } from "../lib/fetch-document";

const app = new OpenAPIHono<AuthEnv>();
app.use(requireAuth);
// Generous per-user budget covering status polling (the web/native uploaders
// poll every 2s). Ingestion routes add their own strict limits below.
app.use(rateLimit({ windowMs: 60_000, maxRequests: 60, keyPrefix: "uploads:user" }));
// AI ingestion is expensive — strict per-user caps per method.
app.use("/", rateLimit({ windowMs: 60_000, maxRequests: 10, keyPrefix: "ingest:user" }));
app.use("/text", rateLimit({ windowMs: 60_000, maxRequests: 10, keyPrefix: "ingest:user" }));
app.use("/from-url", rateLimit({ windowMs: 60_000, maxRequests: 10, keyPrefix: "ingest:user" }));
// Structured events are free (no AI) — a slightly looser cap.
app.use("/events", rateLimit({ windowMs: 60_000, maxRequests: 30, keyPrefix: "eventsdirect:user" }));

const uploadStatusEnum = z.enum(["pending", "processing", "completed", "failed", "no_events"]);

const uploadSummarySchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileType: z.string(),
  status: uploadStatusEnum,
  shareToken: z.string().nullable(),
  createdAt: z.string(),
});

const statusResultSchema = z.object({
  uploadId: z.string(),
  status: uploadStatusEnum,
  eventCount: z.number(),
  failureReason: z.string().nullable(),
  result: z
    .object({
      uploadId: z.string(),
      eventCount: z.number(),
      status: uploadStatusEnum,
      shareToken: z.string().optional(),
      downloadPath: z.string().optional(),
    })
    .nullable(),
});

const listUploads = createRoute({
  method: "get",
  path: "/",
  tags: ["Uploads"],
  summary: "List your uploads",
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ uploads: z.array(uploadSummarySchema) }),
      "Your uploads, newest first",
    ),
  },
});

app.openapi(listUploads, async (c) => {
  const { limit } = c.req.valid("query");
  const userId = c.get("userId");
  const rows = await getUserUploads(getDb(), userId, limit);
  return c.json(
    {
      uploads: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
    },
    HttpStatusCodes.OK,
  );
});

const ingestAcceptedSchema = jsonContent(
  z.object({
    uploadId: z.string(),
    runId: z.string(),
    status: uploadStatusEnum,
  }),
  "Upload stored, workflow started",
);

const ingestForbiddenResponse = jsonContent(
  z.object({
    message: z.string(),
    code: z.string().optional(),
  }),
  "No free AI extractions left — Premium required",
);

const createUpload = createRoute({
  method: "post",
  path: "/",
  tags: ["Uploads"],
  summary: "Upload a schedule document (Premium or free-trial credit)",
  description:
    "Send `file` as multipart/form-data (JPEG/PNG/WebP/PDF, ≤ 10MB). Optionally add `callbackUrl` for a signed webhook when processing finishes, and an `Idempotency-Key` header so retries replay instead of duplicating.",
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            // OpenAPI file-upload placeholder; validated at runtime instead.
            file: z.any(),
            callbackUrl: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.ACCEPTED]: ingestAcceptedSchema,
    [HttpStatusCodes.FORBIDDEN]: ingestForbiddenResponse,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createMessageObjectSchema("Invalid file"),
      "File validation failed",
    ),
  },
});

app.openapi(createUpload, async (c) => {
  const userId = c.get("userId");
  const db = getDb();

  return withIdempotency(c, db, userId, async () => {
    const access = await requireIngestionAccess(db, userId);
    if (!access) {
      return c.json(ingestionForbiddenResponse(), HttpStatusCodes.FORBIDDEN);
    }

    const formData = await c.req.formData();
    const file = formData.get("file");

    const fail = (message: string) => {
      void refundIngestion(db, userId, access);
      return c.json({ message }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
    };

    if (!(file instanceof File)) return fail("No file provided");
    if (file.size > MAX_UPLOAD_FILE_SIZE_BYTES) return fail("File exceeds 10MB limit");

    // Validate the real content — the client-supplied Content-Type is only a
    // hint, so check magic bytes before anything is stored or sent to the AI.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const detectedType = detectMimeType(bytes);
    if (!detectedType) {
      return fail("Unsupported file type — could not read the file contents.");
    }

    const callbackUrl = validateCallbackUrl(String(formData.get("callbackUrl") ?? "")) ?? null;
    if (formData.has("callbackUrl") && !callbackUrl) {
      return fail("callbackUrl must be an https:// URL (http allowed for localhost).");
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "upload";
    const storageKey = `uploads/${userId}/${Date.now()}-${safeName}`;

    try {
      await ENV.FILES.put(storageKey, bytes, {
        httpMetadata: { contentType: detectedType },
      });

      const result = await startIngestionWorkflow(
        db,
        userId,
        { fileName: file.name, fileType: detectedType, storageKey, sourceType: "file" },
        callbackUrl,
        (params) => ENV.CALENDAR_WORKFLOW.create({ params }),
      );

      return c.json(result, HttpStatusCodes.ACCEPTED);
    } catch (error) {
      await ENV.FILES.delete(storageKey).catch(() => undefined);
      await refundIngestion(db, userId, access);
      throw error;
    }
  });
});

// ─── Text ingestion (agents paste schedules as plain text) ──────────────────

const MAX_TEXT_BYTES = 100 * 1024;

const createTextUpload = createRoute({
  method: "post",
  path: "/text",
  tags: ["Uploads"],
  summary: "Extract events from pasted schedule text (Premium or free-trial credit)",
  description:
    "Give the AI a raw schedule as plain text, Markdown, or CSV — no file needed. Same processing pipeline and review flow as file uploads. Optionally include `callbackUrl` and an `Idempotency-Key` header.",
  request: {
    body: jsonContentRequired(
      z.object({
        content: z.string().trim().min(1).max(MAX_TEXT_BYTES),
        title: z.string().trim().max(120).optional(),
        callbackUrl: z.string().optional(),
      }),
      "Schedule text",
    ),
  },
  responses: {
    [HttpStatusCodes.ACCEPTED]: ingestAcceptedSchema,
    [HttpStatusCodes.FORBIDDEN]: ingestForbiddenResponse,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createMessageObjectSchema("Invalid input"),
      "Text validation failed",
    ),
  },
});

app.openapi(createTextUpload, async (c) => {
  const userId = c.get("userId");
  const db = getDb();

  return withIdempotency(c, db, userId, async () => {
    const { content, title, callbackUrl: rawCallback } = c.req.valid("json");

    const callbackUrl = validateCallbackUrl(rawCallback) ?? null;
    if (rawCallback && !callbackUrl) {
      return c.json(
        { message: "callbackUrl must be an https:// URL (http allowed for localhost)." },
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }

    const access = await requireIngestionAccess(db, userId);
    if (!access) {
      return c.json(ingestionForbiddenResponse(), HttpStatusCodes.FORBIDDEN);
    }

    const storageKey = `uploads/${userId}/${Date.now()}-pasted-text.txt`;
    const textBytes = new TextEncoder().encode(content);

    try {
      await ENV.FILES.put(storageKey, textBytes, {
        httpMetadata: { contentType: "text/plain" },
      });

      const result = await startIngestionWorkflow(
        db,
        userId,
        {
          fileName: title || "Pasted text",
          fileType: "text/plain",
          storageKey,
          sourceType: "text",
        },
        callbackUrl,
        (params) => ENV.CALENDAR_WORKFLOW.create({ params }),
      );

      return c.json(result, HttpStatusCodes.ACCEPTED);
    } catch (error) {
      await ENV.FILES.delete(storageKey).catch(() => undefined);
      await refundIngestion(db, userId, access);
      throw error;
    }
  });
});

// ─── URL ingestion (agents hand over links) ──────────────────────────────────

const createUrlUpload = createRoute({
  method: "post",
  path: "/from-url",
  tags: ["Uploads"],
  summary: "Ingest a schedule from a public URL (Premium or free-trial credit)",
  description:
    "The server fetches the URL (https only) and runs the same pipeline. Accepted: JPEG/PNG/WebP/PDF (by content, not header) and plain text / Markdown / CSV. HTML pages are rejected — link the image/PDF/text file directly. Optionally include `callbackUrl` and an `Idempotency-Key` header.",
  request: {
    body: jsonContentRequired(
      z.object({
        url: z.string().trim().url(),
        callbackUrl: z.string().optional(),
      }),
      "Document URL",
    ),
  },
  responses: {
    [HttpStatusCodes.ACCEPTED]: ingestAcceptedSchema,
    [HttpStatusCodes.FORBIDDEN]: ingestForbiddenResponse,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createMessageObjectSchema("Invalid input"),
      "URL rejected or validation failed",
    ),
    [HttpStatusCodes.BAD_GATEWAY]: jsonContent(
      createMessageObjectSchema("Fetch failed"),
      "The document URL could not be fetched",
    ),
  },
});

app.openapi(createUrlUpload, async (c) => {
  const userId = c.get("userId");
  const db = getDb();

  return withIdempotency(c, db, userId, async () => {
    const { url, callbackUrl: rawCallback } = c.req.valid("json");

    const callbackUrl = validateCallbackUrl(rawCallback) ?? null;
    if (rawCallback && !callbackUrl) {
      return c.json(
        { message: "callbackUrl must be an https:// URL (http allowed for localhost)." },
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }

    const access = await requireIngestionAccess(db, userId);
    if (!access) {
      return c.json(ingestionForbiddenResponse(), HttpStatusCodes.FORBIDDEN);
    }

    let doc;
    try {
      doc = await fetchIngestDocument(url);
    } catch (error) {
      await refundIngestion(db, userId, access);
      const message = error instanceof Error ? error.message : "Could not fetch that document.";
      const status = error instanceof IngestUrlError ? error.status : 422;
      if (status === 502) {
        return c.json({ message }, HttpStatusCodes.BAD_GATEWAY);
      }
      return c.json({ message }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
    }

    const isText = doc.text !== null;
    const safeName =
      doc.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "fetched-document";
    const storageKey = `uploads/${userId}/${Date.now()}-${safeName}`;

    try {
      await ENV.FILES.put(storageKey, doc.bytes, {
        httpMetadata: { contentType: doc.contentType },
      });

      const result = await startIngestionWorkflow(
        db,
        userId,
        {
          fileName: doc.fileName,
          fileType: doc.contentType,
          storageKey,
          sourceType: isText ? "text" : "file",
        },
        callbackUrl,
        (params) => ENV.CALENDAR_WORKFLOW.create({ params }),
      );

      return c.json(result, HttpStatusCodes.ACCEPTED);
    } catch (error) {
      await ENV.FILES.delete(storageKey).catch(() => undefined);
      await refundIngestion(db, userId, access);
      throw error;
    }
  });
});

// ─── Direct structured events (no AI — agents that already parsed) ─────────

const structuredEventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  time: z
    .string()
    .trim()
    .regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/, "Time must be in HH:MM 24-hour format")
    .optional()
    .default(""),
  endTime: z
    .string()
    .trim()
    .regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/, "End time must be in HH:MM 24-hour format")
    .optional()
    .default(""),
  location: z.string().trim().max(300).optional().default(""),
  description: z.string().trim().max(2000).optional().default(""),
});

const MAX_DIRECT_EVENTS = 500;

const createDirectEvents = createRoute({
  method: "post",
  path: "/events",
  tags: ["Uploads"],
  summary: "Create events directly from structured JSON (free, no AI)",
  description:
    "For agents that already parsed the schedule themselves — skip the AI, pass up to 500 structured events, and get the same upload record, .ics file, and share link as every other ingestion path. Free tier: no credit is consumed. Supports `Idempotency-Key`.",
  request: {
    body: jsonContentRequired(
      z.object({
        name: z.string().trim().max(120).optional(),
        events: z.array(structuredEventSchema).min(1).max(MAX_DIRECT_EVENTS),
      }),
      "Structured events",
    ),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(
      z.object({
        uploadId: z.string(),
        status: uploadStatusEnum,
        eventCount: z.number(),
        shareToken: z.string(),
        downloadPath: z.string(),
      }),
      "Events created — the .ics and share link are ready immediately",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createMessageObjectSchema("Invalid input"),
      "Event validation failed",
    ),
  },
});

app.openapi(createDirectEvents, async (c) => {
  const userId = c.get("userId");
  const db = getDb();

  return withIdempotency(c, db, userId, async () => {
    const { name, events: inputEvents } = c.req.valid("json");

    const result = await createDirectEventsRecord(db, ENV.FILES, userId, {
      name,
      events: inputEvents,
    });

    return c.json(result, HttpStatusCodes.CREATED);
  });
});

// ─── Review: the owner's event list for an upload ────────────────────────────

const eventReviewSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  isAllDay: z.boolean(),
  confidence: z.number().nullable(),
  sourceQuote: z.string().nullable(),
});

const listUploadEvents = createRoute({
  method: "get",
  path: "/{id}/events",
  tags: ["Uploads"],
  summary: "List an upload's events for review (with confidence and source quote)",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ events: z.array(eventReviewSchema) }),
      "Extracted events",
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema("Not found"),
      "Upload not found",
    ),
  },
});

app.openapi(listUploadEvents, async (c) => {
  const { id } = c.req.valid("param");
  const userId = c.get("userId");
  const db = getDb();

  const upload = await getUploadById(db, id);
  if (!upload || upload.userId !== userId) {
    return c.json({ message: "Upload not found" }, HttpStatusCodes.NOT_FOUND);
  }

  const rows = await getUploadEventsForReview(db, userId, upload.id);
  return c.json(
    {
      events: rows.map((e) => ({
        ...e,
        startTime: e.startTime.toISOString(),
        endTime: e.endTime?.toISOString() ?? null,
      })),
    },
    HttpStatusCodes.OK,
  );
});

type StatusRow = {
  id: string;
  status: UploadStatus;
  failureReason: string | null;
  shareToken: string | null;
};

async function buildStatusResponse(db: ReturnType<typeof getDb>, upload: StatusRow) {
  const eventCount = upload.status === "completed" ? await getUploadEventCount(db, upload.id) : 0;

  return {
    uploadId: upload.id,
    status: upload.status,
    eventCount,
    failureReason: upload.failureReason,
    result:
      upload.status === "completed"
        ? {
            uploadId: upload.id,
            eventCount,
            status: upload.status,
            ...(upload.shareToken ? { shareToken: upload.shareToken } : {}),
            ...(upload.shareToken ? { downloadPath: `/api/share/${upload.shareToken}/ics` } : {}),
          }
        : null,
  };
}

const statusResponses = {
  [HttpStatusCodes.OK]: jsonContent(statusResultSchema, "Current processing status"),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    createMessageObjectSchema("Not found"),
    "Upload not found",
  ),
};

const getUploadStatus = createRoute({
  method: "get",
  path: "/{id}/status",
  tags: ["Uploads"],
  summary: "Poll processing status for an upload",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: statusResponses,
});

app.openapi(getUploadStatus, async (c) => {
  const { id } = c.req.valid("param");
  const userId = c.get("userId");
  const db = getDb();

  const upload = await getUploadById(db, id);
  if (!upload || upload.userId !== userId) {
    return c.json({ message: "Upload not found" }, HttpStatusCodes.NOT_FOUND);
  }

  return c.json(await buildStatusResponse(db, upload), HttpStatusCodes.OK);
});

const TERMINAL_STATUSES: ReadonlySet<UploadStatus> = new Set(["completed", "failed", "no_events"]);

const getUploadStatusByRun = createRoute({
  method: "get",
  path: "/by-run/{runId}/status",
  tags: ["Uploads"],
  summary: "Poll processing status by workflow run id",
  request: {
    params: z.object({ runId: z.string().min(1) }),
  },
  responses: statusResponses,
});

app.openapi(getUploadStatusByRun, async (c) => {
  const { runId } = c.req.valid("param");
  const userId = c.get("userId");
  const db = getDb();

  const upload = await getUserUploadByWorkflowRunId(db, userId, runId);
  if (!upload) {
    return c.json({ message: "Upload not found" }, HttpStatusCodes.NOT_FOUND);
  }

  if (!TERMINAL_STATUSES.has(upload.status)) {
    try {
      const instance = await ENV.CALENDAR_WORKFLOW.get(runId);
      const state = await instance.status();
      if (state.status === "errored" || state.status === "terminated") {
        const failureReason = upload.failureReason ?? "Workflow failed during processing.";
        await updateUploadRecord(db, upload.id, {
          status: "failed",
          failureReason,
        });
        return c.json(
          await buildStatusResponse(db, {
            ...upload,
            status: "failed",
            failureReason,
          }),
          HttpStatusCodes.OK,
        );
      }
    } catch {
      // Workflow handle unavailable — fall back to the stored DB status.
    }
  }

  return c.json(await buildStatusResponse(db, upload), HttpStatusCodes.OK);
});

const deleteUploadRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Uploads"],
  summary: "Delete an upload and its events",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(createMessageObjectSchema("Deleted"), "Upload deleted"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema("Not found"),
      "Upload not found",
    ),
  },
});

app.openapi(deleteUploadRoute, async (c) => {
  const { id } = c.req.valid("param");
  const userId = c.get("userId");
  const db = getDb();

  const upload = await getUploadById(db, id);
  if (!upload || upload.userId !== userId) {
    return c.json({ message: "Upload not found" }, HttpStatusCodes.NOT_FOUND);
  }

  await ENV.FILES.delete(upload.storageKey).catch(() => undefined);
  if (upload.icsKey) {
    await ENV.FILES.delete(upload.icsKey).catch(() => undefined);
  }
  await deleteUpload(db, id);
  return c.json({ message: "Upload deleted" }, HttpStatusCodes.OK);
});

const revokeShareRoute = createRoute({
  method: "post",
  path: "/{id}/share/revoke",
  tags: ["Uploads"],
  summary: "Revoke the public share link for an upload",
  description:
    "Deletes the public .ics share object and clears the share token. Any previously shared links stop working immediately.",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(createMessageObjectSchema("Revoked"), "Share link revoked"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema("Not found"),
      "Upload not found",
    ),
  },
});

app.openapi(revokeShareRoute, async (c) => {
  const { id } = c.req.valid("param");
  const userId = c.get("userId");
  const db = getDb();

  const upload = await getUploadById(db, id);
  if (!upload || upload.userId !== userId) {
    return c.json({ message: "Upload not found" }, HttpStatusCodes.NOT_FOUND);
  }

  if (upload.icsKey) {
    await ENV.FILES.delete(upload.icsKey).catch(() => undefined);
  }
  await updateUploadRecord(db, upload.id, { icsKey: null, shareToken: null });
  return c.json({ message: "Share link revoked" }, HttpStatusCodes.OK);
});

export default app;
