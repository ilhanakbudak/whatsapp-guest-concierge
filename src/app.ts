import { loadConfig, type AppConfig } from "./config/env.js";
import { openDatabase, type Db } from "./db/index.js";
import { createRepositories, type Repositories } from "./db/repositories/index.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { TokenBucketLimiter } from "./lib/rate-limit.js";
import { BackgroundTaskRunner, type TaskRunner } from "./lib/tasks.js";
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
  handler?: MessageHandler;
}

export function createContext(options: CreateContextOptions = {}): AppContext {
  const config = options.config ?? loadConfig();
  const logger = createLogger(config);

  const db = openDatabase({
    path: options.databasePath ?? config.DATABASE_PATH,
    onMigration: (m) => logger.info({ migration: m.name }, "applied migration"),
  });

  if (config.DEMO_MODE) {
    logger.warn("DEMO_MODE is on — Twilio, Calendar and the knowledge base are mocked");
  }

  logger.info({ provider: config.LLM_PROVIDER, model: config.llmModel }, "llm provider selected");

  const tasks = new BackgroundTaskRunner(logger);

  return {
    config,
    logger,
    db,
    repos: createRepositories(db),
    whatsapp: options.whatsapp ?? createWhatsAppClient(config, logger),
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
