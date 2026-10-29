#!/usr/bin/env bun
/**
 * Send the QuickCalAI "what is new" announcement.
 *
 * The default is a dry run: it renders the email, writes an HTML/text preview,
 * and prints the recipient count without contacting Resend. Add --apply to send.
 *
 * Usage:
 *   RESEND_API_KEY=re_... bun run email:announcement -- --dry-run
 *   RESEND_API_KEY=re_... MAILING_ADDRESS="123 Main St" bun run email:announcement -- --apply
 *
 * Options:
 *   --dry-run                 Render a preview and print recipients (default).
 *   --apply                   Send the email through Resend.
 *   --to <email>              Send only to one address. Useful for a test send.
 *   --exclude <emails>        Comma-separated addresses to skip.
 *   --limit <n>               Send to the first n recipients.
 *   --database <name>         D1 database name. Defaults to D1_DATABASE_NAME or
 *                             the single production database Wrangler can see.
 *   --login-url <url>         CTA destination. Defaults to https://quickcalai.com/login.
 *   --from <address>          Sender. Defaults to RESEND_FROM_EMAIL or the
 *                             QuickCalAI sending address.
 *   --reply-to <address>      Reply-To address. Set this so replies reach you.
 *   --unsubscribe-url <url>   Unsubscribe link. Defaults to a mailto address.
 *   --mailing-address <text>  Required with --apply for CAN-SPAM compliance.
 *   --include-test            Include @example.com / @quickcalai.test accounts.
 *   --include-unverified      Include accounts whose email is not verified.
 *   --help                    Show this help.
 */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ANNOUNCEMENT_SUBJECT,
  renderAnnouncementEmail,
} from "../packages/email/src/index.ts";

const execFileAsync = promisify(execFile);

export interface Recipient {
  id: string;
  email: string;
  name: string;
  emailVerified: number;
  banned: number;
}

interface Options {
  apply: boolean;
  to?: string;
  exclude: string[];
  limit?: number;
  database?: string;
  loginUrl: string;
  from: string;
  replyTo?: string;
  senderName: string;
  unsubscribeUrl: string;
  mailingAddress?: string;
  includeTest: boolean;
  includeUnverified: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  let apply = false;
  let to: string | undefined;
  let exclude: string[] = [];
  let limit: number | undefined;
  let database: string | undefined;
  let loginUrl = process.env.ANNOUNCEMENT_LOGIN_URL?.trim() || "https://quickcalai.com/login";
  let from =
    process.env.RESEND_FROM_EMAIL?.trim() ||
    "QuickCalAI <noreply@extractions.quickcalai.com>";
  let replyTo = process.env.ANNOUNCEMENT_REPLY_TO?.trim();
  let senderName =
    process.env.ANNOUNCEMENT_SENDER_NAME?.trim() || "The QuickCalAI team";
  let unsubscribeUrl =
    process.env.ANNOUNCEMENT_UNSUBSCRIBE_URL?.trim() ||
    "mailto:unsubscribe@quickcalai.com?subject=Unsubscribe";
  let mailingAddress = process.env.MAILING_ADDRESS?.trim();
  let includeTest = false;
  let includeUnverified = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--to") {
      to = argv[i + 1];
      i += 1;
    } else if (arg === "--exclude") {
      exclude = (argv[i + 1] ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--limit") {
      limit = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--database") {
      database = argv[i + 1];
      i += 1;
    } else if (arg === "--login-url") {
      loginUrl = argv[i + 1] ?? loginUrl;
      i += 1;
    } else if (arg === "--from") {
      from = argv[i + 1] ?? from;
      i += 1;
    } else if (arg === "--reply-to") {
      replyTo = argv[i + 1] ?? replyTo;
      i += 1;
    } else if (arg === "--sender-name") {
      senderName = argv[i + 1] ?? senderName;
      i += 1;
    } else if (arg === "--unsubscribe-url") {
      unsubscribeUrl = argv[i + 1] ?? unsubscribeUrl;
      i += 1;
    } else if (arg === "--mailing-address") {
      mailingAddress = argv[i + 1];
      i += 1;
    } else if (arg === "--include-test") includeTest = true;
    else if (arg === "--include-unverified") includeUnverified = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  return {
    apply,
    to,
    exclude,
    limit,
    database,
    loginUrl,
    from,
    replyTo,
    senderName,
    unsubscribeUrl,
    mailingAddress,
    includeTest,
    includeUnverified,
    help,
  };
}

function usage(): string {
  return `Send the QuickCalAI announcement

  RESEND_API_KEY=re_... bun run email:announcement -- [options]

Options:
  --dry-run                 Render a preview and print recipients (default).
  --apply                   Send through Resend.
  --to <email>              Send only to one address.
  --exclude <emails>        Comma-separated addresses to skip.
  --limit <n>               Send to the first n recipients.
  --database <name>         D1 database name.
  --login-url <url>         CTA destination.
  --from <address>          Sender address.
  --reply-to <address>      Reply-To address. Set this so replies reach you.
  --sender-name <name>      Sign-off name. Defaults to "The QuickCalAI team".
  --unsubscribe-url <url>   Unsubscribe link.
  --mailing-address <text>  Required with --apply.
  --include-test            Include test accounts.
  --include-unverified      Include accounts whose email is not verified.
  --help                    Show this help.`;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local?.slice(0, 1) ?? ""}***@${domain ?? ""}`;
}

function isTestEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return (
    normalized.endsWith("@example.com") ||
    normalized.endsWith("@test.com") ||
    normalized.endsWith(".test") ||
    normalized.startsWith("test@") ||
    normalized.startsWith("testing@") ||
    normalized.startsWith("deploytest")
  );
}

export interface RecipientFilters {
  includeTest: boolean;
  includeUnverified: boolean;
  to?: string;
  exclude: string[];
  limit?: number;
}

/**
 * Pure recipient filtering, kept separate from the D1/Resend I/O so the
 * exclusion rules (banned, unverified, test, explicit to/exclude/limit) are
 * testable. Banned accounts are always excluded.
 */
export function filterRecipients(
  allRecipients: Recipient[],
  options: RecipientFilters,
): { recipients: Recipient[]; skippedBanned: number; skippedUnverified: number } {
  let recipients = allRecipients;
  const skippedBanned = recipients.filter((recipient) => recipient.banned).length;
  recipients = recipients.filter((recipient) => !recipient.banned);

  const skippedUnverified = recipients.filter((recipient) => !recipient.emailVerified).length;
  if (!options.includeUnverified) {
    recipients = recipients.filter((recipient) => recipient.emailVerified === 1);
  }
  if (!options.includeTest && !options.to) {
    recipients = recipients.filter((recipient) => !isTestEmail(recipient.email));
  }
  if (options.to) {
    const target = options.to.trim().toLowerCase();
    recipients = recipients.filter((recipient) => recipient.email.toLowerCase() === target);
  }
  if (options.exclude.length > 0) {
    const excluded = new Set(options.exclude);
    recipients = recipients.filter((recipient) => !excluded.has(recipient.email.toLowerCase()));
  }
  if (options.limit !== undefined) {
    recipients = recipients.slice(0, Math.max(0, options.limit));
  }

  return { recipients, skippedBanned, skippedUnverified };
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

async function fetchRecipients(database: string): Promise<Recipient[]> {
  const output = await runWrangler([
    "d1",
    "execute",
    database,
    "--remote",
    "--json",
    "--command",
    "select id, lower(email) as email, name, email_verified as emailVerified, banned from user order by created_at;",
  ]);
  const parsed = JSON.parse(output) as Array<{ results?: Recipient[] }>;
  return parsed[0]?.results ?? [];
}

async function sendEmail(input: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  unsubscribeUrl: string;
  idempotencyKey: string;
}): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      headers: {
        "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend returned ${response.status}: ${body}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.apply && !options.mailingAddress) {
    throw new Error(
      "A mailing address is required with --apply. Pass --mailing-address or set MAILING_ADDRESS.",
    );
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (options.apply && !apiKey) {
    throw new Error("RESEND_API_KEY is required with --apply.");
  }

  const database = await resolveDatabase(options.database);
  const allRecipients = await fetchRecipients(database);

  const { recipients, skippedBanned, skippedUnverified } = filterRecipients(
    allRecipients,
    options,
  );

  const previewRecipient = recipients[0];
  const workDir = await mkdtemp(join(tmpdir(), "quickcal-announcement-"));
  const htmlPath = join(workDir, "announcement.html");
  const textPath = join(workDir, "announcement.txt");

  if (previewRecipient) {
    const rendered = await renderAnnouncementEmail({
      firstName: previewRecipient.name.split(/\s+/)[0],
      senderName: options.senderName,
      loginUrl: options.loginUrl,
      unsubscribeUrl: options.unsubscribeUrl,
      mailingAddress: options.mailingAddress ?? "[mailing address]",
    });
    await writeFile(htmlPath, rendered.html, { mode: 0o600 });
    await writeFile(textPath, rendered.text, { mode: 0o600 });
    await chmod(workDir, 0o700).catch(() => undefined);
  }

  console.log(`Database: ${database}`);
  console.log(`Users in D1: ${allRecipients.length}`);
  console.log(`Skipped banned: ${skippedBanned}`);
  console.log(
    `Skipped unverified: ${skippedUnverified}${options.includeUnverified ? " (included by flag)" : ""}`,
  );
  console.log(`Recipients after filters: ${recipients.length}`);
  console.log(`Subject: ${ANNOUNCEMENT_SUBJECT}`);
  console.log(`Preview: ${htmlPath}`);
  console.log(`Plain text: ${textPath}`);

  if (recipients.length > 0) {
    console.log("\nRecipients:");
    for (const recipient of recipients) {
      console.log(`  ${maskEmail(recipient.email)}`);
    }
  }

  if (!options.apply) {
    console.log(
      "\nDry run only. Confirm the login URL and mailing address, then re-run with --apply.",
    );
    return;
  }

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is required with --apply.");
  }

  if (options.loginUrl.includes("workers.dev")) {
    console.log(
      "\nWarning: the login URL points at a workers.dev host. Confirm that is intentional before sending.",
    );
  } else {
    console.log(
      "\nConfirm quickcalai.com points at the new app before sending. This script cannot verify DNS.",
    );
  }

  if (!options.replyTo) {
    console.log(
      "Tip: pass --reply-to <address> so replies reach a real inbox instead of the noreply sender.",
    );
  }

  let sent = 0;
  let failed = 0;
  const failures: string[] = [];
  const stamp = new Date().toISOString().slice(0, 10);

  for (const recipient of recipients) {
    const firstName = recipient.name.split(/\s+/)[0];
    const rendered = await renderAnnouncementEmail({
      firstName,
      senderName: options.senderName,
      loginUrl: options.loginUrl,
      unsubscribeUrl: options.unsubscribeUrl,
      mailingAddress: options.mailingAddress,
    });

    try {
      await sendEmail({
        apiKey,
        from: options.from,
        to: recipient.email,
        subject: ANNOUNCEMENT_SUBJECT,
        html: rendered.html,
        text: rendered.text,
        replyTo: options.replyTo,
        unsubscribeUrl: options.unsubscribeUrl,
        idempotencyKey: `quickcal-announcement-${stamp}-${recipient.id}`,
      });
      sent += 1;
      console.log(`  sent ${maskEmail(recipient.email)}`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${maskEmail(recipient.email)}: ${message}`);
      console.error(`  failed ${maskEmail(recipient.email)}: ${message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(`\nSent: ${sent}`);
  console.log(`Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`  ${failure}`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
