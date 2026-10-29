import { describe, expect, test } from "bun:test";
import { filterRecipients, type Recipient } from "./send-announcement";

const recipients: Recipient[] = [
  { id: "1", email: "verified@acme.io", name: "Verified", emailVerified: 1, banned: 0 },
  { id: "2", email: "unverified@acme.io", name: "Unverified", emailVerified: 0, banned: 0 },
  { id: "3", email: "banned@acme.io", name: "Banned", emailVerified: 1, banned: 1 },
  { id: "4", email: "test@example.com", name: "Test", emailVerified: 1, banned: 0 },
  { id: "5", email: "second@acme.io", name: "Second", emailVerified: 1, banned: 0 },
];

const base = { includeTest: false, includeUnverified: false, exclude: [] as string[] };

describe("announcement recipient filters", () => {
  test("excludes banned, unverified, and test accounts by default", () => {
    const result = filterRecipients(recipients, base);
    expect(result.recipients.map((recipient) => recipient.email)).toEqual([
      "verified@acme.io",
      "second@acme.io",
    ]);
    expect(result.skippedBanned).toBe(1);
    expect(result.skippedUnverified).toBe(1);
  });

  test("can include unverified accounts explicitly", () => {
    const result = filterRecipients(recipients, { ...base, includeUnverified: true });
    expect(result.recipients.map((recipient) => recipient.email)).toContain(
      "unverified@acme.io",
    );
    expect(result.recipients.map((recipient) => recipient.email)).not.toContain(
      "banned@acme.io",
    );
  });

  test("can include test accounts explicitly", () => {
    const result = filterRecipients(recipients, { ...base, includeTest: true });
    expect(result.recipients.map((recipient) => recipient.email)).toContain("test@example.com");
  });

  test("a --to target bypasses the test-account filter for a deliberate test send", () => {
    const result = filterRecipients(recipients, { ...base, to: "test@example.com" });
    expect(result.recipients.map((recipient) => recipient.email)).toEqual(["test@example.com"]);
  });

  test("supports exclude and limit", () => {
    const result = filterRecipients(recipients, {
      ...base,
      exclude: ["second@acme.io"],
      limit: 1,
    });
    expect(result.recipients.map((recipient) => recipient.email)).toEqual([
      "verified@acme.io",
    ]);
  });
});
