import type { Db } from "../index.js";
import type { Message, MessageDirection } from "../types.js";

interface MessageRow {
  id: number;
  guest_id: number | null;
  phone: string;
  direction: MessageDirection;
  body: string;
  twilio_sid: string | null;
  created_at: string;
}

const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  guestId: row.guest_id,
  phone: row.phone,
  direction: row.direction,
  body: row.body,
  twilioSid: row.twilio_sid,
  createdAt: row.created_at,
});

export interface RecordMessageInput {
  guestId: number | null;
  phone: string;
  direction: MessageDirection;
  body: string;
  twilioSid?: string | null;
}

export class MessagesRepository {
  constructor(private readonly db: Db) {}

  record(input: RecordMessageInput): Message {
    const row = this.db
      .prepare<[number | null, string, MessageDirection, string, string | null], MessageRow>(
        `INSERT INTO messages (guest_id, phone, direction, body, twilio_sid)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(input.guestId, input.phone, input.direction, input.body, input.twilioSid ?? null);

    return toMessage(row!);
  }

  recentForGuest(guestId: number, limit = 20): Message[] {
    return this.db
      .prepare<[number, number], MessageRow>(
        "SELECT * FROM messages WHERE guest_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(guestId, limit)
      .map(toMessage)
      .reverse();
  }

  /** Powers the dashboard's activity feed. */
  recent(limit = 50): Message[] {
    return this.db
      .prepare<[number], MessageRow>(
        "SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(limit)
      .map(toMessage);
  }

  countSince(isoTimestamp: string): number {
    const row = this.db
      .prepare<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM messages WHERE created_at >= ?",
      )
      .get(isoTimestamp);
    return row?.count ?? 0;
  }
}
