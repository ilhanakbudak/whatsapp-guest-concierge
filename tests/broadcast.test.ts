import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BroadcastService } from "../src/broadcast/service.js";
import { BroadcastWorker } from "../src/broadcast/worker.js";
import { renderBroadcast } from "../src/broadcast/render.js";
import { createLogger } from "../src/lib/logger.js";
import { normalizePhone } from "../src/lib/phone.js";
import { MockWhatsAppClient } from "../src/whatsapp/mock.js";
import { WhatsAppSendError, TWILIO_ERROR } from "../src/whatsapp/types.js";
import type { WhatsAppClient, SendMessageInput } from "../src/whatsapp/types.js";
import { createTestDb, seedGuests, type TestContext } from "./helpers/db.js";

const logger = createLogger({ LOG_LEVEL: "fatal", isProduction: false, isTest: true });

let ctx: TestContext;
beforeEach(() => (ctx = createTestDb()));
afterEach(() => ctx.close());

function service() {
  return new BroadcastService(ctx.repos.guests, ctx.repos.broadcasts);
}

function worker(whatsapp: WhatsAppClient, overrides: { concurrency?: number; maxAttempts?: number } = {}) {
  return new BroadcastWorker({
    broadcasts: ctx.repos.broadcasts,
    guests: ctx.repos.guests,
    whatsapp,
    logger,
    concurrency: overrides.concurrency ?? 2,
    maxAttempts: overrides.maxAttempts ?? 3,
    sleep: async () => {},
  });
}

/** Fails the first `failures` sends to a given phone, then succeeds. */
class FlakyClient implements WhatsAppClient {
  readonly sent: SendMessageInput[] = [];
  attempts = new Map<string, number>();

  constructor(
    private readonly failuresPerPhone: Map<string, number>,
    private readonly error: () => Error,
  ) {}

  async send(input: SendMessageInput) {
    const seen = (this.attempts.get(input.to) ?? 0) + 1;
    this.attempts.set(input.to, seen);

    if (seen <= (this.failuresPerPhone.get(input.to) ?? 0)) throw this.error();

    this.sent.push(input);
    return { sid: `SM_${input.to}_${seen}` };
  }
}

// --- rendering --------------------------------------------------------------

describe("renderBroadcast", () => {
  it("substitutes name and first name", () => {
    expect(renderBroadcast("Hi {first_name}, boat at 14:00", { name: "Priya Patel" })).toBe(
      "Hi Priya, boat at 14:00",
    );
    expect(renderBroadcast("Dear {name}", { name: "Priya Patel" })).toBe("Dear Priya Patel");
  });

  it("substitutes every occurrence", () => {
    expect(renderBroadcast("{first_name}, {first_name}!", { name: "Tom Okafor" })).toBe(
      "Tom, Tom!",
    );
  });

  it("leaves an unknown placeholder untouched", () => {
    expect(renderBroadcast("Hi {nickname}", { name: "Priya Patel" })).toBe("Hi {nickname}");
  });

  it("handles a single-word name", () => {
    expect(renderBroadcast("Hi {first_name}", { name: "Cher" })).toBe("Hi Cher");
  });
});

// --- preview ----------------------------------------------------------------

describe("BroadcastService.preview", () => {
  it("counts active recipients and renders samples", () => {
    seedGuests(ctx.repos, 4);
    const preview = service().preview("Boat departs in 90 minutes.");

    expect(preview.recipientCount).toBe(4);
    expect(preview.samples).toHaveLength(3);
    expect(preview.warnings).toEqual([]);
  });

  it("excludes deactivated guests", () => {
    const guests = seedGuests(ctx.repos, 3);
    ctx.repos.guests.deactivate(guests[0]!.phone);

    expect(service().preview("hello").recipientCount).toBe(2);
  });

  it("masks phone numbers in the preview", () => {
    seedGuests(ctx.repos, 1);
    expect(service().preview("hello").samples[0]!.phone).toMatch(/\*\*\*\*/);
  });

  it("warns when nobody would receive it", () => {
    expect(service().preview("hello").warnings[0]).toContain("reach nobody");
  });

  it("warns about a typo'd placeholder rather than sending it verbatim", () => {
    seedGuests(ctx.repos, 1);
    const preview = service().preview("Hi {frist_name}, boat at 14:00");

    expect(preview.warnings.join(" ")).toContain("{frist_name}");
  });

  it("reports the placeholders actually in use", () => {
    seedGuests(ctx.repos, 1);
    expect(service().preview("Hi {first_name}").placeholders).toEqual(["{first_name}"]);
  });

  it("rejects an empty or oversized message", () => {
    expect(() => service().preview("   ")).toThrow(/needs a message body/);
    expect(() => service().preview("x".repeat(2000))).toThrow(/limit is 1500/);
  });
});

// --- queueing ---------------------------------------------------------------

describe("BroadcastService.create", () => {
  it("creates one recipient row per active guest", () => {
    seedGuests(ctx.repos, 3);
    const { broadcast } = service().create({ body: "Boat in 90 minutes", createdBy: "test" });

    expect(ctx.repos.broadcasts.summary(broadcast.id)!.counts.queued).toBe(3);
  });

  it("refuses to create a broadcast with no recipients", () => {
    expect(() => service().create({ body: "hello", createdBy: "test" })).toThrow(
      /no active guests/,
    );
  });
});

// --- the worker -------------------------------------------------------------

describe("BroadcastWorker", () => {
  it("sends to every recipient and marks them sent", async () => {
    seedGuests(ctx.repos, 5);
    const { broadcast } = service().create({ body: "Boat in 90 minutes", createdBy: "test" });
    const client = new MockWhatsAppClient();

    const result = await worker(client).run(broadcast.id);

    expect(result.sent).toBe(5);
    expect(result.failed).toBe(0);
    expect(client.sent).toHaveLength(5);
    expect(ctx.repos.broadcasts.summary(broadcast.id)!.counts.sent).toBe(5);
    expect(ctx.repos.broadcasts.findById(broadcast.id)!.status).toBe("completed");
  });

  it("personalises each message", async () => {
    ctx.repos.guests.upsert({ phone: normalizePhone("+447700900001"), name: "Priya Patel" });
    ctx.repos.guests.upsert({ phone: normalizePhone("+447700900002"), name: "Tom Okafor" });

    const { broadcast } = service().create({ body: "Hi {first_name}!", createdBy: "test" });
    const client = new MockWhatsAppClient();
    await worker(client).run(broadcast.id);

    expect(client.sent.map((m) => m.body).sort()).toEqual(["Hi Priya!", "Hi Tom!"]);
  });

  it("sends each recipient exactly once", async () => {
    seedGuests(ctx.repos, 6);
    const { broadcast } = service().create({ body: "once only", createdBy: "test" });
    const client = new MockWhatsAppClient();

    await worker(client, { concurrency: 3 }).run(broadcast.id);

    const recipients = client.sent.map((m) => m.to);
    expect(new Set(recipients).size).toBe(6);
    expect(recipients).toHaveLength(6);
  });

  it("respects the concurrency limit", async () => {
    seedGuests(ctx.repos, 8);
    const { broadcast } = service().create({ body: "hello", createdBy: "test" });

    let inFlight = 0;
    let peak = 0;
    const client: WhatsAppClient = {
      send: async (input) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { sid: `SM_${input.to}` };
      },
    };

    await worker(client, { concurrency: 3 }).run(broadcast.id);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("retries a transient failure and eventually succeeds", async () => {
    const guests = seedGuests(ctx.repos, 2);
    const { broadcast } = service().create({ body: "hello", createdBy: "test" });

    const client = new FlakyClient(
      new Map([[guests[0]!.phone, 1]]),
      () => new WhatsAppSendError("rate limited", "63018", true),
    );

    const result = await worker(client).run(broadcast.id);

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(client.attempts.get(guests[0]!.phone)).toBe(2);
  });

  it("gives up after maxAttempts and records the error", async () => {
    const guests = seedGuests(ctx.repos, 1);
    const { broadcast } = service().create({ body: "hello", createdBy: "test" });

    const client = new FlakyClient(
      new Map([[guests[0]!.phone, 99]]),
      () => new WhatsAppSendError("still failing", "63018", true),
    );

    const result = await worker(client, { maxAttempts: 3 }).run(broadcast.id);

    expect(result.failed).toBe(1);
    const [recipient] = ctx.repos.broadcasts.recipients(broadcast.id);
    expect(recipient!.status).toBe("failed");
    expect(recipient!.attempts).toBeGreaterThanOrEqual(3);
  });

  it("does not retry the 24-hour session window error", async () => {
    const guests = seedGuests(ctx.repos, 1);
    const { broadcast } = service().create({ body: "hello", createdBy: "test" });

    const client = new FlakyClient(
      new Map([[guests[0]!.phone, 99]]),
      () =>
        new WhatsAppSendError("outside window", TWILIO_ERROR.OUTSIDE_SESSION_WINDOW, false),
    );

    await worker(client).run(broadcast.id);

    // Retrying can only fail again; the fix is a template, not another attempt.
    expect(client.attempts.get(guests[0]!.phone)).toBe(1);
    const [recipient] = ctx.repos.broadcasts.recipients(broadcast.id);
    expect(recipient!.errorCode).toBe(TWILIO_ERROR.OUTSIDE_SESSION_WINDOW);
    expect(recipient!.errorMessage).toContain("must message the bot first");
  });

  it("delivers to everyone else when one recipient fails", async () => {
    const guests = seedGuests(ctx.repos, 4);
    const { broadcast } = service().create({ body: "boat in 90", createdBy: "test" });

    const client = new FlakyClient(
      new Map([[guests[1]!.phone, 99]]),
      () => new WhatsAppSendError("bad number", "63003", false),
    );

    const result = await worker(client).run(broadcast.id);

    // The whole point: one bad number must not silence the other three guests.
    expect(result.sent).toBe(3);
    expect(result.failed).toBe(1);
  });

  it("records the twilio message sid for delivery tracking", async () => {
    seedGuests(ctx.repos, 1);
    const { broadcast } = service().create({ body: "hello", createdBy: "test" });

    await worker(new MockWhatsAppClient()).run(broadcast.id);

    expect(ctx.repos.broadcasts.recipients(broadcast.id)[0]!.twilioSid).toMatch(/^SM/);
  });

  it("attaches the status callback url when configured", async () => {
    seedGuests(ctx.repos, 1);
    const { broadcast } = service().create({ body: "hello", createdBy: "test" });
    const client = new MockWhatsAppClient();

    const w = new BroadcastWorker({
      broadcasts: ctx.repos.broadcasts,
      guests: ctx.repos.guests,
      whatsapp: client,
      logger,
      concurrency: 2,
      maxAttempts: 3,
      statusCallbackUrl: "https://example.com/webhooks/twilio/status",
      sleep: async () => {},
    });
    await w.run(broadcast.id);

    expect(client.sent[0]!.statusCallbackUrl).toBe(
      "https://example.com/webhooks/twilio/status",
    );
  });
});

// --- restart safety ---------------------------------------------------------

describe("restart safety", () => {
  it("does not re-send recipients already sent", async () => {
    seedGuests(ctx.repos, 4);
    const { broadcast } = service().create({ body: "hello", createdBy: "test" });

    const first = new MockWhatsAppClient();
    await worker(first).run(broadcast.id);
    expect(first.sent).toHaveLength(4);

    // A second run over a completed broadcast must find nothing to claim.
    const second = new MockWhatsAppClient();
    const result = await worker(second).run(broadcast.id);

    expect(second.sent).toHaveLength(0);
    expect(result.sent).toBe(0);
  });

  it("recovers recipients stranded mid-send by a crash", async () => {
    seedGuests(ctx.repos, 3);
    const { broadcast } = service().create({ body: "hello", createdBy: "test" });

    // Simulate a crash: rows claimed into 'sending', process dies.
    const stranded = ctx.repos.broadcasts.claimQueued(broadcast.id, 2);
    expect(stranded).toHaveLength(2);
    expect(ctx.repos.broadcasts.summary(broadcast.id)!.counts.sending).toBe(2);

    const client = new MockWhatsAppClient();
    const resumed = await worker(client).resumeInterrupted();

    expect(resumed).toEqual([broadcast.id]);
    // All three go out: the two stranded plus the one never claimed. A duplicate
    // announcement beats a guest never hearing it.
    expect(client.sent).toHaveLength(3);
    expect(ctx.repos.broadcasts.summary(broadcast.id)!.counts.sent).toBe(3);
  });

  it("finds nothing to resume when everything is resolved", async () => {
    seedGuests(ctx.repos, 2);
    const { broadcast } = service().create({ body: "hello", createdBy: "test" });
    await worker(new MockWhatsAppClient()).run(broadcast.id);

    expect(await worker(new MockWhatsAppClient()).resumeInterrupted()).toEqual([]);
  });

  it("applies delivery receipts arriving after the run", async () => {
    seedGuests(ctx.repos, 2);
    const { broadcast } = service().create({ body: "hello", createdBy: "test" });
    await worker(new MockWhatsAppClient()).run(broadcast.id);

    for (const recipient of ctx.repos.broadcasts.recipients(broadcast.id)) {
      ctx.repos.broadcasts.updateStatusBySid(recipient.twilioSid!, "delivered");
    }

    expect(ctx.repos.broadcasts.summary(broadcast.id)!.counts.delivered).toBe(2);
  });
});
