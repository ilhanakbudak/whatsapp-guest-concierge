import { describe, expect, it } from "vitest";
import { CachedCalendarClient } from "../src/calendar/cache.js";
import { formatSchedule } from "../src/calendar/format.js";
import { MockCalendarClient } from "../src/calendar/mock.js";
import { ScheduleService } from "../src/calendar/schedule.js";
import type { CalendarClient, CalendarEvent, EventQuery } from "../src/calendar/types.js";
import { fromZonedTime } from "../src/lib/datetime.js";

const TZ = "Europe/Istanbul";
const NOW = new Date("2026-08-27T09:00:00Z"); // 12:00 in Istanbul

/** A calendar returning a fixed list, recording the windows it was asked for. */
class StubCalendar implements CalendarClient {
  readonly queries: EventQuery[] = [];
  calls = 0;

  constructor(private readonly events: CalendarEvent[] = []) {}

  async listEvents(query: EventQuery): Promise<CalendarEvent[]> {
    this.calls++;
    this.queries.push(query);
    return this.events.filter((e) => e.start < query.to && e.end > query.from);
  }
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    title: "Boat trip",
    start: fromZonedTime(TZ, 2026, 8, 27, 14, 0),
    end: fromZonedTime(TZ, 2026, 8, 27, 18, 0),
    allDay: false,
    ...overrides,
  };
}

describe("formatSchedule", () => {
  it("says so plainly when there is nothing on", () => {
    expect(formatSchedule([], { timeZone: TZ, now: NOW })).toBe(
      "No scheduled events in this period.",
    );
  });

  it("renders times in the villa's timezone, not the server's", () => {
    const text = formatSchedule([event()], { timeZone: TZ, now: NOW });
    // 14:00 local is 11:00 UTC. A UTC-formatted answer would tell guests 11:00.
    expect(text).toContain("14:00–18:00");
    expect(text).not.toContain("11:00");
  });

  it("labels today and tomorrow relatively, with the date for grounding", () => {
    const text = formatSchedule(
      [event(), event({ id: "e2", start: fromZonedTime(TZ, 2026, 8, 28, 9, 0), end: fromZonedTime(TZ, 2026, 8, 28, 10, 0), title: "Yoga" })],
      { timeZone: TZ, now: NOW },
    );

    expect(text).toContain("today (Thursday 27 August)");
    expect(text).toContain("tomorrow (Friday 28 August)");
  });

  it("groups events under their day and orders days", () => {
    const text = formatSchedule(
      [
        event({ id: "b", start: fromZonedTime(TZ, 2026, 8, 29, 9, 0), end: fromZonedTime(TZ, 2026, 8, 29, 10, 0), title: "Later" }),
        event({ id: "a", title: "Earlier" }),
      ],
      { timeZone: TZ, now: NOW },
    );

    expect(text.indexOf("Earlier")).toBeLessThan(text.indexOf("Later"));
  });

  it("marks all-day events without inventing a time", () => {
    const text = formatSchedule(
      [
        event({
          title: "Dress code: whites",
          allDay: true,
          start: fromZonedTime(TZ, 2026, 8, 28),
          end: fromZonedTime(TZ, 2026, 8, 29),
        }),
      ],
      { timeZone: TZ, now: NOW },
    );

    expect(text).toContain("all day  Dress code: whites");
    expect(text).not.toMatch(/00:00/);
  });

  it("spells out the end day for a multi-day event", () => {
    const text = formatSchedule(
      [
        event({
          title: "Yacht charter",
          start: fromZonedTime(TZ, 2026, 8, 27, 10, 0),
          end: fromZonedTime(TZ, 2026, 8, 29, 16, 0),
        }),
      ],
      { timeZone: TZ, now: NOW },
    );

    expect(text).toContain("until Saturday 29 August 16:00");
  });

  it("includes location and flattens multi-line descriptions", () => {
    const text = formatSchedule(
      [event({ location: "South jetty", description: "Bring swimwear.\n\nDeparts promptly." })],
      { timeZone: TZ, now: NOW },
    );

    expect(text).toContain("(South jetty)");
    expect(text).toContain("Bring swimwear. Departs promptly.");
    expect(text.split("\n").filter((l) => l.includes("Boat trip"))).toHaveLength(1);
  });
});

describe("ScheduleService windows", () => {
  it("asks for exactly today in the villa's timezone", async () => {
    const stub = new StubCalendar();
    const service = new ScheduleService(stub, { timeZone: TZ, now: () => NOW });

    await service.get({ range: "today" });

    expect(stub.queries[0]!.from.toISOString()).toBe("2026-08-26T21:00:00.000Z");
    expect(stub.queries[0]!.to.toISOString()).toBe("2026-08-27T21:00:00.000Z");
  });

  it("rolls to the next local day for tomorrow", async () => {
    const stub = new StubCalendar();
    const service = new ScheduleService(stub, { timeZone: TZ, now: () => NOW });

    await service.get({ range: "tomorrow" });

    expect(stub.queries[0]!.from.toISOString()).toBe("2026-08-27T21:00:00.000Z");
    expect(stub.queries[0]!.to.toISOString()).toBe("2026-08-28T21:00:00.000Z");
  });

  it("uses the villa's day even when the server is on the next date", async () => {
    // 21:30 UTC is already 28 August in Istanbul.
    const lateNow = new Date("2026-08-27T21:30:00Z");
    const stub = new StubCalendar();
    const service = new ScheduleService(stub, { timeZone: TZ, now: () => lateNow });

    await service.get({ range: "today" });

    expect(stub.queries[0]!.from.toISOString()).toBe("2026-08-27T21:00:00.000Z");
  });

  it("covers seven days for a week request", async () => {
    const stub = new StubCalendar();
    const service = new ScheduleService(stub, { timeZone: TZ, now: () => NOW });

    await service.get({ range: "this_week" });

    const { from, to } = stub.queries[0]!;
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(7);
  });

  it("accepts an explicit date", async () => {
    const stub = new StubCalendar();
    const service = new ScheduleService(stub, { timeZone: TZ, now: () => NOW });

    await service.get({ date: "2026-09-02" });

    expect(stub.queries[0]!.from.toISOString()).toBe("2026-09-01T21:00:00.000Z");
  });

  it("rejects a backwards range", async () => {
    const service = new ScheduleService(new StubCalendar(), { timeZone: TZ, now: () => NOW });
    await expect(service.get({ date: "2026-09-05", endDate: "2026-09-01" })).rejects.toThrow(
      /on or after/,
    );
  });

  it("refuses an absurdly wide range rather than fetching a year", async () => {
    const service = new ScheduleService(new StubCalendar(), { timeZone: TZ, now: () => NOW });
    await expect(service.get({ date: "2026-01-01", endDate: "2026-12-31" })).rejects.toThrow(
      /too wide/,
    );
  });

  it("rejects a malformed date instead of guessing", async () => {
    const service = new ScheduleService(new StubCalendar(), { timeZone: TZ, now: () => NOW });
    await expect(service.get({ date: "next friday" })).rejects.toThrow();
  });
});

describe("ScheduleService.find", () => {
  it("matches on title, location and description", async () => {
    const stub = new StubCalendar([
      event({ id: "a", title: "Boat trip", location: "South jetty" }),
      event({ id: "b", title: "Yoga", description: "Bring a mat" }),
    ]);
    const service = new ScheduleService(stub, { timeZone: TZ, now: () => NOW });

    expect((await service.find("boat")).events.map((e) => e.id)).toEqual(["a"]);
    expect((await service.find("jetty")).events.map((e) => e.id)).toEqual(["a"]);
    expect((await service.find("mat")).events.map((e) => e.id)).toEqual(["b"]);
  });

  it("is case-insensitive and returns empty rather than throwing", async () => {
    const stub = new StubCalendar([event({ title: "Boat trip" })]);
    const service = new ScheduleService(stub, { timeZone: TZ, now: () => NOW });

    expect((await service.find("BOAT")).events).toHaveLength(1);
    expect((await service.find("helicopter")).events).toHaveLength(0);
  });
});

describe("CachedCalendarClient", () => {
  it("serves a repeated window from cache", async () => {
    const stub = new StubCalendar([event()]);
    const cached = new CachedCalendarClient(stub, { ttlMs: 60_000, now: () => 0 });
    const query = { from: new Date("2026-08-27T00:00:00Z"), to: new Date("2026-08-28T00:00:00Z") };

    await cached.listEvents(query);
    await cached.listEvents(query);

    expect(stub.calls).toBe(1);
  });

  it("refetches once the TTL expires, so a schedule change lands quickly", async () => {
    const stub = new StubCalendar([event()]);
    let now = 0;
    const cached = new CachedCalendarClient(stub, { ttlMs: 60_000, now: () => now });
    const query = { from: new Date("2026-08-27T00:00:00Z"), to: new Date("2026-08-28T00:00:00Z") };

    await cached.listEvents(query);
    now += 61_000;
    await cached.listEvents(query);

    expect(stub.calls).toBe(2);
  });

  it("treats a different window as a different key", async () => {
    const stub = new StubCalendar([event()]);
    const cached = new CachedCalendarClient(stub, { now: () => 0 });

    await cached.listEvents({ from: new Date("2026-08-27T00:00:00Z"), to: new Date("2026-08-28T00:00:00Z") });
    await cached.listEvents({ from: new Date("2026-08-28T00:00:00Z"), to: new Date("2026-08-29T00:00:00Z") });

    expect(stub.calls).toBe(2);
  });

  it("can be invalidated explicitly", async () => {
    const stub = new StubCalendar([event()]);
    const cached = new CachedCalendarClient(stub, { now: () => 0 });
    const query = { from: new Date("2026-08-27T00:00:00Z"), to: new Date("2026-08-28T00:00:00Z") };

    await cached.listEvents(query);
    cached.invalidate();
    await cached.listEvents(query);

    expect(stub.calls).toBe(2);
  });
});

describe("MockCalendarClient", () => {
  it("builds the itinerary relative to today so the demo never goes stale", async () => {
    const mock = new MockCalendarClient({ timeZone: TZ, now: () => NOW });
    const service = new ScheduleService(mock, { timeZone: TZ, now: () => NOW });

    const today = await service.get({ range: "today" });
    const tomorrow = await service.get({ range: "tomorrow" });

    expect(today.events.length).toBeGreaterThan(0);
    expect(today.text).toContain("Boat trip to the blue caves");
    expect(tomorrow.text).toContain("White party");
  });

  it("returns only events overlapping the requested window", async () => {
    const mock = new MockCalendarClient({ timeZone: TZ, now: () => NOW });
    const events = await mock.listEvents({
      from: fromZonedTime(TZ, 2026, 8, 27),
      to: fromZonedTime(TZ, 2026, 8, 28),
    });

    expect(events.every((e) => e.start < fromZonedTime(TZ, 2026, 8, 28))).toBe(true);
  });

  it("returns events already sorted by start time", async () => {
    const mock = new MockCalendarClient({ timeZone: TZ, now: () => NOW });
    const events = await mock.listEvents({
      from: fromZonedTime(TZ, 2026, 8, 27),
      to: fromZonedTime(TZ, 2026, 9, 3),
    });

    const starts = events.map((e) => e.start.getTime());
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("can be made to fail, for exercising degradation paths", async () => {
    const mock = new MockCalendarClient({ timeZone: TZ, now: () => NOW });
    mock.failNextWith(new Error("calendar unavailable"));

    await expect(mock.listEvents({ from: NOW, to: NOW })).rejects.toThrow("calendar unavailable");
    await expect(mock.listEvents({ from: NOW, to: NOW })).resolves.toBeDefined();
  });
});
