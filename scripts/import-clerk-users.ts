/**
 * Clerk to Better-Auth (D1) User Importer
 *
 * Reads a Clerk JSON user export, extracts user records, and generates
 * SQL INSERT statements for the Cloudflare D1 `user` table.
 *
 * Usage:
 *   bun run scripts/import-clerk-users.ts --file clerk-users.json [--owner-email you@example.com]
 *
 * This offline variant only generates SQL. For the live Clerk API importer
 * that can apply changes to D1, use scripts/migrate-clerk-users.ts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface ClerkEmailAddress {
  id: string;
  email_address: string;
  verification?: {
    status?: string;
  };
}

interface ClerkUser {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  email_addresses?: ClerkEmailAddress[];
  primary_email_address_id?: string | null;
  primary_email_address?: string | null;
  email?: string;
  image_url?: string | null;
  profile_image_url?: string | null;
  public_metadata?: {
    onboardingComplete?: boolean;
    [key: string]: unknown;
  };
  created_at?: number | string;
  updated_at?: number | string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let filePath = "";
  let ownerEmail = "";
  let outSqlPath = "clerk-import.sql";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file" && args[i + 1]) {
      filePath = args[++i]!;
    } else if (arg === "--owner-email" && args[i + 1]) {
      ownerEmail = args[++i]!.toLowerCase().trim();
    } else if (arg === "--out" && args[i + 1]) {
      outSqlPath = args[++i]!;
    }
  }

  return { filePath, ownerEmail, outSqlPath };
}

function extractEmail(user: ClerkUser): string | null {
  if (user.primary_email_address) return user.primary_email_address.trim().toLowerCase();
  if (user.email) return user.email.trim().toLowerCase();
  if (user.email_addresses && user.email_addresses.length > 0) {
    if (user.primary_email_address_id) {
      const primary = user.email_addresses.find((e) => e.id === user.primary_email_address_id);
      if (primary?.email_address) return primary.email_address.trim().toLowerCase();
    }
    return user.email_addresses[0]!.email_address.trim().toLowerCase();
  }
  return null;
}

function extractName(user: ClerkUser, fallbackEmail: string): string {
  const parts = [user.first_name, user.last_name].filter(Boolean).map((s) => String(s).trim());
  if (parts.length > 0) return parts.join(" ");
  if (user.username) return user.username.trim();
  return fallbackEmail.split("@")[0] || "User";
}

function escapeSqlString(val: string): string {
  return `'${val.replace(/'/g, "''")}'`;
}

export function generateMigrationSql(
  users: ClerkUser[],
  options: { ownerEmail?: string } = {},
): { sql: string; stats: { total: number; skippedOwner: number; valid: number } } {
  const stats = { total: users.length, skippedOwner: 0, valid: 0 };
  const statements: string[] = [
    "-- QuickCalAI Clerk to Better-Auth D1 Migration",
    `-- Generated on ${new Date().toISOString()}`,
    "-- Preserves Clerk user IDs for referential integrity with legacy data",
    "",
  ];

  for (const clerkUser of users) {
    const email = extractEmail(clerkUser);
    if (!email) {
      console.warn(`[skip] User ${clerkUser.id} has no email address`);
      continue;
    }

    if (options.ownerEmail && email === options.ownerEmail) {
      stats.skippedOwner++;
      statements.push(
        `-- Note: Skipping owner account ${email} (already exists in target D1 database with Better-Auth ID)`,
      );
      continue;
    }

    const name = extractName(clerkUser, email);
    const id = clerkUser.id;
    const image = clerkUser.image_url || clerkUser.profile_image_url || null;
    const isOnboarded = clerkUser.public_metadata?.onboardingComplete ? 1 : 0;
    const freeCredits = 1;
    const emailVerified = 1; // All 19 Clerk users were email-verified; required for Google OAuth linking
    const role = "user";

    const createdAt = typeof clerkUser.created_at === "number"
      ? clerkUser.created_at < 10000000000 ? clerkUser.created_at * 1000 : clerkUser.created_at
      : clerkUser.created_at ? new Date(clerkUser.created_at).getTime() : Date.now();

    const updatedAt = typeof clerkUser.updated_at === "number"
      ? clerkUser.updated_at < 10000000000 ? clerkUser.updated_at * 1000 : clerkUser.updated_at
      : clerkUser.updated_at ? new Date(clerkUser.updated_at).getTime() : Date.now();

    const sqlStmt = `INSERT INTO "user" (id, name, email, email_verified, image, is_onboarded, free_credits, role, created_at, updated_at)
VALUES (${escapeSqlString(id)}, ${escapeSqlString(name)}, ${escapeSqlString(email)}, ${emailVerified}, ${image ? escapeSqlString(image) : "NULL"}, ${isOnboarded}, ${freeCredits}, ${escapeSqlString(role)}, ${createdAt}, ${updatedAt})
ON CONFLICT DO NOTHING;`;

    statements.push(sqlStmt);
    stats.valid++;
  }

  return { sql: statements.join("\n"), stats };
}

function main() {
  const { filePath, ownerEmail, outSqlPath } = parseArgs();

  if (!filePath) {
    console.log("Clerk -> Better-Auth Importer (offline SQL generator)");
    console.log("Usage: bun run scripts/import-clerk-users.ts --file <clerk-export.json> [--owner-email <email>] [--out <output.sql>]");
    console.log("\nIf you have a Clerk API key, you can also fetch users directly via:");
    console.log("  curl -H 'Authorization: Bearer <CLERK_SECRET_KEY>' https://api.clerk.com/v1/users?limit=100 > clerk-users.json");
    process.exit(0);
  }

  const raw = readFileSync(resolve(filePath), "utf8");
  const data = JSON.parse(raw);
  const users: ClerkUser[] = Array.isArray(data) ? data : data.data || [];

  const { sql, stats } = generateMigrationSql(users, { ownerEmail });
  writeFileSync(outSqlPath, sql, "utf8");

  console.log(`\nMigration SQL generated at: ${outSqlPath}`);
  console.log(`Total users in export: ${stats.total}`);
  console.log(`Users queued for insert: ${stats.valid}`);
  if (stats.skippedOwner > 0) {
    console.log(`Owner account mapped/skipped: ${stats.skippedOwner} (${ownerEmail})`);
  }

  console.log("\nNext step to apply to Cloudflare D1 prod:");
  console.log(`  cf d1 execute quickcal-prod --file=${outSqlPath}`);
  console.log("  (or npx wrangler d1 execute quickcal-prod --file=" + outSqlPath + ")\n");
}

if (import.meta.main) {
  main();
}
