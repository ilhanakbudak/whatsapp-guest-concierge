import type { AppConfig } from "../config/env.js";
import { LocalMarkdownKnowledgeBase } from "./local.js";
import type { KnowledgeBaseProvider, KnowledgeBaseSnapshot } from "./types.js";

/**
 * Caches the rendered knowledge base in memory.
 *
 * The content changes maybe once a week, so re-reading it per message would be
 * pure waste — and because it is the cacheable half of the system prompt, a
 * stable string is also what keeps the provider-side prompt cache warm.
 */
export class CachedKnowledgeBase {
  private snapshot: KnowledgeBaseSnapshot | null = null;
  private inFlight: Promise<KnowledgeBaseSnapshot> | null = null;

  constructor(
    private readonly provider: KnowledgeBaseProvider,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<KnowledgeBaseSnapshot> {
    if (this.snapshot && this.now() - this.snapshot.fetchedAt.getTime() < this.ttlMs) {
      return this.snapshot;
    }
    return this.refresh();
  }

  /** Forces a re-read. Backs the daily job, the dashboard button and `!refresh`. */
  async refresh(): Promise<KnowledgeBaseSnapshot> {
    // Collapse concurrent refreshes so a burst of messages triggers one read.
    this.inFlight ??= this.provider
      .fetch()
      .then((snapshot) => {
        this.snapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  get current(): KnowledgeBaseSnapshot | null {
    return this.snapshot;
  }
}

export function createKnowledgeBase(config: AppConfig): CachedKnowledgeBase {
  // Notion and Google Docs providers land with the knowledge-base phase; local
  // Markdown is the default and needs no credentials.
  return new CachedKnowledgeBase(new LocalMarkdownKnowledgeBase(config.KB_LOCAL_PATH));
}

export { LocalMarkdownKnowledgeBase };
export * from "./types.js";
