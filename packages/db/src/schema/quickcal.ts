import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
} from "drizzle-orm/sqlite-core";
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
    isAllDay: integer("is_all_day", { mode: "boolean" })
      .default(false)
      .notNull(),

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
