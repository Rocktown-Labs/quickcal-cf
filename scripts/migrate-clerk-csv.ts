#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

type Query = { sql: string; params?: (string | number | null)[] };
type Existing = { id: string; email: string; credentials?: number };
export type CsvUser = Record<string, string>;

export function readUsers(csv: string): CsvUser[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, bom: true }) as CsvUser[];
  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const row of rows) {
    const email = row.primary_email_address?.trim().toLowerCase();
    if (!row.id || !email || !email.includes("@")) throw new Error("Missing user ID or email");
    if (ids.has(row.id) || emails.has(email)) throw new Error("Duplicate CSV user ID or email");
    ids.add(row.id);
    emails.add(email);
    if (row.totp_secret)
      throw new Error("TOTP migration requires two-factor support; refusing to downgrade");
    if (
      row.password_digest &&
      (row.password_hasher !== "bcrypt" ||
        !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(row.password_digest))
    ) {
      throw new Error("Unsupported or malformed exported password hash");
    }
    if (!Number.isFinite(Date.parse(row.created_at!)))
      throw new Error("Invalid creation timestamp");
  }
  return rows;
}

export function planImport(rows: CsvUser[], existing: Existing[]) {
  const queries: Query[] = [];
  let skipped = 0;
  let credentials = 0;
  for (const row of rows) {
    const email = row.primary_email_address!.trim().toLowerCase();
    const matched = existing.find(
      (user) => user.id === row.id || user.email.toLowerCase() === email,
    );
    // Never attach legacy credentials to an independently created account.
    if (matched && (matched.id !== row.id || matched.email.toLowerCase() !== email)) {
      skipped++;
      continue;
    }
    const name =
      [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || email.split("@")[0]!;
    const verified = row
      .verified_email_addresses!.split(/[,;]/)
      .map((value) => value.trim().toLowerCase())
      .includes(email);
    const timestamp = Date.parse(row.created_at!);
    if (matched) skipped++;
    else
      queries.push({
        sql: `INSERT INTO user (id, name, email, email_verified, phone_number, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM user WHERE id = ? OR lower(email) = ?)`,
        params: [
          row.id!,
          name,
          email,
          Number(verified),
          row.primary_phone_number || null,
          timestamp,
          timestamp,
          row.id!,
          email,
        ],
      });
    if (matched && verified)
      queries.push({
        sql: "UPDATE user SET email_verified = 1 WHERE id = ? AND lower(email) = ? AND email_verified = 0",
        params: [row.id!, email],
      });
    if (row.password_digest && !matched?.credentials) {
      credentials++;
      queries.push({
        sql: `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
          SELECT ?, ?, 'credential', ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM user WHERE id = ? AND lower(email) = ?)
          AND NOT EXISTS (SELECT 1 FROM account WHERE user_id = ? AND provider_id = 'credential')`,
        params: [
          `clerk-credential-${row.id}`,
          row.id!,
          row.id!,
          row.password_digest,
          timestamp,
          timestamp,
          row.id!,
          email,
          row.id!,
        ],
      });
    }
  }
  return { queries, users: rows.length - skipped, skipped, credentials };
}

function cf(args: string[]) {
  const output = execFileSync("cf", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const result = JSON.parse(output);
  if (Array.isArray(result) && result.some((entry) => entry.success === false))
    throw new Error("D1 query failed");
  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "bun scripts/migrate-clerk-csv.ts --database <bound D1 UUID> [--file exported_users.csv] [--apply]",
    );
    return;
  }
  for (let i = 0; i < args.length; i++) {
    if (["--database", "--file"].includes(args[i]!)) {
      if (!args[++i] || args[i]!.startsWith("--")) throw new Error("Missing option value");
    } else if (!["--apply", "--dry-run"].includes(args[i]!))
      throw new Error(`Unknown option: ${args[i]}`);
  }
  const database = args[args.indexOf("--database") + 1];
  if (!args.includes("--database") || !database)
    throw new Error("Explicit --database UUID required; confirm the Worker's DB binding first");
  const file = args.includes("--file") ? args[args.indexOf("--file") + 1]! : "exported_users.csv";
  const rows = readUsers(readFileSync(file, "utf8"));
  const existing = cf([
    "d1",
    "query",
    database,
    "--sql",
    "SELECT u.id, lower(u.email) AS email, (SELECT count(*) FROM account a WHERE a.user_id = u.id AND a.provider_id = 'credential') AS credentials FROM user u",
  ])[0].results as Existing[];
  const plan = planImport(rows, existing);
  const dir = mkdtempSync(join(tmpdir(), "quickcal-clerk-csv-"));
  chmodSync(dir, 0o700);
  const batch = join(dir, "batch.json");
  writeFileSync(batch, JSON.stringify(plan.queries), { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        database,
        csvUsers: rows.length,
        usersToImport: plan.users,
        skippedExisting: plan.skipped,
        credentialsToImport: plan.credentials,
        batch,
      },
      null,
      2,
    ),
  );
  if (!args.includes("--apply") || args.includes("--dry-run")) return;
  if (plan.queries.length) cf(["d1", "query", database, "--batch", `@${batch}`]);
  const after = cf([
    "d1",
    "query",
    database,
    "--sql",
    "SELECT id, lower(email) AS email FROM user",
  ])[0].results as Existing[];
  if (
    rows.some(
      (row) =>
        !after.some((user) => user.email === row.primary_email_address!.trim().toLowerCase()),
    )
  )
    throw new Error("Post-import verification failed");
  console.log(`Verified all ${rows.length} CSV emails exist in D1. Announcement not sent.`);
}

if (import.meta.main) main();
