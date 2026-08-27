import type { Guest } from "../db/types.js";

export interface IncomingMessage {
  guest: Guest;
  body: string;
  messageSid: string;
}

/**
 * The seam between transport and intelligence. Phase 2 ships the transport with
 * a placeholder; Phase 4 swaps in the LLM-backed handler without touching the
 * webhook, the allowlist, or the rate limiter.
 *
 * Returning null means "say nothing" — used for admin commands that reply through
 * their own path, and for messages that warrant no response.
 */
export interface MessageHandler {
  handle(message: IncomingMessage): Promise<string | null>;
}

/**
 * Stand-in until the LLM layer lands. It answers honestly rather than pretending
 * to be the finished bot, so a demo run is never misleading about what exists.
 */
export class PlaceholderHandler implements MessageHandler {
  async handle(message: IncomingMessage): Promise<string> {
    return (
      `Hi ${message.guest.name.split(" ")[0]}, I received your message. ` +
      `The AI assistant isn't connected yet — that arrives in the next build step.`
    );
  }
}
