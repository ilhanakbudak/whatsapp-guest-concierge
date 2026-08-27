import type { Logger } from "../lib/logger.js";
import type { RegisteredTool } from "./tools.js";
import {
  addUsage,
  EMPTY_USAGE,
  type LlmMessage,
  type LlmProvider,
  type LlmUsage,
  type SystemBlock,
} from "./types.js";

export interface RunOptions {
  provider: LlmProvider;
  system: SystemBlock[];
  messages: LlmMessage[];
  tools: RegisteredTool[];
  maxTokens: number;
  temperature?: number;
  /** Safety valve — a model that keeps calling tools must terminate. */
  maxIterations: number;
  logger: Logger;
}

export interface RunResult {
  text: string;
  usage: LlmUsage;
  /** Names of tools actually invoked, in order. Surfaced on the dashboard. */
  toolsUsed: string[];
  iterations: number;
  stoppedEarly: boolean;
}

/**
 * The agentic loop, written once against the neutral interface.
 *
 * This lives here rather than in a vendor SDK helper precisely so that swapping
 * provider is a config change: Anthropic, OpenAI and Gemini all disagree about
 * how tool calls are represented, and all of that is absorbed by the adapters
 * before control reaches this function.
 */
export async function runConversation(options: RunOptions): Promise<RunResult> {
  const messages: LlmMessage[] = [...options.messages];
  const byName = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
  const toolsUsed: string[] = [];

  let usage = EMPTY_USAGE;

  for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
    const response = await options.provider.complete({
      system: options.system,
      messages,
      tools: options.tools.map((tool) => tool.definition),
      maxTokens: options.maxTokens,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    });

    usage = addUsage(usage, response.usage);

    if (response.toolCalls.length === 0) {
      return {
        text: response.text,
        usage,
        toolsUsed,
        iterations: iteration,
        stoppedEarly: false,
      };
    }

    messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
    });

    // Results for a parallel batch must all be appended before the next request,
    // or the provider sees an unanswered call and the turn breaks.
    for (const call of response.toolCalls) {
      const tool = byName.get(call.name);
      toolsUsed.push(call.name);

      let result: string;
      if (!tool) {
        // A hallucinated tool name is answered, not thrown: the model can
        // recover on the next turn.
        options.logger.warn({ tool: call.name }, "model called an unknown tool");
        result = `No tool named "${call.name}" exists.`;
      } else {
        try {
          result = await tool.execute(call.input);
        } catch (err) {
          options.logger.error({ err, tool: call.name }, "tool threw");
          result = `The ${call.name} tool failed.`;
        }
      }

      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result,
      });
    }
  }

  // Out of iterations with tool calls still pending. Ask once more with tools
  // withheld, so the guest gets a real answer from what was already gathered
  // rather than silence.
  options.logger.warn({ maxIterations: options.maxIterations }, "tool loop hit its limit");

  const final = await options.provider.complete({
    system: options.system,
    messages,
    maxTokens: options.maxTokens,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });

  return {
    text: final.text,
    usage: addUsage(usage, final.usage),
    toolsUsed,
    iterations: options.maxIterations,
    stoppedEarly: true,
  };
}
