import type { Db } from "../index.js";
import type { UsageEvent } from "../types.js";

interface UsageRow {
  id: number;
  kind: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  guest_id: number | null;
  created_at: string;
}

const toUsageEvent = (row: UsageRow): UsageEvent => ({
  id: row.id,
  kind: row.kind,
  provider: row.provider,
  model: row.model,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cachedInputTokens: row.cached_input_tokens,
  guestId: row.guest_id,
  createdAt: row.created_at,
});

export interface RecordUsageInput {
  kind: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  guestId?: number | null;
}

export interface UsageTotals {
  events: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Share of input tokens served from cache. The number AD-3 exists to move. */
  cacheHitRate: number;
}

export class UsageRepository {
  constructor(private readonly db: Db) {}

  record(input: RecordUsageInput): void {
    this.db
      .prepare(
        `INSERT INTO usage_events
           (kind, provider, model, input_tokens, output_tokens, cached_input_tokens, guest_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.provider,
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.cachedInputTokens ?? 0,
        input.guestId ?? null,
      );
  }

  totalsSince(isoTimestamp: string): UsageTotals {
    const row = this.db
      .prepare<
        [string],
        {
          events: number;
          input_tokens: number | null;
          output_tokens: number | null;
          cached_input_tokens: number | null;
        }
      >(
        `SELECT COUNT(*) AS events,
                SUM(input_tokens)        AS input_tokens,
                SUM(output_tokens)       AS output_tokens,
                SUM(cached_input_tokens) AS cached_input_tokens
         FROM usage_events WHERE created_at >= ?`,
      )
      .get(isoTimestamp);

    const inputTokens = row?.input_tokens ?? 0;
    const cachedInputTokens = row?.cached_input_tokens ?? 0;
    const billable = inputTokens + cachedInputTokens;

    return {
      events: row?.events ?? 0,
      inputTokens,
      outputTokens: row?.output_tokens ?? 0,
      cachedInputTokens,
      cacheHitRate: billable === 0 ? 0 : cachedInputTokens / billable,
    };
  }

  recent(limit = 50): UsageEvent[] {
    return this.db
      .prepare<[number], UsageRow>(
        "SELECT * FROM usage_events ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(limit)
      .map(toUsageEvent);
  }
}
