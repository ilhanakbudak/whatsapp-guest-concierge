import type { AppConfig } from "../config/env.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";
import { MockLlmProvider } from "./providers/mock.js";
import { OpenAIProvider } from "./providers/openai.js";
import type { LlmProvider } from "./types.js";

/**
 * The whole point of the abstraction: switching provider is this function
 * reading one env var, plus the matching API key. No call site changes.
 */
export function createLlmProvider(config: AppConfig): LlmProvider {
  if (config.demo.llm || config.LLM_PROVIDER === "mock") {
    return new MockLlmProvider({ model: config.llmModel });
  }

  switch (config.LLM_PROVIDER) {
    case "anthropic":
      return new AnthropicProvider({
        apiKey: config.ANTHROPIC_API_KEY!,
        model: config.llmModel,
      });

    case "openai":
      return new OpenAIProvider({
        apiKey: config.OPENAI_API_KEY!,
        model: config.llmModel,
      });

    case "gemini":
      return new GeminiProvider({
        apiKey: config.GEMINI_API_KEY!,
        model: config.llmModel,
      });
  }
}

export { AnthropicProvider, GeminiProvider, MockLlmProvider, OpenAIProvider };
