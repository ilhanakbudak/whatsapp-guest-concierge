import { describe, expect, it } from "vitest";
import { runConversation } from "../src/ai/loop.js";
import { MockLlmProvider } from "../src/ai/providers/mock.js";
import { buildSystemPrompt } from "../src/ai/prompt.js";
import { createTools } from "../src/ai/tools.js";
import { ScheduleService } from "../src/calendar/schedule.js";
import { MockCalendarClient } from "../src/calendar/mock.js";
import { createLogger } from "../src/lib/logger.js";
import type { RegisteredTool } from "../src/ai/tools.js";
import type { Guest } from "../src/db/types.js";

const logger = createLogger({ LOG_LEVEL: "fatal", isProduction: false, isTest: true });
const TZ = "Europe/Istanbul";
const NOW = new Date("2026-08-27T09:00:00Z");

const GUEST: Guest = {
  id: 1,
  phone: "+447700900001",
  name: "Priya Patel",
  role: "guest",
  active: true,
  notes: "Vegetarian",
  createdAt: "",
  updatedAt: "",
};

function echoTool(name: string, result: string, spy?: () => void): RegisteredTool {
  return {
    definition: {
      name,
      description: `Test tool ${name}`,
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
    execute: async () => {
      spy?.();
      return result;
    },
  };
}

const base = {
  system: [{ text: "system" }],
  messages: [{ role: "user" as const, content: "hello" }],
  maxTokens: 256,
  maxIterations: 5,
  logger,
};

describe("runConversation", () => {
  it("returns immediately when the model makes no tool calls", async () => {
    const provider = new MockLlmProvider({ script: [{ text: "All good." }] });
    const result = await runConversation({ ...base, provider, tools: [] });

    expect(result.text).toBe("All good.");
    expect(result.iterations).toBe(1);
    expect(result.toolsUsed).toEqual([]);
    expect(result.stoppedEarly).toBe(false);
  });

  it("executes a tool then returns the follow-up answer", async () => {
    const provider = new MockLlmProvider({
      script: [
        { text: "Checking.", toolCalls: [{ name: "get_schedule", input: { range: "today" } }] },
        { text: "The boat leaves at 14:00." },
      ],
    });

    const result = await runConversation({
      ...base,
      provider,
      tools: [echoTool("get_schedule", "14:00 Boat trip")],
    });

    expect(result.text).toBe("The boat leaves at 14:00.");
    expect(result.toolsUsed).toEqual(["get_schedule"]);
    expect(result.iterations).toBe(2);
  });

  it("feeds the tool result back to the model", async () => {
    const provider = new MockLlmProvider({
      script: [
        { toolCalls: [{ name: "get_schedule", input: {} }] },
        { text: "done" },
      ],
    });

    await runConversation({
      ...base,
      provider,
      tools: [echoTool("get_schedule", "14:00 Boat trip")],
    });

    const secondRequest = provider.requests[1]!;
    const toolMessage = secondRequest.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.content).toBe("14:00 Boat trip");
  });

  it("answers all calls in a parallel batch before the next request", async () => {
    const provider = new MockLlmProvider({
      script: [
        {
          toolCalls: [
            { name: "get_schedule", input: {} },
            { name: "find_event", input: {} },
          ],
        },
        { text: "done" },
      ],
    });

    await runConversation({
      ...base,
      provider,
      tools: [echoTool("get_schedule", "A"), echoTool("find_event", "B")],
    });

    const toolMessages = provider.requests[1]!.messages.filter((m) => m.role === "tool");
    // Leaving any call unanswered breaks the turn on every provider.
    expect(toolMessages).toHaveLength(2);
  });

  it("accumulates usage across iterations", async () => {
    const provider = new MockLlmProvider({
      script: [{ toolCalls: [{ name: "t", input: {} }] }, { text: "done" }],
    });

    const result = await runConversation({ ...base, provider, tools: [echoTool("t", "x")] });
    expect(result.usage.outputTokens).toBe(48); // 24 per call, two calls
  });

  it("answers a hallucinated tool name instead of crashing", async () => {
    const provider = new MockLlmProvider({
      script: [
        { toolCalls: [{ name: "book_helicopter", input: {} }] },
        { text: "I can't do that, but I can ask the host." },
      ],
    });

    const result = await runConversation({ ...base, provider, tools: [echoTool("t", "x")] });

    expect(result.text).toContain("ask the host");
    const toolMessage = provider.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMessage!.content).toContain("No tool named");
  });

  it("recovers when a tool throws", async () => {
    const throwing: RegisteredTool = {
      definition: {
        name: "boom",
        description: "throws",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
      execute: async () => {
        throw new Error("calendar down");
      },
    };

    const provider = new MockLlmProvider({
      script: [{ toolCalls: [{ name: "boom", input: {} }] }, { text: "Sorry, I couldn't check." }],
    });

    const result = await runConversation({ ...base, provider, tools: [throwing] });
    expect(result.text).toBe("Sorry, I couldn't check.");
  });

  it("terminates and still answers when the model loops on tools", async () => {
    // A model that calls a tool every single turn must not spin forever.
    const provider = new MockLlmProvider({
      script: Array.from({ length: 10 }, () => ({
        toolCalls: [{ name: "t", input: {} }],
      })),
    });

    const result = await runConversation({
      ...base,
      provider,
      tools: [echoTool("t", "x")],
      maxIterations: 3,
    });

    expect(result.stoppedEarly).toBe(true);
    expect(result.iterations).toBe(3);
    // Four calls: three loop iterations plus the final tool-free request.
    expect(provider.requests).toHaveLength(4);
    // The rescue request must withhold tools, or the model just calls again.
    expect(provider.requests[3]!.tools).toBeUndefined();
  });
});

describe("buildSystemPrompt", () => {
  const context = {
    guest: GUEST,
    knowledgeBase: "WiFi password is turquoise-2026.",
    timeZone: TZ,
    now: NOW,
  };

  it("marks the persona and knowledge base cacheable", () => {
    const blocks = buildSystemPrompt(context);
    expect(blocks[0]!.cacheable).toBe(true);
    expect(blocks[1]!.cacheable).toBe(true);
    expect(blocks[1]!.text).toContain("turquoise-2026");
  });

  it("puts volatile content last and never marks it cacheable", () => {
    const blocks = buildSystemPrompt(context);
    const volatile = blocks.at(-1)!;

    expect(volatile.cacheable).toBeUndefined();
    expect(volatile.text).toContain("Priya Patel");
    // The timestamp is the classic silent cache-invalidator; it must be last.
    expect(volatile.text).toContain("Thursday 27 August");
  });

  it("keeps the cacheable prefix byte-identical as time and guest change", () => {
    const a = buildSystemPrompt(context);
    const b = buildSystemPrompt({
      ...context,
      now: new Date("2026-08-28T18:22:00Z"),
      guest: { ...GUEST, name: "Tom Okafor", notes: null },
    });

    const prefix = (blocks: typeof a) =>
      blocks.filter((x) => x.cacheable).map((x) => x.text).join("|");

    expect(prefix(a)).toBe(prefix(b));
  });

  it("renders the villa's local time, not the server's", () => {
    const blocks = buildSystemPrompt({ ...context, now: new Date("2026-08-27T21:30:00Z") });
    // 21:30 UTC is 00:30 on the 28th in Istanbul.
    expect(blocks.at(-1)!.text).toContain("Friday 28 August, 00:30");
  });

  it("includes guest notes when present and omits the line when not", () => {
    expect(buildSystemPrompt(context).at(-1)!.text).toContain("Vegetarian");
    expect(
      buildSystemPrompt({ ...context, guest: { ...GUEST, notes: null } }).at(-1)!.text,
    ).not.toContain("Note about this guest");
  });

  it("omits the knowledge-base block entirely when there is none", () => {
    const blocks = buildSystemPrompt({ ...context, knowledgeBase: "   " });
    expect(blocks.filter((b) => b.cacheable)).toHaveLength(1);
  });
});

describe("calendar tools", () => {
  const schedule = new ScheduleService(new MockCalendarClient({ timeZone: TZ, now: () => NOW }), {
    timeZone: TZ,
    now: () => NOW,
  });

  it("exposes both tools with object schemas", () => {
    const tools = createTools(schedule);
    expect(tools.map((t) => t.definition.name)).toEqual(["get_schedule", "find_event"]);
    for (const tool of tools) {
      expect(tool.definition.parameters.type).toBe("object");
    }
  });

  it("get_schedule returns rendered text for a named range", async () => {
    const [getSchedule] = createTools(schedule);
    const result = await getSchedule!.execute({ range: "tomorrow" });
    expect(result).toContain("White party");
  });

  it("get_schedule reports a bad date as a tool result, not an exception", async () => {
    const [getSchedule] = createTools(schedule);
    // Thrown errors end the turn; a returned message lets the model recover.
    await expect(getSchedule!.execute({ date: "next tuesday" })).resolves.toContain(
      "Could not read the schedule",
    );
  });

  it("find_event locates an activity by keyword", async () => {
    const [, findEvent] = createTools(schedule);
    expect(await findEvent!.execute({ query: "boat" })).toContain("blue caves");
  });

  it("find_event says so when nothing matches", async () => {
    const [, findEvent] = createTools(schedule);
    expect(await findEvent!.execute({ query: "helicopter" })).toContain("Nothing matching");
  });

  it("find_event handles a missing query", async () => {
    const [, findEvent] = createTools(schedule);
    expect(await findEvent!.execute({})).toContain("No search term");
  });
});
