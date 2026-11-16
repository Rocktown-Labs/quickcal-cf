import { describe, expect, test } from "bun:test";
import { Database as BunSqlite } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  getUserUploadByWorkflowRunId,
  updateUploadRecord,
  uploads,
  type Database,
} from "@quickcal-cf/db";

/**
 * The ingestion route writes the workflow run id best-effort after starting
 * the workflow. The workflow's mark-processing step writes the same id from
 * `event.instanceId`, so `/by-run/{runId}/status` must resolve even when the
 * route's write failed. This covers the query/reconciliation contract.
 */

function createTestDb(): Database {
  const sqlite = new BunSqlite(":memory:");
  sqlite.exec(`
    CREATE TABLE uploads (
      id text primary key,
      file_name text not null,
      file_type text not null,
      storage_key text not null,
      ics_key text,
      share_token text,
      workflow_run_id text,
      callback_url text,
      failure_reason text,
      status text not null default 'pending',
      user_id text not null,
      created_at integer not null,
      updated_at integer not null
    );
  `);
  return (drizzle as any)({ client: sqlite }) as Database;
}

describe("workflow run-id reconciliation", () => {
  test("a run id written after start resolves for the owner, not another user", async () => {
    const db = createTestDb();
    await db.insert(uploads).values({
      id: "upload-1",
      fileName: "schedule.pdf",
      fileType: "application/pdf",
      storageKey: "uploads/user-1/source.pdf",
      status: "pending",
      userId: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await updateUploadRecord(db, "upload-1", {
      workflowRunId: "run-1",
      status: "processing",
    });

    const owner = await getUserUploadByWorkflowRunId(db, "user-1", "run-1");
    expect(owner?.id).toBe("upload-1");
    expect(owner?.status).toBe("processing");
    expect(await getUserUploadByWorkflowRunId(db, "user-2", "run-1")).toBeNull();
  });
});
