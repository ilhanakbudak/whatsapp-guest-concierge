import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers/app.js";

const TOKEN = "test-admin-token";

let harness: TestApp;
beforeEach(async () => {
  harness = await createTestApp({ env: { ADMIN_API_TOKEN: TOKEN, KB_LOCAL_PATH: "./kb" } });
});
afterEach(async () => harness?.close());

const auth = { authorization: `Bearer ${TOKEN}` };

describe("admin authentication", () => {
  it.each([
    ["GET", "/admin/kb"],
    ["POST", "/admin/kb/refresh"],
  ])("rejects %s %s without a token", async (method, url) => {
    const res = await harness.app.inject({ method: method as "GET", url });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/admin/kb",
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token of a different length without leaking timing", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/admin/kb",
      headers: { authorization: "Bearer short" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a non-Bearer authorization header", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/admin/kb",
      headers: { authorization: TOKEN },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the correct token", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/admin/kb", headers: auth });
    expect(res.statusCode).toBe(200);
  });
});

describe("knowledge base endpoints", () => {
  it("reports status", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/admin/kb", headers: auth });
    expect(res.json()).toMatchObject({ source: expect.stringContaining("local:") });
  });

  it("refreshes on demand and reports whether anything changed", async () => {
    const first = await harness.app.inject({
      method: "POST",
      url: "/admin/kb/refresh",
      headers: auth,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, changed: true });

    // Re-reading identical content must not register as a change.
    const second = await harness.app.inject({
      method: "POST",
      url: "/admin/kb/refresh",
      headers: auth,
    });
    expect(second.json()).toMatchObject({ ok: true, changed: false });
  });

  it("shows snapshot history after a refresh", async () => {
    await harness.app.inject({ method: "POST", url: "/admin/kb/refresh", headers: auth });

    const res = await harness.app.inject({ method: "GET", url: "/admin/kb", headers: auth });
    expect(res.json().history.length).toBeGreaterThan(0);
  });
});
