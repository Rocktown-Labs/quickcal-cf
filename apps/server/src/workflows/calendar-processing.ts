import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  createDb,
  deleteEventsForUpload,
  events,
  generateICSForAI,
  generateShareToken,
  getUploadById,
  getUserProfile,
  refundFreeCredit,
  updateUploadRecord,
  type Database,
} from "@quickcal-cf/db";
import {
  extractEventsFromImage,
  extractEventsFromText,
  isDocumentCalendarClef,
  shouldUseClefGate,
  type ExtractedEvent,
} from "../lib/ai";
import { extractPdfText } from "../lib/pdf-text";
import { sendProcessingCompleteEmail } from "../lib/notifications";
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
      // the pixel gate entirely — extraction decides on what it finds, which
      // answers "is this a calendar?" implicitly for the formats Clef can't
      // read.
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
            const failureReason = "The uploaded file did not appear to contain any dated events.";
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

      // Screenshots and flyers often use relative dates ("today", "this
      // Saturday"). The extraction prompt is told never to invent dates, so
      // it needs the date the document was captured — the upload timestamp,
      // which for schedule photos is effectively the same day.
      const upload = await step.do("get-upload", async () => getUploadById(db, uploadId));
      const capturedOn = (upload?.createdAt ? new Date(upload.createdAt) : new Date())
        .toISOString()
        .slice(0, 10);

      const extractedEvents = await step.do(
        "extract-events",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          if (sourceType === "text") {
            const source = await this.getSourceFile(storageKey, fileType);
            return extractEventsFromText(
              this.env.AI,
              source.text,
              this.env.EXTRACTION_MODEL ?? undefined,
              capturedOn,
            );
          }

          const { data, contentType } = await this.getSourceFile(storageKey, fileType);
          if (contentType.startsWith("image/")) {
            return extractEventsFromImage(
              this.env.AI,
              data,
              contentType,
              this.env.EXTRACTION_MODEL ?? undefined,
              capturedOn,
            );
          }

          const pdfText = await extractPdfText(data);
          return extractEventsFromText(
            this.env.AI,
            pdfText,
            this.env.EXTRACTION_MODEL ?? undefined,
            capturedOn,
          );
        },
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

        // The step may retry after a partial failure. Clear any rows from the
        // previous attempt so a retry cannot duplicate events in the .ics.
        await deleteEventsForUpload(db, uploadId);
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
        // Log only the origin: callback URLs may carry secret query tokens.
        let callbackOrigin = "invalid";
        try {
          callbackOrigin = new URL(upload.callbackUrl).origin;
        } catch {
          // keep the placeholder
        }
        console.warn(
          `[webhook] delivery abandoned for upload ${uploadId} (${callbackOrigin}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Automatic completion email for browser uploads. Agent/API uploads that
    // supplied a callback already get their result through the signed webhook,
    // so skip the inbox noise for those.
    const shareToken = upload?.shareToken;
    if (result.status === "completed" && shareToken && !upload?.callbackUrl) {
      try {
        await step.do("send-completion-email", async () => {
          const profile = await getUserProfile(db, userId);
          if (!profile?.email) return;

          const webOrigin =
            (this.env.CORS_ORIGIN ?? "").split(",")[0]?.trim().replace(/\/+$/, "") ||
            this.env.BETTER_AUTH_URL;

          await sendProcessingCompleteEmail({
            uploadId,
            userId,
            to: profile.email,
            fileName: upload.fileName,
            eventCount: result.eventCount,
            shareUrl: `${webOrigin}/s/${shareToken}`,
            icsUrl: `${this.env.BETTER_AUTH_URL}/api/share/${shareToken}/ics`,
          });
        });
      } catch (err) {
        console.warn(
          `[email] completion email abandoned for upload ${uploadId}: ${
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
