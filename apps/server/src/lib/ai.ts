import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { z } from "zod";

export interface ExtractedEvent {
  id: number;
  date: string;
  time: string;
  description: string;
}

const extractedEventSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  time: z.string().regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/, "Time must be in HH:MM format"),
  description: z.string().trim().min(1).max(1000),
});

const extractedEventsSchema = z.array(extractedEventSchema);

function toBase64(data: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    bin += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export async function isDocumentCalendar(
  apiKey: string,
  fileData: Uint8Array,
  fileType: string,
): Promise<boolean> {
  try {
    const google = createGoogleGenerativeAI({ apiKey });
    const dataUrl = `data:${fileType};base64,${toBase64(fileData)}`;

    const { text } = await generateText({
      model: google("gemini-2.5-pro"),
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

    return text?.trim().toLowerCase() === "yes";
  } catch {
    return false;
  }
}

export async function extractEventsFromDocument(
  apiKey: string,
  fileData: Uint8Array,
  fileType: string,
): Promise<ExtractedEvent[]> {
  const google = createGoogleGenerativeAI({ apiKey });
  const dataUrl = `data:${fileType};base64,${toBase64(fileData)}`;

  const { text } = await generateText({
    model: google("gemini-2.5-flash"),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze the provided calendar, schedule, or agenda document. Please examine ALL pages and identify all distinct events, appointments, or line items across the entire document. For each item, extract the date (YYYY-MM-DD format), time (HH:MM 24 hour format), and a brief description. If a date or time is not explicitly mentioned for an item, leave the corresponding field as an empty string. Return the data as a JSON array of objects with no duplicates.`,
          },
          {
            type: "image",
            image: dataUrl,
          },
        ],
      },
    ],
  });

  if (text === undefined) {
    return [];
  }

  const cleanedText = text
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/\s*```$/, "");

  if (cleanedText === "") {
    return [];
  }

  const raw: unknown = JSON.parse(cleanedText);
  const parsed = extractedEventsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid AI extraction output: ${parsed.error.message}`);
  }

  return parsed.data.map((item, index) => ({
    ...item,
    id: Date.now() + index,
  }));
}
