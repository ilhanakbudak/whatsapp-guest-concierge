import type { ScheduleService } from "../calendar/schedule.js";
import type { ConversationsRepository, UsageRepository } from "../db/repositories/index.js";
import type { CachedKnowledgeBase } from "../knowledge/index.js";
import type { Logger } from "../lib/logger.js";
import type { IncomingMessage, MessageHandler } from "../whatsapp/handler.js";
import { runConversation } from "./loop.js";
import { buildSystemPrompt } from "./prompt.js";
import { createTools } from "./tools.js";
import type { LlmMessage, LlmProvider } from "./types.js";

/** What a guest sees when the model or the network lets us down. */
export const FALLBACK_REPLY =
  "Sorry — I couldn't work that out just now. Please try again in a moment, " +
  "or message the host directly if it's urgent.";

export interface ConciergeHandlerOptions {
  provider: LlmProvider;
  schedule: ScheduleService;
  knowledgeBase: CachedKnowledgeBase;
  conversations: ConversationsRepository;
  usage: UsageRepository;
  logger: Logger;
  timeZone: string;
  maxTokens: number;
  temperature: number;
  maxIterations: number;
  historyTurns: number;
  now?: () => Date;
}

export class ConciergeHandler implements MessageHandler {
  private readonly now: () => Date;

  constructor(private readonly options: ConciergeHandlerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async handle(message: IncomingMessage): Promise<string> {
    const { options } = this;
    const now = this.now();

    try {
      const kb = await options.knowledgeBase.get();

      const history = options.conversations.get(message.guest.id);
      const messages: LlmMessage[] = [
        ...history.map(
          (turn): LlmMessage =>
            turn.role === "user"
              ? { role: "user", content: turn.content }
              : { role: "assistant", content: turn.content },
        ),
        { role: "user", content: message.body },
      ];

      const result = await runConversation({
        provider: options.provider,
        system: buildSystemPrompt({
          guest: message.guest,
          knowledgeBase: kb.content,
          timeZone: options.timeZone,
          now,
        }),
        messages,
        tools: createTools(options.schedule),
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        maxIterations: options.maxIterations,
        logger: options.logger,
      });

      options.usage.record({
        kind: "reply",
        provider: options.provider.name,
        model: options.provider.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
        guestId: message.guest.id,
      });

      const reply = result.text.trim() || FALLBACK_REPLY;

      // History is written only on success. Persisting a failed turn would feed
      // the model its own error message on the guest's next question.
      const at = now.toISOString();
      options.conversations.append(
        message.guest.id,
        { role: "user", content: message.body, at },
        options.historyTurns,
      );
      options.conversations.append(
        message.guest.id,
        { role: "assistant", content: reply, at },
        options.historyTurns,
      );

      options.logger.info(
        {
          guestId: message.guest.id,
          toolsUsed: result.toolsUsed,
          iterations: result.iterations,
          stoppedEarly: result.stoppedEarly,
          cachedInputTokens: result.usage.cachedInputTokens,
        },
        "generated reply",
      );

      return reply;
    } catch (err) {
      // A guest must always get something back. Silence looks like a broken bot.
      options.logger.error({ err, guestId: message.guest.id }, "failed to generate reply");
      return FALLBACK_REPLY;
    }
  }
}
