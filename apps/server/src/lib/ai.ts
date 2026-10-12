import { z } from "zod";

export interface ExtractedEvent {
  id: number;
  date: string;
  time: string;
  endTime: string;
  description: string;
  title: string;
  location: string;
  /** 0..1 — the model's confidence this event was parsed correctly. */
  confidence: number | null;
  /** The snippet of the source document this event was parsed from. */
  sourceQuote: string | null;
}

const timeRegex = /^$|^([01]\d|2[0-3]):[0-5]\d$/;
// Empty is allowed: the prompt tells the model to leave the date empty when
// the document doesn't determine one, and the workflow drops undated events
// before persisting (ICS generation would throw on them).
const dateRegex = /^$|^\d{4}-\d{2}-\d{2}$/;

const extractedEventSchema = z.object({
  date: z
    .string()
    .regex(dateRegex, "Date must be in YYYY-MM-DD format, or empty if undeterminable"),
  time: z.string().regex(timeRegex, "Time must be in HH:MM format"),
  endTime: z.string().regex(timeRegex, "End time must be in HH:MM format").optional().default(""),
  // Short event name — falls back to the description when omitted by the model.
  title: z.string().trim().max(200).optional().default(""),
  description: z.string().trim().min(1).max(1000),
  location: z.string().trim().max(300).optional().default(""),
  confidence: z.number().min(0).max(1).optional().nullable().default(null),
  sourceQuote: z.string().trim().max(500).optional().nullable().default(null),
});

// Cap the number of events so a pathological document (or a hallucinating
// model) can't generate thousands of DB rows and a giant .ics.
const MAX_EXTRACTED_EVENTS = 500;

const extractedEventsSchema = z
  .array(extractedEventSchema)
  .max(MAX_EXTRACTED_EVENTS, `Too many events extracted (max ${MAX_EXTRACTED_EVENTS})`);

// ─── The gate: Clef (Cloudflare Workers AI, in-network) ─────────────────────

// Cloudflare Clef (27B decision model) classifies in-spec image uploads for
// the "is this a calendar?" gate: in-network via the AI binding, ~209 ms
// median latency, and $0.24/M input tokens vs a frontier VLM's pricing.
// Clef accepts embedded PNG/JPEG/WebP only (≤ 4 MiB and 16 megapixels each).
// PDFs and oversized images are OCR'd instead (see lib/ocr.ts) — extraction
// on that text decides, so they need no pixel gate at all.
const CLEF_MODEL = "@cf/cloudflare/clef";
// clef-flash must be called at its own endpoint — the clef endpoint rejects
// model:"clef-flash" with 422 "Unsupported model".
const CLEF_FLASH_MODEL = "@cf/cloudflare/clef-flash";
const CLEF_PROBABILITY_THRESHOLD = 0.5;
export const CLEF_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const CLEF_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** True when the upload fits within Clef's image input constraints. */
export function shouldUseClefGate(contentType: string, byteLength: number): boolean {
  return CLEF_IMAGE_TYPES.has(contentType) && byteLength <= CLEF_MAX_IMAGE_BYTES;
}

function toBase64(data: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    bin += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// System One noul answers arrive as { type: "noul", noul: probability }
// where noul ∈ [0, 1] is the probability the answer is yes. Accept a bare
// number too, in case the API ever simplifies the shape.
function clefYesProbability(response: unknown): number {
  const answer = (response as { answers?: Record<string, unknown> } | null)?.answers?.isCalendar;
  if (typeof answer === "number") return answer;
  const noul = (answer as { noul?: unknown } | null)?.noul;
  if (typeof noul === "number") return noul;
  throw new Error("Clef returned an unexpected answer shape");
}

/**
 * Runs the production "isCalendar" Clef question and returns the raw
 * probability (0..1) that the document is calendar-like. `variant` selects
 * the model: "clef" (27B, most accurate) or "clef-flash" (9B, ~5x faster).
 */
export async function getCalendarProbability(
  ai: Ai,
  fileData: Uint8Array,
  fileType: string,
  variant: "clef" | "clef-flash" = "clef",
): Promise<number> {
  const response = await ai.run(variant === "clef-flash" ? CLEF_FLASH_MODEL : CLEF_MODEL, {
    model: variant,
    state: "A document uploaded by a user who wants its schedule turned into a calendar file.",
    questions: {
      isCalendar: {
        type: "noul",
        instructions:
          "Does this document contain one or more dated or timed events that the user might want to add to a calendar?",
        criteria: {
          true: "Documents built around upcoming events: calendars, class or school timetables, sports team game schedules, shift rosters, conference or event agendas, event flyers, concert or event tickets, invitations with a date or time, travel itineraries, booking or reservation confirmations, appointment reminders.",
          false:
            "Documents with no events to attend: scenery or people photos, articles and news screenshots, memes, product manuals, grocery or retail receipts, app or conversation screenshots without event information.",
        },
      },
    },
    images: [{ content_type: fileType, base64: toBase64(fileData) }],
  });

  return clefYesProbability(response);
}

/**
 * Clef gate — throws on any failure (so the workflow can retry, then mark
 * the upload `failed`). A provider error must never be mislabeled "not a
 * calendar" (`no_events`).
 */
export async function isDocumentCalendarClef(
  ai: Ai,
  fileData: Uint8Array,
  fileType: string,
): Promise<boolean> {
  const probability = await getCalendarProbability(ai, fileData, fileType);
  return probability >= CLEF_PROBABILITY_THRESHOLD;
}

// ─── The extraction: GLM on the Workers AI binding (in-network) ─────────────

export const DEFAULT_EXTRACTION_MODEL = "@cf/zai-org/glm-5.3-flash";

export const EXTRACTION_PROMPT = `Analyze the provided calendar, schedule, or agenda document. Examine ALL pages and identify all distinct events, appointments, or line items across the entire document.

For each item, extract:
- "title": a short event name (e.g. "Biology 101", "Standup", "Dentist"). If no distinct name exists, use the description.
- "date": the event date in YYYY-MM-DD format. If the document only defines dates indirectly (e.g. a weekday under a date header), resolve it to the concrete date. Leave "" only if truly undeterminable.
- "time": the start time in HH:MM 24-hour format, or "" if none is given.
- "endTime": the end time in HH:MM 24-hour format, or "" if none is given.
- "location": where it takes place, or "" if not stated.
- "description": a brief description of the event.
- "confidence": a number between 0 and 1 for how certain you are the date and time are parsed correctly.
- "sourceQuote": the exact short snippet from the document this event was parsed from.

Do not invent dates or times that are not in the document. Return ONLY a JSON array of objects with no duplicates, no commentary, and no markdown fences.`;

/**
 * Normalizes Workers AI text-model responses. Most models return
 * { response }, but newer/reasoning-capable models have been known to shape
 * output differently — accept the common alternatives without failing.
 */
function workersAiText(response: unknown): string | undefined {
  if (response === null || response === undefined) return undefined;
  if (typeof response === "string") return response;

  const obj = response as {
    response?: unknown;
    text?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
  };

  if (typeof obj.response === "string") return obj.response;
  if (typeof obj.text === "string") return obj.text;
  const content = obj.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;

  throw new Error("Extraction model returned an unrecognized response shape");
}

/**
 * Pulls the JSON events array out of a model reply that may include fences,
 * prose, or reasoning before/after the payload.
 */
function extractJsonArray(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall back to the outermost array literal in the reply.
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Extraction output contained no JSON array");
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

export function parseExtraction(text: string | undefined): ExtractedEvent[] {
  if (text === undefined || text.trim() === "") return [];

  const raw = extractJsonArray(text);
  const parsed = extractedEventsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid AI extraction output: ${parsed.error.message}`);
  }

  return parsed.data.map((item, index) => ({
    ...item,
    title: item.title || item.description,
    id: Date.now() + index,
  }));
}

/**
 * Appends capture-date resolution to an extraction prompt. Screenshots and
 * flyers often use relative dates ("today", "this Saturday"); the model is
 * told not to invent dates, so it needs the date the document was captured —
 * in production that's the upload timestamp.
 */
function withCaptureDate(prompt: string, capturedOn?: string): string {
  if (!capturedOn) return prompt;
  return `${prompt}\n\nThe document was captured on ${capturedOn}. Resolve relative dates like "today", "tonight", or "this Saturday" to actual dates based on ${capturedOn}. Never use a purchase, booking, or print timestamp as an event time.`;
}

/**
 * Extracts events from schedule text (OCR markdown, pasted text, CSV) using
 * GLM on the Workers AI binding — in-network, no external key. Throws on
 * provider errors so the workflow's retry policy applies.
 */
export async function extractEventsFromText(
  ai: Ai,
  content: string,
  model = DEFAULT_EXTRACTION_MODEL,
  capturedOn?: string,
): Promise<ExtractedEvent[]> {
  const response = await ai.run(model, {
    messages: [
      {
        role: "user",
        content: `${withCaptureDate(EXTRACTION_PROMPT, capturedOn)}\n\nThe schedule content follows between the markers. Ignore the markers themselves.\n\n<<<BEGIN DOCUMENT>>>\n${content}\n<<<END DOCUMENT>>>`,
      },
    ],
    stream: false,
  });

  return parseExtraction(workersAiText(response));
}

/**
 * Extracts events directly from an image (PNG/JPEG/WebP) in a single vision
 * call — replaces the old OCR-then-extract pipeline for images. Validated by
 * scripts/ocr-bench: 100% recall and field accuracy on schedule documents,
 * ~3-10s and ~$0.0004 per image at reasoning_effort "low".
 */
export async function extractEventsFromImage(
  ai: Ai,
  imageData: Uint8Array,
  contentType: string,
  model = DEFAULT_EXTRACTION_MODEL,
  capturedOn?: string,
): Promise<ExtractedEvent[]> {
  const response = await ai.run(model, {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${withCaptureDate(EXTRACTION_PROMPT, capturedOn)}\n\nThe schedule content is provided as an attached image. Read every line of it carefully, including small print.`,
          },
          {
            type: "image_url",
            image_url: { url: `data:${contentType};base64,${toBase64(imageData)}` },
          },
        ],
      },
    ],
    // "low" matched default-reasoning accuracy in the bench at a third of
    // the latency and cost.
    reasoning_effort: "low",
    stream: false,
    max_tokens: 4096,
  });

  return parseExtraction(workersAiText(response));
}
