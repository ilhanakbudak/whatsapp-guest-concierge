import { randomUUID } from "node:crypto";
import type {
  SendMessageInput,
  SendMessageResult,
  WhatsAppClient,
} from "./types.js";

export interface SentMessage extends SendMessageInput {
  sid: string;
  at: Date;
}

/**
 * Records sends instead of performing them. Backs DEMO_MODE, the web simulator,
 * and every test that needs to assert on what the bot said.
 */
export class MockWhatsAppClient implements WhatsAppClient {
  readonly sent: SentMessage[] = [];

  /** Set to make the next send throw — used to test retry and failure paths. */
  private failure: Error | null = null;

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }

    const sid = `SM${randomUUID().replace(/-/g, "").slice(0, 30)}`;
    this.sent.push({ ...input, sid, at: new Date() });
    return { sid };
  }

  failNextWith(error: Error): void {
    this.failure = error;
  }

  lastMessageTo(phone: string): SentMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === phone);
  }

  reset(): void {
    this.sent.length = 0;
    this.failure = null;
  }
}
