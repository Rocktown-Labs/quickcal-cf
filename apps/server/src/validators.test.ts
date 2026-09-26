import { describe, expect, test } from "bun:test";
import {
  MAX_UPLOAD_FILE_SIZE_BYTES,
  createApiKeySchema,
  isValidTimeZone,
  manualEventSchema,
  uploadMimeTypes,
} from "./lib/validators";
import { normalizePhoneNumber } from "./lib/notify-helpers";

describe("upload constraints", () => {
  test("caps files at 10MB", () => {
    expect(MAX_UPLOAD_FILE_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });

  test("allows pdf and common images only", () => {
    expect([...uploadMimeTypes]).toEqual([
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });
});

describe("isValidTimeZone", () => {
  test("accepts IANA zones and rejects garbage", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("manualEventSchema", () => {
  test("accepts a full event", () => {
    const parsed = manualEventSchema.parse({
      title: "Dentist",
      date: "2026-11-05",
      time: "08:15",
      description: "Cleaning",
      timezone: "America/Chicago",
    });
    expect(parsed.title).toBe("Dentist");
  });

  test("defaults optional fields", () => {
    const parsed = manualEventSchema.parse({
      title: "Lunch",
      date: "2026-11-05",
    });
    expect(parsed.time).toBe("");
    expect(parsed.description).toBe("");
    expect(parsed.timezone).toBeUndefined();
  });

  test("rejects bad date, time, and timezone", () => {
    expect(() =>
      manualEventSchema.parse({ title: "x", date: "11/05/2026" }),
    ).toThrow();
    expect(() =>
      manualEventSchema.parse({ title: "x", date: "2026-11-05", time: "25:99" }),
    ).toThrow();
    expect(() =>
      manualEventSchema.parse({
        title: "x",
        date: "2026-11-05",
        timezone: "Mars/Olympus",
      }),
    ).toThrow();
    expect(() => manualEventSchema.parse({ title: "", date: "2026-11-05" })).toThrow();
  });
});

describe("normalizePhoneNumber", () => {
  test("strips formatting and keeps E.164", () => {
    expect(normalizePhoneNumber("+1 (555) 123-4567")).toBe("+15551234567");
  });

  test("rejects non-international numbers", () => {
    expect(() => normalizePhoneNumber("555-1234")).toThrow();
    expect(() => normalizePhoneNumber("")).toThrow();
  });
});

describe("createApiKeySchema", () => {
  test("accepts name-only and bounded expiry", () => {
    expect(createApiKeySchema.parse({ name: "agent" }).expiresInDays).toBeUndefined();
    expect(
      createApiKeySchema.parse({ name: "agent", expiresInDays: 30 }).expiresInDays,
    ).toBe(30);
  });

  test("rejects empty names and out-of-range expiry", () => {
    expect(() => createApiKeySchema.parse({ name: "" })).toThrow();
    expect(() => createApiKeySchema.parse({ name: "a", expiresInDays: 0 })).toThrow();
    expect(() => createApiKeySchema.parse({ name: "a", expiresInDays: 366 })).toThrow();
  });
});
