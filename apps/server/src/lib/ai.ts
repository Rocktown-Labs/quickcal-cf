import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
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

const extractedEventSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
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

function toBase64(data: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    bin += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ─── Models ───

// Gemini 3.8 Flash — stable model ID (released 2026-09-02, no preview suffix).
// Runs event extraction (Clef is a decision model — no free-form output) and
// doubles as the classifier of last resort.
const EXTRACTION_MODEL = "gemini-3.8-flash";
const CLASSIFICATION_MODEL = "gemini-3.8-flash";

// Cloudflare Clef (27B decision model, launched 2026-10-01) classifies image
// uploads for the "is this a calendar?" gate: in-network via the AI binding,
// ~209 ms median latency, and $0.24/M input tokens vs Gemini's $0.75/M.
// Clef accepts embedded PNG/JPEG/WebP only (≤ 4 MiB and 16 megapixels each),
// so PDFs and oversized photos stay on Gemini — it is a fast path with a
// Gemini fallback, not a wholesale replacement.
const CLEF_MODEL = "@cf/cloudflare/clef";
const CLEF_PROBABILITY_THRESHOLD = 0.5;
const CLEF_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const CLEF_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** True when the upload fits within Clef's image input constraints. */
export function shouldUseClefGate(contentType: string, byteLength: number): boolean {
  return CLEF_IMAGE_TYPES.has(contentType) && byteLength <= CLEF_MAX_IMAGE_BYTES;
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

/** Clef gate — throws on any failure so the caller can fall back to Gemini. */
export async function isDocumentCalendarClef(
  ai: Ai,
  fileData: Uint8Array,
  fileType: string,
): Promise<boolean> {
  const response = await ai.run(CLEF_MODEL, {
    model: "clef",
    state: "A document uploaded by a user who wants its schedule turned into a calendar file.",
    questions: {
      isCalendar: {
        type: "noul",
        instructions:
          "Does this document primarily represent a calendar, schedule, agenda, or a list of events with dates?",
        criteria: {
          true: "A calendar, class timetable, shift roster, conference agenda, event flyer, or similar schedule with dates and/or times.",
          false:
            "Any other document: photos, receipts, articles, forms, or content without schedule structure.",
        },
      },
    },
    images: [{ content_type: fileType, base64: toBase64(fileData) }],
  });

  return clefYesProbability(response) >= CLEF_PROBABILITY_THRESHOLD;
}

/**
 * Gemini gate — throws on provider errors (and empty replies) instead of
 * swallowing them, so callers can tell "not a calendar" apart from "the
 * check failed".
 */
export async function isDocumentCalendar(
  apiKey: string,
  fileData: Uint8Array,
  fileType: string,
): Promise<boolean> {
  const google = createGoogleGenerativeAI({ apiKey });
  const dataUrl = `data:${fileType};base64,${toBase64(fileData)}`;

  const { text } = await generateText({
    model: google(CLASSIFICATION_MODEL),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze the following document. Does it primarily represent a calendar, schedule, agenda, or a list of events with dates? Please answer with only a single word: 'yes' or 'no'.`,
          },
          {
            type: "image",
            image: dataUrl,
          },
        ],
      },
    ],
  });

  if (text === undefined || text.trim() === "") {
    throw new Error("Gemini classification returned an empty response");
  }
  return text.trim().toLowerCase() === "yes";
}

export interface ClassifyDocumentInput {
  ai: Ai;
  geminiApiKey: string;
  data: Uint8Array;
  contentType: string;
  /** Test seam — override the Gemini fallback classifier. */
  geminiClassifier?: typeof isDocumentCalendar;
}

/**
 * "Is this a calendar?" gate. Routes in-spec images to Cloudflare Clef
 * (cheap, in-network) and everything else — PDFs, oversized images — to
 * Gemini. A Clef failure falls back to Gemini rather than failing the
 * upload; only when both providers fail does this throw, so provider
 * outages surface as `failed` uploads instead of being mislabeled
 * "not a calendar" (`no_events`).
 */
export async function classifyDocument(input: ClassifyDocumentInput): Promise<boolean> {
  const { ai, geminiApiKey, data, contentType } = input;
  const gemini = input.geminiClassifier ?? isDocumentCalendar;

  if (shouldUseClefGate(contentType, data.byteLength)) {
    try {
      return await isDocumentCalendarClef(ai, data, contentType);
    } catch (err) {
      console.warn(
        `Clef gate failed (${err instanceof Error ? err.message : String(err)}); falling back to Gemini`,
      );
    }
  }

  return gemini(geminiApiKey, data, contentType);
}

const EXTRACTION_PROMPT = `Analyze the provided calendar, schedule, or agenda document. Examine ALL pages and identify all distinct events, appointments, or line items across the entire document.

For each item, extract:
- "title": a short event name (e.g. "Biology 101", "Standup", "Dentist"). If no distinct name exists, use the description.
- "date": the event date in YYYY-MM-DD format. If the document only defines dates indirectly (e.g. a weekday under a date header), resolve it to the concrete date. Leave "" only if truly undeterminable.
- "time": the start time in HH:MM 24-hour format, or "" if none is given.
- "endTime": the end time in HH:MM 24-hour format, or "" if none is given.
- "location": where it takes place, or "" if not stated.
- "description": a brief description of the event.
- "confidence": a number between 0 and 1 for how certain you are the date and time are parsed correctly.
- "sourceQuote": the exact short snippet from the document this event was parsed from.

Do not invent dates or times that are not in the document. Return the data as a JSON array of objects with no duplicates.`;

function parseExtraction(text: string | undefined): ExtractedEvent[] {
  if (text === undefined) return [];

  const cleanedText = text
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/\s*```$/, "");

  if (cleanedText === "") return [];

  const raw: unknown = JSON.parse(cleanedText);
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

export async function extractEventsFromDocument(
  apiKey: string,
  fileData: Uint8Array,
  fileType: string,
): Promise<ExtractedEvent[]> {
  const google = createGoogleGenerativeAI({ apiKey });
  const dataUrl = `data:${fileType};base64,${toBase64(fileData)}`;

  const { text } = await generateText({
    model: google(EXTRACTION_MODEL),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: EXTRACTION_PROMPT },
          {
            type: "image",
            image: dataUrl,
          },
        ],
      },
    ],
  });

  return parseExtraction(text);
}

/**
 * Text-only extraction — the pipeline for pasted plain text, markdown, and
 * CSV schedules (also used by URL ingestion when the target is a text
 * document). Same schema and parsing as the vision path.
 */
export async function extractEventsFromText(
  apiKey: string,
  content: string,
): Promise<ExtractedEvent[]> {
  const google = createGoogleGenerativeAI({ apiKey });

  const { text } = await generateText({
    model: google(EXTRACTION_MODEL),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${EXTRACTION_PROMPT}\n\nThe schedule content follows between the markers. Ignore the markers themselves.\n\n<<<BEGIN DOCUMENT>>>\n${content}\n<<<END DOCUMENT>>>`,
          },
        ],
      },
    ],
  });

  return parseExtraction(text);
}
