import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  createDb,
  events,
  generateICSForAI,
  generateShareToken,
  getUploadById,
  updateUploadRecord,
  type Database,
} from "@quickcal-cf/db";
import {
  extractEventsFromDocument,
  extractEventsFromText,
  classifyDocument,
  type ExtractedEvent,
} from "../lib/ai";
import { sendWebhook, webhookSecretFor } from "../lib/webhook";

export interface CalendarProcessingInput {
  uploadId: string;
  storageKey: string;
  fileName: string;
  fileType: string;
  userId: string;
  /** "text" skips the vision gate and extracts from the stored text file. */
  sourceType: "file" | "text";
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

      if (sourceType !== "text") {
        const isCalendar = await step.do(
          "check-is-calendar",
          // Transient AI-provider hiccups (rate limits, shared-GPU 429s)
          // shouldn't fail the upload on the first hit.
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => {
            const { data, contentType } = await this.getSourceFile(storageKey, fileType);
            return classifyDocument({
              ai: this.env.AI,
              geminiApiKey: this.env.GOOGLE_GENERATIVE_AI_API_KEY,
              data,
              contentType,
            });
          },
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

      const extractedEvents = await step.do("extract-events", async () => {
        const source = await this.getSourceFile(storageKey, fileType);
        return sourceType === "text"
          ? extractEventsFromText(this.env.GOOGLE_GENERATIVE_AI_API_KEY, source.text)
          : extractEventsFromDocument(
              this.env.GOOGLE_GENERATIVE_AI_API_KEY,
              source.data,
              source.contentType,
            );
      });

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
      result = { uploadId, eventCount: 0, status: "failed" };
      return this.finish(step, db, uploadId, userId, result);
    }
  }

  /**
   * Fires the signed webhook (if the upload carries a callbackUrl) once the
   * terminal state is durable. Runs as its own retried step so a flaky
   * callback target never re-runs extraction.
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
