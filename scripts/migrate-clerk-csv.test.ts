import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { planImport, readUsers } from "./migrate-clerk-csv";

const csv = `id,first_name,last_name,primary_email_address,verified_email_addresses,password_digest,password_hasher,created_at
user_one,"O'Neil, Pat",Smith,pat@example.com,other@example.com,,,2025-11-20T00:43:21Z
user_two,Test,User,test@example.com,test@example.com,,,2025-11-20T00:43:21Z`;

test("handles quoted CSV and verifies the primary address specifically", () => {
  const rows = readUsers(csv);
  const plan = planImport(rows, []);
  expect(rows[0]!.first_name).toBe("O'Neil, Pat");
  expect(plan.queries[0]!.params![3]).toBe(0);
  expect(plan.queries[1]!.params![3]).toBe(1);
});

test("skips existing accounts and generated SQL is rerunnable", () => {
  const rows = readUsers(csv);
  expect(planImport(rows, [{ id: "new-id", email: "PAT@example.com" }]).users).toBe(1);
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, email_verified INTEGER, phone_number TEXT, created_at INTEGER, updated_at INTEGER)",
  );
  const plan = planImport(rows, []);
  for (let i = 0; i < 2; i++)
    for (const query of plan.queries) db.query(query.sql).run(...query.params!);
  expect(db.query("SELECT count(*) AS n FROM user").get()).toEqual({ n: 2 });
  db.close();
});

test("refuses unsupported passwords and TOTP downgrades", () => {
  expect(() => readUsers(csv.replace(",,,2025", ",digest,argon2,2025"))).toThrow();
  expect(() =>
    readUsers(
      csv.replace("created_at", "totp_secret,created_at").replace(",,,2025", ",,,secret,2025"),
    ),
  ).toThrow();
});

test("backfills a missing credential once without overwriting an existing password", () => {
  const row = { ...readUsers(csv)[0]!, password_digest: "exported-hash" };
  const db = new Database(":memory:");
  db.run("CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, email_verified INTEGER)");
  db.run(
    "CREATE TABLE account (id TEXT PRIMARY KEY, account_id TEXT, provider_id TEXT, user_id TEXT, password TEXT, created_at INTEGER, updated_at INTEGER)",
  );
  db.run("INSERT INTO user VALUES (?, ?, 0)", [row.id!, row.primary_email_address!]);
  const existing = [{ id: row.id!, email: row.primary_email_address!, credentials: 0 }];
  const plan = planImport([row], existing);
  expect(plan.users).toBe(0);
  expect(plan.credentials).toBe(1);
  for (let i = 0; i < 2; i++)
    for (const query of plan.queries) db.query(query.sql).run(...query.params!);
  expect(db.query("SELECT count(*) AS n FROM account").get()).toEqual({ n: 1 });
  db.run("UPDATE account SET password = 'new-password'");
  for (const query of plan.queries) db.query(query.sql).run(...query.params!);
  expect(db.query("SELECT password FROM account").get()).toEqual({ password: "new-password" });
  expect(planImport([row], [{ ...existing[0]!, credentials: 1 }]).credentials).toBe(0);
  db.close();
});
