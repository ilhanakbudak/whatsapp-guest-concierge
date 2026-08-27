import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizePhone } from "../src/lib/phone.js";
import { createTestApp, type TestApp } from "./helpers/app.js";

const TOKEN = "test-admin-token";
const auth = { authorization: `Bearer ${TOKEN}` };

let harness: TestApp;
beforeEach(async () => {
  harness = await createTestApp({ env: { ADMIN_API_TOKEN: TOKEN } });
});
afterEach(async () => harness?.close());

describe("guest endpoints", () => {
  it("requires the admin token", async () => {
    for (const [method, url] of [
      ["GET", "/admin/guests"],
      ["POST", "/admin/guests"],
      ["DELETE", "/admin/guests/%2B447700900001"],
    ] as const) {
      const res = await harness.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("creates a guest and reports 201", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/admin/guests",
      headers: auth,
      payload: { phone: "+44 7700 900123", name: "Marcus Bell" },
    });

    expect(res.statusCode).toBe(201);
    // Stored normalised, regardless of how it was typed.
    expect(res.json().phone).toBe("+447700900123");
  });

  it("returns 200 when updating an existing guest", async () => {
    const payload = { phone: "+447700900123", name: "Marcus Bell" };
    await harness.app.inject({ method: "POST", url: "/admin/guests", headers: auth, payload });

    const res = await harness.app.inject({
      method: "POST",
      url: "/admin/guests",
      headers: auth,
      payload: { ...payload, name: "Marcus B" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Marcus B");
  });

  it("rejects a malformed number", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/admin/guests",
      headers: auth,
      payload: { phone: "07700900123", name: "Marcus" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("+447700900123");
  });

  it("requires a name", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/admin/guests",
      headers: auth,
      payload: { phone: "+447700900123", name: "  " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists only active guests by default", async () => {
    harness.context.repos.guests.upsert({ phone: normalizePhone("+447700900001"), name: "Priya" });
    harness.context.repos.guests.upsert({ phone: normalizePhone("+447700900002"), name: "Tom" });
    harness.context.repos.guests.deactivate("+447700900002");

    const active = await harness.app.inject({ method: "GET", url: "/admin/guests", headers: auth });
    expect(active.json()).toHaveLength(1);

    const all = await harness.app.inject({
      method: "GET",
      url: "/admin/guests?all=true",
      headers: auth,
    });
    expect(all.json()).toHaveLength(2);
  });

  it("deactivates rather than deleting, preserving history", async () => {
    const guest = harness.context.repos.guests.upsert({
      phone: normalizePhone("+447700900001"),
      name: "Priya",
    });
    harness.context.repos.messages.record({
      guestId: guest.id,
      phone: guest.phone,
      direction: "inbound",
      body: "hello",
    });

    const res = await harness.app.inject({
      method: "DELETE",
      url: `/admin/guests/${encodeURIComponent(guest.phone)}`,
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.context.repos.guests.isAuthorized(guest.phone)).toBe(false);
    expect(harness.context.repos.messages.recent()).toHaveLength(1);
  });

  it("404s when removing someone not on the list", async () => {
    const res = await harness.app.inject({
      method: "DELETE",
      url: "/admin/guests/%2B447700900999",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("usage endpoint", () => {
  it("reports totals and cache hit rate", async () => {
    harness.context.repos.usage.record({
      kind: "reply",
      provider: "mock",
      model: "mock-1",
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 900,
    });

    const res = await harness.app.inject({ method: "GET", url: "/admin/usage", headers: auth });
    expect(res.json()).toMatchObject({ events: 1, inputTokens: 100, cachedInputTokens: 900 });
    expect(res.json().cacheHitRate).toBeCloseTo(0.9);
  });

  it("requires the admin token", async () => {
    expect((await harness.app.inject({ method: "GET", url: "/admin/usage" })).statusCode).toBe(401);
  });
});
