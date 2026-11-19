import { describe, expect, test } from "bun:test";
import { generateICS, generateICSForAI, generateICSForManual, generateICSFromRows } from "./ics";

describe("generateICSFromRows (review edits / aggregate feed)", () => {
  const timedRow = {
    id: "event-1",
    title: "Biology 101",
    description: null,
    location: "Room 214",
    // Wall-clock 14:30 encoded as UTC — the storage invariant.
    startTime: new Date("2026-10-01T14:30:00Z"),
    endTime: new Date("2026-10-01T16:00:00Z"),
    isAllDay: false,
  };

  test("round-trips a timed row back into floating local time with end + location", () => {
    const ics = generateICSFromRows([timedRow]);
    expect(ics).toContain("SUMMARY:Biology 101");
    expect(ics).toContain("DTSTART:20261001T143000");
    expect(ics).toContain("DTEND:20261001T160000");
    expect(ics).toContain("LOCATION:Room 214");
  });

  test("falls back to a 1-hour duration when there is no end time", () => {
    const ics = generateICSFromRows([{ ...timedRow, endTime: null }]);
    expect(ics).toContain("DURATION:PT1H");
  });

  test("renders all-day rows as date-only events", () => {
    const ics = generateICSFromRows([
      { ...timedRow, startTime: new Date("2026-12-25T00:00:00Z"), isAllDay: true },
    ]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261225");
  });

  test("many rows produce a calendar with the same event count", () => {
    const ics = generateICSFromRows([timedRow, allDayRow()]);
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(2);
  });

  test("keeps a stored description alongside the title", () => {
    const ics = generateICSFromRows([{ ...timedRow, description: "Bring the lab manual." }]);
    expect(ics).toContain("DESCRIPTION:Biology 101\\n\\nBring the lab manual.");
  });

  test("uses the end date for events crossing midnight", () => {
    const ics = generateICSFromRows([
      {
        ...timedRow,
        startTime: new Date("2026-10-01T23:00:00Z"),
        endTime: new Date("2026-10-02T01:00:00Z"),
      },
    ]);
    expect(ics).toContain("DTSTART:20261001T230000");
    expect(ics).toContain("DTEND:20261002T010000");
  });

  test("keeps a stable UID across regenerations", () => {
    const first = generateICSFromRows([timedRow]);
    const second = generateICSFromRows([timedRow]);
    expect(first).toContain("UID:event-1");
    expect(second).toContain("UID:event-1");
  });

  function allDayRow() {
    return {
      id: "event-2",
      title: "Holiday",
      description: null,
      location: null,
      startTime: new Date("2027-01-01T00:00:00Z"),
      endTime: null,
      isAllDay: true,
    };
  }
});

describe("generateICSForAI", () => {
  test("creates a timed event with a 1-hour duration", () => {
    const ics = generateICSForAI([
      { date: "2026-10-01", time: "14:30", description: "Team standup" },
    ]);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("SUMMARY:Team standup");
    expect(ics).toContain("DTSTART:20261001T143000");
    expect(ics).toContain("DURATION:PT1H");
    expect(ics).toContain("END:VEVENT");
  });

  test("creates an all-day event when time is empty", () => {
    const ics = generateICSForAI([{ date: "2026-12-25", time: "", description: "Holiday" }]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261225");
  });

  test("handles multiple events in one calendar", () => {
    const ics = generateICSForAI([
      { date: "2026-10-01", time: "09:00", description: "Morning" },
      { date: "2026-10-02", time: "17:00", description: "Evening" },
    ]);
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(2);
  });

  test("throws on invalid date format", () => {
    expect(() => generateICSForAI([{ date: "not-a-date", time: "", description: "x" }])).toThrow(
      "Invalid date format",
    );
  });

  test("throws on invalid time format", () => {
    expect(() =>
      generateICSForAI([{ date: "2026-10-01", time: "nope", description: "x" }]),
    ).toThrow("Invalid time format");
  });

  test("throws on out-of-range hours and minutes", () => {
    expect(() =>
      generateICSForAI([{ date: "2026-10-01", time: "25:00", description: "x" }]),
    ).toThrow("Invalid time");
    expect(() =>
      generateICSForAI([{ date: "2026-10-01", time: "12:70", description: "x" }]),
    ).toThrow("Invalid time");
  });
});

describe("generateICSForManual", () => {
  test("creates a timed event", () => {
    const ics = generateICSForManual([
      { date: "2026-11-05", time: "08:15", description: "Dentist" },
    ]);
    expect(ics).toContain("SUMMARY:Dentist");
    expect(ics).toContain("DTSTART:20261105T081500");
  });

  test("rolls an overnight end time into the next day", () => {
    const ics = generateICSForManual([
      { date: "2026-11-05", time: "23:00", endTime: "01:00", description: "Late shift" },
    ]);
    expect(ics).toContain("DTSTART:20261105T230000");
    expect(ics).toContain("DTEND:20261106T010000");
  });

  test("treats an equal start/end as a one-hour event", () => {
    const ics = generateICSForManual([
      { date: "2026-11-05", time: "10:00", endTime: "10:00", description: "Quick sync" },
    ]);
    expect(ics).toContain("DURATION:PT1H");
  });

  test("rejects an end date without an end time", () => {
    expect(() =>
      generateICSForManual([
        { date: "2026-11-05", time: "10:00", endDate: "2026-11-06", description: "Broken" },
      ]),
    ).toThrow("endDate requires endTime");
  });
});

describe("generateICS legacy alias", () => {
  test("produces the same event as AI behavior (uids differ per call)", () => {
    const event = { date: "2026-10-01", time: "10:00", description: "Same" };
    for (const ics of [generateICS([event]), generateICSForAI([event])]) {
      expect(ics).toContain("SUMMARY:Same");
      expect(ics).toContain("DTSTART:20261001T100000");
    }
  });
});
