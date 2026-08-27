import OpenAI from "openai";
import type { ResponseInput, Tool } from "openai/resources/responses/responses";
import { UpstreamError } from "../../lib/errors.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  StopReason,
  ToolCall,
} from "../types.js";

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  client?: Pick<OpenAI, "responses">;
}

/**
 * Model families that reject `temperature` outright with a 400.
 *
 * The reasoning-era models (gpt-5 onwards, and the o-series) removed sampling
 * controls. Sending it is not ignored — it fails the whole request.
 */
const NO_TEMPERATURE_PREFIXES = ["gpt-5", "o1", "o3", "o4"];

function supportsTemperature(model: string): boolean {
  return !NO_TEMPERATURE_PREFIXES.some((prefix) => model.startsWith(prefix));
}

function isUnsupportedTemperatureError(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    /unsupported parameter: 'temperature'/i.test(err.message)
  );
}

export class OpenAIProvider implements LlmProvider {
  readonly name = "openai" as const;
  readonly model: string;

  private readonly client: Pick<OpenAI, "responses">;

  constructor(options: OpenAIProviderOptions) {
    this.model = options.model;
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const useTemperature =
      request.temperature !== undefined && supportsTemperature(this.model);

    try {
      return await this.send(request, useTemperature);
    } catch (err) {
      // Safety net for models released after NO_TEMPERATURE_PREFIXES was
      // written: drop the parameter and retry once rather than failing the
      // guest's message over a request-shape detail.
      if (useTemperature && isUnsupportedTemperatureError(err)) {
        try {
          return await this.send(request, false);
        } catch (retryErr) {
          throw toUpstreamError(retryErr);
        }
      }
      throw toUpstreamError(err);
    }
  }

  private async send(request: LlmRequest, withTemperature: boolean): Promise<LlmResponse> {
    const response = await this.client.responses.create({
      model: this.model,
      // OpenAI caches long prefixes automatically rather than taking explicit
      // breakpoints, so honouring `cacheable` here is a matter of ordering:
      // stable blocks first, volatile last. The prompt builder guarantees that.
      instructions: request.system.map((block) => block.text).join("\n\n"),
      input: toResponseInput(request.messages),
      max_output_tokens: request.maxTokens,
      ...(withTemperature ? { temperature: request.temperature } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map(
              (tool): Tool => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                strict: false,
              }),
            ),
          }
        : {}),
      store: false,
    });

    const toolCalls: ToolCall[] = [];
    for (const item of response.output ?? []) {
      if (item.type !== "function_call") continue;
      toolCalls.push({
        id: item.call_id,
        name: item.name,
        // Arguments arrive as a JSON string. Never string-match on it.
        input: safeParseArguments(item.arguments),
      });
    }

    return {
      text: (response.output_text ?? "").trim(),
      toolCalls,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
      stopReason: toStopReason(response.status, toolCalls.length > 0),
    };
  }
}

function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A malformed argument blob should degrade to "call the tool with no
    // arguments", not crash the whole reply.
    return {};
  }
}

function toStopReason(status: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "tool_use";
  if (status === "incomplete") return "max_tokens";
  if (status === "completed") return "end";
  return "other";
}

/**
 * The Responses API models a conversation as a flat list of items, so tool
 * results are siblings of messages rather than nested inside one.
 */
function toResponseInput(messages: LlmMessage[]): ResponseInput {
  const input: ResponseInput = [];

  for (const message of messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      if (message.content) {
        input.push({ role: "assistant", content: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input),
        });
      }
      continue;
    }

    input.push({
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    });
  }

  return input;
}

function toUpstreamError(err: unknown): UpstreamError {
  if (err instanceof OpenAI.APIError) {
    const retryable = err.status === 429 || (err.status !== undefined && err.status >= 500);
    return new UpstreamError("openai", err.message, retryable, err);
  }
  return new UpstreamError("openai", (err as Error).message ?? "request failed", true, err);
}
