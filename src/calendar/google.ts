import { readFileSync } from "node:fs";
// Auth comes from googleapis' own bundled google-auth-library. Importing JWT
// from a separately-installed copy yields a nominally different type that the
// calendar client refuses.
import { google, type calendar_v3 } from "googleapis";
import { UpstreamError } from "../lib/errors.js";
import { fromZonedTime } from "../lib/datetime.js";
import type { CalendarClient, CalendarEvent, EventQuery } from "./types.js";

/** Read-only is all this ever needs; the PA team owns the calendar. */
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

export interface GoogleCalendarOptions {
  calendarId: string;
  timeZone: string;
  serviceAccountFile?: string | undefined;
  serviceAccountJson?: string | undefined;
  /** Injected in tests to exercise parsing without network or credentials. */
  api?: Pick<calendar_v3.Calendar, "events">;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

function loadServiceAccount(options: GoogleCalendarOptions): ServiceAccountKey {
  const raw = options.serviceAccountJson
    ? options.serviceAccountJson
    : options.serviceAccountFile
      ? readFileSync(options.serviceAccountFile, "utf-8")
      : null;

  if (!raw) {
    throw new Error(
      "Google Calendar needs GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE",
    );
  }

  let parsed: Partial<ServiceAccountKey>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccountKey>;
  } catch {
    throw new Error("Google service account credentials are not valid JSON");
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Google service account JSON is missing client_email or private_key");
  }

  return {
    client_email: parsed.client_email,
    // Keys pasted into an env var arrive with literal \n rather than newlines.
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
  };
}

export class GoogleCalendarClient implements CalendarClient {
  private readonly calendar: Pick<calendar_v3.Calendar, "events">;

  constructor(private readonly options: GoogleCalendarOptions) {
    if (options.api) {
      this.calendar = options.api as calendar_v3.Calendar;
      return;
    }

    const key = loadServiceAccount(options);

    this.calendar = google.calendar({
      version: "v3",
      auth: new google.auth.JWT({
        email: key.client_email,
        key: key.private_key,
        scopes: SCOPES,
      }),
    });
  }

  async listEvents(query: EventQuery): Promise<CalendarEvent[]> {
    try {
      const response = await this.calendar.events.list({
        calendarId: this.options.calendarId,
        timeMin: query.from.toISOString(),
        timeMax: query.to.toISOString(),
        // Without singleEvents, recurring events come back as unexpanded rules
        // and "what's on tomorrow" misses everything that repeats.
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
      });

      return (response.data.items ?? [])
        .filter((item) => item.status !== "cancelled")
        .map((item) => this.toEvent(item))
        .filter((event): event is CalendarEvent => event !== null);
    } catch (err) {
      throw toUpstreamError(err);
    }
  }

  private toEvent(item: calendar_v3.Schema$Event): CalendarEvent | null {
    const startRaw = item.start;
    const endRaw = item.end;
    if (!startRaw || !endRaw) return null;

    // Timed events carry dateTime; all-day events carry only a date. Treating a
    // date as a timestamp would place it at UTC midnight, which is the previous
    // evening in any positive-offset zone.
    const allDay = !startRaw.dateTime;

    const start = allDay
      ? this.parseDateOnly(startRaw.date)
      : startRaw.dateTime
        ? new Date(startRaw.dateTime)
        : null;

    const end = allDay
      ? this.parseDateOnly(endRaw.date)
      : endRaw.dateTime
        ? new Date(endRaw.dateTime)
        : null;

    if (!start || !end) return null;

    return {
      id: item.id ?? `${start.toISOString()}-${item.summary ?? "untitled"}`,
      title: item.summary?.trim() || "Untitled",
      start,
      end,
      allDay,
      ...(item.location ? { location: item.location } : {}),
      ...(item.description ? { description: item.description } : {}),
    };
  }

  /** `2026-08-27` → local midnight in the villa's timezone. */
  private parseDateOnly(date: string | null | undefined): Date | null {
    if (!date) return null;

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) return null;

    return fromZonedTime(
      this.options.timeZone,
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    );
  }
}

interface GoogleApiError {
  code?: number;
  status?: number;
  message?: string;
}

function toUpstreamError(err: unknown): UpstreamError {
  const apiError = err as GoogleApiError;
  const status = apiError.code ?? apiError.status;
  const retryable = status === 403 || status === 429 || (status !== undefined && status >= 500);

  const hint =
    status === 404
      ? " (check GOOGLE_CALENDAR_ID, and that the calendar is shared with the service account)"
      : status === 403
        ? " (the calendar must be shared with the service account email)"
        : "";

  return new UpstreamError(
    "google-calendar",
    `${apiError.message ?? "request failed"}${hint}`,
    retryable,
    err,
  );
}
