import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { createContext } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

function testServer() {
  const context = createContext({
    config: loadConfig({ DEMO_MODE: "true", NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    databasePath: ":memory:",
  });
  return buildServer({ context });
}

describe("health", () => {
  it("responds to /health", async () => {
    const app = await testServer();
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    await app.close();
  });

  it("reports readiness with the selected provider", async () => {
    const app = await testServer();
    const res = await app.inject({ method: "GET", url: "/health/ready" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      demoMode: true,
      llm: { provider: "anthropic", model: "claude-opus-5" },
      guests: 0,
    });

    await app.close();
  });
});

describe("error handling", () => {
  it("returns a structured 404 rather than an HTML page", async () => {
    const app = await testServer();
    const res = await app.inject({ method: "GET", url: "/nope" });

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");

    await app.close();
  });
});
