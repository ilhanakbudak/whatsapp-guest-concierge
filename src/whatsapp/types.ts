import type { E164Number } from "../lib/phone.js";

export interface SendMessageInput {
  to: E164Number;
  body: string;
  /** Twilio posts delivery updates here. Omitted for one-off replies. */
  statusCallbackUrl?: string;
}

export interface SendMessageResult {
  sid: string;
}

/**
 * Twilio error codes we branch on. Everything else is treated generically.
 * @see https://www.twilio.com/docs/api/errors
 */
export const TWILIO_ERROR = {
  /** Outside the 24-hour session window — only approved templates may be sent. */
  OUTSIDE_SESSION_WINDOW: "63016",
  /** The recipient is not a WhatsApp user or has not joined the sandbox. */
  NOT_A_WHATSAPP_USER: "63003",
  RATE_LIMITED: "63018",
  /**
   * Trial accounts using "Try out WhatsApp" reject free-form sends and demand a
   * Content template — which the Content API, itself paid-only, is needed to
   * create. Set TWILIO_REPLY_MODE=twiml to answer guests inline instead.
   */
  TEMPLATE_REQUIRED: "21654",
} as const;

export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    /** Whether re-sending the identical message could plausibly succeed. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WhatsAppSendError";
  }

  /**
   * A message rejected for being outside the session window will never succeed
   * on retry — the fix is a message template, not another attempt.
   */
  get isSessionWindowError(): boolean {
    return this.code === TWILIO_ERROR.OUTSIDE_SESSION_WINDOW;
  }

  /** The account cannot send free-form text at all — a plan limitation. */
  get isTemplateRequiredError(): boolean {
    return this.code === TWILIO_ERROR.TEMPLATE_REQUIRED;
  }
}

export interface WhatsAppClient {
  send(input: SendMessageInput): Promise<SendMessageResult>;
}

/** The subset of Twilio's inbound webhook payload we act on. */
export interface InboundWebhookPayload {
  From: string;
  To: string;
  Body: string;
  MessageSid: string;
  WaId?: string;
  ProfileName?: string;
  NumMedia?: string;
}

/** The subset of Twilio's status-callback payload we act on. */
export interface StatusWebhookPayload {
  MessageSid: string;
  MessageStatus: string;
  ErrorCode?: string;
}
