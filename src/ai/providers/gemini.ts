import { GoogleGenAI, Type, type Content, type FunctionDeclaration } from "@google/genai";
import { UpstreamError } from "../../lib/errors.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  StopReason,
  ToolCall,
} from "../types.js";

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  client?: Pick<GoogleGenAI, "models">;
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  readonly model: string;

  private readonly client: Pick<GoogleGenAI, "models">;

  constructor(options: GeminiProviderOptions) {
    this.model = options.model;
    this.client = options.client ?? new GoogleGenAI({ apiKey: options.apiKey });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: toContents(request.messages),
        config: {
          // Gemini takes the system prompt as its own field rather than a turn.
          systemInstruction: request.system.map((block) => block.text).join("\n\n"),
          maxOutputTokens: request.maxTokens,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.tools?.length
            ? { tools: [{ functionDeclarations: request.tools.map(toFunctionDeclaration) }] }
            : {}),
        },
      });

      const toolCalls: ToolCall[] = (response.functionCalls ?? []).map((call, index) => ({
        // Gemini does not issue call ids, so results are correlated by name.
        // Synthesising a stable id keeps the neutral interface uniform.
        id: call.id ?? `${call.name ?? "tool"}-${index}`,
        name: call.name ?? "",
        input: (call.args ?? {}) as Record<string, unknown>,
      }));

      const usage = response.usageMetadata;

      return {
        text: (response.text ?? "").trim(),
        toolCalls,
        usage: {
          // promptTokenCount includes cached tokens, so subtract to avoid
          // double-counting them against the uncached total.
          inputTokens:
            (usage?.promptTokenCount ?? 0) - (usage?.cachedContentTokenCount ?? 0),
          outputTokens: usage?.candidatesTokenCount ?? 0,
          cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
        },
        stopReason: toStopReason(response.candidates?.[0]?.finishReason, toolCalls.length > 0),
      };
    } catch (err) {
      throw toUpstreamError(err);
    }
  }
}

/**
 * Gemini takes its own schema enum rather than raw JSON Schema strings, so the
 * neutral definition is translated field by field.
 */
function toFunctionDeclaration(tool: {
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown>; required?: string[] };
}): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: Type.OBJECT,
      properties: tool.parameters.properties as Record<string, never>,
      ...(tool.parameters.required ? { required: tool.parameters.required } : {}),
    },
  };
}

function toStopReason(reason: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "tool_use";
  switch (reason) {
    case "STOP":
      return "end";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
      return "refusal";
    default:
      return reason ? "other" : "end";
  }
}

/** Gemini uses `model` for the assistant role and nests tool results in parts. */
function toContents(messages: LlmMessage[]): Content[] {
  const contents: Content[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: message.content }] });
      continue;
    }

    if (message.role === "assistant") {
      const parts = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.input } });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    contents.push({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: message.name,
            response: { result: message.content },
          },
        },
      ],
    });
  }

  return contents;
}

function toUpstreamError(err: unknown): UpstreamError {
  const status = (err as { status?: number }).status;
  const retryable = status === 429 || (status !== undefined && status >= 500);
  return new UpstreamError(
    "gemini",
    (err as Error).message ?? "request failed",
    retryable || status === undefined,
    err,
  );
}
