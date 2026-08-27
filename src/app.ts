import { loadConfig, type AppConfig } from "./config/env.js";
import { openDatabase, type Db } from "./db/index.js";
import { createRepositories, type Repositories } from "./db/repositories/index.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { TokenBucketLimiter } from "./lib/rate-limit.js";
import { BackgroundTaskRunner, type TaskRunner } from "./lib/tasks.js";
import { ConciergeHandler } from "./ai/handler.js";
import { createLlmProvider } from "./ai/registry.js";
import type { LlmProvider } from "./ai/types.js";
import { createCalendarClient } from "./calendar/index.js";
import { createKnowledgeService, type KnowledgeService } from "./knowledge/index.js";
import { scheduleKnowledgeRefresh, type ScheduledRefresh } from "./knowledge/schedule.js";
import { ScheduleService } from "./calendar/schedule.js";
import type { CalendarClient } from "./calendar/types.js";
import { createWhatsAppClient } from "./whatsapp/index.js";
import type { MessageHandler } from "./whatsapp/handler.js";
import type { WhatsAppClient } from "./whatsapp/types.js";

/**
 * Everything the request handlers need, constructed once at boot and passed
 * explicitly. No module-level singletons — tests build their own container
 * against an in-memory database and mock clients.
 */
export interface AppContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  repos: Repositories;
  whatsapp: WhatsAppClient;
  calendar: CalendarClient;
  schedule: ScheduleService;
  llm: LlmProvider;
  knowledgeBase: KnowledgeService;
  handler: MessageHandler;
  tasks: TaskRunner;
  rateLimiter: TokenBucketLimiter;
  shutdown: () => Promise<void>;
}

export interface CreateContextOptions {
  config?: AppConfig;
  /** Overrides config.DATABASE_PATH — tests pass ':memory:'. */
  databasePath?: string;
  /** Overrides for tests; each defaults to the configured implementation. */
  whatsapp?: WhatsAppClient;
  calendar?: CalendarClient;
  llm?: LlmProvider;
  handler?: MessageHandler;
}

export function createContext(options: CreateContextOptions = {}): AppContext {
  const config = options.config ?? loadConfig();
  const logger = createLogger(config);

  const db = openDatabase({
    path: options.databasePath ?? config.DATABASE_PATH,
    onMigration: (m) => logger.info({ migration: m.name }, "applied migration"),
  });

  const mocked = Object.entries(config.demo)
    .filter(([, isMocked]) => isMocked)
    .map(([name]) => name);
  if (mocked.length > 0) {
    logger.warn({ mocked }, "running with mocked integrations");
  }

  logger.info({ provider: config.LLM_PROVIDER, model: config.llmModel }, "llm provider selected");

  const tasks = new BackgroundTaskRunner(logger);
  const calendar = options.calendar ?? createCalendarClient(config);
  const repos = createRepositories(db);
  const schedule = new ScheduleService(calendar, { timeZone: config.CALENDAR_TIMEZONE });
  const llm = options.llm ?? createLlmProvider(config);
  const knowledgeBase = createKnowledgeService(config, repos.knowledge, logger);

  // Not scheduled in tests: a live cron timer keeps the process alive.
  const refreshJob: ScheduledRefresh | null = config.isTest
    ? null
    : scheduleKnowledgeRefresh(knowledgeBase, config.KB_REFRESH_CRON, logger);

  return {
    config,
    logger,
    db,
    repos,
    whatsapp: options.whatsapp ?? createWhatsAppClient(config, logger),
    calendar,
    schedule,
    llm,
    knowledgeBase,
    handler:
      options.handler ??
      new ConciergeHandler({
        provider: llm,
        schedule,
        knowledgeBase,
        conversations: repos.conversations,
        usage: repos.usage,
        logger,
        timeZone: config.CALENDAR_TIMEZONE,
        maxTokens: config.LLM_MAX_TOKENS,
        temperature: config.LLM_TEMPERATURE,
        maxIterations: config.LLM_MAX_TOOL_ITERATIONS,
        historyTurns: config.CONVERSATION_HISTORY_TURNS,
      }),
    tasks,
    rateLimiter: new TokenBucketLimiter(
      config.GUEST_RATE_LIMIT_PER_MINUTE,
      config.GUEST_RATE_LIMIT_PER_MINUTE,
    ),
    shutdown: async () => {
      refreshJob?.stop();
      // Finish replies already in flight before closing the database under them.
      await tasks.drain();
      db.close();
    },
  };
}
