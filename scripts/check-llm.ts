/**
 * Sends real questions through the full reply pipeline against the configured
 * provider, and prints what came back plus what it cost.
 *
 * Verifies the parts unit tests cannot: that the credentials work, that this
 * provider's tool-calling round trip actually functions, and that the prompt
 * cache is being hit.
 *
 *   npm run check:llm
 *
 * This makes real API calls and costs real money (fractions of a cent).
 */
import { ConciergeHandler } from "../src/ai/handler.js";
import { createLlmProvider } from "../src/ai/registry.js";
import { createCalendarClient } from "../src/calendar/index.js";
import { ScheduleService } from "../src/calendar/schedule.js";
import { loadConfig } from "../src/config/env.js";
import { openDatabase } from "../src/db/index.js";
import { createRepositories } from "../src/db/repositories/index.js";
import { createKnowledgeBase } from "../src/knowledge/index.js";
import { createLogger } from "../src/lib/logger.js";
import { normalizePhone } from "../src/lib/phone.js";

const QUESTIONS = [
  "hey! what's the wifi password?",
  "what time does the boat leave tomorrow?",
  "is there anything on Saturday?",
  "can you book me a helicopter to Rome?",
];

const config = loadConfig();
const logger = createLogger({ ...config, LOG_LEVEL: "error" });

if (config.demo.llm) {
  console.log(
    "LLM_DEMO is on, so this would exercise the mock provider.\n" +
      "Set LLM_DEMO=false (and the matching API key) to test for real.",
  );
  process.exit(0);
}

const db = openDatabase({ path: ":memory:" });
const repos = createRepositories(db);
const provider = createLlmProvider(config);

const guest = repos.guests.upsert({
  phone: normalizePhone("+447700900001"),
  name: "Priya Patel",
  notes: "Vegetarian",
});

// Uses whichever calendar is configured, so this doubles as a full-stack check
// once CALENDAR_DEMO is off.
const schedule = new ScheduleService(createCalendarClient(config), {
  timeZone: config.CALENDAR_TIMEZONE,
});

const handler = new ConciergeHandler({
  provider,
  schedule,
  knowledgeBase: createKnowledgeBase(config),
  conversations: repos.conversations,
  usage: repos.usage,
  logger,
  timeZone: config.CALENDAR_TIMEZONE,
  maxTokens: config.LLM_MAX_TOKENS,
  temperature: config.LLM_TEMPERATURE,
  maxIterations: config.LLM_MAX_TOOL_ITERATIONS,
  historyTurns: config.CONVERSATION_HISTORY_TURNS,
});

console.log(`provider  ${provider.name}`);
console.log(`model     ${provider.model}`);
console.log(`timezone  ${config.CALENDAR_TIMEZONE}`);
console.log(`calendar  ${config.demo.calendar ? "mock" : "live Google Calendar"}\n`);

for (const question of QUESTIONS) {
  const started = Date.now();
  const reply = await handler.handle({ guest, body: question, messageSid: "SM_check" });
  const elapsed = Date.now() - started;

  console.log(`> ${question}`);
  console.log(`  ${reply.replace(/\n/g, "\n  ")}`);
  console.log(`  [${elapsed}ms]\n`);
}

const totals = repos.usage.totalsSince("1970-01-01");
console.log(
  `usage     ${totals.events} calls · ${totals.inputTokens} in · ` +
    `${totals.outputTokens} out · ${totals.cachedInputTokens} cached ` +
    `(${Math.round(totals.cacheHitRate * 100)}% of input served from cache)`,
);

if (totals.cachedInputTokens === 0) {
  console.log(
    "\nnote      No cached input tokens reported. Either this provider does not\n" +
      "          report them, or the prompt prefix is changing between calls.",
  );
}

db.close();
