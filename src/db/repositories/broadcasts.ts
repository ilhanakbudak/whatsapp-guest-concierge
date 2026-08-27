import type { Db } from "../index.js";
import type {
  Broadcast,
  BroadcastRecipient,
  BroadcastStatus,
  RecipientStatus,
} from "../types.js";

interface BroadcastRow {
  id: number;
  body: string;
  created_by: string;
  status: BroadcastStatus;
  created_at: string;
  completed_at: string | null;
}

interface RecipientRow {
  id: number;
  broadcast_id: number;
  guest_id: number;
  phone: string;
  status: RecipientStatus;
  twilio_sid: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  updated_at: string;
}

const toBroadcast = (row: BroadcastRow): Broadcast => ({
  id: row.id,
  body: row.body,
  createdBy: row.created_by,
  status: row.status,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

const toRecipient = (row: RecipientRow): BroadcastRecipient => ({
  id: row.id,
  broadcastId: row.broadcast_id,
  guestId: row.guest_id,
  phone: row.phone,
  status: row.status,
  twilioSid: row.twilio_sid,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  attempts: row.attempts,
  updatedAt: row.updated_at,
});

export interface CreateBroadcastInput {
  body: string;
  createdBy: string;
  recipients: Array<{ guestId: number; phone: string }>;
}

export interface BroadcastSummary {
  broadcast: Broadcast;
  counts: Record<RecipientStatus, number>;
  total: number;
}

export class BroadcastsRepository {
  constructor(private readonly db: Db) {}

  /**
   * The broadcast and every recipient row commit together. A partially-created
   * broadcast would be drained by the worker and silently under-deliver.
   */
  create(input: CreateBroadcastInput): Broadcast {
    return this.db.transaction(() => {
      const row = this.db
        .prepare<[string, string], BroadcastRow>(
          "INSERT INTO broadcasts (body, created_by) VALUES (?, ?) RETURNING *",
        )
        .get(input.body, input.createdBy)!;

      const insert = this.db.prepare(
        "INSERT INTO broadcast_recipients (broadcast_id, guest_id, phone) VALUES (?, ?, ?)",
      );
      for (const recipient of input.recipients) {
        insert.run(row.id, recipient.guestId, recipient.phone);
      }

      return toBroadcast(row);
    })();
  }

  findById(id: number): Broadcast | null {
    const row = this.db
      .prepare<[number], BroadcastRow>("SELECT * FROM broadcasts WHERE id = ?")
      .get(id);
    return row ? toBroadcast(row) : null;
  }

  list(limit = 25): Broadcast[] {
    return this.db
      .prepare<[number], BroadcastRow>(
        "SELECT * FROM broadcasts ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(limit)
      .map(toBroadcast);
  }

  setStatus(id: number, status: BroadcastStatus): void {
    this.db
      .prepare(
        `UPDATE broadcasts
         SET status = ?, completed_at = CASE WHEN ? IN ('completed','failed')
                                             THEN datetime('now') ELSE completed_at END
         WHERE id = ?`,
      )
      .run(status, status, id);
  }

  /**
   * Claims up to `limit` queued recipients, moving them to 'sending' in the same
   * statement that selects them. The status change is what makes the claim
   * exclusive — incrementing `attempts` alone would let a second caller re-claim
   * the same rows and double-send.
   */
  claimQueued(broadcastId: number, limit: number): BroadcastRecipient[] {
    return this.db
      .prepare<[number, number], RecipientRow>(
        `UPDATE broadcast_recipients
         SET status = 'sending', attempts = attempts + 1, updated_at = datetime('now')
         WHERE id IN (
           SELECT id FROM broadcast_recipients
           WHERE broadcast_id = ? AND status = 'queued'
           ORDER BY id
           LIMIT ?
         )
         RETURNING *`,
      )
      .all(broadcastId, limit)
      .map(toRecipient);
  }

  markSent(recipientId: number, twilioSid: string): void {
    this.db
      .prepare(
        `UPDATE broadcast_recipients
         SET status = 'sent', twilio_sid = ?, error_code = NULL, error_message = NULL,
             updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(twilioSid, recipientId);
  }

  markFailed(recipientId: number, errorCode: string | null, errorMessage: string): void {
    this.db
      .prepare(
        `UPDATE broadcast_recipients
         SET status = 'failed', error_code = ?, error_message = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(errorCode, errorMessage, recipientId);
  }

  /** Returns a failed or stranded recipient to the queue for another attempt. */
  requeue(recipientId: number): void {
    this.db
      .prepare(
        "UPDATE broadcast_recipients SET status = 'queued', updated_at = datetime('now') WHERE id = ?",
      )
      .run(recipientId);
  }

  /** Applied from Twilio's status webhook, keyed by message SID. */
  updateStatusBySid(twilioSid: string, status: RecipientStatus): boolean {
    const result = this.db
      .prepare(
        "UPDATE broadcast_recipients SET status = ?, updated_at = datetime('now') WHERE twilio_sid = ?",
      )
      .run(status, twilioSid);
    return result.changes > 0;
  }

  recipients(broadcastId: number): BroadcastRecipient[] {
    return this.db
      .prepare<[number], RecipientRow>(
        "SELECT * FROM broadcast_recipients WHERE broadcast_id = ? ORDER BY id",
      )
      .all(broadcastId)
      .map(toRecipient);
  }

  summary(broadcastId: number): BroadcastSummary | null {
    const broadcast = this.findById(broadcastId);
    if (!broadcast) return null;

    const counts: Record<RecipientStatus, number> = {
      queued: 0,
      sending: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      undelivered: 0,
    };

    const rows = this.db
      .prepare<[number], { status: RecipientStatus; count: number }>(
        "SELECT status, COUNT(*) AS count FROM broadcast_recipients WHERE broadcast_id = ? GROUP BY status",
      )
      .all(broadcastId);

    let total = 0;
    for (const row of rows) {
      counts[row.status] = row.count;
      total += row.count;
    }

    return { broadcast, counts, total };
  }

  /** Broadcasts left mid-flight by a restart, so the worker can resume them. */
  findResumable(): Broadcast[] {
    return this.db
      .prepare<[], BroadcastRow>(
        `SELECT DISTINCT b.* FROM broadcasts b
         JOIN broadcast_recipients r ON r.broadcast_id = b.id
         WHERE b.status IN ('queued','running') AND r.status IN ('queued','sending')
         ORDER BY b.id`,
      )
      .all()
      .map(toBroadcast);
  }
}
