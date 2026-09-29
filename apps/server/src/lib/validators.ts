import { z } from "@hono/zod-openapi";

export const MAX_UPLOAD_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const uploadMimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/**
 * Detects the real content type from magic bytes so we never trust the
 * client-supplied Content-Type. Returns null for unknown signatures.
 */
export function detectMimeType(data: Uint8Array): string | null {
  if (data.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }

  // PDF: %PDF- (25 50 44 46 2D)
  if (
    data[0] === 0x25 &&
    data[1] === 0x50 &&
    data[2] === 0x44 &&
    data[3] === 0x46 &&
    data[4] === 0x2d
  ) {
    return "application/pdf";
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

export function isValidTimeZone(value: string) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const manualEventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  time: z
    .string()
    .trim()
    .regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/, "Time must be in HH:MM 24-hour format")
    .optional()
    .default(""),
  description: z.string().trim().max(2000).optional().default(""),
  timezone: z.string().trim().refine(isValidTimeZone, "Invalid IANA timezone").optional(),
});

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
