import type { Db } from "../index.js";

export interface KbSnapshotRecord {
  id: number;
  source: string;
  contentHash: string;
  rendered: string;
  fetchedAt: string;
}

interface KbSnapshotRow {
  id: number;
  source: string;
  content_hash: string;
  rendered: string;
  fetched_at: string;
}

const toRecord = (row: KbSnapshotRow): KbSnapshotRecord => ({
  id: row.id,
  source: row.source,
  contentHash: row.content_hash,
  rendered: row.rendered,
  fetchedAt: row.fetched_at,
});

/**
 * Persists rendered knowledge-base snapshots.
 *
 * Two reasons this is a table rather than just an in-memory cache: the bot can
 * answer from the last good copy if Notion is down at boot, and the team can see
 * on the dashboard when the content last actually changed — as opposed to when
 * it was last fetched, which is every day regardless.
 */
export class KnowledgeRepository {
  constructor(private readonly db: Db) {}

  latest(source: string): KbSnapshotRecord | null {
    const row = this.db
      .prepare<[string], KbSnapshotRow>(
        "SELECT * FROM kb_snapshots WHERE source = ? ORDER BY fetched_at DESC, id DESC LIMIT 1",
      )
      .get(source);
    return row ? toRecord(row) : null;
  }

  /**
   * Stores a snapshot only when the content actually differs from the last one,
   * so the history is a record of changes rather than of cron firings.
   * Returns true when a new row was written.
   */
  saveIfChanged(source: string, contentHash: string, rendered: string): boolean {
    const previous = this.latest(source);
    if (previous?.contentHash === contentHash) return false;

    this.db
      .prepare("INSERT INTO kb_snapshots (source, content_hash, rendered) VALUES (?, ?, ?)")
      .run(source, contentHash, rendered);
    return true;
  }

  history(source: string, limit = 10): KbSnapshotRecord[] {
    return this.db
      .prepare<[string, number], KbSnapshotRow>(
        "SELECT * FROM kb_snapshots WHERE source = ? ORDER BY fetched_at DESC, id DESC LIMIT ?",
      )
      .all(source, limit)
      .map(toRecord);
  }

  /** Keeps the most recent `keep` snapshots per source. */
  prune(source: string, keep = 20): number {
    const result = this.db
      .prepare(
        `DELETE FROM kb_snapshots
         WHERE source = ? AND id NOT IN (
           SELECT id FROM kb_snapshots WHERE source = ? ORDER BY fetched_at DESC, id DESC LIMIT ?
         )`,
      )
      .run(source, source, keep);
    return result.changes;
  }
}
