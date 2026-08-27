import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConciergeHandler, FALLBACK_REPLY } from "../src/ai/handler.js";
import { MockLlmProvider } from "../src/ai/providers/mock.js";
import { MockCalendarClient } from "../src/calendar/mock.js";
import { ScheduleService } from "../src/calendar/schedule.js";
import { CachedKnowledgeBase } from "../src/knowledge/index.js";
import type { KnowledgeBaseProvider } from "../src/knowledge/types.js";
import { createLogger } from "../src/lib/logger.js";
import { createTestDb, type TestContext } from "./helpers/db.js";
import { normalizePhone } from "../src/lib/phone.js";
import type { LlmProvider } from "../src/ai/types.js";

const logger = createLogger({ LOG_LEVEL: "fatal", isProduction: false, isTest: true });
const TZ = "Europe/Istanbul";
const NOW = new Date("2026-08-27T09:00:00Z");

class StaticKb implements KnowledgeBaseProvider {
  readonly source = "test";
  constructor(private readonly content: string) {}
  async fetch() {
    return { content: this.content, hash: "h", fetchedAt: new Date() };
  }
}

let ctx: TestContext;
beforeEach(() => (ctx = createTestDb()));
afterEach(() => ctx.close());

function build(provider: LlmProvider, kb = "WiFi password is turquoise-2026.") {
  return new ConciergeHandler({
    provider,
    schedule: new ScheduleService(new MockCalendarClient({ timeZone: TZ, now: () => NOW }), {
      timeZone: TZ,
      now: () => NOW,
    }),
    knowledgeBase: new CachedKnowledgeBase(new StaticKb(kb)),
    conversations: ctx.repos.conversations,
    usage: ctx.repos.usage,
    logger,
    timeZone: TZ,
    maxTokens: 256,
    temperature: 0.3,
    maxIterations: 3,
    historyTurns: 4,
    now: () => NOW,
  });
}

function guest() {
  return ctx.repos.guests.upsert({
    phone: normalizePhone("+447700900001"),
    name: "Priya Patel",
  });
}

describe("ConciergeHandler", () => {
  it("answers and records the exchange", async () => {
    const handler = build(new MockLlmProvider({ script: [{ text: "The password is turquoise-2026." }] }));
    const g = guest();

    const reply = await handler.handle({ guest: g, body: "wifi?", messageSid: "SM1" });

    expect(reply).toBe("The password is turquoise-2026.");
    expect(ctx.repos.conversations.get(g.id)).toHaveLength(2);
  });

  it("records usage with the provider and model that answered", async () => {
    const provider = new MockLlmProvider({ model: "mock-9", script: [{ text: "hi" }] });
    const g = guest();

    await build(provider).handle({ guest: g, body: "hello", messageSid: "SM1" });

    const [event] = ctx.repos.usage.recent();
    expect(event).toMatchObject({ kind: "reply", provider: "mock", model: "mock-9", guestId: g.id });
    expect(event!.cachedInputTokens).toBeGreaterThan(0);
  });

  it("passes prior turns back to the model", async () => {
    const provider = new MockLlmProvider({ script: [{ text: "first" }, { text: "second" }] });
    const handler = build(provider);
    const g = guest();

    await handler.handle({ guest: g, body: "what's the wifi?", messageSid: "SM1" });
    await handler.handle({ guest: g, body: "and the password?", messageSid: "SM2" });

    const second = provider.requests[1]!;
    expect(second.messages.map((m) => m.content)).toEqual([
      "what's the wifi?",
      "first",
      "and the password?",
    ]);
  });

  it("trims history to the configured window", async () => {
    const provider = new MockLlmProvider({
      script: Array.from({ length: 6 }, (_, i) => ({ text: `reply ${i}` })),
    });
    const handler = build(provider);
    const g = guest();

    for (let i = 0; i < 6; i++) {
      await handler.handle({ guest: g, body: `question ${i}`, messageSid: `SM${i}` });
    }

    expect(ctx.repos.conversations.get(g.id)).toHaveLength(4);
  });

  it("keeps each guest's history separate", async () => {
    const provider = new MockLlmProvider({ script: [{ text: "a" }, { text: "b" }] });
    const handler = build(provider);

    const priya = guest();
    const tom = ctx.repos.guests.upsert({
      phone: normalizePhone("+447700900002"),
      name: "Tom Okafor",
    });

    await handler.handle({ guest: priya, body: "priya question", messageSid: "SM1" });
    await handler.handle({ guest: tom, body: "tom question", messageSid: "SM2" });

    expect(provider.requests[1]!.messages.map((m) => m.content)).toEqual(["tom question"]);
  });

  it("uses the calendar tool for a schedule question", async () => {
    const provider = new MockLlmProvider({
      script: [
        { toolCalls: [{ name: "get_schedule", input: { range: "tomorrow" } }] },
        { text: "The white party starts at 19:30." },
      ],
    });

    const reply = await build(provider).handle({
      guest: guest(),
      body: "what's on tomorrow?",
      messageSid: "SM1",
    });

    expect(reply).toBe("The white party starts at 19:30.");
    const toolResult = provider.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolResult!.content).toContain("White party");
  });

  it("falls back gracefully when the provider fails", async () => {
    const failing: LlmProvider = {
      name: "mock",
      model: "mock-1",
      complete: async () => {
        throw new Error("provider exploded");
      },
    };

    const g = guest();
    const reply = await build(failing).handle({ guest: g, body: "hello", messageSid: "SM1" });

    expect(reply).toBe(FALLBACK_REPLY);
  });

  it("does not persist a failed turn into history", async () => {
    const failing: LlmProvider = {
      name: "mock",
      model: "mock-1",
      complete: async () => {
        throw new Error("provider exploded");
      },
    };

    const g = guest();
    await build(failing).handle({ guest: g, body: "hello", messageSid: "SM1" });

    // Otherwise the next question would be answered in the context of an error.
    expect(ctx.repos.conversations.get(g.id)).toEqual([]);
  });

  it("substitutes the fallback when the model returns nothing", async () => {
    const reply = await build(new MockLlmProvider({ script: [{ text: "   " }] })).handle({
      guest: guest(),
      body: "hello",
      messageSid: "SM1",
    });

    expect(reply).toBe(FALLBACK_REPLY);
  });

  it("includes the knowledge base in the cacheable prefix", async () => {
    const provider = new MockLlmProvider({ script: [{ text: "ok" }] });
    await build(provider, "The gate code is 4417.").handle({
      guest: guest(),
      body: "gate code?",
      messageSid: "SM1",
    });

    const cacheable = provider.requests[0]!.system.filter((b) => b.cacheable);
    expect(cacheable.some((b) => b.text.includes("4417"))).toBe(true);
  });
});

describe("CachedKnowledgeBase", () => {
  it("reads once and serves the cached copy", async () => {
    let reads = 0;
    const kb = new CachedKnowledgeBase({
      source: "t",
      fetch: async () => {
        reads++;
        return { content: "x", hash: "h", fetchedAt: new Date() };
      },
    });

    await kb.get();
    await kb.get();
    expect(reads).toBe(1);
  });

  it("collapses concurrent refreshes into one read", async () => {
    let reads = 0;
    const kb = new CachedKnowledgeBase({
      source: "t",
      fetch: async () => {
        reads++;
        await new Promise((r) => setTimeout(r, 5));
        return { content: "x", hash: "h", fetchedAt: new Date() };
      },
    });

    await Promise.all([kb.get(), kb.get(), kb.get()]);
    expect(reads).toBe(1);
  });

  it("re-reads on explicit refresh", async () => {
    let reads = 0;
    const kb = new CachedKnowledgeBase({
      source: "t",
      fetch: async () => {
        reads++;
        return { content: `read-${reads}`, hash: "h", fetchedAt: new Date() };
      },
    });

    await kb.get();
    const refreshed = await kb.refresh();

    expect(reads).toBe(2);
    expect(refreshed.content).toBe("read-2");
  });
});
