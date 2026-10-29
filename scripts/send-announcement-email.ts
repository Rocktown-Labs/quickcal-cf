/**
 * Announcement Email Dispatcher
 *
 * Sends the "QuickCalAI is rebuilt and agent-ready" email to migrated users.
 * Supports dry-run verification, single test-recipient sends, and rate-limited batch sends.
 *
 * Usage:
 *   # 1. Preview / Dry Run
 *   bun run scripts/send-announcement-email.ts --file clerk-users.json
 *
 *   # 2. Send single test email to your own inbox
 *   bun run scripts/send-announcement-email.ts --test-recipient you@example.com --send
 *
 *   # 3. Send to all migrated users
 *   bun run scripts/send-announcement-email.ts --file clerk-users.json --send
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderAnnouncementEmail, ANNOUNCEMENT_SUBJECT } from "../packages/email/src/index";

async function getResendClient(apiKey: string) {
  let ResendClass: any;
  try {
    const mod = await import("resend");
    ResendClass = mod.Resend || mod.default?.Resend || mod.default;
  } catch {
    const mod = await import("../apps/server/node_modules/resend" as string);
    ResendClass = mod.Resend || mod.default?.Resend || mod.default;
  }
  return new ResendClass(apiKey);
}

interface ClerkUser {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  email_addresses?: Array<{ id: string; email_address: string }>;
  primary_email_address_id?: string | null;
  primary_email_address?: string | null;
  email?: string;
}

interface Recipient {
  email: string;
  firstName?: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let filePath = "";
  let send = false;
  let testRecipient = "";
  let senderName = "Rocktown Labs";
  let loginUrl = "https://quickcalai.com/login";
  let mailingAddress = "";
  let limit = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file" && args[i + 1]) {
      filePath = args[++i]!;
    } else if (arg === "--send") {
      send = true;
    } else if (arg === "--test-recipient" && args[i + 1]) {
      testRecipient = args[++i]!;
    } else if (arg === "--sender-name" && args[i + 1]) {
      senderName = args[++i]!;
    } else if (arg === "--login-url" && args[i + 1]) {
      loginUrl = args[++i]!;
    } else if (arg === "--address" && args[i + 1]) {
      mailingAddress = args[++i]!;
    } else if (arg === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i]!, 10);
    }
  }

  return { filePath, send, testRecipient, senderName, loginUrl, mailingAddress, limit };
}

function extractRecipients(data: unknown): Recipient[] {
  const users: ClerkUser[] = Array.isArray(data)
    ? data
    : (data as { data?: ClerkUser[] })?.data || [];

  const recipients: Recipient[] = [];
  const seen = new Set<string>();

  for (const u of users) {
    let email = u.primary_email_address || u.email;
    if (!email && u.email_addresses && u.email_addresses.length > 0) {
      if (u.primary_email_address_id) {
        const primary = u.email_addresses.find((e) => e.id === u.primary_email_address_id);
        if (primary) email = primary.email_address;
      }
      if (!email) email = u.email_addresses[0]?.email_address;
    }

    if (!email) continue;
    email = email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);

    recipients.push({
      email,
      firstName: u.first_name || u.username || undefined,
    });
  }

  return recipients;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { filePath, send, testRecipient, senderName, loginUrl, mailingAddress, limit } = parseArgs();

  let recipients: Recipient[] = [];

  if (testRecipient) {
    recipients = [{ email: testRecipient.trim().toLowerCase(), firstName: "Tester" }];
  } else if (filePath) {
    const raw = readFileSync(resolve(filePath), "utf8");
    const json = JSON.parse(raw);
    recipients = extractRecipients(json);
  } else {
    console.log("Announcement Email Sender");
    console.log("Usage:");
    console.log("  bun run scripts/send-announcement-email.ts --file <clerk-users.json> [--send] [--sender-name 'Your Name, Rocktown Labs']");
    console.log("  bun run scripts/send-announcement-email.ts --test-recipient user@example.com [--send]");
    process.exit(0);
  }

  if (limit > 0) {
    recipients = recipients.slice(0, limit);
  }

  console.log(`\nFound ${recipients.length} recipient(s).`);
  console.log(`Mode: ${send ? "LIVE SEND" : "DRY RUN (no emails sent)"}`);
  console.log(`Subject: ${ANNOUNCEMENT_SUBJECT}`);
  console.log(`Login URL: ${loginUrl}`);
  console.log(`Sender: ${senderName}`);

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const fromEmail = process.env.RESEND_FROM_EMAIL?.trim() || "QuickCalAI <noreply@extractions.quickcalai.com>";

  if (send && !apiKey) {
    console.error("\nError: RESEND_API_KEY environment variable is required to send emails.");
    process.exit(1);
  }

  if (send && !mailingAddress) {
    console.error(
      "\nError: --address is required when sending. CAN-SPAM requires a physical mailing address.",
    );
    process.exit(1);
  }

  const resend = send && apiKey ? await getResendClient(apiKey) : null;

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i]!;
    const unsubscribeUrl = `mailto:unsubscribe@quickcalai.com?subject=Unsubscribe%20${encodeURIComponent(r.email)}`;

    const { html, text } = await renderAnnouncementEmail({
      firstName: r.firstName,
      senderName,
      loginUrl,
      unsubscribeUrl,
      mailingAddress: mailingAddress || undefined,
    });

    if (!send) {
      console.log(`[DRY RUN] ${i + 1}/${recipients.length}: Would send to ${r.email} (${r.firstName || "no name"})`);
      if (i === 0) {
        console.log("\n--- Preview Text Sample ---");
        console.log(text.slice(0, 300) + "...\n---------------------------");
      }
    } else if (resend) {
      try {
        const res = await resend.emails.send({
          from: fromEmail,
          to: r.email,
          subject: ANNOUNCEMENT_SUBJECT,
          html,
          text,
          replyTo: process.env.ANNOUNCEMENT_REPLY_TO?.trim() || undefined,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
          },
        });

        if (res.error) {
          console.error(`[ERROR] Failed to send to ${r.email}: ${res.error.message}`);
        } else {
          console.log(`[SENT] ${i + 1}/${recipients.length}: Sent to ${r.email} (id: ${res.data?.id})`);
        }
      } catch (err) {
        console.error(`[FAIL] Exception sending to ${r.email}:`, err);
      }

      // 250ms spacing between sends to avoid any provider burst rate limit
      await sleep(250);
    }
  }

  console.log("\nFinished.");
}

if (import.meta.main) {
  main().catch(console.error);
}
