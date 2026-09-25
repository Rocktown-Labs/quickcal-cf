import { z } from "@hono/zod-openapi";

export const MAX_UPLOAD_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const uploadMimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

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
