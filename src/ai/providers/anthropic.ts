import Anthropic from "@anthropic-ai/sdk";
import { UpstreamError } from "../../lib/errors.js";
import {
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type StopReason,
  type ToolCall,
} from "../types.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /**
   * Depth/cost dial. A concierge answering "what's the wifi password" does not
   * need deep reasoning, so this defaults low — it keeps adaptive thinking on
   * (disabling it entirely has its own failure modes) while holding latency and
   * spend down.
   */
  effort?: "low" | "medium" | "high";
  client?: Pick<Anthropic, "messages">;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  readonly model: string;

  private readonly client: Pick<Anthropic, "messages">;
  private readonly effort: "low" | "medium" | "high";

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.effort = options.effort ?? "low";
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens,
        output_config: { effort: this.effort },
        system: request.system.map((block) => ({
          type: "text" as const,
          text: block.text,
          // An explicit breakpoint after the stable content. Anything volatile
          // must come after it or every request misses the cache.
          ...(block.cacheable ? { cache_control: { type: "ephemeral" as const } } : {}),
        })),
        messages: toAnthropicMessages(request.messages),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
              })),
            }
          : {}),
      });

      return {
        text: response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim(),
        toolCalls: response.content
          .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
          .map((block) => ({
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          })),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
        },
        stopReason: toStopReason(response.stop_reason),
      };
    } catch (err) {
      throw toUpstreamError(err);
    }
  }
}

function toStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/**
 * Anthropic has no `tool` role — results are `tool_result` blocks inside a user
 * message, and consecutive results must be merged into one message rather than
 * sent as several.
 */
function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.content) content.push({ type: "text", text: message.content });

      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }

      if (content.length > 0) out.push({ role: "assistant", content });
      continue;
    }

    const block: Anthropic.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
    };

    const previous = out.at(-1);
    if (previous?.role === "user" && Array.isArray(previous.content)) {
      previous.content.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }

  return out;
}

function toUpstreamError(err: unknown): UpstreamError {
  if (err instanceof Anthropic.APIError) {
    const retryable = err.status === 429 || (err.status !== undefined && err.status >= 500);
    return new UpstreamError("anthropic", err.message, retryable, err);
  }
  return new UpstreamError("anthropic", (err as Error).message ?? "request failed", true, err);
}

export type { ToolCall };
