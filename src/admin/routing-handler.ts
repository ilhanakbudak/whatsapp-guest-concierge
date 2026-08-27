import type { IncomingMessage, MessageHandler } from "../whatsapp/handler.js";
import type { AdminCommandService } from "./commands.js";
import { looksLikeCommand } from "./parse.js";

/**
 * Sends a message to either the command service or the concierge.
 *
 * Routing on the `!` prefix rather than asking the model to classify keeps the
 * two paths completely separate: a command never costs a token, and a command
 * typo can never be answered conversationally by a model that has no ability to
 * actually perform it.
 */
export class RoutingHandler implements MessageHandler {
  constructor(
    private readonly commands: AdminCommandService,
    private readonly concierge: MessageHandler,
  ) {}

  async handle(message: IncomingMessage): Promise<string | null> {
    if (looksLikeCommand(message.body)) {
      return this.commands.execute(message.guest, message.body);
    }

    return this.concierge.handle(message);
  }
}
