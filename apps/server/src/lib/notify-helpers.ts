export class NotificationConfigurationError extends Error {}
export class NotificationInputError extends Error {}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizePhoneNumber(phoneNumber: string) {
  const normalized = phoneNumber.trim().replace(/[()\s-]/g, "");

  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) {
    throw new NotificationInputError(
      "Phone number must be in international format, for example +15551234567",
    );
  }

  return normalized;
}
