import { afterAll, describe, expect, test } from "bun:test";
import { assertFetchableUrl, fetchIngestDocument, IngestUrlError } from "./fetch-document";

/**
 * Regression coverage for the URL-ingestion SSRF guards. The initial URL was
 * validated, but `fetch(..., { redirect: "follow" })` followed redirects
 * without re-running the guards — a public URL could bounce to http:// or an
 * internal address.
 */

const realFetch = globalThis.fetch;
const calls: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];

function installFetch(handler: (url: string, index: number) => Response) {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, redirect: init?.redirect });
    return handler(url, calls.length - 1);
  }) as typeof fetch;
}

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("assertFetchableUrl private-network guards", () => {
  test("rejects RFC1918, link-local, CGNAT, and loopback addresses", () => {
    for (const url of [
      "https://10.0.0.1/x",
      "https://172.16.0.1/x",
      "https://192.168.1.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/x",
      "https://127.0.0.2/x",
      "https://0.0.0.0/x",
      "https://[::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[fd00::1]/x",
      "https://[fe80::1]/x",
      // FQDN trailing-dot forms resolve to the same internal address.
      "https://localhost./x",
      "https://127.0.0.1./x",
      "https://printer.local./x",
    ]) {
      expect(() => assertFetchableUrl(url)).toThrow(IngestUrlError);
    }
  });
});

describe("fetchIngestDocument redirect handling", () => {
  test("never fetches a redirect target that downgrades to http", async () => {
    installFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    );

    await expect(fetchIngestDocument("https://example.com/start")).rejects.toThrow(IngestUrlError);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.redirect).toBe("manual");
  });

  test("never fetches a redirect target on a private host", async () => {
    installFetch(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://127.0.0.1/secret" },
        }),
    );

    await expect(fetchIngestDocument("https://example.com/start")).rejects.toThrow(IngestUrlError);
    expect(calls).toHaveLength(1);
  });

  test("follows a safe redirect and validates every hop", async () => {
    installFetch((url) => {
      if (url === "https://example.com/start") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://cdn.example.com/schedule.txt" },
        });
      }
      return new Response("Mon 10/5: Biology 101 at 9:00", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const doc = await fetchIngestDocument("https://example.com/start");
    expect(doc.text).toContain("Biology 101");
    expect(calls.map((call) => call.url)).toEqual([
      "https://example.com/start",
      "https://cdn.example.com/schedule.txt",
    ]);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
  });

  test("stops after too many redirects", async () => {
    installFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/loop" },
        }),
    );

    await expect(fetchIngestDocument("https://example.com/start")).rejects.toThrow(
      /redirected too many times/,
    );
    expect(calls.length).toBeLessThanOrEqual(6);
  });
});
