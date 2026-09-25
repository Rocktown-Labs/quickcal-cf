import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  createDb,
  events,
  generateICSForAI,
  generateShareToken,
  updateUploadRecord,
  type Database,
} from "@quickcal-cf/db";
import {
  extractEventsFromDocument,
  isDocumentCalendar,
  type ExtractedEvent,
} from "../lib/ai";

export interface CalendarProcessingInput {
  uploadId: string;
  storageKey: string;
  fileName: string;
  fileType: string;
  userId: string;
}

export interface CalendarProcessingResult {
  uploadId: string;
  eventCount: number;
  status: "completed" | "no_events" | "failed";
  icsKey?: string;
  shareToken?: string;
}

export class CalendarProcessingWorkflow extends WorkflowEntrypoint<
  Env,
  CalendarProcessingInput
> {
  private db(): Database {
    return createDb(this.env);
  }

  private async getSourceFile(
    storageKey: string,
    fileType: string,
  ): Promise<{ data: Uint8Array; contentType: string }> {
    const object = await this.env.FILES.get(storageKey);
    if (!object) {
      throw new Error("Source file not found in storage");
    }
    const arrayBuffer = await object.arrayBuffer();
    return {
      data: new Uint8Array(arrayBuffer),
      contentType: object.httpMetadata?.contentType ?? fileType,
    };
  }

  async run(
    event: Readonly<WorkflowEvent<CalendarProcessingInput>>,
    step: WorkflowStep,
  ): Promise<CalendarProcessingResult> {
    const { uploadId, userId, storageKey, fileType } = event.payload;
    const db = this.db();

    try {
      await step.do("mark-processing", async () => {
        await updateUploadRecord(db, uploadId, {
          status: "processing",
          failureReason: null,
        });
      });

      const isCalendar = await step.do("check-is-calendar", async () => {
        const { data, contentType } = await this.getSourceFile(storageKey, fileType);
        return isDocumentCalendar(this.env.GOOGLE_GENERATIVE_AI_API_KEY, data, contentType);
      });

      if (!isCalendar) {
        const failureReason =
          "The uploaded file did not appear to contain a calendar or schedule.";
        await step.do("mark-no-events", async () => {
          await updateUploadRecord(db, uploadId, {
            status: "no_events",
            failureReason,
          });
        });
        return { uploadId, eventCount: 0, status: "no_events" };
      }

      const extractedEvents = await step.do("extract-events", async () => {
        const { data, contentType } = await this.getSourceFile(storageKey, fileType);
        return extractEventsFromDocument(
          this.env.GOOGLE_GENERATIVE_AI_API_KEY,
          data,
          contentType,
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
        return { uploadId, eventCount: 0, status: "no_events" };
      }

      const result = await step.do("persist", async () => {
        const validEvents = extractedEvents.filter(
          (e) => e.date && e.date.trim() !== "",
        );

        const shareToken = generateShareToken();
        const icsKey = `ics/${shareToken}.ics`;
        const icsContent = generateICSForAI(
          validEvents.map((e) => ({
            date: e.date,
            time: e.time,
            description: e.description,
          })),
        );

        await this.env.FILES.put(icsKey, icsContent, {
          httpMetadata: { contentType: "text/calendar" },
        });

        await this.insertEvents(db, uploadId, userId, validEvents);

        await updateUploadRecord(db, uploadId, {
          status: "completed",
          icsKey,
          shareToken,
          failureReason: null,
        });

        return { icsKey, shareToken, eventCount: validEvents.length };
      });

      return {
        uploadId,
        eventCount: result.eventCount,
        status: "completed",
        icsKey: result.icsKey,
        shareToken: result.shareToken,
      };
    } catch (error) {
      await step.do("mark-failed", async () => {
        await updateUploadRecord(db, uploadId, {
          status: "failed",
          failureReason:
            error instanceof Error ? error.message : "Unknown workflow failure.",
        });
      });
      return { uploadId, eventCount: 0, status: "failed" };
    }
  }

  private async insertEvents(
    db: Database,
    uploadId: string,
    userId: string,
    extractedEvents: ExtractedEvent[],
  ): Promise<void> {
    for (const event of extractedEvents) {
      await db.insert(events).values({
        id: crypto.randomUUID(),
        title: event.description,
        description: event.description,
        startTime: new Date(`${event.date}T${event.time || "00:00"}:00Z`),
        isAllDay: false,
        uploadId,
        userId,
      });
    }
  }
}
