import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarClient } from "../src/calendar/google.js";
import { UpstreamError } from "../src/lib/errors.js";
import { fromZonedTime } from "../src/lib/datetime.js";

const TZ = "Europe/Istanbul";
const WINDOW = {
  from: new Date("2026-08-27T00:00:00Z"),
  to: new Date("2026-08-29T00:00:00Z"),
};

function clientReturning(items: unknown[]) {
  const list = vi.fn().mockResolvedValue({ data: { items } });
  const client = new GoogleCalendarClient({
    calendarId: "cal@group.calendar.google.com",
    timeZone: TZ,
    api: { events: { list } } as never,
  });
  return { client, list };
}

describe("query parameters", () => {
  it("expands recurring events and orders them", async () => {
    const { client, list } = clientReturning([]);
    await client.listEvents(WINDOW);

    // Without singleEvents, recurring events return as unexpanded rules and
    // every repeating item silently vanishes from the answer.
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ singleEvents: true, orderBy: "startTime" }),
    );
  });

  it("passes the window as ISO bounds", async () => {
    const { client, list } = clientReturning([]);
    await client.listEvents(WINDOW);

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        timeMin: "2026-08-27T00:00:00.000Z",
        timeMax: "2026-08-29T00:00:00.000Z",
      }),
    );
  });
});

describe("event parsing", () => {
  it("reads a timed event", async () => {
    const { client } = clientReturning([
      {
        id: "abc",
        summary: "Boat trip",
        location: "South jetty",
        start: { dateTime: "2026-08-27T14:00:00+03:00" },
        end: { dateTime: "2026-08-27T18:00:00+03:00" },
      },
    ]);

    const [event] = await client.listEvents(WINDOW);

    expect(event).toMatchObject({ id: "abc", title: "Boat trip", allDay: false });
    expect(event!.start.toISOString()).toBe("2026-08-27T11:00:00.000Z");
  });

  it("anchors an all-day event to local midnight, not UTC midnight", async () => {
    // The classic bug: treating '2026-08-28' as a timestamp puts the event at
    // UTC midnight, which is 03:00 on the 28th in Istanbul — or, for a negative
    // offset zone, the previous evening entirely.
    const { client } = clientReturning([
      {
        id: "allday",
        summary: "Dress code: whites",
        start: { date: "2026-08-28" },
        end: { date: "2026-08-29" },
      },
    ]);

    const [event] = await client.listEvents(WINDOW);

    expect(event!.allDay).toBe(true);
    expect(event!.start.toISOString()).toBe(fromZonedTime(TZ, 2026, 8, 28).toISOString());
    expect(event!.start.toISOString()).toBe("2026-08-27T21:00:00.000Z");
  });

  it("drops cancelled occurrences", async () => {
    const { client } = clientReturning([
      { id: "live", summary: "Yoga", start: { dateTime: "2026-08-27T09:00:00+03:00" }, end: { dateTime: "2026-08-27T10:00:00+03:00" } },
      { id: "gone", summary: "Yoga", status: "cancelled", start: { dateTime: "2026-08-28T09:00:00+03:00" }, end: { dateTime: "2026-08-28T10:00:00+03:00" } },
    ]);

    const events = await client.listEvents(WINDOW);
    expect(events.map((e) => e.id)).toEqual(["live"]);
  });

  it("skips malformed entries instead of throwing", async () => {
    const { client } = clientReturning([
      { id: "no-start", summary: "Broken" },
      { id: "bad-date", summary: "Also broken", start: { date: "27/08/2026" }, end: { date: "28/08/2026" } },
      { id: "ok", summary: "Fine", start: { dateTime: "2026-08-27T09:00:00+03:00" }, end: { dateTime: "2026-08-27T10:00:00+03:00" } },
    ]);

    const events = await client.listEvents(WINDOW);
    expect(events.map((e) => e.id)).toEqual(["ok"]);
  });

  it("falls back to a title for an untitled event", async () => {
    const { client } = clientReturning([
      { id: "x", summary: "   ", start: { dateTime: "2026-08-27T09:00:00+03:00" }, end: { dateTime: "2026-08-27T10:00:00+03:00" } },
    ]);

    expect((await client.listEvents(WINDOW))[0]!.title).toBe("Untitled");
  });

  it("handles an empty calendar", async () => {
    const list = vi.fn().mockResolvedValue({ data: {} });
    const client = new GoogleCalendarClient({
      calendarId: "cal",
      timeZone: TZ,
      api: { events: { list } } as never,
    });

    await expect(client.listEvents(WINDOW)).resolves.toEqual([]);
  });
});

describe("error mapping", () => {
  it("explains a 404 in terms of the likely cause", async () => {
    const list = vi.fn().mockRejectedValue({ code: 404, message: "Not Found" });
    const client = new GoogleCalendarClient({
      calendarId: "cal",
      timeZone: TZ,
      api: { events: { list } } as never,
    });

    await expect(client.listEvents(WINDOW)).rejects.toThrow(/shared with the service account/);
  });

  it("marks a 403 retryable and points at calendar sharing", async () => {
    const list = vi.fn().mockRejectedValue({ code: 403, message: "Forbidden" });
    const client = new GoogleCalendarClient({
      calendarId: "cal",
      timeZone: TZ,
      api: { events: { list } } as never,
    });

    await expect(client.listEvents(WINDOW)).rejects.toMatchObject({
      service: "google-calendar",
      retryable: true,
    });
  });

  it("marks a 400 non-retryable", async () => {
    const list = vi.fn().mockRejectedValue({ code: 400, message: "Bad Request" });
    const client = new GoogleCalendarClient({
      calendarId: "cal",
      timeZone: TZ,
      api: { events: { list } } as never,
    });

    await expect(client.listEvents(WINDOW)).rejects.toMatchObject({ retryable: false });
  });

  it("wraps everything as an UpstreamError", async () => {
    const list = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const client = new GoogleCalendarClient({
      calendarId: "cal",
      timeZone: TZ,
      api: { events: { list } } as never,
    });

    await expect(client.listEvents(WINDOW)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("credential loading", () => {
  it("rejects invalid JSON with a clear message", () => {
    expect(
      () =>
        new GoogleCalendarClient({
          calendarId: "cal",
          timeZone: TZ,
          serviceAccountJson: "{not json",
        }),
    ).toThrow(/not valid JSON/);
  });

  it("rejects JSON missing the required fields", () => {
    expect(
      () =>
        new GoogleCalendarClient({
          calendarId: "cal",
          timeZone: TZ,
          serviceAccountJson: JSON.stringify({ client_email: "a@b.com" }),
        }),
    ).toThrow(/private_key/);
  });

  it("says what to set when given nothing", () => {
    expect(
      () => new GoogleCalendarClient({ calendarId: "cal", timeZone: TZ }),
    ).toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON/);
  });
});
