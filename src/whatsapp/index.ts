import type { AppConfig } from "../config/env.js";
import type { Logger } from "../lib/logger.js";
import { MockWhatsAppClient } from "./mock.js";
import { TwilioWhatsAppClient } from "./twilio.js";
import type { WhatsAppClient } from "./types.js";

export function createWhatsAppClient(config: AppConfig, logger: Logger): WhatsAppClient {
  if (config.DEMO_MODE) {
    return new MockWhatsAppClient();
  }

  // loadConfig guarantees these in live mode; the assertions document that.
  return new TwilioWhatsAppClient({
    accountSid: config.TWILIO_ACCOUNT_SID!,
    authToken: config.TWILIO_AUTH_TOKEN!,
    from: config.TWILIO_WHATSAPP_FROM,
    logger,
  });
}

export { MockWhatsAppClient, TwilioWhatsAppClient };
export * from "./types.js";
export * from "./signature.js";
