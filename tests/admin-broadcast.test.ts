import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizePhone } from "../src/lib/phone.js";
import { createTestApp, type TestApp } from "./helpers/app.js";

const TOKEN = "test-admin-token";
const auth = { authorization: `Bearer ${TOKEN}` };

let harness: TestApp;
beforeEach(async () => {
  harness = await createTestApp({ env: { ADMIN_API_TOKEN: TOKEN } });
  for (const [phone, name] of [
    ["+447700900001", "Priya Patel"],
    ["+447700900002", "Tom Okafor"],
    ["+447700900003", "Elena Rossi"],
  ]) {
    harness.context.repos.guests.upsert({ phone: normalizePhone(phone!), name: name! });
  }
});
afterEach(async () => harness?.close());

function post(body: { message?: string; dryRun?: boolean }) {
  return harness.app.inject({
    method: "POST",
    url: "/admin/broadcast",
    headers: auth,
    payload: body,
  });
}

describe("broadcast authorisation", () => {
  it("refuses to send without a token", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/admin/broadcast",
      payload: { message: "Boat in 90 minutes" },
    });

    expect(res.statusCode).toBe(401);
    await harness.context.tasks.drain();
    expect(harness.whatsapp.sent).toHaveLength(0);
  });
});

describe("dry run", () => {
  it("previews without sending anything", async () => {
    const res = await post({ message: "Boat departs in 90 minutes.", dryRun: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dryRun: true, recipientCount: 3 });

    await harness.context.tasks.drain();
    expect(harness.whatsapp.sent).toHaveLength(0);
  });

  it("shows rendered samples with masked numbers", async () => {
    const res = await post({ message: "Hi {first_name}, boat at 14:00", dryRun: true });
    const preview = res.json();

    expect(preview.samples[0].body).toMatch(/^Hi \w+, boat at 14:00$/);
    expect(preview.samples[0].phone).toContain("****");
  });

  it("surfaces a typo'd placeholder as a warning", async () => {
    const res = await post({ message: "Hi {frist_name}", dryRun: true });
    expect(res.json().warnings.join(" ")).toContain("{frist_name}");
  });
});

describe("sending", () => {
  it("queues and delivers to every active guest", async () => {
    const res = await post({ message: "Boat departs in 90 minutes." });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ queued: 3, status: "queued" });

    // The HTTP call returns immediately; sending happens in the background.
    await harness.context.tasks.drain();
    expect(harness.whatsapp.sent).toHaveLength(3);
  });

  it("rejects an empty message before queueing anything", async () => {
    const res = await post({ message: "   " });

    expect(res.statusCode).toBe(400);
    await harness.context.tasks.drain();
    expect(harness.whatsapp.sent).toHaveLength(0);
  });

  it("rejects an oversized message", async () => {
    expect((await post({ message: "x".repeat(2000) })).statusCode).toBe(400);
  });

  it("reports per-recipient status afterwards", async () => {
    const created = await post({ message: "Boat in 90 minutes" });
    await harness.context.tasks.drain();

    const res = await harness.app.inject({
      method: "GET",
      url: `/admin/broadcasts/${created.json().id}`,
      headers: auth,
    });

    const detail = res.json();
    expect(detail.counts.sent).toBe(3);
    expect(detail.recipients).toHaveLength(3);
    // Numbers stay masked even for an authenticated admin view.
    expect(detail.recipients[0].phone).toContain("****");
  });

  it("lists past broadcasts with their rollups", async () => {
    await post({ message: "First announcement" });
    await harness.context.tasks.drain();

    const res = await harness.app.inject({
      method: "GET",
      url: "/admin/broadcasts",
      headers: auth,
    });

    expect(res.json()[0]).toMatchObject({ body: "First announcement" });
    expect(res.json()[0].counts.sent).toBe(3);
  });

  it("404s for an unknown broadcast", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/admin/broadcasts/9999",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});
