import { sha256Hex } from "./notify-helpers";

/**
 * Per-user webhook signing secret, deterministically derived from the
 * server secret — stable across deploys, no extra DB column, and safe to
 * expose to the account owner (it only verifies their own callbacks).
 *
 * Agents verify with: HMAC-SHA256(secret, `${ts}.${body}`).
 */
export function webhookSecretFor(serverSecret: string, userId: string): Promise<string> {
  return sha256Hex(`webhook:${serverSecret}:${userId}`);
}

export interface WebhookPayload {
  event: "upload.completed" | "upload.no_events" | "upload.failed";
  uploadId: string;
  status: "completed" | "no_events" | "failed";
  eventCount: number;
  failureReason?: string | null;
  shareToken?: string | null;
  downloadPath?: string | null;
  sentAt: string;
}

/**
 * Sends a signed webhook. `t=<unix-seconds>,v1=<hex>` header format matches
 * Stripe/GitHub conventions. Any failure throws — workflow steps retry, which
 * is exactly the durability we want for agent callbacks.
 */
export async function sendWebhook(
  callbackUrl: string,
  secret: string,
  payload: WebhookPayload,
): Promise<void> {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const signature = await hmacSha256Hex(secret, `${ts}.${body}`);

  const res = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "QuickCalAI-Webhooks/1.0",
      "X-QuickCal-Event": payload.event,
      "X-QuickCal-Signature": `t=${ts},v1=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Webhook target responded ${res.status}`);
  }
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
