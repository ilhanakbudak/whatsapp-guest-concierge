import { describe, expect, it } from "vitest";
import {
  addDaysZoned,
  dayKeyToDate,
  daysBetweenZoned,
  formatZonedDayLabel,
  formatZonedTime,
  fromZonedTime,
  relativeDayLabel,
  zonedDayKey,
  zonedEndOfDay,
  zonedStartOfDay,
  timeZoneOffsetMs,
} from "../src/lib/datetime.js";

const ISTANBUL = "Europe/Istanbul"; // UTC+3 year round, no DST
const LONDON = "Europe/London"; // GMT/BST, DST
const CHATHAM = "Pacific/Chatham"; // UTC+12:45 — a 45-minute offset

describe("timeZoneOffsetMs", () => {
  it("handles a whole-hour offset", () => {
    expect(timeZoneOffsetMs(new Date("2026-08-27T12:00:00Z"), ISTANBUL)).toBe(3 * 3_600_000);
  });

  it("handles a 45-minute offset", () => {
    expect(timeZoneOffsetMs(new Date("2026-08-27T12:00:00Z"), CHATHAM)).toBe(12.75 * 3_600_000);
  });

  it("tracks DST", () => {
    expect(timeZoneOffsetMs(new Date("2026-01-15T12:00:00Z"), LONDON)).toBe(0);
    expect(timeZoneOffsetMs(new Date("2026-07-15T12:00:00Z"), LONDON)).toBe(3_600_000);
  });
});

describe("zonedStartOfDay", () => {
  it("uses the local day, not the server's", () => {
    // 21:30 UTC is already the 28th in Istanbul. A UTC-based implementation
    // would return the 27th and answer "tomorrow" with the wrong day.
    const evening = new Date("2026-08-27T21:30:00Z");
    expect(zonedStartOfDay(evening, ISTANBUL).toISOString()).toBe("2026-08-27T21:00:00.000Z");
    expect(zonedDayKey(evening, ISTANBUL)).toBe("2026-08-28");
  });

  it("agrees with UTC when the zone is UTC", () => {
    const d = new Date("2026-08-27T21:30:00Z");
    expect(zonedStartOfDay(d, "UTC").toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });

  it("is idempotent", () => {
    const d = new Date("2026-08-27T21:30:00Z");
    const once = zonedStartOfDay(d, ISTANBUL);
    expect(zonedStartOfDay(once, ISTANBUL).getTime()).toBe(once.getTime());
  });

  it("spans exactly one day even across a DST transition", () => {
    // Clocks go forward in London on 29 March 2026: that day is 23 hours long.
    const dstDay = new Date("2026-03-29T12:00:00Z");
    const start = zonedStartOfDay(dstDay, LONDON);
    const end = zonedEndOfDay(dstDay, LONDON);

    expect(end.getTime() - start.getTime()).toBe(23 * 3_600_000);
    expect(zonedDayKey(start, LONDON)).toBe("2026-03-29");
  });

  it("handles the autumn transition, when a day is 25 hours long", () => {
    const dstDay = new Date("2026-10-25T12:00:00Z");
    const start = zonedStartOfDay(dstDay, LONDON);
    const end = zonedEndOfDay(dstDay, LONDON);

    expect(end.getTime() - start.getTime()).toBe(25 * 3_600_000);
  });
});

describe("fromZonedTime", () => {
  it("resolves a wall-clock time to the right instant", () => {
    expect(fromZonedTime(ISTANBUL, 2026, 8, 27, 14, 0).toISOString()).toBe(
      "2026-08-27T11:00:00.000Z",
    );
  });

  it("picks the correct side of a spring-forward gap", () => {
    // 01:30 on 29 March does not exist in London. Any answer is a compromise;
    // what matters is that it is stable and lands on the right day.
    const result = fromZonedTime(LONDON, 2026, 3, 29, 1, 30);
    expect(zonedDayKey(result, LONDON)).toBe("2026-03-29");
  });

  it("round-trips through formatZonedTime", () => {
    const instant = fromZonedTime(ISTANBUL, 2026, 8, 27, 20, 30);
    expect(formatZonedTime(instant, ISTANBUL)).toBe("20:30");
  });

  it("normalises an overflowing day into the next month", () => {
    expect(zonedDayKey(fromZonedTime(ISTANBUL, 2026, 8, 32), ISTANBUL)).toBe("2026-09-01");
  });
});

describe("addDaysZoned", () => {
  it("preserves wall-clock time across a DST boundary", () => {
    const before = fromZonedTime(LONDON, 2026, 3, 28, 20, 0);
    const after = addDaysZoned(before, 1, LONDON);

    // Naive +86400000 would land at 21:00 local. Wall-clock addition keeps 20:00.
    expect(formatZonedTime(after, LONDON)).toBe("20:00");
    expect(zonedDayKey(after, LONDON)).toBe("2026-03-29");
  });
});

describe("day keys", () => {
  it("round-trips", () => {
    const date = dayKeyToDate("2026-08-27", ISTANBUL);
    expect(zonedDayKey(date, ISTANBUL)).toBe("2026-08-27");
  });

  it("rejects a malformed key", () => {
    expect(() => dayKeyToDate("27/08/2026", ISTANBUL)).toThrow(/YYYY-MM-DD/);
    expect(() => dayKeyToDate("tomorrow", ISTANBUL)).toThrow();
  });
});

describe("labels", () => {
  it("formats a day heading", () => {
    expect(formatZonedDayLabel(new Date("2026-08-27T12:00:00Z"), ISTANBUL)).toBe(
      "Thursday 27 August",
    );
  });

  it("names today, tomorrow and yesterday relative to the villa's clock", () => {
    const now = new Date("2026-08-27T21:30:00Z"); // already the 28th in Istanbul

    expect(relativeDayLabel(new Date("2026-08-27T22:00:00Z"), now, ISTANBUL)).toBe("today");
    expect(relativeDayLabel(new Date("2026-08-28T22:00:00Z"), now, ISTANBUL)).toBe("tomorrow");
    expect(relativeDayLabel(new Date("2026-08-26T22:00:00Z"), now, ISTANBUL)).toBe("yesterday");
  });

  it("falls back to a named day further out", () => {
    const now = new Date("2026-08-27T09:00:00Z");
    expect(relativeDayLabel(new Date("2026-08-30T09:00:00Z"), now, ISTANBUL)).toBe(
      "Sunday 30 August",
    );
  });

  it("counts calendar days, not elapsed hours", () => {
    // 23:00 to 01:00 is two hours but one calendar day.
    const late = new Date("2026-08-27T20:00:00Z"); // 23:00 Istanbul
    const earlyNext = new Date("2026-08-27T22:00:00Z"); // 01:00 Istanbul, next day
    expect(daysBetweenZoned(late, earlyNext, ISTANBUL)).toBe(1);
  });
});
