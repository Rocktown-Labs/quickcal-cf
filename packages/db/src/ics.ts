import { createEvents, type EventAttributes } from "ics";

export interface CalendarEvent {
  date: string;
  time?: string;
  /** Optional end date (YYYY-MM-DD) for events spanning midnight. */
  endDate?: string;
  /** Optional end time (HH:MM) — defaults to time+1h / 1-day duration. */
  endTime?: string;
  /** Display title. Falls back to `description` when omitted. */
  title?: string;
  description: string;
  location?: string;
}

function parseDateParts(event: { date: string }): [number, number, number] {
  const [year, month, day] = event.date.split("-").map(Number);
  if (!year || !month || !day || [year, month, day].some(isNaN)) {
    throw new Error(`Invalid date format: ${event.date}`);
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date: ${event.date}`);
  }
  return [year, month, day];
}

function parseTimeParts(value: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid time format: ${value}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`Invalid time: ${value}`);
  }
  return [hour, minute];
}

function nextDay([year, month, day]: [number, number, number]): [number, number, number] {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
}

function toIcsEvent(event: CalendarEvent): EventAttributes {
  const start = parseDateParts(event);
  const location = event.location?.trim() ? event.location.trim().slice(0, 300) : undefined;
  const title = event.title?.trim() || event.description;

  // If a specific time is provided, create a timed event with a 1-hour
  // duration (or until the provided end time).
  if (event.time && event.time.trim() !== "") {
    const [hour, minute] = parseTimeParts(event.time);
    const hasEnd = Boolean(event.endTime && event.endTime.trim() !== "");

    if (hasEnd) {
      const [endHour, endMinute] = parseTimeParts(event.endTime!.trim());
      let endDate = event.endDate ? parseDateParts({ date: event.endDate }) : start;
      // Overnight event (23:00 → 01:00): roll the end into the next day when
      // the end still falls on the start date.
      const sameDay = endDate[0] === start[0] && endDate[1] === start[1] && endDate[2] === start[2];
      if (sameDay && (endHour < hour || (endHour === hour && endMinute <= minute))) {
        endDate = nextDay(endDate);
      }
      return {
        title,
        description: event.description,
        start: [...start, hour, minute] as [number, number, number, number, number],
        end: [...endDate, endHour, endMinute] as [number, number, number, number, number],
        // Emit floating wall-clock times. The `ics` default converts local
        // components to UTC using the runtime timezone, which would shift
        // times on non-UTC hosts.
        startOutputType: "local",
        endOutputType: "local",
        ...(location ? { location } : {}),
      };
    }

    return {
      title,
      description: event.description,
      start: [...start, hour, minute] as [number, number, number, number, number],
      startOutputType: "local",
      ...(location ? { location } : {}),
      duration: { hours: 1 },
    };
  }

  // Otherwise, create an all-day event by specifying a 1-day duration.
  return {
    title,
    description: event.description,
    start,
    ...(location ? { location } : {}),
    duration: { days: 1 },
  };
}

export function calendarEventsToICS(events: CalendarEvent[]): string {
  const { error, value } = createEvents(events.map(toIcsEvent));
  if (error) {
    throw new Error(`Failed to generate ICS file: ${error.message}`);
  }
  return value!;
}

// For AI-extracted events - treat times as document local time.
export function generateICSForAI(events: CalendarEvent[]): string {
  return calendarEventsToICS(events);
}

// Manual events use the same floating wall-clock representation.
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
  const dateOf = (d: Date) =>
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return calendarEventsToICS(
    rows.map((row) => ({
      date: dateOf(row.startTime),
      time: row.isAllDay
        ? ""
        : `${pad(row.startTime.getUTCHours())}:${pad(row.startTime.getUTCMinutes())}`,
      endDate: !row.isAllDay && row.endTime ? dateOf(row.endTime) : undefined,
      endTime:
        !row.isAllDay && row.endTime
          ? `${pad(row.endTime.getUTCHours())}:${pad(row.endTime.getUTCMinutes())}`
          : "",
      title: row.title,
      description: row.description ? `${row.title}\n\n${row.description}` : row.title,
      location: row.location ?? undefined,
    })),
  );
}
