import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

export const uploadStatusValues = [
  "pending", // File uploaded, waiting for workflow to start
  "processing", // AI is analyzing the file
  "completed", // AI finished, one or more events extracted
  "failed", // AI failed during processing
  "no_events", // Document was valid, but no events were found
] as const;

export type UploadStatus = (typeof uploadStatusValues)[number];

function timestamps() {
  return {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  };
}

export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    fileName: text("file_name").notNull(),
    fileType: text("file_type").notNull(), // e.g. 'image/png', 'application/pdf'
    storageKey: text("storage_key").notNull(), // R2 object key for the source file
    icsKey: text("ics_key"), // R2 object key for the combined .ics file
    shareToken: text("share_token").unique(), // Public share token for preview page
    workflowRunId: text("workflow_run_id").unique(),
    callbackUrl: text("callback_url"), // Signed webhook target for agent workflows
    failureReason: text("failure_reason"),

    // Text union instead of pgEnum — validated in zod schemas.
    status: text("status").$type<UploadStatus>().default("pending").notNull(),

    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (table) => [
    index("uploads_userId_idx").on(table.userId),
    index("uploads_shareToken_idx").on(table.shareToken),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    startTime: integer("start_time", { mode: "timestamp_ms" }).notNull(),
    endTime: integer("end_time", { mode: "timestamp_ms" }),
    isAllDay: integer("is_all_day", { mode: "boolean" }).default(false).notNull(),

    // Extraction aids for the review flow — per-event AI confidence (0..1)
    // and the quote from the source document the event was parsed from.
    confidence: real("confidence"),
    sourceQuote: text("source_quote"),

    uploadId: text("upload_id").references(() => uploads.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (table) => [
    index("events_userId_idx").on(table.userId),
    index("events_uploadId_idx").on(table.uploadId),
  ],
);

// Idempotency keys for ingestion endpoints — agents retry, and a retried
// upload must not create a second upload + workflow run. Scoped per user.
export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull(), // sha256 of the raw Idempotency-Key header
    responseJson: text("response_json").notNull(), // exact response body to replay
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("idempotency_user_key_idx").on(table.userId, table.keyHash)],
);
