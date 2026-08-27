import type { LlmProvider as LlmProviderName } from "../config/env.js";

export type { LlmProviderName };

/**
 * A chunk of the system prompt.
 *
 * `cacheable` marks content that is large and changes rarely — the knowledge
 * base, principally. Each provider honours it in whatever way it can: Anthropic
 * gets an explicit `cache_control` breakpoint, OpenAI caches long prefixes
 * automatically so ordering is what matters, and Gemini has its own cached
 * content lifecycle. Exposing intent rather than Anthropic's mechanism is what
 * keeps the abstraction honest.
 */
export interface SystemBlock {
  text: string;
  cacheable?: boolean;
}

export interface ToolCall {
  /** Provider-issued correlation id; must be echoed back with the result. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/**
 * JSON Schema subset every provider accepts.
 *
 * A `type` alias rather than an `interface` on purpose: interfaces get no
 * implicit index signature, so they refuse to assign to the SDKs' open
 * `[k: string]: unknown` schema types.
 */
export type ToolParameterSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export interface LlmRequest {
  system: SystemBlock[];
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  maxTokens: number;
  temperature?: number;
}

export interface LlmUsage {
  /** Input tokens billed at full rate. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from cache, where the provider reports them. */
  cachedInputTokens: number;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: LlmUsage;
  stopReason: StopReason;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export const EMPTY_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  };
}
