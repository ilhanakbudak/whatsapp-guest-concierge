import { loadConfig, type AppConfig } from "./config/env.js";
import { openDatabase, type Db } from "./db/index.js";
import { createRepositories, type Repositories } from "./db/repositories/index.js";
import { createLogger, type Logger } from "./lib/logger.js";

/**
 * Everything the request handlers need, constructed once at boot and passed
 * explicitly. No module-level singletons — tests build their own container
 * against an in-memory database.
 */
export interface AppContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  repos: Repositories;
  shutdown: () => void;
}

export interface CreateContextOptions {
  config?: AppConfig;
  /** Overrides config.DATABASE_PATH — tests pass ':memory:'. */
  databasePath?: string;
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

  logger.info(
    { provider: config.LLM_PROVIDER, model: config.llmModel },
    "llm provider selected",
  );

  return {
    config,
    logger,
    db,
    repos: createRepositories(db),
    shutdown: () => db.close(),
  };
}
