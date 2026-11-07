#!/usr/bin/env bun
/**
 * Import Clerk users into the QuickCalAI D1 database.
 *
 * Clerk user IDs are preserved so any legacy foreign keys stay valid. Existing
 * D1 users are matched by lowercased email and skipped, which keeps an account
 * that already signed up in the new app on its Better-Auth ID. Clerk's
 * per-address verification status is preserved: only verified addresses are
 * imported as verified, so an unverified address cannot be used to link a
 * Google account with the same email.
 *
 * Password hashes are never imported. Clerk does not expose them, and
 * Better-Auth creates a credential account the first time a user completes the
 * password reset flow.
 *
 * Usage:
 *   CLERK_SECRET_KEY=sk_... bun run migrate:clerk-users -- --dry-run
 *   CLERK_SECRET_KEY=sk_... bun run migrate:clerk-users -- --apply
 *
 * Options:
 *   --dry-run              Write the SQL/report and print a summary (default).
 *   --apply                Execute the generated SQL against the remote D1 DB.
 *   --database <name>      D1 database name. Defaults to D1_DATABASE_NAME or the
 *                          single production database discovered by Wrangler.
 *   --help                 Show this help.
 */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ClerkEmailAddress {
  id: string;
  email_address: string;
  verification?: { status?: string };
}

interface ClerkPhoneNumber {
  id: string;
  phone_number: string;
}

interface ClerkUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  image_url: string;
  primary_email_address_id: string | null;
  primary_phone_number_id: string | null;
  email_addresses: ClerkEmailAddress[];
  phone_numbers: ClerkPhoneNumber[];
  public_metadata?: { onboardingComplete?: boolean };
  created_at: number;
  updated_at: number;
}

interface ExistingUser {
  id: string;
  email: string;
}

interface ImportRow {
  id: string;
  name: string;
  email: string;
  /** Clerk's verification status, not an assumption. */
  emailVerified: number;
  image: string | null;
  phoneNumber: string | null;
  isOnboarded: number;
  createdAt: number;
  updatedAt: number;
}

interface SkippedUser {
  clerkId: string;
  email: string;
  reason: string;
}

interface Options {
  apply: boolean;
  database?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  let apply = false;
  let database: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--database") {
      database = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  return { apply, database, help };
}

function usage(): string {
  return `Import Clerk users into D1

  CLERK_SECRET_KEY=sk_... bun run migrate:clerk-users -- [options]

Options:
  --dry-run              Generate SQL and a report without writing to D1.
  --apply                Execute the generated SQL against remote D1.
  --database <name>      D1 database name. Defaults to D1_DATABASE_NAME or the
                         single production database Wrangler can see.
  --help                 Show this help.

The importer preserves Clerk IDs and Clerk's email-verification status, skips
emails that already exist in D1, and never imports password hashes. Unverified
addresses must complete the Better-Auth verification flow before they can link
to Google.`;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local?.slice(0, 1) ?? ""}***@${domain ?? ""}`;
}

function sqlString(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "NULL";
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlInt(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "NULL"
    : String(Math.trunc(value));
}

async function fetchClerkUsers(secretKey: string): Promise<ClerkUser[]> {
  const users: ClerkUser[] = [];
  const limit = 100;
  let offset = 0;

  while (true) {
    const response = await fetch(
      `https://api.clerk.com/v1/users?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );

    if (!response.ok) {
      throw new Error(`Clerk API returned ${response.status}: ${await response.text()}`);
    }

    const page = (await response.json()) as ClerkUser[];
    users.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return users;
}

async function runWrangler(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("bunx", ["wrangler", ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function resolveDatabase(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.D1_DATABASE_NAME) return process.env.D1_DATABASE_NAME;

  const output = await runWrangler(["d1", "list", "--json"]);
  const databases = JSON.parse(output) as Array<{ name: string }>;
  const production = databases.filter((db) => db.name.startsWith("quickcal-cf-database-prod"));

  if (production.length === 1) return production[0]!.name;

  throw new Error(
    "Could not pick a D1 database automatically. Pass --database <name> or set D1_DATABASE_NAME.",
  );
}

async function fetchExistingUsers(database: string): Promise<ExistingUser[]> {
  const output = await runWrangler([
    "d1",
    "execute",
    database,
    "--remote",
    "--json",
    "--command",
    "select id, lower(email) as email from user;",
  ]);
  const parsed = JSON.parse(output) as Array<{ results?: ExistingUser[] }>;
  return parsed[0]?.results ?? [];
}

function primaryEmail(user: ClerkUser): ClerkEmailAddress | undefined {
  return (
    user.email_addresses.find((email) => email.id === user.primary_email_address_id) ??
    user.email_addresses[0]
  );
}

function primaryPhone(user: ClerkUser): string | null {
  const phone =
    user.phone_numbers.find((entry) => entry.id === user.primary_phone_number_id) ??
    user.phone_numbers[0];
  return phone?.phone_number ?? null;
}

function displayName(user: ClerkUser, email: string): string {
  return (
    [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
    user.username ||
    email.split("@")[0] ||
    "QuickCalAI user"
  );
}

function buildSql(rows: ImportRow[]): string {
  if (rows.length === 0) return "";

  const values = rows
    .map(
      (row) =>
        `(${[
          sqlString(row.id),
          sqlString(row.name),
          sqlString(row.email),
          sqlInt(row.emailVerified),
          sqlString(row.image),
          "NULL", // stripe_customer_id
          sqlString(row.phoneNumber),
          "NULL", // use_case
          "NULL", // calendar_app
          "1", // free_credits
          "NULL", // cal_token
          sqlInt(row.isOnboarded),
          sqlString("user"),
          "0", // banned
          "NULL", // ban_reason
          "NULL", // ban_expires
          sqlInt(row.createdAt),
          sqlInt(row.updatedAt),
        ].join(", ")})`,
    )
    .join(",\n  ");

  return `INSERT INTO user (
  id, name, email, email_verified, image, stripe_customer_id, phone_number,
  use_case, calendar_app, free_credits, cal_token, is_onboarded, role, banned,
  ban_reason, ban_expires, created_at, updated_at
)
VALUES
  ${values}
ON CONFLICT DO NOTHING;
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    return;
  }

  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY is required.");
  }

  const database = await resolveDatabase(options.database);
  const [clerkUsers, existingUsers] = await Promise.all([
    fetchClerkUsers(secretKey),
    fetchExistingUsers(database),
  ]);

  const existingByEmail = new Map(
    existingUsers.map((user) => [user.email.trim().toLowerCase(), user.id]),
  );
  const existingIds = new Set(existingUsers.map((user) => user.id));

  const rows: ImportRow[] = [];
  const skipped: SkippedUser[] = [];

  for (const user of clerkUsers) {
    const emailAddress = primaryEmail(user);
    const email = emailAddress?.email_address?.trim().toLowerCase();

    if (!email) {
      skipped.push({ clerkId: user.id, email: "", reason: "no email address" });
      continue;
    }

    if (existingIds.has(user.id)) {
      skipped.push({ clerkId: user.id, email, reason: "Clerk ID already exists in D1" });
      continue;
    }

    const existingId = existingByEmail.get(email);
    if (existingId) {
      skipped.push({
        clerkId: user.id,
        email,
        reason: `email already belongs to D1 user ${existingId}`,
      });
      continue;
    }

    rows.push({
      id: user.id,
      name: displayName(user, email),
      email,
      // Only mark verified when Clerk says the address is verified. Marking
      // unverified addresses verified would let them link to a Google account
      // with the same address (Better-Auth's requireLocalEmailVerified gate).
      emailVerified: emailAddress?.verification?.status === "verified" ? 1 : 0,
      image: user.image_url || null,
      phoneNumber: primaryPhone(user),
      isOnboarded: user.public_metadata?.onboardingComplete === true ? 1 : 0,
      createdAt: user.created_at,
      updatedAt: user.updated_at || user.created_at,
    });
  }

  const sql = buildSql(rows);
  const workDir = await mkdtemp(join(tmpdir(), "quickcal-clerk-"));
  const sqlPath = join(workDir, "import.sql");
  const reportPath = join(workDir, "report.json");

  await writeFile(sqlPath, sql, { mode: 0o600 });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        database,
        clerkUsers: clerkUsers.length,
        importable: rows.length,
        skipped,
        imported: rows,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await chmod(workDir, 0o700).catch(() => undefined);

  console.log(`Database: ${database}`);
  console.log(`Clerk users: ${clerkUsers.length}`);
  console.log(`Already in D1: ${skipped.length}`);
  console.log(`Importable: ${rows.length}`);
  console.log(`SQL: ${sqlPath}`);
  console.log(`Full report: ${reportPath}`);

  if (skipped.length > 0) {
    console.log("\nSkipped:");
    for (const entry of skipped) {
      console.log(`  ${maskEmail(entry.email) || entry.clerkId}: ${entry.reason}`);
    }
  }

  if (!options.apply) {
    console.log("\nDry run only. Re-run with --apply to write these users to D1.");
    return;
  }

  if (rows.length === 0) {
    console.log("\nNothing to import.");
    return;
  }

  console.log("\nApplying...");
  const output = await runWrangler([
    "d1",
    "execute",
    database,
    "--remote",
    "--file",
    sqlPath,
  ]);
  console.log(output.trim());

  const after = await fetchExistingUsers(database);
  console.log(`\nD1 users now: ${after.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
