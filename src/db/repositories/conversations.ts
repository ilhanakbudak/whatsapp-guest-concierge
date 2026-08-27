import type { Db } from "../index.js";
import type { ConversationTurn } from "../types.js";

interface ConversationRow {
  guest_id: number;
  turns: string;
  updated_at: string;
}

/**
 * Conversation history is a rolling window, not an archive — `messages` is the
 * archive. This table exists so the LLM gets recent context cheaply, so it is
 * trimmed aggressively and stored as a single JSON column rather than rows.
 */
export class ConversationsRepository {
  constructor(private readonly db: Db) {}

  get(guestId: number): ConversationTurn[] {
    const row = this.db
      .prepare<[number], ConversationRow>("SELECT * FROM conversations WHERE guest_id = ?")
      .get(guestId);

    if (!row) return [];

    try {
      const parsed: unknown = JSON.parse(row.turns);
      return Array.isArray(parsed) ? (parsed as ConversationTurn[]) : [];
    } catch {
      // A corrupt history is not worth failing a guest's message over.
      return [];
    }
  }

  /** Appends a turn and trims to the most recent `maxTurns`. */
  append(guestId: number, turn: ConversationTurn, maxTurns: number): ConversationTurn[] {
    const turns = [...this.get(guestId), turn].slice(-maxTurns);

    this.db
      .prepare(
        `INSERT INTO conversations (guest_id, turns, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(guest_id) DO UPDATE SET
           turns      = excluded.turns,
           updated_at = excluded.updated_at`,
      )
      .run(guestId, JSON.stringify(turns));

    return turns;
  }

  clear(guestId: number): void {
    this.db.prepare("DELETE FROM conversations WHERE guest_id = ?").run(guestId);
  }

  /** Drops histories untouched for `hours`, so a new stay starts clean. */
  pruneOlderThan(hours: number): number {
    const result = this.db
      .prepare(`DELETE FROM conversations WHERE updated_at < datetime('now', ?)`)
      .run(`-${hours} hours`);
    return result.changes;
  }
}
