/**
 * Loads the fictional Villa Meltem dataset so a fresh clone has something to
 * talk about.
 *
 * Idempotent: guests are upserted by phone number and knowledge-base files are
 * only written when absent, so re-running never clobbers local edits. Pass
 * --force to overwrite the knowledge base, --reset to start from an empty
 * database.
 */
import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig } from "../src/config/env.js";
import { openDatabase } from "../src/db/index.js";
import { createRepositories } from "../src/db/repositories/index.js";
import { DEMO_GUESTS, DEMO_ITINERARY, DEMO_KB_FILES } from "../src/demo/dataset.js";
import { MockCalendarClient } from "../src/calendar/mock.js";
import { formatSchedule } from "../src/calendar/format.js";
import { normalizePhone } from "../src/lib/phone.js";
import { zonedStartOfDay, addDaysZoned, zonedEndOfDay } from "../src/lib/datetime.js";

const force = process.argv.includes("--force");
const reset = process.argv.includes("--reset");

const config = loadConfig();

if (reset && config.DATABASE_PATH !== ":memory:" && existsSync(config.DATABASE_PATH)) {
  rmSync(config.DATABASE_PATH, { force: true });
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(`${config.DATABASE_PATH}${suffix}`, { force: true });
  }
  console.log(`reset  removed ${config.DATABASE_PATH}`);
}

// --- Guests -----------------------------------------------------------------

const db = openDatabase({ path: config.DATABASE_PATH });
const repos = createRepositories(db);

let added = 0;
let updated = 0;

for (const guest of DEMO_GUESTS) {
  const phone = normalizePhone(guest.phone);
  const existing = repos.guests.findByPhone(phone);

  repos.guests.upsert({
    phone,
    name: guest.name,
    role: guest.role,
    notes: guest.notes ?? null,
  });

  if (existing) updated++;
  else added++;
}

console.log(`guests ${added} added, ${updated} updated (${DEMO_GUESTS.length} total)`);

// --- Knowledge base ---------------------------------------------------------

const kbDir = config.KB_LOCAL_PATH;
mkdirSync(kbDir, { recursive: true });

let written = 0;
let skipped = 0;

for (const [filename, content] of Object.entries(DEMO_KB_FILES)) {
  const path = join(kbDir, filename);

  if (existsSync(path) && !force) {
    skipped++;
    continue;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  written++;
}

console.log(
  `kb     ${written} written, ${skipped} left alone` +
    (skipped > 0 && !force ? " (use --force to overwrite)" : ""),
);

// --- Itinerary preview ------------------------------------------------------

// The itinerary lives in the mock calendar rather than the database, because it
// stands in for Google Calendar. Rendering it here proves the seed produced
// something coherent and shows the operator what the bot will say.
const now = new Date();
const calendar = new MockCalendarClient({ timeZone: config.CALENDAR_TIMEZONE });
const from = zonedStartOfDay(now, config.CALENDAR_TIMEZONE);
const to = zonedEndOfDay(
  addDaysZoned(from, 6, config.CALENDAR_TIMEZONE),
  config.CALENDAR_TIMEZONE,
);

const events = await calendar.listEvents({ from, to });

console.log(
  `agenda ${events.length} events across ${DEMO_ITINERARY.length} seeds ` +
    `(timezone ${config.CALENDAR_TIMEZONE})`,
);

if (!config.demo.calendar) {
  console.log(
    "\nnote   CALENDAR_DEMO is off, so the bot will read your real Google Calendar.\n" +
      "       The agenda below is the demo fixture and will not be used.",
  );
}

console.log(`\n${formatSchedule(events, { timeZone: config.CALENDAR_TIMEZONE, now })}\n`);

db.close();

console.log("Seeded. Run `npm run dev` and open http://localhost:3000/health/ready");
