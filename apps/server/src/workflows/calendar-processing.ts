import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  createDb,
  events,
  generateICSForAI,
  generateShareToken,
  getUploadById,
  refundFreeCredit,
  updateUploadRecord,
  type Database,
} from "@quickcal-cf/db";
import {
  extractEventsFromText,
  isDocumentCalendarClef,
  shouldUseClefGate,
  type ExtractedEvent,
} from "../lib/ai";
import { ocrDocument } from "../lib/ocr";
import { sendWebhook, webhookSecretFor } from "../lib/webhook";

export interface CalendarProcessingInput {
  uploadId: string;
  storageKey: string;
  fileName: string;
  fileType: string;
  userId: string;
  /** "text" extracts from the stored text directly; "file" OCRs first. */
  sourceType: "file" | "text";
  /** True when a free-trial credit paid for this ingestion — refunded if the run fails. */
  creditUsed?: boolean;
}

export interface CalendarProcessingResult {
  uploadId: string;
  eventCount: number;
  status: "completed" | "no_events" | "failed";
  icsKey?: string;
  shareToken?: string;
}

export class CalendarProcessingWorkflow extends WorkflowEntrypoint<Env, CalendarProcessingInput> {
  private db(): Database {
    return createDb(this.env);
  }

  private async getSourceFile(
    storageKey: string,
    fileType: string,
  ): Promise<{ data: Uint8Array; text: string; contentType: string }> {
    const object = await this.env.FILES.get(storageKey);
    if (!object) {
      throw new Error("Source file not found in storage");
    }
    const arrayBuffer = await object.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    return {
      data: bytes,
      text: new TextDecoder().decode(bytes),
      contentType: object.httpMetadata?.contentType ?? fileType,
    };
  }

  async run(
    event: Readonly<WorkflowEvent<CalendarProcessingInput>>,
    step: WorkflowStep,
  ): Promise<CalendarProcessingResult> {
    const { uploadId, userId, storageKey, fileType, sourceType } = event.payload;
    const db = this.db();

    let result: CalendarProcessingResult;

    try {
      await step.do("mark-processing", async () => {
        await updateUploadRecord(db, uploadId, {
          status: "processing",
          failureReason: null,
        });
      });

      // The gate runs only where it's free and in-network: in-spec images,
      // via Clef on the Workers AI binding. PDFs and oversized images skip
      // the pixel gate entirely — they're OCR'd first and extraction decides
      // (see the "ocr" step), which answers "is this a calendar?" implicitly
      // for the formats Clef can't read.
      if (sourceType !== "text") {
        const { data, contentType } = await this.getSourceFile(storageKey, fileType);

        if (shouldUseClefGate(contentType, data.byteLength)) {
          const isCalendar = await step.do(
            "check-is-calendar",
            // Transient AI-provider hiccups (rate limits, shared-GPU 429s)
            // shouldn't fail the upload on the first hit. Clef failures throw
            // here — never mislabeled as "not a calendar".
            { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
            () => isDocumentCalendarClef(this.env.AI, data, contentType),
          );

          if (!isCalendar) {
            const failureReason =
              "The uploaded file did not appear to contain a calendar or schedule.";
            await step.do("mark-no-events", async () => {
              await updateUploadRecord(db, uploadId, {
                status: "no_events",
                failureReason,
              });
            });
            result = { uploadId, eventCount: 0, status: "no_events" };
            return this.finish(step, db, uploadId, userId, result);
          }
        }
      }

      // Every non-text source becomes text first: images and PDFs are OCR'd
      // by GLM-OCR (z.ai), which also handles what Clef cannot read. The
      // workflow retries transient provider failures; hard OcrErrors surface
      // as the upload's failureReason (e.g. WebP, missing key).
      let scheduleText: string;
      if (sourceType === "text") {
        const source = await this.getSourceFile(storageKey, fileType);
        scheduleText = source.text;
      } else {
        scheduleText = await step.do(
          "ocr",
          { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
          async () => {
            const { data, contentType } = await this.getSourceFile(storageKey, fileType);
            return ocrDocument(
              {
                apiKey: this.env.ZAI_API_KEY,
                url: this.env.ZAI_LAYOUT_PARSING_URL,
              },
              data,
              contentType,
            );
          },
        );
      }

      const extractedEvents = await step.do(
        "extract-events",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        () =>
          extractEventsFromText(
            this.env.AI,
            scheduleText,
            this.env.EXTRACTION_MODEL ?? undefined,
          ),
      );

      if (extractedEvents.length === 0) {
        const failureReason = "No calendar events were found in the uploaded document.";
        await step.do("mark-no-events", async () => {
          await updateUploadRecord(db, uploadId, {
            status: "no_events",
            failureReason,
          });
        });
        result = { uploadId, eventCount: 0, status: "no_events" };
        return this.finish(step, db, uploadId, userId, result);
      }

      const persist = await step.do("persist", async () => {
        const validEvents = extractedEvents.filter((e) => e.date && e.date.trim() !== "");

        // Dedupe (date, time, description) — the AI is told not to repeat
        // itself, but don't trust it.
        const seen = new Set<string>();
        const uniqueEvents = validEvents.filter((e) => {
          const key = `${e.date}|${e.time ?? ""}|${e.description}`.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        if (uniqueEvents.length === 0) {
          return null;
        }

        // Reuse the token from a previous attempt so a retried persist step
        // overwrites the same .ics object instead of orphaning one per retry.
        const existing = await getUploadById(db, uploadId);
        const shareToken = existing?.shareToken ?? generateShareToken();
        const icsKey = existing?.icsKey ?? `ics/${shareToken}.ics`;
        const icsContent = generateICSForAI(
          uniqueEvents.map((e) => ({
            date: e.date,
            time: e.time,
            endTime: e.endTime || "",
            description: e.title || e.description,
            location: e.location || "",
          })),
        );

        await this.env.FILES.put(icsKey, icsContent, {
          httpMetadata: { contentType: "text/calendar" },
        });

        await this.insertEvents(db, uploadId, userId, uniqueEvents);

        await updateUploadRecord(db, uploadId, {
          status: "completed",
          icsKey,
          shareToken,
          failureReason: null,
        });

        return { icsKey, shareToken, eventCount: uniqueEvents.length };
      });

      if (!persist) {
        const failureReason = "No calendar events were found in the uploaded document.";
        await step.do("mark-no-events", async () => {
          await updateUploadRecord(db, uploadId, {
            status: "no_events",
            failureReason,
          });
        });
        result = { uploadId, eventCount: 0, status: "no_events" };
        return this.finish(step, db, uploadId, userId, result);
      }

      result = {
        uploadId,
        eventCount: persist.eventCount,
        status: "completed",
        icsKey: persist.icsKey,
        shareToken: persist.shareToken,
      };
      return this.finish(step, db, uploadId, userId, result);
    } catch (error) {
      await step.do("mark-failed", async () => {
        await updateUploadRecord(db, uploadId, {
          status: "failed",
          failureReason: error instanceof Error ? error.message : "Unknown workflow failure.",
        });
      });
      // A failed run delivered nothing — don't keep the free-trial credit.
      if (event.payload.creditUsed) {
        await refundFreeCredit(db, userId);
      }
      result = { uploadId, eventCount: 0, status: "failed" };
      return this.finish(step, db, uploadId, userId, result);
    }
  }

  /**
   * Fires the signed webhook (if the upload carries a callbackUrl) once the
   * terminal state is durable. Runs as its own retried step so a flaky
   * callback target never re-runs extraction — and if the target stays
   * broken, delivery is logged and abandoned rather than failing the
   * workflow (which would let the status reconciler mislabel a completed
   * upload as failed).
   */
  private async finish(
    step: WorkflowStep,
    db: Database,
    uploadId: string,
    userId: string,
    result: CalendarProcessingResult,
  ): Promise<CalendarProcessingResult> {
    const upload = await getUploadById(db, uploadId);

    if (upload?.callbackUrl) {
      try {
        await step.do(
          "webhook",
          { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } },
          async () => {
            const secret = await webhookSecretFor(this.env.BETTER_AUTH_SECRET, userId);
            await sendWebhook(upload.callbackUrl!, secret, {
              event: `upload.${result.status}`,
              uploadId,
              status: result.status,
              eventCount: result.eventCount,
              failureReason: upload.failureReason ?? null,
              shareToken: result.shareToken ?? null,
              downloadPath: result.shareToken ? `/api/share/${result.shareToken}/ics` : null,
              sentAt: new Date().toISOString(),
            });
          },
        );
      } catch (err) {
        console.warn(
          `[webhook] delivery abandoned for upload ${uploadId} (${upload.callbackUrl}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return result;
  }

  private async insertEvents(
    db: Database,
    uploadId: string,
    userId: string,
    extractedEvents: ExtractedEvent[],
  ): Promise<void> {
    for (const event of extractedEvents) {
      const startTime = new Date(`${event.date}T${event.time || "00:00"}:00Z`);
      const endTime =
        event.time && event.endTime ? new Date(`${event.date}T${event.endTime}:00Z`) : null;
      await db.insert(events).values({
        id: crypto.randomUUID(),
        title: event.title || event.description,
        description: event.description,
        location: event.location || null,
        startTime,
        endTime,
        // No time extracted → treat as an all-day event.
        isAllDay: !event.time,
        confidence: event.confidence ?? null,
        sourceQuote: event.sourceQuote ?? null,
        uploadId,
        userId,
      });
    }
  }
}
