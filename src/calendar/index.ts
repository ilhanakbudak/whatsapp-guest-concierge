import type { AppConfig } from "../config/env.js";
import { CachedCalendarClient } from "./cache.js";
import { GoogleCalendarClient } from "./google.js";
import { MockCalendarClient } from "./mock.js";
import type { CalendarClient } from "./types.js";

export function createCalendarClient(config: AppConfig): CalendarClient {
  const inner: CalendarClient = config.demo.calendar
    ? new MockCalendarClient({ timeZone: config.CALENDAR_TIMEZONE })
    : new GoogleCalendarClient({
        calendarId: config.GOOGLE_CALENDAR_ID!,
        timeZone: config.CALENDAR_TIMEZONE,
        serviceAccountFile: config.GOOGLE_SERVICE_ACCOUNT_FILE,
        serviceAccountJson: config.GOOGLE_SERVICE_ACCOUNT_JSON,
      });

  return new CachedCalendarClient(inner);
}

export { CachedCalendarClient, GoogleCalendarClient, MockCalendarClient };
export * from "./types.js";
export * from "./format.js";
