import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizePhone } from "../src/lib/phone.js";
import { createTestApp, type TestApp } from "./helpers/app.js";

let harness: TestApp;
afterEach(async () => harness?.close());

async function app(env: NodeJS.ProcessEnv = {}) {
  harness = await createTestApp({ env, handler: { handle: async () => "simulated reply" } });
  harness.context.repos.guests.upsert({
    phone: normalizePhone("+447700900001"),
    name: "Priya Patel",
  });
  return harness;
}

describe("simulator", () => {
  beforeEach(async () => app());

  it("serves the page", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/simulator" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Villa Meltem Concierge");
  });

  it("runs the real pipeline and returns the reply", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/simulator/message",
      payload: { message: "what's the wifi?", from: "+447700900001" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authorized: true, reply: "simulated reply" });
  });

  it("applies the same allowlist as the webhook", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/simulator/message",
      payload: { message: "hello", from: "+447700999999" },
    });

    expect(res.json().authorized).toBe(false);
    expect(res.json().reply).toContain("not on the guest list");
  });

  it("records both sides of the exchange", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/simulator/message",
      payload: { message: "hello", from: "+447700900001" },
    });

    const directions = harness.context.repos.messages.recent().map((m) => m.direction);
    expect(directions.sort()).toEqual(["inbound", "outbound"]);
  });

  it("returns history for the conversation", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/simulator/message",
      payload: { message: "hello", from: "+447700900001" },
    });

    const res = await harness.app.inject({
      method: "GET",
      url: "/simulator/history?from=%2B447700900001",
    });

    expect(res.json().messages).toHaveLength(2);
    expect(res.json().guest.name).toBe("Priya Patel");
  });

  it("lists guests to choose between", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/simulator/guests" });
    expect(res.json()[0]).toMatchObject({ name: "Priya Patel" });
  });

  it("rejects an empty message", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/simulator/message",
      payload: { message: "   " },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("simulator gating", () => {
  it("defaults to off in production", async () => {
    await app({
      NODE_ENV: "production",
      ADMIN_API_TOKEN: "a-real-token",
      DEMO_MODE: "true",
    });
    expect((await harness.app.inject({ method: "GET", url: "/simulator" })).statusCode).toBe(404);
  });

  it("requires the admin token when explicitly enabled in production", async () => {
    // It bypasses Twilio signature verification, so a deployed instance must not
    // expose it to anyone who finds the URL.
    await app({
      NODE_ENV: "production",
      ADMIN_API_TOKEN: "a-real-token",
      SIMULATOR_ENABLED: "true",
      DEMO_MODE: "true",
    });

    const unauthenticated = await harness.app.inject({
      method: "POST",
      url: "/simulator/message",
      payload: { message: "hello", from: "+447700900001" },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const authenticated = await harness.app.inject({
      method: "POST",
      url: "/simulator/message",
      headers: { authorization: "Bearer a-real-token" },
      payload: { message: "hello", from: "+447700900001" },
    });
    expect(authenticated.statusCode).toBe(200);
  });

  it("is not served when disabled", async () => {
    await app({ SIMULATOR_ENABLED: "false" });

    expect((await harness.app.inject({ method: "GET", url: "/simulator" })).statusCode).toBe(404);
    expect(
      (
        await harness.app.inject({
          method: "POST",
          url: "/simulator/message",
          payload: { message: "hello" },
        })
      ).statusCode,
    ).toBe(404);
  });
});
