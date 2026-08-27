import type { LlmProvider, LlmRequest, LlmResponse, LlmUsage } from "../types.js";

export interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
}

export interface MockProviderOptions {
  model?: string;
  /** Consumed one per `complete()` call. Falls back to a canned reply. */
  script?: ScriptedTurn[];
}

/**
 * Deterministic provider for tests and for demo runs with no API key.
 *
 * Without a script it answers from a few keyword rules — enough that the
 * simulator does something recognisable, while being obviously not a real model.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = "mock" as const;
  readonly model: string;

  readonly requests: LlmRequest[] = [];
  private readonly script: ScriptedTurn[];
  private cursor = 0;

  constructor(options: MockProviderOptions = {}) {
    this.model = options.model ?? "mock-1";
    this.script = options.script ?? [];
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);

    const scripted = this.script[this.cursor];
    if (scripted) {
      this.cursor++;
      return {
        text: scripted.text ?? "",
        toolCalls: (scripted.toolCalls ?? []).map((call, i) => ({
          id: `mock-call-${this.cursor}-${i}`,
          name: call.name,
          input: call.input,
        })),
        usage: this.usageFor(request),
        stopReason: scripted.toolCalls?.length ? "tool_use" : "end",
      };
    }

    return {
      text: this.cannedAnswer(request),
      toolCalls: [],
      usage: this.usageFor(request),
      stopReason: "end",
    };
  }

  private cannedAnswer(request: LlmRequest): string {
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const question = lastUser && "content" in lastUser ? lastUser.content.toLowerCase() : "";

    if (question.includes("wifi") || question.includes("password")) {
      return "The WiFi network is VillaMeltem and the password is turquoise-2026.";
    }
    if (question.includes("boat") || question.includes("schedule") || question.includes("tomorrow")) {
      return "Let me check the schedule for you.";
    }
    return "I'm the demo assistant — set an API key to get real answers.";
  }

  /** Rough but stable, so cache-accounting assertions have something to bite on. */
  private usageFor(request: LlmRequest): LlmUsage {
    const systemChars = request.system.reduce((n, b) => n + b.text.length, 0);
    const cacheableChars = request.system
      .filter((b) => b.cacheable)
      .reduce((n, b) => n + b.text.length, 0);
    const messageChars = request.messages.reduce((n, m) => n + m.content.length, 0);

    return {
      inputTokens: Math.ceil((systemChars - cacheableChars + messageChars) / 4),
      outputTokens: 24,
      cachedInputTokens: Math.ceil(cacheableChars / 4),
    };
  }
}
