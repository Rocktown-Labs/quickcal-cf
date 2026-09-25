import { describe, expect, test } from "bun:test";
import {
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
} from "./queries/apikeys";
import { generateShareToken } from "./queries/uploads";

describe("generateApiKey", () => {
  test("has the qc_ prefix and is URL-safe", () => {
    const key = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key).toMatch(/^qc_[A-Za-z0-9_-]+$/);
    expect(key.length).toBeGreaterThan(30);
  });

  test("generates unique keys", () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey()));
    expect(keys.size).toBe(100);
  });
});

describe("hashApiKey", () => {
  test("is deterministic and hex sha256", async () => {
    const key = generateApiKey();
    const a = await hashApiKey(key);
    const b = await hashApiKey(key);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("differs per key", async () => {
    expect(await hashApiKey(generateApiKey())).not.toBe(
      await hashApiKey(generateApiKey()),
    );
  });
});

describe("generateShareToken", () => {
  test("is short, URL-safe, and unique", () => {
    const tokens = new Set(
      Array.from({ length: 100 }, () => generateShareToken()),
    );
    expect(tokens.size).toBe(100);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
