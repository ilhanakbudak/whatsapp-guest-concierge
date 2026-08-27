import type { AppConfig } from "../config/env.js";
import type { KnowledgeRepository } from "../db/repositories/knowledge.js";
import type { Logger } from "../lib/logger.js";
import { GoogleDocKnowledgeBase } from "./google-doc.js";
import { LocalMarkdownKnowledgeBase } from "./local.js";
import { NotionKnowledgeBase } from "./notion.js";
import { KnowledgeService } from "./service.js";
import type { KnowledgeBaseProvider } from "./types.js";

/**
 * Swapping the source the team maintains is a config change: `KB_PROVIDER`
 * plus that provider's credentials. Nothing downstream of this function knows
 * or cares where the handbook came from.
 */
export function createKnowledgeProvider(config: AppConfig): KnowledgeBaseProvider {
  switch (config.KB_PROVIDER) {
    case "notion":
      return new NotionKnowledgeBase({
        apiKey: config.NOTION_API_KEY!,
        pageId: config.NOTION_PAGE_ID!,
      });

    case "google-doc":
      return new GoogleDocKnowledgeBase({
        documentId: config.GOOGLE_DOC_ID!,
        serviceAccountFile: config.GOOGLE_SERVICE_ACCOUNT_FILE,
        serviceAccountJson: config.GOOGLE_SERVICE_ACCOUNT_JSON,
      });

    case "local":
      return new LocalMarkdownKnowledgeBase(config.KB_LOCAL_PATH);
  }
}

export function createKnowledgeService(
  config: AppConfig,
  repository: KnowledgeRepository,
  logger: Logger,
): KnowledgeService {
  return new KnowledgeService({
    provider: createKnowledgeProvider(config),
    repository,
    logger,
  });
}

export { GoogleDocKnowledgeBase, KnowledgeService, LocalMarkdownKnowledgeBase, NotionKnowledgeBase };
export * from "./types.js";
export type { RefreshResult } from "./service.js";
