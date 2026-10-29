import { describe, expect, test } from "bun:test";
import { Database as BunSqlite } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { events, uploads, type Database } from "@quickcal-cf/db";
import { refreshUploadIcs, type IcsFiles } from "./refresh-ics";
import { deleteEventAndRefreshIcs, updateEventAndRefreshIcs } from "./event-mutations";

/**
 * Regression coverage for the shared .ics refresh. The REST routes and the
 * MCP tools both mutate events, and both must regenerate (or delete) the
 * public share artifact — otherwise a deleted event keeps being served from
 * a previously shared link.
 */

function createTestDb(): { db: Database; sqlite: BunSqlite } {
  const sqlite = new BunSqlite(":memory:");
  sqlite.exec(`
    CREATE TABLE user (id text primary key);
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
    CREATE TABLE events (
      id text primary key,
      title text not null,
      description text,
      location text,
      start_time integer not null,
      end_time integer,
      is_all_day integer not null default 0,
      confidence real,
      source_quote text,
      upload_id text,
      user_id text not null,
      created_at integer not null,
      updated_at integer not null
    );
  `);
  return { db: (drizzle as any)({ client: sqlite }) as Database, sqlite };
}

function fakeFiles() {
  const puts: Array<{ key: string; data: string | Uint8Array }> = [];
  const deletes: string[] = [];
  const files: IcsFiles = {
    async put(key, data) {
      puts.push({ key, data });
    },
    async delete(key) {
      deletes.push(key);
    },
  };
  return { files, puts, deletes };
}

async function seedUpload(
  db: Database,
  overrides: Partial<typeof uploads.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? "upload-1";
  await db.insert(uploads).values({
    id,
    fileName: "Fall schedule.pdf",
    fileType: "application/pdf",
    storageKey: `uploads/${overrides.userId ?? "user-1"}/source.pdf`,
    icsKey: "ics/share-token.ics",
    shareToken: "share-token",
    status: "completed",
    userId: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return id;
}

async function seedEvent(
  db: Database,
  id: string,
  uploadId: string,
  title: string,
  userId = "user-1",
): Promise<void> {
  await db.insert(events).values({
    id,
    title,
    startTime: new Date("2026-10-01T14:30:00Z"),
    endTime: new Date("2026-10-01T16:00:00Z"),
    isAllDay: false,
    uploadId,
    userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("refreshUploadIcs", () => {
  test("regenerates the public .ics from the current event rows", async () => {
    const { db } = createTestDb();
    const uploadId = await seedUpload(db);
    await seedEvent(db, "event-1", uploadId, "Biology 101");
    await seedEvent(db, "event-2", uploadId, "Study group");

    const { files, puts } = fakeFiles();
    await refreshUploadIcs(db, files, "user-1", uploadId);

    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe("ics/share-token.ics");
    const ics = String(puts[0]!.data);
    expect(ics).toContain("SUMMARY:Biology 101");
    expect(ics).toContain("SUMMARY:Study group");
  });

  test("removes the deleted event from the regenerated file", async () => {
    const { db, sqlite } = createTestDb();
    const uploadId = await seedUpload(db);
    await seedEvent(db, "event-1", uploadId, "Biology 101");
    await seedEvent(db, "event-2", uploadId, "Study group");
    sqlite.exec("DELETE FROM events WHERE id = 'event-2'");

    const { files, puts } = fakeFiles();
    await refreshUploadIcs(db, files, "user-1", uploadId);

    const ics = String(puts[0]!.data);
    expect(ics).toContain("SUMMARY:Biology 101");
    expect(ics).not.toContain("SUMMARY:Study group");
  });

  test("deleting the last event revokes the share link and marks no_events", async () => {
    const { db, sqlite } = createTestDb();
    const uploadId = await seedUpload(db);
    await seedEvent(db, "event-1", uploadId, "Biology 101");
    sqlite.exec("DELETE FROM events WHERE id = 'event-1'");

    const { files, deletes } = fakeFiles();
    await refreshUploadIcs(db, files, "user-1", uploadId);

    expect(deletes).toEqual(["ics/share-token.ics"]);
    const [row] = await db.select().from(uploads);
    expect(row?.icsKey).toBeNull();
    expect(row?.shareToken).toBeNull();
    expect(row?.status).toBe("no_events");
  });

  test("never touches another user's upload", async () => {
    const { db } = createTestDb();
    const uploadId = await seedUpload(db, { id: "upload-2", userId: "user-2" });
    await seedEvent(db, "event-1", uploadId, "Private event", "user-2");

    const { files, puts, deletes } = fakeFiles();
    await refreshUploadIcs(db, files, "user-1", uploadId);

    expect(puts).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });
});

describe("event mutations used by REST and MCP", () => {
  test("updateEventAndRefreshIcs writes the edited title into the public .ics", async () => {
    const { db } = createTestDb();
    const uploadId = await seedUpload(db);
    await seedEvent(db, "event-1", uploadId, "Biology 101");

    const { files, puts } = fakeFiles();
    const updated = await updateEventAndRefreshIcs(db, files, "user-1", "event-1", {
      title: "Biology 102",
    });

    expect(updated?.uploadId).toBe(uploadId);
    expect(puts).toHaveLength(1);
    expect(String(puts[0]!.data)).toContain("SUMMARY:Biology 102");
  });

  test("deleteEventAndRefreshIcs removes the event from the public .ics", async () => {
    const { db } = createTestDb();
    const uploadId = await seedUpload(db);
    await seedEvent(db, "event-1", uploadId, "Biology 101");
    await seedEvent(db, "event-2", uploadId, "Study group");

    const { files, puts } = fakeFiles();
    const deleted = await deleteEventAndRefreshIcs(db, files, "user-1", "event-2");

    expect(deleted?.uploadId).toBe(uploadId);
    expect(puts).toHaveLength(1);
    expect(String(puts[0]!.data)).toContain("SUMMARY:Biology 101");
    expect(String(puts[0]!.data)).not.toContain("SUMMARY:Study group");
  });

  test("deleting the last event through the shared helper revokes the share link", async () => {
    const { db } = createTestDb();
    const uploadId = await seedUpload(db);
    await seedEvent(db, "event-1", uploadId, "Biology 101");

    const { files, deletes } = fakeFiles();
    await deleteEventAndRefreshIcs(db, files, "user-1", "event-1");

    expect(deletes).toEqual(["ics/share-token.ics"]);
    const [row] = await db.select().from(uploads);
    expect(row?.shareToken).toBeNull();
    expect(row?.status).toBe("no_events");
  });
});
