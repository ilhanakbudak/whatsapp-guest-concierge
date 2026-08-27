import cron from "node-cron";
import type { Logger } from "../lib/logger.js";
import type { KnowledgeService } from "./service.js";

export interface ScheduledRefresh {
  stop: () => void;
}

/**
 * Runs the knowledge-base refresh on a cron schedule.
 *
 * The brief said a daily refresh is fine, and the content genuinely changes
 * about that often. On-demand refresh exists alongside this for the case that
 * actually matters: someone fixes a wrong phone number and wants it live now.
 */
export function scheduleKnowledgeRefresh(
  service: KnowledgeService,
  expression: string,
  logger: Logger,
): ScheduledRefresh {
  if (!cron.validate(expression)) {
    // Fail loudly rather than silently never refreshing — a typo'd cron string
    // would otherwise look exactly like a working system.
    throw new Error(`KB_REFRESH_CRON is not a valid cron expression: "${expression}"`);
  }

  const task = cron.schedule(expression, () => {
    void service
      .refresh()
      .then((result) => {
        logger.info({ ...result }, "scheduled knowledge base refresh complete");
      })
      .catch((err: unknown) => {
        // Never throw out of the scheduler; the next run will try again.
        logger.error({ err }, "scheduled knowledge base refresh failed");
      });
  });

  logger.info({ cron: expression, source: service.source }, "knowledge base refresh scheduled");

  return { stop: () => task.stop() };
}
