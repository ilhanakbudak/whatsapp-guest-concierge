import { loadConfig, type AppConfig } from "./config/env.js";
import { openDatabase, type Db } from "./db/index.js";
import { createRepositories, type Repositories } from "./db/repositories/index.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { TokenBucketLimiter } from "./lib/rate-limit.js";
import { BackgroundTaskRunner, type TaskRunner } from "./lib/tasks.js";
import { createCalendarClient } from "./calendar/index.js";
import { ScheduleService } from "./calendar/schedule.js";
import type { CalendarClient } from "./calendar/types.js";
import { createWhatsAppClient } from "./whatsapp/index.js";
import { PlaceholderHandler, type MessageHandler } from "./whatsapp/handler.js";
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

  return {
    config,
    logger,
    db,
    repos: createRepositories(db),
    whatsapp: options.whatsapp ?? createWhatsAppClient(config, logger),
    calendar,
    schedule: new ScheduleService(calendar, { timeZone: config.CALENDAR_TIMEZONE }),
    handler: options.handler ?? new PlaceholderHandler(),
    tasks,
    rateLimiter: new TokenBucketLimiter(
      config.GUEST_RATE_LIMIT_PER_MINUTE,
      config.GUEST_RATE_LIMIT_PER_MINUTE,
    ),
    shutdown: async () => {
      // Finish replies already in flight before closing the database under them.
      await tasks.drain();
      db.close();
    },
  };
}
