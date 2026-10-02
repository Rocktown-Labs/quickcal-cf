import { createEvents, type EventAttributes } from "ics";

export interface CalendarEvent {
  date: string;
  time?: string;
  /** Optional end time (HH:MM) — defaults to time+1h / 1-day duration. */
  endTime?: string;
  description: string;
  location?: string;
  timezone?: string;
}

function parseDateParts(event: { date: string }): [number, number, number] {
  const [year, month, day] = event.date.split("-").map(Number);
  if (!year || !month || !day || [year, month, day].some(isNaN)) {
    throw new Error(`Invalid date format: ${event.date}`);
  }
  return [year, month, day];
}

function parseTimeParts(value: string): [number, number] {
  const [hour, minute] = value.split(":").map(Number);
  if (hour === undefined || minute === undefined || [hour, minute].some(isNaN)) {
    throw new Error(`Invalid time format: ${value}`);
  }
  return [hour, minute];
}

function toIcsEvent(event: CalendarEvent): EventAttributes {
  const start = parseDateParts(event);
  const location = event.location?.trim() ? event.location.trim().slice(0, 300) : undefined;

  // If a specific time is provided, create a timed event with a 1-hour
  // duration (or until the provided end time).
  if (event.time && event.time.trim() !== "") {
    const [hour, minute] = parseTimeParts(event.time);
    const hasEnd = Boolean(event.endTime && event.endTime.trim() !== "");
    const [endHour, endMinute] = hasEnd ? parseTimeParts(event.endTime!.trim()) : [0, 0];

    return {
      title: event.description,
      description: event.description,
      start: [...start, hour, minute] as [number, number, number, number, number],
      ...(location ? { location } : {}),
      ...(hasEnd
        ? { end: [...start, endHour, endMinute] as [number, number, number, number, number] }
        : { duration: { hours: 1 } }),
    };
  }

  // Otherwise, create an all-day event by specifying a 1-day duration.
  return {
    title: event.description,
    description: event.description,
    start,
    ...(location ? { location } : {}),
    duration: { days: 1 },
  };
}

export function calendarEventsToICS(events: CalendarEvent[]): string {
  const { error, value } = createEvents(events.map(toIcsEvent));
  if (error) {
    throw new Error("Failed to generate ICS file");
  }
  return value!;
}

// For AI-extracted events - treat times as document local time
export function generateICSForAI(events: CalendarEvent[]): string {
  return calendarEventsToICS(events);
}

// For manual events - respect user's timezone
export function generateICSForManual(events: CalendarEvent[]): string {
  return calendarEventsToICS(events);
}

// Legacy function - kept for backward compatibility
export function generateICS(events: CalendarEvent[]): string {
  // Default to AI extraction behavior for backward compatibility
  return generateICSForAI(events);
}

// Shape of an `events` row as selected by the review/feed queries.
export interface EventRow {
  title: string;
  description: string | null;
  location: string | null;
  startTime: Date;
  endTime: Date | null;
  isAllDay: boolean;
}

/**
 * Regenerates an .ics from stored event rows (review edits, aggregate feed).
 *
 * Invariant: both the AI and manual paths encode the *intended wall-clock
 * time* as UTC (e.g. `2026-10-02T19:00:00Z` means "7pm in the document's
 * local time"), so reading the UTC components back out reproduces the same
 * floating times the original file carried.
 */
export function generateICSFromRows(rows: EventRow[]): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return calendarEventsToICS(
    rows.map((row) => ({
      date: `${row.startTime.getUTCFullYear()}-${pad(row.startTime.getUTCMonth() + 1)}-${pad(row.startTime.getUTCDate())}`,
      time: row.isAllDay
        ? ""
        : `${pad(row.startTime.getUTCHours())}:${pad(row.startTime.getUTCMinutes())}`,
      endTime:
        !row.isAllDay && row.endTime
          ? `${pad(row.endTime.getUTCHours())}:${pad(row.endTime.getUTCMinutes())}`
          : "",
      description: row.title,
      location: row.location ?? undefined,
    })),
  );
}
