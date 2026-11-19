import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import * as Sentry from "@sentry/cloudflare";
import {
  createDb,
  deleteEventsForUpload,
  events,
  generateICSForAI,
  generateShareToken,
  getUploadById,
  getUserProfile,
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
  /**
   * Retained for in-flight payload compatibility. The one-time credit is
   * refunded only before the run starts; a running/failed workflow consumes it.
   */
  creditUsed?: boolean;
}

export interface CalendarProcessingResult {
  uploadId: string;
  eventCount: number;
  status: "completed" | "no_events" | "failed";
  icsKey?: string;
  shareToken?: string;
}

function isValidEventDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export class CalendarProcessingWorkflow extends WorkflowEntrypoint<Env, CalendarProcessingInput> {
  private db(): Database {
    return createDb(this.env);
  }

  private async getSourceFile(
    storageKey: string,
    fileType: string,
    decodeText = false,
  ): Promise<{ data: Uint8Array; text: string; contentType: string }> {
    const object = await this.env.FILES.get(storageKey);
    if (!object) {
      throw new Error("Source file not found in storage");
    }
    const arrayBuffer = await object.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    return {
      data: bytes,
      // Only the text path needs a full UTF-8 decode.
      text: decodeText ? new TextDecoder().decode(bytes) : "",
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
          // The ingestion route normally writes this immediately after
          // starting the workflow. Writing it here too reconciles the row if
          // that best-effort write failed, so /by-run/{runId}/status works.
          workflowRunId: event.instanceId,
          status: "processing",
          failureReason: null,
        });
      });

      // The gate runs only where it's free and in-network: in-spec images,
      // via Clef on the Workers AI binding. PDFs and oversized images skip
      // the pixel gate entirely — extraction decides on what it finds, which
      // answers "is this a calendar?" implicitly for the formats Clef can't
      // read. The read lives inside the step so a transient R2 error is
      // retried instead of failing the upload.
      if (sourceType !== "text") {
        const isCalendar = await step.do(
          "check-is-calendar",
          // Transient AI-provider hiccups (rate limits, shared-GPU 429s)
          // shouldn't fail the upload on the first hit. Clef failures throw
          // here — never mislabeled as "not a calendar".
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => {
            const { data, contentType } = await this.getSourceFile(storageKey, fileType);
            if (!shouldUseClefGate(contentType, data.byteLength)) return true;
            return isDocumentCalendarClef(this.env.AI, data, contentType);
          },
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
            const source = await this.getSourceFile(storageKey, fileType, true);
            return extractEventsFromText(
              this.env.AI,
              source.text,
              this.env.EXTRACTION_MODEL ?? undefined,
              capturedOn,
            );
          }

          const { data, text, contentType } = await this.getSourceFile(storageKey, fileType);
          if (contentType.startsWith("image/")) {
            return extractEventsFromImage(
              this.env.AI,
              data,
              contentType,
              this.env.EXTRACTION_MODEL ?? undefined,
              capturedOn,
            );
          }

          if (contentType.startsWith("text/")) {
            return extractEventsFromText(
              this.env.AI,
              text,
              this.env.EXTRACTION_MODEL ?? undefined,
              capturedOn,
            );
          }

          if (
            contentType === "application/pdf" ||
            contentType === "application/x-pdf" ||
            contentType === "application/octet-stream"
          ) {
            const pdfText = await extractPdfText(data);
            return extractEventsFromText(
              this.env.AI,
              pdfText,
              this.env.EXTRACTION_MODEL ?? undefined,
              capturedOn,
            );
          }

          throw new Error(`Unsupported file type for extraction: ${contentType}`);
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

        // Drop impossible model dates before ICS generation (which throws)
        // and before insertion, so one bad row can't fail the batch.
        const persistableEvents = uniqueEvents.filter((e) => isValidEventDate(e.date));
        if (persistableEvents.length === 0) {
          return null;
        }
        if (persistableEvents.length !== uniqueEvents.length) {
          console.warn(
            `[workflow] skipped ${uniqueEvents.length - persistableEvents.length} event(s) with invalid dates`,
            { uploadId },
          );
        }

        // Reuse the token from a previous attempt so a retried persist step
        // overwrites the same .ics object instead of orphaning one per retry.
        const existing = await getUploadById(db, uploadId);
        const shareToken = existing?.shareToken ?? generateShareToken();
        const icsKey = existing?.icsKey ?? `ics/${shareToken}.ics`;
        const icsContent = generateICSForAI(
          persistableEvents.map((e) => ({
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
        const inserted = await this.insertEvents(db, uploadId, userId, persistableEvents);
        if (inserted === 0) return null;

        await updateUploadRecord(db, uploadId, {
          status: "completed",
          icsKey,
          shareToken,
          failureReason: null,
        });

        return { icsKey, shareToken, eventCount: inserted };
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
      const finalStatus = await step.do("mark-failed", async () => {
        // A notification/finish failure must not overwrite a terminal state.
        const current = await getUploadById(db, uploadId);
        if (current?.status === "completed" || current?.status === "no_events") {
          return current.status;
        }

        Sentry.captureException(error);
        Sentry.logger.error("Calendar processing failed", { sourceType });
        Sentry.metrics.count("calendar.processing.failed", 1, { attributes: { sourceType } });
        await updateUploadRecord(db, uploadId, {
          workflowRunId: event.instanceId,
          status: "failed",
          failureReason: "Processing failed. Please try again.",
        });
        return "failed" as const;
      });
      // The free trial credit is one-time. It is refunded only if the run
      // never started (validation/storage/workflow-start failure, handled by
      // the ingestion route). Once the workflow is running, an AI failure or
      // an unparseable document consumes it — otherwise a user could force
      // failures and get unlimited free AI work.
      result = { uploadId, eventCount: 0, status: finalStatus };
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
    // Notifications are best-effort. A failure here must never bubble into
    // the outer catch and rewrite an already-completed upload as failed.
    try {
      await step.do("record-processing-outcome", async () => {
        const attributes = { outcome: result.status, event_count: result.eventCount };
        Sentry.metrics.count("calendar.processing.finished", 1, {
          attributes: { outcome: result.status },
        });
        Sentry.logger.info("Calendar processing finished", attributes);
        return null;
      });
      const upload = await step.do("load-upload-for-finish", async () =>
        getUploadById(db, uploadId),
      );

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
          Sentry.captureException(err, { tags: { operation: "webhook_delivery" } });
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
    } catch (err) {
      console.warn(
        `[finish] notification step failed for upload ${uploadId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return result;
    }
  }

  private async insertEvents(
    db: Database,
    uploadId: string,
    userId: string,
    extractedEvents: ExtractedEvent[],
  ): Promise<number> {
    let inserted = 0;
    for (const event of extractedEvents) {
      const startTime = new Date(`${event.date}T${event.time || "00:00"}:00Z`);
      if (
        Number.isNaN(startTime.getTime()) ||
        startTime.toISOString().slice(0, 10) !== event.date
      ) {
        // Noisy model output must not fail the whole upload; skip and log.
        console.warn(`[workflow] skipping event with invalid date "${event.date}"`, { uploadId });
        continue;
      }
      let endTime: Date | null = null;
      if (event.time && event.endTime) {
        endTime = new Date(`${event.date}T${event.endTime}:00Z`);
        if (Number.isNaN(endTime.getTime())) {
          endTime = null;
        } else if (endTime <= startTime) {
          // Overnight event: the end belongs to the next day.
          endTime = new Date(endTime.getTime() + 24 * 60 * 60 * 1000);
        }
      }
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
      inserted += 1;
    }
    return inserted;
  }
}
