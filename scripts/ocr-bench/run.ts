/**
 * OCR bench — evaluates Workers AI vision models as replacements for the
 * external Z.ai GLM-OCR step (apps/server/src/lib/ocr.ts).
 *
 * Runs every sample in ./samples through each strategy below, scores the
 * extracted events against ./truth.json, and writes full transcripts and
 * metrics to ./results/<timestamp>/.
 *
 * Usage:
 *   bun run run.ts
 *   bun run run.ts --only=glm-direct,moondream-ocr
 *   bun run run.ts --samples=ticket-concert.png
 *
 * Requires `wrangler login` (uses the same OAuth token as the CLI) and the
 * account to be on Workers Paid (glm-5.3-flash is a paid model).
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import {
  EXTRACTION_PROMPT,
  getCalendarProbability,
  parseExtraction,
  type ExtractedEvent,
} from "../../apps/server/src/lib/ai";
import type * as WorkersTypes from "@cloudflare/workers-types";

// ─── Config ──────────────────────────────────────────────────────────────────

const MODELS = {
  glm: "@cf/zai-org/glm-5.3-flash",
  qwen: "@cf/qwen/qwen3.8-27b",
  moondream: "@cf/moondream/moondream3.1-9B-A2B",
} as const;

/** USD per million tokens, from developers.cloudflare.com/workers-ai/models/. */
const COST_PER_M: Record<string, { input: number; output: number }> = {
  [MODELS.glm]: { input: 0.15, output: 0.5 },
  [MODELS.qwen]: { input: 0.45, output: 3.2 },
  [MODELS.moondream]: { input: 0.3, output: 1.0 },
};

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

const VISION_INSTRUCTION = `The schedule content is provided as an attached image. Read every line of it carefully, including small print.`;

// Proposed gate criteria — same "contains dated events" framing as the
// production question, but with explicit coverage for single-event documents
// (concert tickets, invitations) which the production criteria score low.
// No betting-slip language: those belong to a different product.
const TUNED_GATE_QUESTION = {
  isCalendar: {
    type: "noul" as const,
    instructions:
      "Does this document contain one or more dated or timed events that the user might want to add to a calendar?",
    criteria: {
      true: "Documents built around upcoming events: calendars, class or school timetables, sports team game schedules, shift rosters, conference or event agendas, event flyers, concert or event tickets, invitations with a date or time, travel itineraries, booking or reservation confirmations, appointment reminders.",
      false:
        "Documents with no events to attend: scenery or people photos, articles and news screenshots, memes, product manuals, grocery or retail receipts, app or conversation screenshots without event information.",
    },
  },
};

// Production extraction prompt plus sports-aware guidance for betting slips.
const TUNED_EXTRACTION_PROMPT = `${EXTRACTION_PROMPT}

The document may be a sports betting slip or parlay card: extract each game or matchup as its own event (title like "76ers @ Trail Blazers"), using the game date and time when shown. Never use the bet placement or purchase timestamp as an event time. If a matchup has no date or time shown, leave those fields empty rather than guessing.`;

// Same as tuned, but resolves relative dates ("today", "tonight") against the
// capture date — in production that's the upload timestamp, which is almost
// always the same day for betting slips.
const CAPTURE_DATE = new Date().toISOString().slice(0, 10);
const DATED_EXTRACTION_PROMPT = `${TUNED_EXTRACTION_PROMPT}

The image was captured on ${CAPTURE_DATE}. Resolve relative dates like "today" or "tonight" to ${CAPTURE_DATE}. Only include events you can give a date to; skip events whose date stays unknown.`;

// ─── Types ───────────────────────────────────────────────────────────────────

type AiLike = {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Calls the Workers AI REST API directly (same endpoints as the binding, so
 * results match production). Auth: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
 * env vars if set, otherwise the wr CLI's logged-in OAuth token.
 */
function makeRestAi(): AiLike {
  const accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID ?? "5af47adc047fa74dcfa59048858b486c";
  let token = readToken();
  if (!token) {
    throw new Error(
      "No Cloudflare credentials — run `npx wrangler login` or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID",
    );
  }

  function readToken(): string | undefined {
    const wranglerConfig = join(
      homedir(),
      "Library/Preferences/.wrangler/config/default.toml",
    );
    const raw = readFileSync(wranglerConfig, "utf8");
    return /oauth_token\s*=\s*"([^"]+)"/.exec(raw)?.[1];
  }

  /** Wrangler refreshes its OAuth token when the CLI runs — nudge it. */
  function refreshToken(): void {
    try {
      execSync("npx wrangler whoami", { stdio: "ignore", timeout: 60_000 });
    } catch {
      // best effort — the retried request will surface the real error
    }
  }

  const request = async (
    model: string,
    input: Record<string, unknown>,
  ): Promise<Response> =>
    fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

  return {
    async run(model, input) {
      let response = await request(model, input);
      if (response.status === 401) {
        // OAuth access tokens expire ~hourly; make wrangler refresh, then retry once.
        refreshToken();
        token = process.env.CLOUDFLARE_API_TOKEN ?? readToken();
        response = await request(model, input);
      }
      if (!response.ok) {
        const detail = await response.text().then((t) => t.slice(0, 300)).catch(() => "");
        throw new Error(`${model} request failed: HTTP ${response.status} ${detail}`);
      }
      // Streaming requests return SSE — hand the raw body to the caller.
      if (input.stream === true) return response.body;
      const json = (await response.json().catch(() => null)) as
        | { result?: unknown; success?: boolean; errors?: Array<{ message?: string }> }
        | null;
      if (!json?.success) {
        const message = json?.errors?.[0]?.message ?? "no body";
        throw new Error(`${model} request failed: ${message}`);
      }
      // REST wraps the binding result in { result } — unwrap it so the same
      // parsers work for both transports.
      return json.result;
    },
  };
}

interface Sample {
  file: string;
  mime: string;
  data: Uint8Array;
  dataUrl: string;
}

interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface StrategyResult {
  events: ExtractedEvent[];
  raw: string | undefined;
  /** Intermediate artifacts, e.g. the OCR transcript. */
  artifacts: Record<string, string>;
  usage: Usage[];
  error?: string;
}

interface Strategy {
  id: string;
  description: string;
  /** Restrict to these sample extensions (e.g. pdf-only strategies). */
  extensions?: string[];
  run: (ai: AiLike, sample: Sample) => Promise<StrategyResult>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toBase64(data: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    bin += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Mirrors the private workersAiText() in apps/server/src/lib/ai.ts. */
function responseText(response: unknown): string | undefined {
  if (response == null) return undefined;
  if (typeof response === "string") return response;
  const obj = response as {
    response?: unknown;
    text?: unknown;
    answer?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  if (typeof obj.response === "string") return obj.response;
  if (typeof obj.answer === "string") return obj.answer;
  if (typeof obj.text === "string") return obj.text;
  const content = obj.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return undefined;
}

function usageOf(model: string, response: unknown): Usage {
  const usage = (response as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
    ?.usage;
  return {
    model,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

function costOf(usage: Usage[]): number {
  return usage.reduce((sum, u) => {
    const rate = COST_PER_M[u.model];
    if (!rate) return sum;
    return (
      sum + (u.inputTokens / 1e6) * rate.input + (u.outputTokens / 1e6) * rate.output
    );
  }, 0);
}

// ─── Strategies ──────────────────────────────────────────────────────────────

/**
 * Moondream's non-streaming path returns an empty object (broken as of
 * Oct 2026), so call it with stream:true and parse the SSE stream. The final
 * event carries the complete answer and token metrics.
 */
async function runMoondream(
  ai: AiLike,
  payload: Record<string, unknown>,
): Promise<{ answer: string; usage: Usage }> {
  const response = (await ai.run(MODELS.moondream, {
    ...payload,
    stream: true,
  })) as ReadableStream<Uint8Array> | undefined;
  if (!response) throw new Error("Moondream returned no stream");

  const text = await new Response(response).text();
  let answer = "";
  let usage: Usage = { model: MODELS.moondream, inputTokens: 0, outputTokens: 0 };
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const body = line.slice(6).trim();
    if (!body || body === "[DONE]") continue;
    let event: {
      chunk?: { answer?: string | null };
      output?: Array<{ answer?: string | null; metrics?: { input_tokens?: number; output_tokens?: number } }>;
    };
    try {
      event = JSON.parse(body);
    } catch {
      continue;
    }
    const finalOutput = event.output?.[event.output.length - 1];
    if (finalOutput) {
      answer = finalOutput.answer ?? answer;
      usage = {
        model: MODELS.moondream,
        inputTokens: finalOutput.metrics?.input_tokens ?? 0,
        outputTokens: finalOutput.metrics?.output_tokens ?? 0,
      };
    } else if (event.chunk?.answer) {
      answer = event.chunk.answer;
    }
  }
  return { answer, usage };
}

/** One call: image → events JSON. */
function directStrategy(
  id: string,
  model: string,
  description: string,
  extraInput: Record<string, unknown> = {},
  prompt: string = EXTRACTION_PROMPT,
): Strategy {
  return {
    id,
    description,
    run: async (ai, sample) => {
      const response = await ai.run(model, {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `${prompt}\n\n${VISION_INSTRUCTION}` },
              { type: "image_url", image_url: { url: sample.dataUrl } },
            ],
          },
        ],
        stream: false,
        max_tokens: 4096,
        ...extraInput,
      });
      const raw = responseText(response);
      const { events, rescued } = parseExtractionLenient(raw);
      const artifacts: Record<string, string> = {};
      if (rescued) artifacts.rescuedByNormalization = "true";
      if (!events.length && !rescued) {
        // Reasoning models can burn the entire budget on reasoning_content
        // and never emit final content — capture a snippet for diagnosis.
        const reasoning = (response as any)?.choices?.[0]?.message
          ?.reasoning_content;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          artifacts.reasoningSnippet = reasoning.slice(0, 500);
        }
      }
      return {
        events,
        raw,
        artifacts,
        usage: [usageOf(model, response)],
      };
    },
  };
}

const STRATEGIES: Strategy[] = [
  directStrategy(
    "glm-direct",
    MODELS.glm,
    "One call: image → events with the production prompt (default reasoning)",
  ),
  directStrategy(
    "glm-direct-low",
    MODELS.glm,
    "Same as glm-direct but reasoning_effort=low (cheaper/faster)",
    { reasoning_effort: "low" },
  ),
  directStrategy(
    "glm-direct-tuned",
    MODELS.glm,
    "Low reasoning + betting-slip-aware prompt (proposed production config)",
    { reasoning_effort: "low" },
    TUNED_EXTRACTION_PROMPT,
  ),
  directStrategy(
    "glm-direct-dated",
    MODELS.glm,
    "Tuned prompt + capture-date reference to resolve 'today' (proposed production config)",
    { reasoning_effort: "low" },
    DATED_EXTRACTION_PROMPT,
  ),
  directStrategy(
    "qwen-direct",
    MODELS.qwen,
    "One call: image → events with Qwen 3.8 27B",
    { max_tokens: 12000 },
  ),
  {
    id: "moondream-ocr",
    description: "Two calls: Moondream transcribes image → GLM extracts events (production shape)",
    run: async (ai, sample) => {
      const ocr = await runMoondream(ai, {
        task: "query",
        image: sample.dataUrl,
        question:
          "Transcribe ALL text in this image exactly as written, preserving the layout as markdown. Include every date, time, name, venue, seat, and address. Output only the transcription.",
        reasoning: false,
        max_tokens: 4096,
      });
      const transcript = ocr.answer;
      const usage = [ocr.usage];

      const response = await ai.run(MODELS.glm, {
        messages: [
          {
            role: "user",
            content: `${EXTRACTION_PROMPT}\n\nThe schedule content follows between the markers. Ignore the markers themselves.\n\n<<<BEGIN DOCUMENT>>>\n${transcript}\n<<<END DOCUMENT>>>`,
          },
        ],
        stream: false,
        max_tokens: 4096,
      });
      const raw = responseText(response);
      const parsed = parseExtractionLenient(raw);
      usage.push(usageOf(MODELS.glm, response));

      return {
        events: parsed.events,
        raw,
        artifacts: { transcript, ...(parsed.rescued ? { rescuedByNormalization: "true" } : {}) },
        usage,
      };
    },
  },
  {
    id: "moondream-direct",
    description: "One call: Moondream reads the image and returns events JSON directly",
    run: async (ai, sample) => {
      const result = await runMoondream(ai, {
        task: "query",
        image: sample.dataUrl,
        question: `${EXTRACTION_PROMPT}\n\n${VISION_INSTRUCTION}`,
        max_tokens: 4096,
      });
      const parsed = parseExtractionLenient(result.answer);
      return {
        events: parsed.events,
        raw: result.answer,
        artifacts: parsed.rescued ? { rescuedByNormalization: "true" } : {},
        usage: [result.usage],
      };
    },
  },
  {
    id: "glm-pdf",
    description: "One call: PDF file part → events with GLM (tests direct PDF input)",
    extensions: [".pdf"],
    run: async (ai, sample) => {
      const response = await ai.run(MODELS.glm, {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `${EXTRACTION_PROMPT}\n\n${VISION_INSTRUCTION}` },
              {
                type: "file",
                file: {
                  file_data: `data:application/pdf;base64,${toBase64(sample.data)}`,
                  filename: sample.file,
                },
              },
            ],
          },
        ],
        stream: false,
      });
      const raw = responseText(response);
      return {
        events: parseExtraction(raw),
        raw,
        artifacts: {},
        usage: [usageOf(MODELS.glm, response)],
      };
    },
  },
];

// ─── Lenient parsing ─────────────────────────────────────────────────────────

// Production's schema is strict (YYYY-MM-DD, HH:MM), but models commonly emit
// "3/12/2026" or "8:10 PM" for real-world documents. This normalizes the
// common cases before re-running the strict parser, to measure how much a
// production-side normalizer would rescue.
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

function normalizeDate(s: unknown): string {
  if (typeof s !== "string") return s as string;
  const value = s.trim();
  if (!value) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  // M/D/YYYY, M-D-YYYY, M/D/YY
  let m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(value);
  if (m) {
    const year = m[3].length <= 2 ? `20${m[3]}` : m[3];
    return `${year}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`;
  }
  // "March 12, 2026" / "Mar 12 2026" / "12 March 2026"
  m = /^([A-Za-z]{3,12})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s+(\d{4})$/.exec(value);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month) return `${m[3]}-${pad2(month)}-${pad2(Number(m[2]))}`;
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,12})\.?\s*,?\s+(\d{4})$/.exec(value);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month) return `${m[3]}-${pad2(month)}-${pad2(Number(m[1]))}`;
  }
  return value;
}

function normalizeTime(s: unknown): string {
  if (typeof s !== "string") return s as string;
  const value = s.trim().toUpperCase();
  if (!value) return value;
  // H:MM AM/PM — 12 AM → 00:00, 12 PM → 12:00
  let m = /^(\d{1,2}):(\d{2})\s*(AM|PM)\.?$/.exec(value);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3] === "PM") h += 12;
    return `${pad2(h)}:${m[2]}`;
  }
  // H AM/PM
  m = /^(\d{1,2})\s*(AM|PM)\.?$/.exec(value);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[2] === "PM") h += 12;
    return `${pad2(h)}:00`;
  }
  // H:MM 24h
  m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (m) return `${pad2(Number(m[1]))}:${m[2]}`;
  return value;
}

/**
 * Strict parse first (production behavior); on failure, normalize each
 * event's date/time fields and retry. `rescued` reports whether the retry
 * was needed and succeeded.
 */
function parseExtractionLenient(
  raw: string | undefined,
): { events: ExtractedEvent[]; rescued: boolean } {
  if (raw === undefined || raw.trim() === "") return { events: [], rescued: false };
  try {
    return { events: parseExtraction(raw), rescued: false };
  } catch {
    // fall through to normalization
  }

  // Extract the outermost JSON array — same logic as production's parser.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) return { events: [], rescued: false };
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return { events: [], rescued: false };
    }
  }
  if (!Array.isArray(parsed)) return { events: [], rescued: false };

  const normalized = parsed.map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const event = item as Record<string, unknown>;
    return {
      ...event,
      date: normalizeDate(event.date),
      time: normalizeTime(event.time),
      endTime: normalizeTime(event.endTime),
    };
  });
  try {
    return { events: parseExtraction(JSON.stringify(normalized)), rescued: true };
  } catch {
    return { events: [], rescued: false };
  }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

interface TruthEvent {
  title: string;
  date: string;
  time: string;
  endTime?: string;
  location?: string;
}

type Truth = Record<string, { events: TruthEvent[] }>;

interface EventScore {
  matched: boolean;
  fields: { hit: number; total: number };
}

function normalize(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function fuzzyContains(a: string | undefined, b: string | undefined): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Token overlap — handles reordered/expanded values (e.g. the model returns
  // "Rocktown Amphitheatre, 1200 Venue Way, Austin, TX 78704" for the truth
  // "Rocktown Amphitheatre, Austin, TX").
  const aTokens = new Set(na.split(" "));
  const bTokens = nb.split(" ");
  const hits = bTokens.filter((t) => aTokens.has(t)).length;
  return hits / bTokens.length >= 0.7;
}

function scoreEvent(truthEvent: TruthEvent, predictions: ExtractedEvent[]): EventScore {
  // Match on date first, then prefer an exact time among those.
  const sameDate = predictions.filter((p) => p.date === truthEvent.date);
  const matched =
    sameDate.find((p) => p.time === truthEvent.time) ?? sameDate[0];
  if (!matched) return { matched: false, fields: { hit: 0, total: 0 } };

  let hit = 0;
  let total = 0;
  const record = (ok: boolean) => {
    total += 1;
    if (ok) hit += 1;
  };

  record(matched.time === truthEvent.time);
  record(fuzzyContains(matched.title, truthEvent.title));
  if (truthEvent.location) record(fuzzyContains(matched.location, truthEvent.location));
  if (truthEvent.endTime) record(matched.endTime === truthEvent.endTime);

  return { matched: true, fields: { hit, total } };
}

interface SampleScore {
  recall: number; // matched truth events / truth events
  precision: number; // matched truth events / predicted events
  fieldAccuracy: number; // hits / scored fields over matched events
  matchedCount: number;
  truthCount: number;
  predictedCount: number;
}

function scoreSample(
  truthEvents: TruthEvent[],
  predictions: ExtractedEvent[],
): SampleScore {
  const remaining = [...predictions];
  let hit = 0;
  let fieldHit = 0;
  let fieldTotal = 0;
  for (const truthEvent of truthEvents) {
    const result = scoreEvent(truthEvent, remaining);
    if (result.matched) {
      hit += 1;
      fieldHit += result.fields.hit;
      fieldTotal += result.fields.total;
      const sameDate = remaining.filter((p) => p.date === truthEvent.date);
      const matched =
        sameDate.find((p) => p.time === truthEvent.time) ?? sameDate[0];
      remaining.splice(remaining.indexOf(matched), 1);
    }
  }
  const truthCount = truthEvents.length;
  const predictedCount = predictions.length;
  return {
    recall: truthCount ? hit / truthCount : 1,
    precision: predictedCount ? hit / predictedCount : 1,
    fieldAccuracy: fieldTotal ? fieldHit / fieldTotal : 1,
    matchedCount: hit,
    truthCount,
    predictedCount,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function parseArgs(): { only?: string[]; samples?: string[]; gate: "on" | "off" | "only" } {
  const out: { only?: string[]; samples?: string[]; gate: "on" | "off" | "only" } = {
    gate: "on",
  };
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "only" && value) out.only = value.split(",");
    if (key === "samples" && value) out.samples = value.split(",");
    if (key === "gate" && value) out.gate = value as "on" | "off" | "only";
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const samplesDir = new URL("./samples", import.meta.url).pathname;
  const truthPath = join(samplesDir, "..", "truth.json");

  const truth: Truth = existsSync(truthPath)
    ? JSON.parse(readFileSync(truthPath, "utf8"))
    : {};

  const samples: Sample[] = readdirSync(samplesDir)
    .filter((file) => MIME[extname(file).toLowerCase()])
    .filter((file) => !args.samples || args.samples.includes(file))
    .map((file) => {
      const data = readFileSync(join(samplesDir, file));
      const mime = MIME[extname(file).toLowerCase()];
      return { file, mime, data, dataUrl: `data:${mime};base64,${toBase64(data)}` };
    });

  if (samples.length === 0) {
    console.error("No samples found in ./samples — run `bun run make-samples.ts` first.");
    process.exit(1);
  }

  const strategies = STRATEGIES.filter(
    (s) => !args.only || args.only.includes(s.id),
  );

  console.log(`Models: ${Object.values(MODELS).join(", ")}\n`);
  console.log(`Samples: ${samples.map((s) => s.file).join(", ")}\n`);
  console.log(`Strategies: ${strategies.map((s) => s.id).join(", ")}\n`);

  const ai = makeRestAi();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(new URL("./results", import.meta.url).pathname, stamp);
  mkdirSync(outDir, { recursive: true });

  const summary: Array<{
    strategy: string;
    samples: number;
    errors: number;
    recall: number;
    precision: number;
    fieldAccuracy: number;
    avgLatencyMs: number;
    estCostUsd: number;
  }> = [];

  // ─── Gate phase: would production's Clef check even admit this document? ───
  if (args.gate !== "off") {
    console.log("\n━━━ clef-gate — production 'is this a calendar?' check (threshold 0.5)");
    const gateResults: Array<{
      file: string;
      model: string;
      probability?: number;
      passes: boolean;
      error?: string;
    }> = [];
    for (const sample of samples) {
      if (sample.mime === "application/pdf") {
        console.log(`  ${sample.file.padEnd(28)} — skipped: Clef is images-only (production skips the gate for PDFs)`);
        continue;
      }
      let line = `  ${sample.file.padEnd(28)}`;
      for (const variant of ["clef", "clef-flash"] as const) {
        try {
          const probability = await getCalendarProbability(
            ai as unknown as WorkersTypes.Ai,
            sample.data,
            sample.mime,
            variant,
          );
          const passes = probability >= 0.5;
          gateResults.push({ file: sample.file, model: variant, probability, passes });
          line += `  ${variant} ${probability.toFixed(2)} ${passes ? "PASS" : "REJECT"}`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          gateResults.push({ file: sample.file, model: variant, passes: false, error: message });
          line += `  ${variant} ERROR: ${message.slice(0, 40)}`;
        }
      }
      // Tuned criteria (bench-only proposal): "contains dated events a user
      // might want on a calendar?" — includes betting slips explicitly.
      try {
        const response = await ai.run("@cf/cloudflare/clef", {
          model: "clef",
          state: "A document uploaded by a user who wants its events turned into a calendar file.",
          questions: TUNED_GATE_QUESTION,
          images: [{ content_type: sample.mime, base64: toBase64(sample.data) }],
        });
        const answer = (response as { answers?: Record<string, unknown> })?.answers?.isCalendar;
        const probability =
          typeof answer === "number"
            ? answer
            : ((answer as { noul?: number } | null)?.noul ?? 0);
        const passes = probability >= 0.5;
        gateResults.push({ file: sample.file, model: "clef-tuned", probability, passes });
        line += `  tuned ${probability.toFixed(2)} ${passes ? "PASS" : "REJECT"}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        gateResults.push({ file: sample.file, model: "clef-tuned", passes: false, error: message });
        line += `  tuned ERROR`;
      }
      console.log(line);
    }
    writeFileSync(join(outDir, "clef-gate.json"), JSON.stringify(gateResults, null, 2));
    if (args.gate === "only") {
      console.log("\nGate-only run — skipping extraction strategies.");
      return;
    }
  }

  for (const strategy of strategies) {
    console.log(`\n━━━ ${strategy.id} — ${strategy.description}`);
    const scores: SampleScore[] = [];
    let totalLatency = 0;
    let totalCost = 0;
    let errors = 0;
    let ran = 0;

    for (const sample of samples) {
      const ext = extname(sample.file).toLowerCase();
      if (strategy.extensions && !strategy.extensions.includes(ext)) continue;

      const started = Date.now();
      let result: StrategyResult;
      try {
        result = await strategy.run(ai, sample);
      } catch (err) {
        result = {
          events: [],
          raw: undefined,
          artifacts: {},
          usage: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const latency = Date.now() - started;
      ran += 1;
      totalLatency += latency;
      totalCost += costOf(result.usage);

      const truthEvents = truth[sample.file]?.events ?? [];
      const hasTruth = truthEvents.length > 0;
      const score = hasTruth
        ? scoreSample(truthEvents, result.events)
        : null;
      if (score) scores.push(score);

      if (result.error) errors += 1;
      console.log(
        `  ${sample.file.padEnd(28)} ${latency.toString().padStart(6)}ms  ` +
          `${result.error ? `ERROR: ${result.error.slice(0, 90)}` : `${result.events.length} events${result.artifacts.rescuedByNormalization ? " *rescued*" : ""}`}` +
          (score
            ? `  recall ${(score.recall * 100).toFixed(0)}%  fields ${(score.fieldAccuracy * 100).toFixed(0)}%`
            : hasTruth
              ? ""
              : "  (no truth)"),
      );

      writeFileSync(
        join(outDir, `${strategy.id}--${sample.file}.json`),
        JSON.stringify({ ...result, latencyMs: latency, score }, null, 2),
      );
    }

    const avg = (nums: number[]) =>
      nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    summary.push({
      strategy: strategy.id,
      samples: ran,
      errors,
      recall: avg(scores.map((s) => s.recall)),
      precision: avg(scores.map((s) => s.precision)),
      fieldAccuracy: avg(scores.map((s) => s.fieldAccuracy)),
      avgLatencyMs: ran ? Math.round(totalLatency / ran) : 0,
      estCostUsd: totalCost,
    });
  }

  console.log("\n═══ SUMMARY ═══\n");
  const header =
    "strategy".padEnd(18) +
    "recall".padStart(8) +
    "prec".padStart(7) +
    "fields".padStart(8) +
    "latency".padStart(10) +
    "cost".padStart(10) +
    "errors".padStart(8);
  console.log(header);
  for (const row of summary) {
    console.log(
      row.strategy.padEnd(18) +
        `${(row.recall * 100).toFixed(0)}%`.padStart(8) +
        `${(row.precision * 100).toFixed(0)}%`.padStart(7) +
        `${(row.fieldAccuracy * 100).toFixed(0)}%`.padStart(8) +
        `${row.avgLatencyMs}ms`.padStart(10) +
        `$${row.estCostUsd.toFixed(4)}`.padStart(10) +
        String(row.errors).padStart(8),
    );
  }
  console.log(`\nFull transcripts + per-sample scores in ${outDir}`);
}

await main();
