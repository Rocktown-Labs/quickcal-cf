import SentDm from "@sentdm/sentdm";
import { Resend } from "resend";
import { renderProcessingCompleteEmail } from "@quickcal-cf/email";
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
  const { html, text } = await renderProcessingCompleteEmail({
    fileName: input.fileName,
    eventCount: input.eventCount ?? 0,
    shareUrl: input.shareUrl,
    icsUrl: input.icsUrl,
  });

  // The filename is client-controlled. Strip CR/LF so it can never inject
  // headers into the provider request, and cap it for readability.
  const subjectName = input.fileName
    .replace(/\.[^/.]+$/, "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 120);

  const { data, error } = await resend.emails.send(
    {
      from,
      to: input.to,
      subject: `Your calendar from ${subjectName || "your upload"} is ready`,
      html,
      text,
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

/**
 * Automatic "your calendar is ready" notification sent after a web upload
 * completes. Delivery to a user-specified address still goes through
 * sendCalendarFileEmail from the delivery route.
 */
export async function sendProcessingCompleteEmail(input: {
  uploadId: string;
  userId: string;
  to: string;
  fileName: string;
  eventCount: number;
  shareUrl?: string;
  icsUrl: string;
}) {
  return sendCalendarFileEmail(input);
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
