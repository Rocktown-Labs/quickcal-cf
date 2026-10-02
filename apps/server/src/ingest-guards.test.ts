import { describe, expect, test } from "bun:test";
import { assertFetchableUrl, IngestUrlError } from "./lib/fetch-document";
import { validateCallbackUrl } from "./lib/ingest";

describe("assertFetchableUrl (SSRF guards)", () => {
  test("accepts https URLs", () => {
    expect(assertFetchableUrl("https://example.com/schedule.pdf").hostname).toBe("example.com");
    expect(assertFetchableUrl("https://example.com:443/schedule.png").hostname).toBe("example.com");
  });

  test("rejects non-http(s) protocols", () => {
    expect(() => assertFetchableUrl("ftp://example.com/schedule.pdf")).toThrow(IngestUrlError);
    expect(() => assertFetchableUrl("file:///etc/passwd")).toThrow(IngestUrlError);
    expect(() => assertFetchableUrl("javascript:alert(1)")).toThrow(IngestUrlError);
  });

  test("rejects embedded credentials", () => {
    expect(() => assertFetchableUrl("https://user:pass@example.com/schedule.pdf")).toThrow(
      IngestUrlError,
    );
  });

  test("rejects non-standard ports", () => {
    expect(() => assertFetchableUrl("https://example.com:8443/schedule.pdf")).toThrow(
      IngestUrlError,
    );
  });

  test("rejects loopback and internal hosts", () => {
    expect(() => assertFetchableUrl("http://localhost:3000/x")).toThrow(IngestUrlError);
    expect(() => assertFetchableUrl("http://127.0.0.1/x")).toThrow(IngestUrlError);
    expect(() => assertFetchableUrl("https://printer.local/x.png")).toThrow(IngestUrlError);
    expect(() => assertFetchableUrl("https://db.internal/x.png")).toThrow(IngestUrlError);
  });

  test("rejects plain http to the open internet", () => {
    expect(() => assertFetchableUrl("http://example.com/schedule.pdf")).toThrow(IngestUrlError);
  });

  test("rejects garbage", () => {
    expect(() => assertFetchableUrl("not a url")).toThrow(IngestUrlError);
  });
});

describe("validateCallbackUrl (webhook targets)", () => {
  test("accepts https", () => {
    expect(validateCallbackUrl("https://hooks.example.com/qc")).toBe(
      "https://hooks.example.com/qc",
    );
  });

  test("accepts http only for localhost development", () => {
    expect(validateCallbackUrl("http://localhost:9000/hook")).toBe("http://localhost:9000/hook");
    expect(validateCallbackUrl("http://127.0.0.1:9000/hook")).toBe("http://127.0.0.1:9000/hook");
  });

  test("rejects plain http elsewhere and non-http schemes", () => {
    expect(validateCallbackUrl("http://evil.example.com/hook")).toBeNull();
    expect(validateCallbackUrl("file:///etc/passwd")).toBeNull();
  });

  test("null-safe", () => {
    expect(validateCallbackUrl(undefined)).toBeNull();
    expect(validateCallbackUrl(null)).toBeNull();
    expect(validateCallbackUrl("")).toBeNull();
  });
});
