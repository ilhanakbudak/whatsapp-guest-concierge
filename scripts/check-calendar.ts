/**
 * Diagnoses Google Calendar configuration.
 *
 * Answers the three questions that account for nearly every failure:
 * do the credentials load, which calendars can the service account actually see,
 * and does GOOGLE_CALENDAR_ID return events?
 *
 *   npm run check:calendar
 */
import { auth as googleAuth, calendar } from "@googleapis/calendar";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config/env.js";
import { GoogleCalendarClient } from "../src/calendar/google.js";
import { formatSchedule } from "../src/calendar/format.js";
import { addDaysZoned, zonedEndOfDay, zonedStartOfDay } from "../src/lib/datetime.js";

const config = loadConfig();
const tz = config.CALENDAR_TIMEZONE;

function fail(message: string, hint?: string): never {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`\n  ${hint}`);
  process.exit(1);
}

// --- 1. Credentials ---------------------------------------------------------

const raw = config.GOOGLE_SERVICE_ACCOUNT_JSON
  ? config.GOOGLE_SERVICE_ACCOUNT_JSON
  : config.GOOGLE_SERVICE_ACCOUNT_FILE
    ? readFileSync(config.GOOGLE_SERVICE_ACCOUNT_FILE, "utf-8")
    : fail(
        "No credentials configured.",
        "Set GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON in .env",
      );

const key = JSON.parse(raw) as { client_email?: string; project_id?: string };
if (!key.client_email) fail("Credentials JSON has no client_email.");

console.log("credentials");
console.log(`  project        ${key.project_id ?? "(unknown)"}`);
console.log(`  service acct   ${key.client_email}`);

const auth = new googleAuth.JWT({
  email: key.client_email,
  key: (JSON.parse(raw) as { private_key: string }).private_key.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
});

const api = calendar({ version: "v3", auth });

// --- 2. What can this account see? ------------------------------------------

console.log("\ncalendars visible to the service account");

let visible: Array<{ id: string; summary: string; primary: boolean }> = [];
try {
  const list = await api.calendarList.list();
  visible = (list.data.items ?? []).map((c) => ({
    id: c.id ?? "(no id)",
    summary: c.summary ?? "(untitled)",
    primary: c.primary === true,
  }));
} catch (err) {
  console.log(`  (could not list: ${(err as Error).message})`);
}

if (visible.length === 0) {
  console.log("  none");
  console.log(
    "\n  A service account sees a calendar only after that calendar has been\n" +
      "  explicitly shared with its email address. In Google Calendar open the\n" +
      "  calendar's Settings and sharing, and under 'Share with specific people'\n" +
      `  add:\n\n    ${key.client_email}\n\n` +
      "  with 'See all event details'. Then copy the Calendar ID from the same page.",
  );
} else {
  for (const cal of visible) {
    console.log(`  ${cal.primary ? "*" : " "} ${cal.summary}`);
    console.log(`      ${cal.id}`);
  }
}

// --- 3. Does the configured ID work? ----------------------------------------

const calendarId = config.GOOGLE_CALENDAR_ID;
console.log(`\nconfigured GOOGLE_CALENDAR_ID\n  ${calendarId || "(not set)"}`);

if (!calendarId) {
  fail(
    "GOOGLE_CALENDAR_ID is not set.",
    visible.length > 0
      ? `Try one of the IDs listed above.`
      : "Share a calendar with the service account first (see above).",
  );
}

if (calendarId === key.client_email) {
  console.log(
    "\n  ! This is the service account's own email address, not a calendar ID.\n" +
      "    It resolves to the service account's private calendar, which nobody\n" +
      "    can add events to through the Google Calendar interface — so it will\n" +
      "    always be empty. You want the ID of the calendar your team edits,\n" +
      "    usually ending in @group.calendar.google.com.",
  );
}

const now = new Date();
const from = zonedStartOfDay(now, tz);
const to = zonedEndOfDay(addDaysZoned(from, 13, tz), tz);

try {
  const client = new GoogleCalendarClient({
    calendarId,
    timeZone: tz,
    serviceAccountFile: config.GOOGLE_SERVICE_ACCOUNT_FILE,
    serviceAccountJson: config.GOOGLE_SERVICE_ACCOUNT_JSON,
  });

  const events = await client.listEvents({ from, to });
  console.log(`\n✓ connected — ${events.length} event(s) in the next 14 days (${tz})\n`);

  if (events.length > 0) {
    console.log(formatSchedule(events, { timeZone: tz, now }));
    console.log();
  } else {
    console.log(
      "  The calendar is reachable but empty in this window. Add an event to it,\n" +
        "  then re-run this check.\n",
    );
  }
} catch (err) {
  fail((err as Error).message);
}
