export class NotificationConfigurationError extends Error {}
export class NotificationInputError extends Error {}

export function normalizePhoneNumber(phoneNumber: string) {
  const normalized = phoneNumber.trim().replace(/[()\s-]/g, "");

  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) {
    throw new NotificationInputError(
      "Phone number must be in international format, for example +15551234567",
    );
  }

  return normalized;
}
