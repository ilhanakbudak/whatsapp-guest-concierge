/**
 * Loads one of the worked scenarios from examples/ so a fresh clone has
 * something to talk about.
 *
 * Idempotent: guests are upserted by phone number and knowledge-base files are
 * only written when absent, so re-running never clobbers local edits.
 *
 *   npm run seed                            the default villa holiday
 *   npm run seed -- --list                  every available scenario
 *   npm run seed -- --scenario ski-chalet   a different kind of trip
 *   npm run seed -- --scenario wedding-weekend --reset --force
 */
import { mkdirSync, existsSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig } from "../src/config/env.js";
import { openDatabase } from "../src/db/index.js";
import { createRepositories } from "../src/db/repositories/index.js";
import { listScenarios, loadScenario } from "../src/demo/scenarios.js";
import { MockCalendarClient } from "../src/calendar/mock.js";
import { formatSchedule } from "../src/calendar/format.js";
import { normalizePhone } from "../src/lib/phone.js";
import { zonedStartOfDay, addDaysZoned, zonedEndOfDay } from "../src/lib/datetime.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const reset = args.includes("--reset");

const flagValue = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--list")) {
  const scenarios = listScenarios();
  if (scenarios.length === 0) {
    console.log("No scenarios found in examples/");
  } else {
    console.log("Available scenarios:\n");
    for (const s of scenarios) {
      console.log(`  ${s.slug.padEnd(20)} ${s.name}`);
      console.log(`  ${" ".repeat(20)} ${s.summary}`);
      console.log(`  ${" ".repeat(20)} ${s.guests} guests · ${s.events} events · ${s.timezone}\n`);
    }
    console.log("Load one with:  npm run seed -- --scenario <slug>");
  }
  process.exit(0);
}

const scenarioSlug = flagValue("--scenario") ?? "villa-holiday";
const scenario = loadScenario(scenarioSlug);

const config = loadConfig();

console.log(`scenario ${scenario.name} (${scenario.slug})`);
console.log(`         ${scenario.summary}\n`);

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

for (const guest of scenario.guests) {
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

console.log(`guests ${added} added, ${updated} updated (${scenario.guests.length} total)`);

// --- Knowledge base ---------------------------------------------------------

const kbDir = config.KB_LOCAL_PATH;
mkdirSync(kbDir, { recursive: true });

/**
 * Files left behind by a previously-seeded scenario. The knowledge base is
 * concatenated wholesale, so a stale ski-chalet document sitting beside a villa
 * one would have the assistant answering from both at once.
 */
const expected = new Set(Object.keys(scenario.knowledgeBase));
const foreign = existsSync(kbDir)
  ? readdirSync(kbDir).filter((f) => f.endsWith(".md") && !expected.has(f))
  : [];

if (foreign.length > 0) {
  if (force) {
    for (const file of foreign) rmSync(join(kbDir, file), { force: true });
    console.log(`kb     removed ${foreign.length} file(s) from a previous scenario`);
  } else {
    console.log(
      `kb     ! ${foreign.length} file(s) in ${kbDir} belong to another scenario:\n` +
        `         ${foreign.join(", ")}\n` +
        `         The assistant would read them too. Re-run with --force to replace them.`,
    );
  }
}

let written = 0;
let skipped = 0;

for (const [filename, content] of Object.entries(scenario.knowledgeBase)) {
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
// The scenario's own timezone, not the configured one — a ski week in
// Saas-Fee is not on Istanbul time.
const timeZone = scenario.timezone;
const calendar = new MockCalendarClient({ timeZone, seeds: scenario.itinerary });
const from = zonedStartOfDay(now, timeZone);
const to = zonedEndOfDay(addDaysZoned(from, 6, timeZone), timeZone);

const events = await calendar.listEvents({ from, to });

console.log(`agenda ${events.length} of ${scenario.itinerary.length} events in the next 7 days (${timeZone})`);

if (!config.demo.calendar) {
  console.log(
    "\nnote   CALENDAR_DEMO is off, so the bot will read your real Google Calendar.\n" +
      "       The agenda below is the demo fixture and will not be used.",
  );
}

console.log(`\n${formatSchedule(events, { timeZone, now })}\n`);

db.close();

console.log("Seeded. Run `npm run dev`, then open http://localhost:3000/dashboard");
if (timeZone !== config.CALENDAR_TIMEZONE) {
  console.log(
    `\nnote     this scenario runs in ${timeZone}. Set CALENDAR_TIMEZONE=${timeZone}\n` +
      `         in .env so the bot answers "tomorrow" in the right timezone.`,
  );
}
