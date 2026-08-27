import { openDatabase, type Db } from "../../src/db/index.js";
import { createRepositories, type Repositories } from "../../src/db/repositories/index.js";
import { normalizePhone } from "../../src/lib/phone.js";

export interface TestContext {
  db: Db;
  repos: Repositories;
  close: () => void;
}

export function createTestDb(): TestContext {
  const db = openDatabase({ path: ":memory:" });
  return { db, repos: createRepositories(db), close: () => db.close() };
}

export function seedGuests(repos: Repositories, count = 3) {
  return Array.from({ length: count }, (_, i) =>
    repos.guests.upsert({
      phone: normalizePhone(`+4477009001${String(i).padStart(2, "0")}`),
      name: `Guest ${i + 1}`,
    }),
  );
}
