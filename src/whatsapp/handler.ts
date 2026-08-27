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
