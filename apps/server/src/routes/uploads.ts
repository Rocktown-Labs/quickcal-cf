import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import jsonContent from "stoker/openapi/helpers/json-content";
import createMessageObjectSchema from "stoker/openapi/schemas/create-message-object";
import {
  createUploadRecord,
  getUploadById,
  getUploadEventCount,
  getUserUploadByWorkflowRunId,
  getUserUploads,
  updateUploadRecord,
  type UploadStatus,
} from "@quickcal-cf/db";
import { ENV } from "../env.server";
import { getDb } from "../services";
import { requireAuth, type AuthEnv } from "../lib/auth";
import { isPremium } from "../lib/premium";
import {
  MAX_UPLOAD_FILE_SIZE_BYTES,
  uploadMimeTypes,
} from "../lib/validators";

const app = new OpenAPIHono<AuthEnv>();
app.use(requireAuth);

const uploadStatusEnum = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
  "no_events",
]);

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
  const rows = await getUserUploads(getDb(), userId);
  return c.json(
    {
      uploads: rows.slice(0, limit).map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
    },
    HttpStatusCodes.OK,
  );
});

const createUpload = createRoute({
  method: "post",
  path: "/",
  tags: ["Uploads"],
  summary: "Upload a schedule document (premium)",
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            // OpenAPI file-upload placeholder; validated at runtime instead.
            file: z.any(),
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.ACCEPTED]: jsonContent(
      z.object({
        uploadId: z.string(),
        runId: z.string(),
        status: uploadStatusEnum,
      }),
      "Upload stored, workflow started",
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema("Premium required"),
      "AI upload is a premium feature",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createMessageObjectSchema("Invalid file"),
      "File validation failed",
    ),
  },
});

app.openapi(createUpload, async (c) => {
  const userId = c.get("userId");
  const db = getDb();

  if (!(await isPremium(db, userId))) {
    return c.json(
      { message: "AI upload is a premium feature. Please upgrade your subscription." },
      HttpStatusCodes.FORBIDDEN,
    );
  }

  const formData = await c.req.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return c.json({ message: "No file provided" }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }
  if (!(uploadMimeTypes as readonly string[]).includes(file.type)) {
    return c.json({ message: "Unsupported file type" }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }
  if (file.size > MAX_UPLOAD_FILE_SIZE_BYTES) {
    return c.json({ message: "File exceeds 10MB limit" }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "upload";
  const storageKey = `uploads/${userId}/${Date.now()}-${safeName}`;

  await ENV.FILES.put(storageKey, file, {
    httpMetadata: { contentType: file.type },
  });

  const upload = await createUploadRecord(db, {
    fileName: file.name,
    fileType: file.type,
    storageKey,
    userId,
    status: "pending",
  }).catch(async (error) => {
    await ENV.FILES.delete(storageKey).catch(() => undefined);
    throw error;
  });

  try {
    const instance = await ENV.CALENDAR_WORKFLOW.create({
      params: {
        uploadId: upload.id,
        storageKey,
        fileName: file.name,
        fileType: file.type,
        userId,
      },
    });

    await updateUploadRecord(db, upload.id, {
      workflowRunId: instance.id,
      status: "processing",
      failureReason: null,
    });

    return c.json(
      { uploadId: upload.id, runId: instance.id, status: "processing" as const },
      HttpStatusCodes.ACCEPTED,
    );
  } catch (error) {
    await updateUploadRecord(db, upload.id, {
      status: "failed",
      failureReason:
        error instanceof Error ? error.message : "Failed to start processing workflow.",
    });
    throw error;
  }
});

type StatusRow = {
  id: string;
  status: UploadStatus;
  failureReason: string | null;
  shareToken: string | null;
};

async function buildStatusResponse(
  db: ReturnType<typeof getDb>,
  upload: StatusRow,
) {
  const eventCount =
    upload.status === "completed" ? await getUploadEventCount(db, upload.id) : 0;

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
            ...(upload.shareToken
              ? { downloadPath: `/api/share/${upload.shareToken}/ics` }
              : {}),
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

const TERMINAL_STATUSES: ReadonlySet<UploadStatus> = new Set([
  "completed",
  "failed",
  "no_events",
]);

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
        const failureReason =
          upload.failureReason ?? "Workflow failed during processing.";
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

export default app;
