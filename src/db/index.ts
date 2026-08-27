import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS, type Migration } from "./migrations.js";

export type Db = Database.Database;

export interface OpenDbOptions {
  /** File path, or ':memory:' for tests. */
  path: string;
  onMigration?: (migration: Migration) => void;
}

export function openDatabase({ path, onMigration }: OpenDbOptions): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);

  // WAL survives concurrent reads while the broadcast worker writes.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  migrate(db, onMigration);
  return db;
}

export function migrate(db: Db, onMigration?: (m: Migration) => void): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare<[], { id: number }>("SELECT id FROM migrations").all().map((r) => r.id),
  );

  const record = db.prepare("INSERT INTO migrations (id, name) VALUES (?, ?)");

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    // Each migration is atomic: schema change and its bookkeeping row commit
    // together, so a crash mid-migration can't leave a half-applied schema.
    db.transaction(() => {
      db.exec(migration.up);
      record.run(migration.id, migration.name);
    })();

    onMigration?.(migration);
  }
}

export function appliedMigrations(db: Db): number[] {
  return db
    .prepare<[], { id: number }>("SELECT id FROM migrations ORDER BY id")
    .all()
    .map((r) => r.id);
}
