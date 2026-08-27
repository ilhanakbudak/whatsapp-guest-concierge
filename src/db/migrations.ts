export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly up: string;
}

/**
 * Append-only. Never edit a migration that has shipped — add a new one.
 * Kept as TS rather than .sql files so the compiled output needs no asset copying.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    up: `
      CREATE TABLE guests (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        phone       TEXT    NOT NULL UNIQUE,
        name        TEXT    NOT NULL,
        role        TEXT    NOT NULL DEFAULT 'guest' CHECK (role IN ('guest','admin')),
        active      INTEGER NOT NULL DEFAULT 1,
        notes       TEXT,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_guests_active ON guests(active);

      CREATE TABLE messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guest_id    INTEGER REFERENCES guests(id) ON DELETE SET NULL,
        phone       TEXT    NOT NULL,
        direction   TEXT    NOT NULL CHECK (direction IN ('inbound','outbound')),
        body        TEXT    NOT NULL,
        twilio_sid  TEXT,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_messages_guest ON messages(guest_id, created_at);
      CREATE INDEX idx_messages_sid   ON messages(twilio_sid);

      CREATE TABLE conversations (
        guest_id    INTEGER PRIMARY KEY REFERENCES guests(id) ON DELETE CASCADE,
        turns       TEXT    NOT NULL DEFAULT '[]',
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE broadcasts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        body        TEXT    NOT NULL,
        created_by  TEXT    NOT NULL,
        status      TEXT    NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued','running','completed','failed')),
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE INDEX idx_broadcasts_status ON broadcasts(status);

      CREATE TABLE broadcast_recipients (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        broadcast_id  INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
        guest_id      INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
        phone         TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued','sending','sent','delivered','read','failed','undelivered')),
        twilio_sid    TEXT,
        error_code    TEXT,
        error_message TEXT,
        attempts      INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE (broadcast_id, guest_id)
      );
      CREATE INDEX idx_recipients_pending ON broadcast_recipients(broadcast_id, status);
      CREATE INDEX idx_recipients_sid     ON broadcast_recipients(twilio_sid);

      CREATE TABLE kb_snapshots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        source       TEXT    NOT NULL,
        content_hash TEXT    NOT NULL,
        rendered     TEXT    NOT NULL,
        fetched_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_kb_fetched ON kb_snapshots(fetched_at DESC);

      CREATE TABLE usage_events (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        kind                TEXT    NOT NULL,
        provider            TEXT    NOT NULL,
        model               TEXT    NOT NULL,
        input_tokens        INTEGER NOT NULL DEFAULT 0,
        output_tokens       INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        guest_id            INTEGER REFERENCES guests(id) ON DELETE SET NULL,
        created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_usage_created ON usage_events(created_at DESC);
    `,
  },
];
