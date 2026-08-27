/**
 * Creates and populates a real Google Calendar owned by the service account.
 *
 * Solves the chicken-and-egg problem of testing the calendar integration with no
 * calendar to test against: rather than asking someone to build one by hand in
 * the Google Calendar UI and remember to share it, the service account creates
 * its own and fills it with the demo itinerary.
 *
 *   npm run setup:calendar                      create + populate
 *   npm run setup:calendar -- --share you@gmail.com   also let a person edit it
 *   npm run setup:calendar -- --reset           wipe events and re-add them
 *   npm run setup:calendar -- --delete          remove the calendar entirely
 *
 * Note the scope: this script needs read/write, but the bot at runtime only ever
 * asks for calendar.readonly.
 */
import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config/env.js";
import { DEMO_ITINERARY } from "../src/demo/dataset.js";
import {
  addDaysZoned,
  fromZonedTime,
  zonedParts,
  zonedStartOfDay,
} from "../src/lib/datetime.js";

const CALENDAR_NAME = "Villa Meltem — Guest Itinerary";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfig();
const tz = config.CALENDAR_TIMEZONE;

const raw = config.GOOGLE_SERVICE_ACCOUNT_JSON
  ? config.GOOGLE_SERVICE_ACCOUNT_JSON
  : config.GOOGLE_SERVICE_ACCOUNT_FILE
    ? readFileSync(config.GOOGLE_SERVICE_ACCOUNT_FILE, "utf-8")
    : null;

if (!raw) {
  console.error("Set GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON first.");
  process.exit(1);
}

const key = JSON.parse(raw) as { client_email: string; private_key: string };

const api = google.calendar({
  version: "v3",
  auth: new google.auth.JWT({
    email: key.client_email,
    key: key.private_key.replace(/\\n/g, "\n"),
    // Read/write, unlike the runtime client — this script creates things.
    scopes: ["https://www.googleapis.com/auth/calendar"],
  }),
});

console.log(`service account  ${key.client_email}`);
console.log(`timezone         ${tz}\n`);

// --- Find or create the calendar --------------------------------------------

const existing = (await api.calendarList.list()).data.items ?? [];
let calendarId = existing.find((c) => c.summary === CALENDAR_NAME)?.id ?? null;

if (flag("--delete")) {
  if (!calendarId) {
    console.log("Nothing to delete.");
    process.exit(0);
  }
  await api.calendars.delete({ calendarId });
  console.log(`deleted  ${CALENDAR_NAME}`);
  process.exit(0);
}

if (calendarId) {
  console.log(`found    ${CALENDAR_NAME}`);
} else {
  const created = await api.calendars.insert({
    requestBody: {
      summary: CALENDAR_NAME,
      description:
        "Demo itinerary for the WhatsApp guest concierge. Created by scripts/setup-calendar.ts.",
      timeZone: tz,
    },
  });
  calendarId = created.data.id!;
  console.log(`created  ${CALENDAR_NAME}`);
}

// --- Clear existing demo events ---------------------------------------------

if (flag("--reset") || flag("--force")) {
  const events = (await api.events.list({ calendarId, maxResults: 250 })).data.items ?? [];
  for (const event of events) {
    if (event.id) await api.events.delete({ calendarId, eventId: event.id });
  }
  console.log(`cleared  ${events.length} existing event(s)`);
}

// --- Insert the itinerary ---------------------------------------------------

const existingCount = ((await api.events.list({ calendarId, maxResults: 250 })).data.items ?? [])
  .length;

if (existingCount > 0) {
  console.log(`skipped  calendar already has ${existingCount} event(s) — use --reset to replace`);
} else {
  const today = zonedStartOfDay(new Date(), tz);
  let inserted = 0;

  for (const seed of DEMO_ITINERARY) {
    const day = addDaysZoned(today, seed.dayOffset, tz);
    const p = zonedParts(day, tz);
    const ymd = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

    // All-day entries use `date`; timed ones use `dateTime`. Exercising both is
    // the point — mixing them up is the classic calendar-integration bug.
    const timing = seed.start
      ? (() => {
          const [sh, sm] = seed.start!.split(":").map(Number);
          const start = fromZonedTime(tz, p.year, p.month, p.day, sh, sm);
          const end = seed.end
            ? (() => {
                const [eh, em] = seed.end!.split(":").map(Number);
                return fromZonedTime(tz, p.year, p.month, p.day, eh, em);
              })()
            : new Date(start.getTime() + 3_600_000);

          return {
            start: { dateTime: start.toISOString(), timeZone: tz },
            end: { dateTime: end.toISOString(), timeZone: tz },
          };
        })()
      : (() => {
          const next = addDaysZoned(day, 1, tz);
          const n = zonedParts(next, tz);
          return {
            start: { date: ymd },
            end: {
              date: `${n.year}-${String(n.month).padStart(2, "0")}-${String(n.day).padStart(2, "0")}`,
            },
          };
        })();

    await api.events.insert({
      calendarId,
      requestBody: {
        summary: seed.title,
        ...(seed.location ? { location: seed.location } : {}),
        ...(seed.description ? { description: seed.description } : {}),
        ...timing,
      },
    });
    inserted++;
  }

  console.log(`inserted ${inserted} event(s)`);
}

// --- Optionally let a person edit it ----------------------------------------

const shareWith = value("--share");
if (shareWith) {
  await api.acl.insert({
    calendarId,
    requestBody: { role: "writer", scope: { type: "user", value: shareWith } },
  });
  console.log(`shared   with ${shareWith} (writer)`);
  console.log(
    `\n         It appears under "Other calendars" in Google Calendar.\n` +
      `         If it does not show up, add it by ID:\n           ${calendarId}`,
  );
}

console.log(`\ncalendar id\n  ${calendarId}\n`);
console.log("Put this in .env:");
console.log(`  GOOGLE_CALENDAR_ID=${calendarId}`);
console.log(`  CALENDAR_DEMO=false`);
