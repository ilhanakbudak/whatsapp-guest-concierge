import type { Db } from "../index.js";
import type { Guest, GuestRole } from "../types.js";
import type { E164Number } from "../../lib/phone.js";

interface GuestRow {
  id: number;
  phone: string;
  name: string;
  role: GuestRole;
  active: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const toGuest = (row: GuestRow): Guest => ({
  id: row.id,
  phone: row.phone,
  name: row.name,
  role: row.role,
  active: row.active === 1,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface UpsertGuestInput {
  phone: E164Number;
  name: string;
  role?: GuestRole;
  notes?: string | null;
}

export class GuestsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Idempotent by phone number — re-adding an existing guest reactivates them and
   * updates their name rather than failing on the unique constraint. The admin
   * `!add` command relies on this.
   */
  upsert(input: UpsertGuestInput): Guest {
    const row = this.db
      .prepare<[string, string, GuestRole, string | null], GuestRow>(
        `INSERT INTO guests (phone, name, role, notes)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(phone) DO UPDATE SET
           name       = excluded.name,
           role       = excluded.role,
           notes      = COALESCE(excluded.notes, guests.notes),
           active     = 1,
           updated_at = datetime('now')
         RETURNING *`,
      )
      .get(input.phone, input.name, input.role ?? "guest", input.notes ?? null);

    return toGuest(row!);
  }

  findByPhone(phone: string): Guest | null {
    const row = this.db
      .prepare<[string], GuestRow>("SELECT * FROM guests WHERE phone = ?")
      .get(phone);
    return row ? toGuest(row) : null;
  }

  findById(id: number): Guest | null {
    const row = this.db.prepare<[number], GuestRow>("SELECT * FROM guests WHERE id = ?").get(id);
    return row ? toGuest(row) : null;
  }

  list(options: { activeOnly?: boolean } = {}): Guest[] {
    const sql = options.activeOnly
      ? "SELECT * FROM guests WHERE active = 1 ORDER BY name"
      : "SELECT * FROM guests ORDER BY active DESC, name";
    return this.db.prepare<[], GuestRow>(sql).all().map(toGuest);
  }

  /** Soft delete: history and delivery logs must survive removing a guest. */
  deactivate(phone: string): boolean {
    const result = this.db
      .prepare("UPDATE guests SET active = 0, updated_at = datetime('now') WHERE phone = ?")
      .run(phone);
    return result.changes > 0;
  }

  /** The allowlist gate on the inbound webhook. */
  isAuthorized(phone: string): boolean {
    const row = this.db
      .prepare<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM guests WHERE phone = ? AND active = 1",
      )
      .get(phone);
    return (row?.count ?? 0) > 0;
  }
}
