import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appliedMigrations, migrate, openDatabase } from "../src/db/index.js";
import { MIGRATIONS } from "../src/db/migrations.js";
import { normalizePhone } from "../src/lib/phone.js";
import { createTestDb, seedGuests, type TestContext } from "./helpers/db.js";

let ctx: TestContext;
beforeEach(() => (ctx = createTestDb()));
afterEach(() => ctx.close());

describe("migrations", () => {
  it("applies every migration on a fresh database", () => {
    expect(appliedMigrations(ctx.db)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("is idempotent — re-opening does not re-apply", () => {
    const db = openDatabase({ path: ":memory:" });
    const applied: number[] = [];
    // Re-running the runner on an already-migrated db must be a no-op.
    migrate(db, (m) => applied.push(m.id));
    expect(applied).toEqual([]);
    db.close();
  });

  it("enforces foreign keys", () => {
    expect(() =>
      ctx.db
        .prepare("INSERT INTO broadcast_recipients (broadcast_id, guest_id, phone) VALUES (?, ?, ?)")
        .run(999, 999, "+447700900123"),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("guests", () => {
  it("upsert reactivates rather than failing on a duplicate phone", () => {
    const phone = normalizePhone("+447700900123");
    const first = ctx.repos.guests.upsert({ phone, name: "Priya" });
    ctx.repos.guests.deactivate(phone);
    expect(ctx.repos.guests.findByPhone(phone)?.active).toBe(false);

    const second = ctx.repos.guests.upsert({ phone, name: "Priya Patel" });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Priya Patel");
    expect(second.active).toBe(true);
  });

  it("gates the allowlist on active status", () => {
    const phone = normalizePhone("+447700900123");
    ctx.repos.guests.upsert({ phone, name: "Priya" });
    expect(ctx.repos.guests.isAuthorized(phone)).toBe(true);

    ctx.repos.guests.deactivate(phone);
    expect(ctx.repos.guests.isAuthorized(phone)).toBe(false);
    expect(ctx.repos.guests.isAuthorized("+440000000000")).toBe(false);
  });

  it("deactivate reports whether it matched anything", () => {
    expect(ctx.repos.guests.deactivate("+440000000000")).toBe(false);
  });

  it("lists active guests only when asked", () => {
    const guests = seedGuests(ctx.repos, 3);
    ctx.repos.guests.deactivate(guests[0]!.phone);
    expect(ctx.repos.guests.list({ activeOnly: true })).toHaveLength(2);
    expect(ctx.repos.guests.list()).toHaveLength(3);
  });
});

describe("conversations", () => {
  it("trims to the most recent N turns", () => {
    const [guest] = seedGuests(ctx.repos, 1);
    for (let i = 0; i < 10; i++) {
      ctx.repos.conversations.append(
        guest!.id,
        { role: "user", content: `msg ${i}`, at: new Date().toISOString() },
        4,
      );
    }
    const turns = ctx.repos.conversations.get(guest!.id);
    expect(turns).toHaveLength(4);
    expect(turns[0]!.content).toBe("msg 6");
    expect(turns[3]!.content).toBe("msg 9");
  });

  it("survives a corrupt history rather than throwing", () => {
    const [guest] = seedGuests(ctx.repos, 1);
    ctx.db
      .prepare("INSERT INTO conversations (guest_id, turns) VALUES (?, ?)")
      .run(guest!.id, "{not json");
    expect(ctx.repos.conversations.get(guest!.id)).toEqual([]);
  });

  it("cascades when a guest is deleted", () => {
    const [guest] = seedGuests(ctx.repos, 1);
    ctx.repos.conversations.append(
      guest!.id,
      { role: "user", content: "hi", at: new Date().toISOString() },
      8,
    );
    ctx.db.prepare("DELETE FROM guests WHERE id = ?").run(guest!.id);
    expect(ctx.repos.conversations.get(guest!.id)).toEqual([]);
  });
});

describe("broadcasts", () => {
  it("creates one recipient row per guest", () => {
    const guests = seedGuests(ctx.repos, 3);
    const broadcast = ctx.repos.broadcasts.create({
      body: "Boat departs in 90 minutes.",
      createdBy: "dashboard",
      recipients: guests.map((g) => ({ guestId: g.id, phone: g.phone })),
    });

    const summary = ctx.repos.broadcasts.summary(broadcast.id)!;
    expect(summary.total).toBe(3);
    expect(summary.counts.queued).toBe(3);
  });

  it("claimQueued hands each recipient to exactly one caller", () => {
    const guests = seedGuests(ctx.repos, 5);
    const broadcast = ctx.repos.broadcasts.create({
      body: "Test",
      createdBy: "test",
      recipients: guests.map((g) => ({ guestId: g.id, phone: g.phone })),
    });

    const first = ctx.repos.broadcasts.claimQueued(broadcast.id, 3);
    const second = ctx.repos.broadcasts.claimQueued(broadcast.id, 3);
    const third = ctx.repos.broadcasts.claimQueued(broadcast.id, 3);

    // Claiming increments attempts but leaves status queued until resolved, so a
    // claim must not hand back a row another claim already took.
    const ids = [...first, ...second, ...third].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tracks per-recipient failure detail", () => {
    const guests = seedGuests(ctx.repos, 2);
    const broadcast = ctx.repos.broadcasts.create({
      body: "Test",
      createdBy: "test",
      recipients: guests.map((g) => ({ guestId: g.id, phone: g.phone })),
    });
    const claimed = ctx.repos.broadcasts.claimQueued(broadcast.id, 2);

    ctx.repos.broadcasts.markSent(claimed[0]!.id, "SM123");
    ctx.repos.broadcasts.markFailed(claimed[1]!.id, "63016", "outside session window");

    const summary = ctx.repos.broadcasts.summary(broadcast.id)!;
    expect(summary.counts.sent).toBe(1);
    expect(summary.counts.failed).toBe(1);

    const failed = ctx.repos.broadcasts.recipients(broadcast.id).find((r) => r.status === "failed");
    expect(failed?.errorCode).toBe("63016");
    expect(failed?.attempts).toBe(1);
  });

  it("applies Twilio status callbacks by message SID", () => {
    const guests = seedGuests(ctx.repos, 1);
    const broadcast = ctx.repos.broadcasts.create({
      body: "Test",
      createdBy: "test",
      recipients: guests.map((g) => ({ guestId: g.id, phone: g.phone })),
    });
    const [recipient] = ctx.repos.broadcasts.claimQueued(broadcast.id, 1);
    ctx.repos.broadcasts.markSent(recipient!.id, "SM_ABC");

    expect(ctx.repos.broadcasts.updateStatusBySid("SM_ABC", "delivered")).toBe(true);
    expect(ctx.repos.broadcasts.updateStatusBySid("SM_UNKNOWN", "delivered")).toBe(false);
    expect(ctx.repos.broadcasts.summary(broadcast.id)!.counts.delivered).toBe(1);
  });

  it("finds broadcasts left mid-flight by a restart", () => {
    const guests = seedGuests(ctx.repos, 2);
    const broadcast = ctx.repos.broadcasts.create({
      body: "Test",
      createdBy: "test",
      recipients: guests.map((g) => ({ guestId: g.id, phone: g.phone })),
    });

    expect(ctx.repos.broadcasts.findResumable().map((b) => b.id)).toEqual([broadcast.id]);

    // Once every recipient is resolved, there is nothing left to resume.
    for (const r of ctx.repos.broadcasts.claimQueued(broadcast.id, 10)) {
      ctx.repos.broadcasts.markSent(r.id, `SM_${r.id}`);
    }
    expect(ctx.repos.broadcasts.findResumable()).toEqual([]);
  });
});

describe("usage", () => {
  it("computes cache hit rate across events", () => {
    ctx.repos.usage.record({
      kind: "reply",
      provider: "anthropic",
      model: "claude-opus-5",
      inputTokens: 200,
      outputTokens: 100,
      cachedInputTokens: 800,
    });

    const totals = ctx.repos.usage.totalsSince("1970-01-01");
    expect(totals.events).toBe(1);
    expect(totals.cacheHitRate).toBeCloseTo(0.8);
  });

  it("reports a zero rate rather than NaN when there is no usage", () => {
    expect(ctx.repos.usage.totalsSince("1970-01-01").cacheHitRate).toBe(0);
  });
});
