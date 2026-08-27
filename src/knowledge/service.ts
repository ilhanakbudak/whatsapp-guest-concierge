import type { KnowledgeRepository } from "../db/repositories/knowledge.js";
import { errorMessage } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import type { KnowledgeBaseProvider, KnowledgeBaseSnapshot } from "./types.js";

export interface RefreshResult {
  source: string;
  hash: string;
  changed: boolean;
  characters: number;
  fetchedAt: Date;
}

export interface KnowledgeServiceOptions {
  provider: KnowledgeBaseProvider;
  repository: KnowledgeRepository;
  logger: Logger;
  /** How long a snapshot is served before a fetch is attempted. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Owns the knowledge base: fetching it, deciding whether it changed, persisting
 * it, and serving it to the prompt builder.
 *
 * The central requirement is that `content` stays byte-identical between
 * refreshes, because it is the cacheable half of the system prompt. A provider
 * that returned equivalent-but-reordered text every day would quietly destroy
 * the prompt cache, so change is judged by content hash and the stored string is
 * reused when the hash matches.
 */
export class KnowledgeService {
  private snapshot: KnowledgeBaseSnapshot | null = null;
  /**
   * When the service last fetched, on the service's own clock. Deliberately not
   * `snapshot.fetchedAt`: that is stamped by the provider, so comparing it
   * against `this.now()` mixes two clocks and makes the TTL untestable.
   */
  private lastFetchedAt: number | null = null;
  private inFlight: Promise<RefreshResult> | null = null;
  private lastError: string | null = null;

  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: KnowledgeServiceOptions) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  get source(): string {
    return this.options.provider.source;
  }

  get status() {
    return {
      source: this.source,
      hash: this.snapshot?.hash ?? null,
      characters: this.snapshot?.content.length ?? 0,
      fetchedAt: this.snapshot?.fetchedAt ?? null,
      lastError: this.lastError,
    };
  }

  /** The content to put in the prompt. Loads from cache, store, or source. */
  async getContent(): Promise<string> {
    if (
      this.snapshot &&
      this.lastFetchedAt !== null &&
      this.now() - this.lastFetchedAt < this.ttlMs
    ) {
      return this.snapshot.content;
    }

    try {
      await this.refresh();
      return this.snapshot!.content;
    } catch (err) {
      // Serving yesterday's handbook beats telling a guest nothing because
      // Notion happened to be down.
      const stored = this.snapshot ?? this.loadStored();
      if (stored) {
        this.options.logger.warn(
          { err, source: this.source },
          "knowledge base refresh failed, serving last known copy",
        );
        return stored.content;
      }
      throw err;
    }
  }

  /**
   * Forces a fetch. Backs the daily job, the dashboard and the !refresh command.
   * Concurrent calls share one fetch — a burst of guest messages after a TTL
   * expiry should cause one request to Notion, not one per message.
   */
  async refresh(): Promise<RefreshResult> {
    this.inFlight ??= this.doRefresh().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async doRefresh(): Promise<RefreshResult> {
    try {
      const fetched = await this.options.provider.fetch();

      const changed = this.options.repository.saveIfChanged(
        this.source,
        fetched.hash,
        fetched.content,
      );
      this.lastError = null;
      this.lastFetchedAt = this.now();

      // On an unchanged hash, keep serving the existing string rather than the
      // newly-built equivalent. Identical bytes are what keep the provider-side
      // prompt cache warm, so this makes that guarantee explicit.
      this.snapshot =
        !changed && this.snapshot
          ? { ...this.snapshot, fetchedAt: fetched.fetchedAt }
          : fetched;

      this.options.logger.info(
        { source: this.source, hash: fetched.hash, changed, characters: fetched.content.length },
        changed ? "knowledge base updated" : "knowledge base unchanged",
      );

      if (changed) this.options.repository.prune(this.source);

      return {
        source: this.source,
        hash: this.snapshot.hash,
        changed,
        characters: this.snapshot.content.length,
        fetchedAt: this.snapshot.fetchedAt,
      };
    } catch (err) {
      this.lastError = errorMessage(err);
      throw err;
    }
  }

  /** Falls back to the newest persisted snapshot, e.g. when the source is down. */
  private loadStored(): KnowledgeBaseSnapshot | null {
    const record = this.options.repository.latest(this.source);
    if (!record) return null;

    this.snapshot = {
      content: record.rendered,
      hash: record.contentHash,
      fetchedAt: new Date(record.fetchedAt),
    };
    // Deliberately leaves lastFetchedAt null: a snapshot recovered from storage
    // is a fallback, not a fresh fetch, so the next call should still try the
    // source rather than treating the stored copy as current.
    return this.snapshot;
  }
}
