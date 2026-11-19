import { describe, expect, test } from "bun:test";
import { normalizeEmail, normalizePhoneNumber } from "./notify-helpers";

describe("normalizeEmail", () => {
  test("trims and lowercases the address", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  test("rejects empty, malformed, and overlong addresses", () => {
    expect(() => normalizeEmail("")).toThrow("valid email");
    expect(() => normalizeEmail("not-an-email")).toThrow("valid email");
    expect(() => normalizeEmail(`${"a".repeat(250)}@example.com`)).toThrow("valid email");
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
