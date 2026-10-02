import { describe, expect, test } from "bun:test";
import { classifyDocument, isDocumentCalendarClef, shouldUseClefGate } from "./ai";

const FOUR_MIB = 4 * 1024 * 1024;

function aiStub(result: unknown) {
  const calls: unknown[] = [];
  const ai = {
    async run(_model: string, input: unknown): Promise<unknown> {
      calls.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { ai: ai as unknown as Ai, calls };
}

function geminiStub(result: boolean | Error) {
  const calls: Array<{ apiKey: string; contentType: string }> = [];
  const classifier = async (apiKey: string, _data: Uint8Array, contentType: string) => {
    calls.push({ apiKey, contentType });
    if (result instanceof Error) throw result;
    return result;
  };
  return { classifier, calls };
}

describe("shouldUseClefGate", () => {
  test("accepts in-spec image types", () => {
    expect(shouldUseClefGate("image/png", 1024)).toBe(true);
    expect(shouldUseClefGate("image/jpeg", FOUR_MIB)).toBe(true);
    expect(shouldUseClefGate("image/webp", 1)).toBe(true);
  });

  test("rejects PDFs, oversized images, and unknown types", () => {
    expect(shouldUseClefGate("application/pdf", 1024)).toBe(false);
    expect(shouldUseClefGate("image/png", FOUR_MIB + 1)).toBe(false);
    expect(shouldUseClefGate("image/gif", 1024)).toBe(false);
  });
});

describe("isDocumentCalendarClef", () => {
  test("thresholds the noul probability", async () => {
    const yes = aiStub({ answers: { isCalendar: { type: "noul", noul: 0.9 } } });
    expect(await isDocumentCalendarClef(yes.ai, new Uint8Array(1), "image/png")).toBe(true);

    const no = aiStub({ answers: { isCalendar: { type: "noul", noul: 0.2 } } });
    expect(await isDocumentCalendarClef(no.ai, new Uint8Array(1), "image/png")).toBe(false);

    const edge = aiStub({ answers: { isCalendar: { type: "noul", noul: 0.5 } } });
    expect(await isDocumentCalendarClef(edge.ai, new Uint8Array(1), "image/png")).toBe(true);
  });

  test("accepts a bare number answer", async () => {
    const { ai } = aiStub({ answers: { isCalendar: 0.7 } });
    expect(await isDocumentCalendarClef(ai, new Uint8Array(1), "image/png")).toBe(true);
  });

  test("throws on an unexpected answer shape", async () => {
    const { ai } = aiStub({ answers: {} });
    expect(isDocumentCalendarClef(ai, new Uint8Array(1), "image/png")).rejects.toThrow(
      "unexpected answer shape",
    );
  });

  test("sends a System One noul question with the image embedded", async () => {
    const { ai, calls } = aiStub({ answers: { isCalendar: { type: "noul", noul: 1 } } });
    await isDocumentCalendarClef(ai, new Uint8Array([1, 2, 3]), "image/png");
    const input = calls[0] as {
      model: string;
      questions: Record<string, { type: string }>;
      images: Array<{ content_type: string; base64: string }>;
    };
    expect(input.model).toBe("clef");
    expect(input.questions.isCalendar?.type).toBe("noul");
    expect(input.images[0]?.content_type).toBe("image/png");
    expect(input.images[0]?.base64).toBe("AQID"); // bytes [1, 2, 3]
  });
});

describe("classifyDocument", () => {
  const png = new Uint8Array([1, 2, 3]);

  test("routes in-spec images to clef", async () => {
    const { ai } = aiStub({ answers: { isCalendar: { type: "noul", noul: 0.95 } } });
    const gemini = geminiStub(false);
    const result = await classifyDocument({
      ai,
      geminiApiKey: "k",
      data: png,
      contentType: "image/png",
      geminiClassifier: gemini.classifier,
    });
    expect(result).toBe(true);
    expect(gemini.calls.length).toBe(0);
  });

  test("routes PDFs straight to Gemini", async () => {
    const { ai, calls } = aiStub({ answers: { isCalendar: { type: "noul", noul: 0.95 } } });
    const gemini = geminiStub(true);
    const result = await classifyDocument({
      ai,
      geminiApiKey: "k",
      data: png,
      contentType: "application/pdf",
      geminiClassifier: gemini.classifier,
    });
    expect(result).toBe(true);
    expect(calls.length).toBe(0);
    expect(gemini.calls.length).toBe(1);
  });

  test("falls back to Gemini when clef fails", async () => {
    const { ai } = aiStub(new Error("429 rate limited"));
    const gemini = geminiStub(true);
    const result = await classifyDocument({
      ai,
      geminiApiKey: "k",
      data: png,
      contentType: "image/jpeg",
      geminiClassifier: gemini.classifier,
    });
    expect(result).toBe(true);
    expect(gemini.calls.length).toBe(1);
  });

  test("falls back to Gemini when clef returns a malformed answer", async () => {
    const { ai } = aiStub({ answers: { isCalendar: "garbage" } });
    const gemini = geminiStub(false);
    const result = await classifyDocument({
      ai,
      geminiApiKey: "k",
      data: png,
      contentType: "image/webp",
      geminiClassifier: gemini.classifier,
    });
    expect(result).toBe(false);
    expect(gemini.calls.length).toBe(1);
  });

  test("routes oversized images to Gemini", async () => {
    const { ai, calls } = aiStub({ answers: { isCalendar: { type: "noul", noul: 0.95 } } });
    const gemini = geminiStub(true);
    const result = await classifyDocument({
      ai,
      geminiApiKey: "k",
      data: new Uint8Array(FOUR_MIB + 1),
      contentType: "image/png",
      geminiClassifier: gemini.classifier,
    });
    expect(result).toBe(true);
    expect(calls.length).toBe(0);
    expect(gemini.calls.length).toBe(1);
  });

  test("rejects only when both providers fail", async () => {
    const { ai } = aiStub(new Error("clef down"));
    const gemini = geminiStub(new Error("gemini down"));
    expect(
      classifyDocument({
        ai,
        geminiApiKey: "k",
        data: png,
        contentType: "image/png",
        geminiClassifier: gemini.classifier,
      }),
    ).rejects.toThrow("gemini down");
  });
});
