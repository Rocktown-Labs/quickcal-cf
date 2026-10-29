import { describe, expect, test } from "bun:test";
import { Database as BunSqlite } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Context } from "hono";
import type { Database } from "@quickcal-cf/db";
import { withIdempotency } from "./ingest";

/**
 * Regression coverage for Idempotency-Key replay. The handlers return a
 * `Response`; the old implementation did `JSON.stringify(response)`, which is
 * `"{}"`, so a retry received an empty 200 instead of the original
 * uploadId/runId.
 */

function createTestDb(): Database {
  const sqlite = new BunSqlite(":memory:");
  sqlite.exec(`
    CREATE TABLE idempotency_keys (
      id text primary key,
      user_id text not null,
      key_hash text not null,
      response_json text not null,
      created_at integer not null default 0,
      expires_at integer not null
    );
  `);
  return drizzle(sqlite) as unknown as Database;
}

function contextWithKey(key: string | null): Context {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === "idempotency-key" ? (key ?? undefined) : undefined,
    },
  } as unknown as Context;
}

function okResponse() {
  return new Response(JSON.stringify({ uploadId: "upload-1", runId: "run-1" }), {
    status: 202,
    headers: { "content-type": "application/json" },
  });
}

describe("withIdempotency", () => {
  test("replays the original status and body instead of an empty object", async () => {
    const db = createTestDb();
    const c = contextWithKey("idempotency-key-123");
    let calls = 0;
    const produce = async () => {
      calls += 1;
      return okResponse();
    };

    const first = await withIdempotency(c, db, "user-1", produce);
    const second = await withIdempotency(c, db, "user-1", produce);

    expect(calls).toBe(1);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await second.json()) as unknown).toEqual({ uploadId: "upload-1", runId: "run-1" });
  });

  test("scopes the key to the user", async () => {
    const db = createTestDb();
    const c = contextWithKey("shared-key-123");
    let calls = 0;
    const produce = async () => {
      calls += 1;
      return okResponse();
    };

    await withIdempotency(c, db, "user-1", produce);
    await withIdempotency(c, db, "user-2", produce);

    expect(calls).toBe(2);
  });

  test("produces normally when no key is supplied", async () => {
    const db = createTestDb();
    const c = contextWithKey(null);
    let calls = 0;
    const produce = async () => {
      calls += 1;
      return okResponse();
    };

    await withIdempotency(c, db, "user-1", produce);
    await withIdempotency(c, db, "user-1", produce);

    expect(calls).toBe(2);
  });
});
