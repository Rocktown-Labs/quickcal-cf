import SentDm from "@sentdm/sentdm";
import { Resend } from "resend";
import { ENV } from "../env.server";
import { NotificationConfigurationError, normalizePhoneNumber, sha256Hex } from "./notify-helpers";

export { NotificationConfigurationError, NotificationInputError } from "./notify-helpers";

function envRecord(): Record<string, string | undefined> {
  return ENV as unknown as Record<string, string | undefined>;
}

function requireEnv(name: string): string {
  const value = envRecord()[name]?.trim();

  if (!value) {
    throw new NotificationConfigurationError(`${name} is not configured`);
  }

  return value;
}

function getResendClient() {
  return new Resend(requireEnv("RESEND_API_KEY"));
}

function getSentClient() {
  return new SentDm({
    apiKey: requireEnv("SENT_DM_API_KEY"),
    maxRetries: 2,
    timeout: 30_000,
  });
}

function getFromEmail() {
  return envRecord().RESEND_FROM_EMAIL?.trim() || "QuickCalAI <noreply@extractions.quickcalai.com>";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function calendarReadyHtml(input: {
  fileName: string;
  eventCount: number;
  shareUrl?: string;
  icsUrl?: string;
}): string {
  const displayName = escapeHtml(input.fileName.replace(/\.[^/.]+$/, ""));
  const eventWord = input.eventCount === 1 ? "event" : "events";
  const shareBlock = input.shareUrl
    ? `<p><a href="${escapeHtml(input.shareUrl)}" style="display:inline-block;background:#c23326;color:#fff;font-weight:bold;padding:12px 24px;border-radius:8px;text-decoration:none;">View Shared Schedule</a></p>
       <p style="color:#888;font-size:14px;">Send this link so others can view and download the calendar without signing up.</p>`
    : "";
  const icsBlock = input.icsUrl
    ? `<p><a href="${escapeHtml(input.icsUrl)}" style="display:inline-block;background:#212121;border:1px solid #333;color:#efefef;font-weight:bold;padding:12px 24px;border-radius:8px;text-decoration:none;">Download .ics File</a></p>`
    : "";

  return `<!doctype html><html><body style="margin:0;background:#0a0a0a;font-family:sans-serif;padding:32px 0;">
<div style="max-width:600px;margin:0 auto;background:#161616;border-radius:12px;overflow:hidden;">
<div style="background:#c23326;padding:24px 32px;color:#fff;font-size:24px;font-weight:bold;">QuickCalAI</div>
<div style="padding:32px;">
<h1 style="color:#efefef;font-size:20px;margin:0 0 16px;">Your calendar is ready!</h1>
<p style="color:#888;font-size:16px;">We found <strong style="color:#efefef;">${input.eventCount} ${eventWord}</strong> in <strong style="color:#efefef;">${displayName}</strong>.</p>
${shareBlock}${icsBlock}
<p style="color:#888;font-size:14px;">Import the .ics file into Google Calendar, Outlook, Apple Calendar, or any app that supports calendar files.</p>
</div>
<div style="padding:24px 32px;border-top:1px solid #333;"><p style="color:#666;font-size:12px;text-align:center;margin:0;">QuickCalAI · Making schedule sharing effortless</p></div>
</div></body></html>`;
}

export async function sendCalendarFileEmail(input: {
  uploadId: string;
  userId: string;
  to: string;
  fileName: string;
  icsUrl: string;
  eventCount?: number;
  shareUrl?: string;
}) {
  const resend = getResendClient();
  const from = getFromEmail();

  const { data, error } = await resend.emails.send(
    {
      from,
      to: input.to,
      subject: `Your calendar from ${input.fileName.replace(/\.[^/.]+$/, "")} is ready`,
      html: calendarReadyHtml({
        fileName: input.fileName,
        eventCount: input.eventCount ?? 0,
        shareUrl: input.shareUrl,
        icsUrl: input.icsUrl,
      }),
    },
    {
      // Include the recipient in the key so sending the same upload to a
      // different address isn't (incorrectly) deduped by Resend.
      idempotencyKey: `calendar-file/${await sha256Hex(`${input.userId}:${input.uploadId}:${input.to}`)}`,
    },
  );

  if (error) {
    throw new Error(`Failed to send calendar file email: ${error.message}`);
  }

  return data;
}

export async function sendCalendarFileSms(input: {
  uploadId: string;
  userId: string;
  to: string;
  icsUrl: string;
}) {
  const phoneNumber = normalizePhoneNumber(input.to);
  const sent = getSentClient();

  const response = await sent.messages.send({
    to: [phoneNumber],
    channel: ["sms"],
    text: `Your QuickCalAI calendar is ready. Download your .ics file: ${input.icsUrl}`,
    "Idempotency-Key": `calendar-file-${input.userId}-${input.uploadId}-${phoneNumber.slice(1)}`,
  });

  return response.data;
}
