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

export class WebhookDeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Sends a signed webhook. `t=<unix-seconds>,v1=<hex>` header format matches
 * Stripe/GitHub conventions.
 *
 * Transient failures (5xx/408/429/network) throw so the workflow retries.
 * Permanent 4xx failures are logged and returned as `delivered: false` so a
 * misconfigured endpoint doesn't burn five retries with backoff.
 */
export async function sendWebhook(
  callbackUrl: string,
  secret: string,
  payload: WebhookPayload,
): Promise<{ delivered: boolean; status?: number }> {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const signature = await hmacSha256Hex(secret, `${ts}.${body}`);

  const res = await fetch(callbackUrl, {
    method: "POST",
    // Never follow redirects: a validated https callback could otherwise
    // bounce the signed payload to http:// or an internal address. A 3xx is
    // treated as a delivery failure and retried/abandoned by the workflow.
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "QuickCalAI-Webhooks/1.0",
      "X-QuickCal-Event": payload.event,
      // Stable per terminal outcome so receivers can dedupe retries.
      "X-QuickCal-Delivery": `${payload.uploadId}:${payload.status}`,
      "X-QuickCal-Signature": `t=${ts},v1=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    const message = `Webhook target responded ${res.status}${detail ? `: ${detail}` : ""}`;
    if (!retryable) {
      console.warn(`[webhook] permanent delivery failure (${res.status}): ${callbackUrl}`);
      return { delivered: false, status: res.status };
    }
    throw new WebhookDeliveryError(message, res.status, true);
  }

  return { delivered: true, status: res.status };
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
