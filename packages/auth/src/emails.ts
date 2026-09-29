import { Resend } from "resend";

export interface AuthEmailConfig {
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  /** Deployed web origin (CORS_ORIGIN) — links in emails land on the app. */
  WEB_ORIGIN: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shell(inner: string): string {
  return `<!doctype html><html><body style="margin:0;background:#0a0a0a;font-family:sans-serif;padding:32px 0;">
<div style="max-width:600px;margin:0 auto;background:#161616;border-radius:12px;overflow:hidden;">
<div style="background:#c23326;padding:24px 32px;color:#fff;font-size:24px;font-weight:bold;">QuickCalAI</div>
<div style="padding:32px;">${inner}</div>
<div style="padding:24px 32px;border-top:1px solid #333;"><p style="color:#666;font-size:12px;text-align:center;margin:0;">QuickCalAI · Making schedule sharing effortless</p></div>
</div></body></html>`;
}

function button(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" style="display:inline-block;background:#c23326;color:#fff;font-weight:bold;padding:12px 24px;border-radius:8px;text-decoration:none;">${label}</a>`;
}

/**
 * Sends transactional auth emails (verification / password reset) through
 * Resend. Returns true when the email was sent; when no API key is
 * configured it returns false so callers can decide how to degrade.
 */
export async function sendAuthEmail(
  config: AuthEmailConfig,
  input: {
    to: string;
    subject: string;
    heading: string;
    bodyHtml: string;
    actionUrl: string;
    actionLabel: string;
    fallbackNote: string;
  },
): Promise<boolean> {
  const apiKey = config.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return false;
  }

  const from =
    config.RESEND_FROM_EMAIL?.trim() || "QuickCalAI <noreply@extractions.quickcalai.com>";

  const html = shell(`
    <h1 style="color:#efefef;font-size:20px;margin:0 0 16px;">${input.heading}</h1>
    <p style="color:#888;font-size:16px;">${input.bodyHtml}</p>
    <p>${button(input.actionUrl, input.actionLabel)}</p>
    <p style="color:#888;font-size:14px;">${input.fallbackNote}</p>
    <p style="color:#666;font-size:12px;">Or paste this link into your browser:<br />
    <a href="${escapeHtml(input.actionUrl)}" style="color:#c23326;word-break:break-all;">${escapeHtml(input.actionUrl)}</a></p>
  `);

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: input.to,
    subject: input.subject,
    html,
  });

  if (error) {
    throw new Error(`Failed to send email: ${error.message}`);
  }
  return true;
}
