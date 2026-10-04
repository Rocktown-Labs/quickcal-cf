import { describe, expect, test } from "bun:test";
import {
  extractEventsFromText,
  isDocumentCalendarClef,
  parseExtraction,
  shouldUseClefGate,
} from "./ai";

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

function textAiStub(result: unknown) {
  const calls: Array<{ model: string; messages: unknown }> = [];
  const ai = {
    async run(model: string, input: unknown): Promise<unknown> {
      calls.push({ model, messages: input });
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { ai: ai as unknown as Ai, calls };
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

  test("propagates provider failures (no silent 'not a calendar')", async () => {
    const { ai } = aiStub(new Error("429 rate limited"));
    expect(isDocumentCalendarClef(ai, new Uint8Array(1), "image/png")).rejects.toThrow(
      "429 rate limited",
    );
  });
});

describe("parseExtraction", () => {
  test("parses a plain JSON array", () => {
    const events = parseExtraction(
      `[{"date":"2026-10-05","time":"09:00","description":"Biology 101","location":"Room 214","confidence":0.9,"sourceQuote":"Bio 101 9am"}]`,
    );
    expect(events.length).toBe(1);
    expect(events[0]!.title).toBe("Biology 101");
    expect(events[0]!.confidence).toBe(0.9);
  });

  test("strips markdown fences", () => {
    const events = parseExtraction(
      "```json\n[{\"date\":\"2026-10-05\",\"time\":\"\",\"description\":\"Holiday\"}]\n```",
    );
    expect(events.length).toBe(1);
    expect(events[0]!.time).toBe(""); // no time = all-day event downstream
  });

  test("recovers the array from prose-wrapped replies", () => {
    const events = parseExtraction(
      `Here are the events I found:\n\n[{"date":"2026-10-06","time":"14:00","description":"Standup"}]\n\nLet me know if you need anything else.`,
    );
    expect(events.length).toBe(1);
    expect(events[0]!.description).toBe("Standup");
  });

  test("falls back to description when the title is omitted", () => {
    const events = parseExtraction(
      `[{"date":"2026-10-05","time":"09:00","description":"Dentist"}]`,
    );
    expect(events[0]!.title).toBe("Dentist");
  });

  test("returns empty for empty model replies", () => {
    expect(parseExtraction("")).toEqual([]);
    expect(parseExtraction(undefined)).toEqual([]);
  });

  test("rejects arrays that exceed the event cap", () => {
    const big = JSON.stringify(
      Array.from({ length: 501 }, () => ({
        date: "2026-10-05",
        time: "",
        description: "x",
      })),
    );
    expect(() => parseExtraction(big)).toThrow("Too many events");
  });
});

describe("extractEventsFromText (GLM on the Workers AI binding)", () => {
  test("sends the prompt to the configured model and parses the reply", async () => {
    const { ai, calls } = textAiStub({
      response: `[{"date":"2026-10-05","time":"09:00","description":"Biology 101"}]`,
    });
    const events = await extractEventsFromText(ai, "Bio 101 9am Monday", "@cf/zai-org/glm-4.7-flash");
    expect(events.length).toBe(1);
    expect(events[0]!.description).toBe("Biology 101");

    const call = calls[0]!;
    expect(call.model).toBe("@cf/zai-org/glm-4.7-flash");
    const input = call.messages as { messages: Array<{ role: string; content: string }> };
    expect(input.messages[0]!.role).toBe("user");
    expect(input.messages[0]!.content).toContain("<<<BEGIN DOCUMENT>>>");
    expect(input.messages[0]!.content).toContain("Bio 101 9am Monday");
  });

  test("defaults to the GLM flash extraction model", async () => {
    const { ai, calls } = textAiStub({ response: "[]" });
    await extractEventsFromText(ai, "nothing here");
    expect(calls[0]!.model).toBe("@cf/zai-org/glm-5.3-flash");
  });

  test("normalizes non-standard response shapes", async () => {
    const choicesAi = textAiStub({
      choices: [{ message: { content: `[{"date":"2026-10-05","time":"","description":"Holiday"}]` } }],
    });
    const events = await extractEventsFromText(choicesAi.ai, "Oct 5 holiday");
    expect(events.length).toBe(1);
    expect(events[0]!.time).toBe("");
  });

  test("propagates provider failures for workflow retry", async () => {
    const { ai } = textAiStub(new Error("model overloaded"));
    expect(extractEventsFromText(ai, "x")).rejects.toThrow("model overloaded");
  });
});
