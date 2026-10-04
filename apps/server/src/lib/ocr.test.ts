import { describe, expect, test } from "bun:test";
import { ocrDocument, OcrError } from "./ocr";

const CONFIG = { apiKey: "test-key", url: undefined };

describe("ocrDocument input guards", () => {
  test("rejects WebP with an actionable message", async () => {
    expect(ocrDocument(CONFIG, new Uint8Array(1), "image/webp")).rejects.toThrow(
      "WebP images aren't supported",
    );
  });

  test("rejects unsupported content types", async () => {
    expect(ocrDocument(CONFIG, new Uint8Array(1), "image/gif")).rejects.toThrow(OcrError);
  });

  test("rejects a missing API key with a configuration hint", async () => {
    expect(
      ocrDocument({ apiKey: "", url: undefined }, new Uint8Array(1), "image/png"),
    ).rejects.toThrow("ZAI_API_KEY missing");
  });
});

describe("ocrDocument request and response handling", () => {
  test("sends a base64 data URI and returns the markdown", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ md_results: "# Schedule\nBiology 101 — 9am" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const markdown = await ocrDocument(CONFIG, new Uint8Array([1, 2, 3]), "image/png");
    expect(markdown).toContain("Biology 101");

    const call = calls[0]!;
    expect(call.url).toBe("https://api.z.ai/api/paas/v4/layout_parsing");
    expect(call.headers.authorization).toBe("Bearer test-key");
    const body = call.body as { model: string; file: string };
    expect(body.model).toBe("glm-ocr");
    expect(body.file).toBe("data:image/png;base64,AQID");
  });

  test("surfaces API errors with status and body", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad image" } }), {
        status: 422,
      })) as unknown as typeof fetch;

    expect(ocrDocument(CONFIG, new Uint8Array(1), "image/jpeg")).rejects.toThrow(
      "GLM-OCR responded 422",
    );
  });

  test("rejects empty OCR results", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ md_results: "" }), { status: 200 })) as unknown as typeof fetch;
    expect(ocrDocument(CONFIG, new Uint8Array(1), "image/png")).rejects.toThrow(
      "no readable text",
    );
  });
});
