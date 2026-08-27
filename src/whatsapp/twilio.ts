import twilio, { type Twilio } from "twilio";
import type { Logger } from "../lib/logger.js";
import { toWhatsAppAddress } from "../lib/phone.js";
import {
  WhatsAppSendError,
  type SendMessageInput,
  type SendMessageResult,
  type WhatsAppClient,
} from "./types.js";

export interface TwilioClientOptions {
  accountSid: string;
  authToken: string;
  /** The sender, e.g. `whatsapp:+14155238886`. */
  from: string;
  logger: Logger;
  maxAttempts?: number;
  /** Injected in tests so retry backoff doesn't actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests to exercise retry and error mapping without the network. */
  client?: Pick<Twilio, "messages">;
}

interface TwilioRestError {
  code?: number;
  status?: number;
  message?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Twilio's own client already retries connection-level failures, but not 429s or
 * 5xx responses. Those are exactly the ones a broadcast hits, so we handle them.
 */
function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500);
}

export class TwilioWhatsAppClient implements WhatsAppClient {
  private readonly client: Pick<Twilio, "messages">;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TwilioClientOptions) {
    this.client = options.client ?? twilio(options.accountSid, options.authToken);
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    let lastError: WhatsAppSendError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const message = await this.client.messages.create({
          from: this.options.from,
          to: toWhatsAppAddress(input.to),
          body: input.body,
          ...(input.statusCallbackUrl ? { statusCallback: input.statusCallbackUrl } : {}),
        });

        return { sid: message.sid };
      } catch (err) {
        lastError = toSendError(err);

        if (!lastError.retryable || attempt === this.maxAttempts) {
          throw lastError;
        }

        // Exponential backoff with jitter, so a broadcast that trips a rate limit
        // doesn't have all its workers retry in lockstep.
        const backoffMs = 2 ** (attempt - 1) * 500 + Math.random() * 250;
        this.options.logger.warn(
          { attempt, code: lastError.code, backoffMs },
          "whatsapp send failed, retrying",
        );
        await this.sleep(backoffMs);
      }
    }

    throw lastError ?? new WhatsAppSendError("send failed", null, false);
  }
}

function toSendError(err: unknown): WhatsAppSendError {
  const restError = err as TwilioRestError;
  const code = restError.code !== undefined ? String(restError.code) : null;
  const message = restError.message ?? "Unknown Twilio error";

  return new WhatsAppSendError(message, code, isRetryableStatus(restError.status));
}
