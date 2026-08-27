import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("server", () => {
  it("responds to /health", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    await app.close();
  });
});
