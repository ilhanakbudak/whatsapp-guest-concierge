import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/ai/providers/anthropic.js";
import { GeminiProvider } from "../src/ai/providers/gemini.js";
import { OpenAIProvider } from "../src/ai/providers/openai.js";
import OpenAI from "openai";
import type { LlmProvider, LlmRequest } from "../src/ai/types.js";
import { UpstreamError } from "../src/lib/errors.js";

/**
 * One suite, run against all three adapters.
 *
 * This is the test that gives the abstraction its value: it asserts that a
 * request expressed in neutral terms produces equivalent behaviour regardless of
 * provider, and that each adapter normalises tool calls and usage the same way.
 * Each case supplies a provider-shaped fake response and the suite checks only
 * the neutral output.
 */

const REQUEST: LlmRequest = {
  system: [
    { text: "You are the villa concierge.", cacheable: true },
    { text: "You are speaking with Priya." },
  ],
  messages: [{ role: "user", content: "what time is the boat?" }],
  tools: [
    {
      name: "get_schedule",
      description: "Look up the schedule.",
      parameters: {
        type: "object",
        properties: { range: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
    },
  ],
  maxTokens: 512,
  temperature: 0.3,
};

interface Harness {
  name: string;
  /** Builds a provider whose transport returns `payload`. */
  make(payload: unknown): { provider: LlmProvider; call: ReturnType<typeof vi.fn> };
  /** Builds a provider whose transport rejects. */
  makeFailing(error: unknown): LlmProvider;
  textResponse: unknown;
  toolResponse: unknown;
  maxTokensResponse: unknown;
}

const anthropicHarness: Harness = {
  name: "anthropic",
  make(payload) {
    const call = vi.fn().mockResolvedValue(payload);
    return {
      provider: new AnthropicProvider({
        apiKey: "k",
        model: "claude-opus-5",
        client: { messages: { create: call } } as never,
      }),
      call,
    };
  },
  makeFailing(error) {
      return new AnthropicProvider({
        apiKey: "k",
        model: "claude-opus-5",
        client: { messages: { create: vi.fn().mockRejectedValue(error) } } as never,
      });
  },
  textResponse: {
    content: [{ type: "text", text: "The boat leaves at 14:00." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
  },
  toolResponse: {
    content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_1", name: "get_schedule", input: { range: "today" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
  },
  maxTokensResponse: {
    content: [{ type: "text", text: "truncated" }],
    stop_reason: "max_tokens",
    usage: { input_tokens: 100, output_tokens: 512 },
  },
};

const openaiHarness: Harness = {
  name: "openai",
  make(payload) {
    const call = vi.fn().mockResolvedValue(payload);
    return {
      provider: new OpenAIProvider({
        apiKey: "k",
        model: "gpt-5.6-terra",
        client: { responses: { create: call } } as never,
      }),
      call,
    };
  },
  makeFailing(error) {
      return new OpenAIProvider({
        apiKey: "k",
        model: "gpt-5.6-terra",
        client: { responses: { create: vi.fn().mockRejectedValue(error) } } as never,
      });
  },
  textResponse: {
    output: [],
    output_text: "The boat leaves at 14:00.",
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 900 } },
  },
  toolResponse: {
    output: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_schedule",
        arguments: '{"range":"today"}',
      },
    ],
    output_text: "Let me check.",
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 900 } },
  },
  maxTokensResponse: {
    output: [],
    output_text: "truncated",
    status: "incomplete",
    usage: { input_tokens: 100, output_tokens: 512, input_tokens_details: { cached_tokens: 0 } },
  },
};

const geminiHarness: Harness = {
  name: "gemini",
  make(payload) {
    const call = vi.fn().mockResolvedValue(payload);
    return {
      provider: new GeminiProvider({
        apiKey: "k",
        model: "gemini-3.7-flash",
        client: { models: { generateContent: call } } as never,
      }),
      call,
    };
  },
  makeFailing(error) {
      return new GeminiProvider({
        apiKey: "k",
        model: "gemini-3.7-flash",
        client: { models: { generateContent: vi.fn().mockRejectedValue(error) } } as never,
      });
  },
  textResponse: {
    text: "The boat leaves at 14:00.",
    functionCalls: [],
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 1000,
      candidatesTokenCount: 20,
      cachedContentTokenCount: 900,
    },
  },
  toolResponse: {
    text: "Let me check.",
    functionCalls: [{ name: "get_schedule", args: { range: "today" } }],
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 1000,
      candidatesTokenCount: 20,
      cachedContentTokenCount: 900,
    },
  },
  maxTokensResponse: {
    text: "truncated",
    functionCalls: [],
    candidates: [{ finishReason: "MAX_TOKENS" }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 512 },
  },
};

const harnesses = [anthropicHarness, openaiHarness, geminiHarness];

describe.each(harnesses)("$name adapter", (harness) => {
  it("returns plain text with no tool calls", async () => {
    const { provider } = harness.make(harness.textResponse);
    const result = await provider.complete(REQUEST);

    expect(result.text).toBe("The boat leaves at 14:00.");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("end");
  });

  it("normalises a tool call to the same neutral shape", async () => {
    const { provider } = harness.make(harness.toolResponse);
    const result = await provider.complete(REQUEST);

    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("get_schedule");
    expect(result.toolCalls[0]!.input).toEqual({ range: "today" });
    // Every provider must yield a non-empty correlation id, even Gemini, which
    // does not issue one.
    expect(result.toolCalls[0]!.id).toBeTruthy();
  });

  it("normalises usage, separating cached from billed input tokens", async () => {
    const { provider } = harness.make(harness.textResponse);
    const result = await provider.complete(REQUEST);

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 900,
    });
  });

  it("reports truncation as max_tokens", async () => {
    const { provider } = harness.make(harness.maxTokensResponse);
    expect((await provider.complete(REQUEST)).stopReason).toBe("max_tokens");
  });

  it("sends the model it was configured with", async () => {
    const { provider, call } = harness.make(harness.textResponse);
    await provider.complete(REQUEST);

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ model: provider.model }),
      ...[],
    );
  });

  it("translates the tool definition into the provider's own schema", async () => {
    const { provider, call } = harness.make(harness.textResponse);
    await provider.complete(REQUEST);

    const sent = JSON.stringify(call.mock.calls[0]![0]);
    expect(sent).toContain("get_schedule");
    expect(sent).toContain("Look up the schedule.");
  });

  it("wraps a transport failure as an UpstreamError naming the provider", async () => {
    const provider = harness.makeFailing(
      Object.assign(new Error("service unavailable"), { status: 503 }),
    );

    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(UpstreamError);
    await expect(harness.makeFailing(new Error("socket hang up")).complete(REQUEST))
      .rejects.toMatchObject({ service: harness.name });
  });
});

describe("provider-specific translation details", () => {
  it("anthropic marks cacheable system blocks and only those", async () => {
    const { provider, call } = anthropicHarness.make(anthropicHarness.textResponse);
    await provider.complete(REQUEST);

    const system = call.mock.calls[0]![0].system as Array<Record<string, unknown>>;
    expect(system[0]).toHaveProperty("cache_control");
    // The volatile block must NOT carry a breakpoint, or the cache is invalidated
    // on every request.
    expect(system[1]).not.toHaveProperty("cache_control");
  });

  it("openai flattens system blocks in order, stable content first", async () => {
    const { provider, call } = openaiHarness.make(openaiHarness.textResponse);
    await provider.complete(REQUEST);

    const instructions = call.mock.calls[0]![0].instructions as string;
    expect(instructions.indexOf("villa concierge")).toBeLessThan(
      instructions.indexOf("Priya"),
    );
  });

  it("gemini nests tools under functionDeclarations", async () => {
    const { provider, call } = geminiHarness.make(geminiHarness.textResponse);
    await provider.complete(REQUEST);

    const config = call.mock.calls[0]![0].config as Record<string, unknown>;
    const tools = config.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
    expect(tools[0]!.functionDeclarations[0]!.name).toBe("get_schedule");
  });

  it("openai parses tool arguments as JSON rather than string-matching", async () => {
    const { provider } = openaiHarness.make({
      output: [
        {
          type: "function_call",
          call_id: "c1",
          name: "get_schedule",
          arguments: '{"date":"2026-08-27","note":"a \\"quoted\\" value"}',
        },
      ],
      output_text: "",
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
    });

    const result = await provider.complete(REQUEST);
    expect(result.toolCalls[0]!.input).toEqual({
      date: "2026-08-27",
      note: 'a "quoted" value',
    });
  });

  it("openai omits temperature for models that reject it", async () => {
    // gpt-5 and the o-series removed sampling controls: sending temperature is
    // a 400, not a no-op. Found by calling the real API, not by a mock.
    const call = vi.fn().mockResolvedValue(openaiHarness.textResponse);
    const provider = new OpenAIProvider({
      apiKey: "k",
      model: "gpt-5.6-luna",
      client: { responses: { create: call } } as never,
    });

    await provider.complete(REQUEST);
    expect(call.mock.calls[0]![0]).not.toHaveProperty("temperature");
  });

  it("openai still sends temperature for models that accept it", async () => {
    const call = vi.fn().mockResolvedValue(openaiHarness.textResponse);
    const provider = new OpenAIProvider({
      apiKey: "k",
      model: "gpt-4o",
      client: { responses: { create: call } } as never,
    });

    await provider.complete(REQUEST);
    expect(call.mock.calls[0]![0]).toHaveProperty("temperature", 0.3);
  });

  it("openai retries without temperature if the model rejects it anyway", async () => {
    // Safety net for models released after the prefix list was written.
    const error = new OpenAI.APIError(
      400,
      { message: "Unsupported parameter: 'temperature' is not supported with this model." },
      "Unsupported parameter: 'temperature' is not supported with this model.",
      undefined,
    );
    const call = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(openaiHarness.textResponse);

    const provider = new OpenAIProvider({
      apiKey: "k",
      model: "gpt-4o",
      client: { responses: { create: call } } as never,
    });

    const result = await provider.complete(REQUEST);

    expect(result.text).toBe("The boat leaves at 14:00.");
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]![0]).toHaveProperty("temperature");
    expect(call.mock.calls[1]![0]).not.toHaveProperty("temperature");
  });

  it("openai degrades a malformed argument blob to an empty object", async () => {
    const { provider } = openaiHarness.make({
      output: [{ type: "function_call", call_id: "c1", name: "get_schedule", arguments: "{oops" }],
      output_text: "",
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
    });

    expect((await provider.complete(REQUEST)).toolCalls[0]!.input).toEqual({});
  });
});
