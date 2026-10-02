import { Hono } from "hono";
import { z } from "zod";
import * as HttpStatusCodes from "stoker/http-status-codes";
import {
  deleteUserEvent,
  getUploadById,
  getUploadEventCount,
  getUploadEventsForReview,
  getUserEventById,
  getUserUploadByWorkflowRunId,
  getUserUploads,
  updateUploadRecord,
  updateUserEvent,
} from "@quickcal-cf/db";
import { ENV } from "./env.server";
import { getDb } from "./services";
import type { AuthEnv } from "./lib/auth";
import {
  createDirectEventsRecord,
  ingestionForbiddenResponse,
  refundIngestion,
  requireIngestionAccess,
  startIngestionWorkflow,
  validateCallbackUrl,
} from "./lib/ingest";
import { fetchIngestDocument } from "./lib/fetch-document";

/**
 * QuickCalAI MCP server — a stateless streamable-HTTP JSON-RPC endpoint so
 * AI agents can use the product from any MCP client. Auth is the same as
 * the REST API (session cookie or `Authorization: Bearer qc_…` user API key),
 * wired in index.ts. Stateless: no sessions, no SSE — every POST is a
 * self-contained JSON-RPC message.
 */

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_ORIGIN = "https://quickcal-server.rocktown-labs.workers.dev";

interface ToolContext {
  userId: string;
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (args: unknown, ctx: ToolContext) => Promise<string>;
}

function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<string>;
}): McpToolDef {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: def.handler as McpToolDef["handler"],
  };
}

const hhmm = /^$|^([01]\d|2[0-3]):[0-5]\d$/;
const eventInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  time: z.string().regex(hhmm).optional(),
  endTime: z.string().regex(hhmm).optional(),
  location: z.string().trim().max(300).optional(),
  description: z.string().trim().max(2000).optional(),
});

const tools: McpToolDef[] = [
  defineTool({
    name: "upload_text",
    description:
      "Extract calendar events from schedule text (plain text, Markdown, or CSV — no file needed). Uses AI (premium or a free-trial credit). Returns uploadId + runId to poll with check_upload_status.",
    inputSchema: z.object({
      content: z
        .string()
        .min(1)
        .max(100 * 1024),
      title: z.string().trim().max(120).optional(),
      callbackUrl: z.string().optional(),
    }),
    handler: async (args, ctx) => {
      const db = getDb();
      const access = await requireIngestionAccess(db, ctx.userId);
      if (!access) return JSON.stringify(ingestionForbiddenResponse());
      const callbackUrl = validateCallbackUrl(args.callbackUrl) ?? null;
      if (args.callbackUrl && !callbackUrl) {
        return JSON.stringify({ message: "callbackUrl must be an https:// URL." });
      }
      const storageKey = `uploads/${ctx.userId}/${Date.now()}-agent-text.txt`;
      try {
        await ENV.FILES.put(storageKey, new TextEncoder().encode(args.content), {
          httpMetadata: { contentType: "text/plain" },
        });
        const result = await startIngestionWorkflow(
          db,
          ctx.userId,
          {
            fileName: args.title ?? "Agent text",
            fileType: "text/plain",
            storageKey,
            sourceType: "text",
            creditUsed: access === "credit",
          },
          callbackUrl,
          (params) => ENV.CALENDAR_WORKFLOW.create({ params }),
        );
        return JSON.stringify(result);
      } catch (error) {
        await ENV.FILES.delete(storageKey).catch(() => undefined);
        await refundIngestion(db, ctx.userId, access);
        throw error;
      }
    },
  }),
  defineTool({
    name: "ingest_url",
    description:
      "Fetch a public https:// URL server-side and extract its schedule events. Accepts images, PDFs, plain text, Markdown, CSV (not HTML pages). Uses AI. Returns uploadId + runId.",
    inputSchema: z.object({
      url: z.string().url(),
      callbackUrl: z.string().optional(),
    }),
    handler: async (args, ctx) => {
      const db = getDb();
      const access = await requireIngestionAccess(db, ctx.userId);
      if (!access) return JSON.stringify(ingestionForbiddenResponse());
      const callbackUrl = validateCallbackUrl(args.callbackUrl) ?? null;
      try {
        const doc = await fetchIngestDocument(args.url);
        const storageKey = `uploads/${ctx.userId}/${Date.now()}-${doc.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)}`;
        await ENV.FILES.put(storageKey, doc.bytes, {
          httpMetadata: { contentType: doc.contentType },
        });
        const result = await startIngestionWorkflow(
          db,
          ctx.userId,
          {
            fileName: doc.fileName,
            fileType: doc.contentType,
            storageKey,
            sourceType: doc.text !== null ? "text" : "file",
            creditUsed: access === "credit",
          },
          callbackUrl,
          (params) => ENV.CALENDAR_WORKFLOW.create({ params }),
        );
        return JSON.stringify(result);
      } catch (error) {
        await refundIngestion(db, ctx.userId, access);
        const message = error instanceof Error ? error.message : "Could not fetch that document.";
        return JSON.stringify({ message });
      }
    },
  }),
  defineTool({
    name: "create_events",
    description:
      "Create calendar events directly from structured JSON — use when you already parsed the schedule yourself. Free (no AI). Returns uploadId, shareToken, and downloadPath immediately.",
    inputSchema: z.object({
      name: z.string().trim().max(120).optional(),
      events: z.array(eventInputSchema).min(1).max(500),
    }),
    handler: async (args, ctx) => {
      const result = await createDirectEventsRecord(getDb(), ENV.FILES, ctx.userId, {
        name: args.name,
        events: args.events.map((e) => ({
          title: e.title,
          date: e.date,
          time: e.time ?? "",
          endTime: e.endTime ?? "",
          location: e.location ?? "",
          description: e.description ?? "",
        })),
      });
      return JSON.stringify({
        ...result,
        shareUrl: `${SERVER_ORIGIN}/s/${result.shareToken}`,
      });
    },
  }),
  defineTool({
    name: "check_upload_status",
    description:
      "Poll the processing status of an ingestion by runId (returned by upload_text / ingest_url / the REST API) or uploadId. Terminal statuses: completed, no_events, failed.",
    inputSchema: z.object({
      runId: z.string().optional(),
      uploadId: z.string().optional(),
    }),
    handler: async (args, ctx) => {
      const db = getDb();
      let upload = null;
      if (args.uploadId) {
        const row = await getUploadById(db, args.uploadId);
        upload = row && row.userId === ctx.userId ? row : null;
      } else if (args.runId) {
        upload = await getUserUploadByWorkflowRunId(db, ctx.userId, args.runId);
      } else {
        return JSON.stringify({ message: "Provide runId or uploadId." });
      }
      if (!upload) return JSON.stringify({ message: "Upload not found" });
      const eventCount =
        upload.status === "completed" ? await getUploadEventCount(db, upload.id) : 0;
      return JSON.stringify({
        uploadId: upload.id,
        status: upload.status,
        eventCount,
        failureReason: upload.failureReason,
        shareToken: upload.shareToken,
        downloadPath: upload.shareToken ? `/api/share/${upload.shareToken}/ics` : null,
      });
    },
  }),
  defineTool({
    name: "list_uploads",
    description: "List your uploads, newest first.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    handler: async (args, ctx) => {
      const rows = await getUserUploads(getDb(), ctx.userId, args.limit ?? 20);
      return JSON.stringify({
        uploads: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      });
    },
  }),
  defineTool({
    name: "get_upload_events",
    description:
      "List an upload's extracted events for review — includes each event's AI confidence and the source quote it was parsed from.",
    inputSchema: z.object({ uploadId: z.string() }),
    handler: async (args, ctx) => {
      const db = getDb();
      const upload = await getUploadById(db, args.uploadId);
      if (!upload || upload.userId !== ctx.userId) {
        return JSON.stringify({ message: "Upload not found" });
      }
      const rows = await getUploadEventsForReview(db, ctx.userId, upload.id);
      return JSON.stringify({
        events: rows.map((e) => ({
          ...e,
          startTime: e.startTime.toISOString(),
          endTime: e.endTime?.toISOString() ?? null,
        })),
      });
    },
  }),
  defineTool({
    name: "update_event",
    description:
      "Correct one event (fix a misread date/time/title). Regenerates the parent upload's .ics automatically. time is HH:MM; empty string = all-day.",
    inputSchema: z.object({
      eventId: z.string(),
      title: z.string().trim().min(1).max(200).optional(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      time: z.string().regex(hhmm).optional(),
      location: z.string().trim().max(300).optional(),
      description: z.string().trim().max(2000).optional(),
    }),
    handler: async (args, ctx) => {
      const db = getDb();
      const existing = await getUserEventById(db, ctx.userId, args.eventId);
      if (!existing) return JSON.stringify({ message: "Event not found" });

      const pad = (n: number) => String(n).padStart(2, "0");
      const d = new Date(existing.startTime);
      const existingDate = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      const existingTime = existing.isAllDay
        ? ""
        : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      const date = args.date ?? existingDate;
      const time = args.time !== undefined ? args.time : existingTime;

      const updated = await updateUserEvent(db, ctx.userId, args.eventId, {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.location !== undefined ? { location: args.location } : {}),
        startTime: new Date(`${date}T${time || "00:00"}:00Z`),
        isAllDay: !time,
      });
      if (!updated) return JSON.stringify({ message: "Event not found" });
      return JSON.stringify({ updated: true, eventId: args.eventId });
    },
  }),
  defineTool({
    name: "delete_event",
    description: "Delete one of your events. Regenerates the parent upload's .ics automatically.",
    inputSchema: z.object({ eventId: z.string() }),
    handler: async (args, ctx) => {
      const deleted = await deleteUserEvent(getDb(), ctx.userId, args.eventId);
      if (!deleted) return JSON.stringify({ message: "Event not found" });
      return JSON.stringify({ deleted: true, eventId: args.eventId });
    },
  }),
  defineTool({
    name: "revoke_share",
    description: "Revoke an upload's public share link immediately.",
    inputSchema: z.object({ uploadId: z.string() }),
    handler: async (args, ctx) => {
      const db = getDb();
      const upload = await getUploadById(db, args.uploadId);
      if (!upload || upload.userId !== ctx.userId) {
        return JSON.stringify({ message: "Upload not found" });
      }
      if (upload.icsKey) {
        await ENV.FILES.delete(upload.icsKey).catch(() => undefined);
      }
      await updateUploadRecord(db, upload.id, { icsKey: null, shareToken: null });
      return JSON.stringify({ revoked: true, uploadId: upload.id });
    },
  }),
];

// ─── JSON-RPC plumbing ───────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input", target: "draft-7" }) as Record<string, unknown>;
}

async function handleMessage(
  message: JsonRpcRequest,
  userId: string,
): Promise<JsonRpcResponse | null> {
  // Notifications (no id) get no response per the JSON-RPC spec.
  if (message.id === undefined || message.id === null) return null;

  const base = { jsonrpc: "2.0" as const, id: message.id };

  try {
    switch (message.method) {
      case "initialize":
        return {
          ...base,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "quickcalai", version: "1.0.0" },
            instructions:
              "Turn schedules into calendar files. Give me schedule text, a public document URL, or structured events; I extract the events and hand back .ics files and share links.",
          },
        };
      case "notifications/initialized":
        return null;
      case "ping":
        return { ...base, result: {} };
      case "tools/list":
        return {
          ...base,
          result: {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: zodToJsonSchema(tool.inputSchema),
            })),
          },
        };
      case "tools/call": {
        const params = message.params ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          return { ...base, error: { code: -32602, message: `Unknown tool: ${name}` } };
        }
        const parsed = tool.inputSchema.safeParse(params.arguments ?? {});
        if (!parsed.success) {
          return {
            ...base,
            result: {
              content: [{ type: "text", text: JSON.stringify(parsed.error.issues) }],
              isError: true,
            },
          };
        }
        const text = await tool.handler(parsed.data, { userId });
        return { ...base, result: { content: [{ type: "text", text }] } };
      }
      default:
        return {
          ...base,
          error: { code: -32601, message: `Method not found: ${message.method ?? "(none)"}` },
        };
    }
  } catch (error) {
    return {
      ...base,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error",
      },
    };
  }
}

export const mcpApp = new Hono<AuthEnv>();

mcpApp.post("/", async (c) => {
  const userId = c.get("userId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      HttpStatusCodes.BAD_REQUEST,
    );
  }

  const messages: JsonRpcRequest[] = Array.isArray(body) ? body : [body];
  const responses: JsonRpcResponse[] = [];

  for (const message of messages) {
    const response = await handleMessage(message, userId);
    if (response) responses.push(response);
  }

  if (Array.isArray(body)) return c.json(responses);
  if (responses.length === 0) return c.body(null, HttpStatusCodes.ACCEPTED);
  return c.json(responses[0]!);
});

// Human/agent discovery surface.
mcpApp.get("/", (c) =>
  c.json(
    {
      server: "quickcalai-mcp",
      transport: "streamable-http (stateless)",
      endpoint: "POST /mcp",
      auth: "Authorization: Bearer qc_… (user API key) or session cookie",
      tools: tools.map((t) => t.name),
    },
    HttpStatusCodes.OK,
  ),
);
