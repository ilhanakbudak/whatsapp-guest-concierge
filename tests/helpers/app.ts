import { createHmac } from "node:crypto";
import { createContext, type AppContext } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { buildServer } from "../../src/server.js";
import { MockWhatsAppClient } from "../../src/whatsapp/mock.js";
import type { MessageHandler } from "../../src/whatsapp/handler.js";

export const TEST_AUTH_TOKEN = "test-auth-token";
export const TEST_PUBLIC_URL = "https://concierge.example.com";

export interface TestAppOptions {
  env?: NodeJS.ProcessEnv;
  handler?: MessageHandler;
}

export interface TestApp {
  app: Awaited<ReturnType<typeof buildServer>>;
  context: AppContext;
  whatsapp: MockWhatsAppClient;
  close: () => Promise<void>;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const whatsapp = new MockWhatsAppClient();

  const context = createContext({
    config: loadConfig({
      DEMO_MODE: "true",
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      PUBLIC_URL: TEST_PUBLIC_URL,
      TWILIO_AUTH_TOKEN: TEST_AUTH_TOKEN,
      TWILIO_VALIDATE_SIGNATURE: "true",
      ...options.env,
    }),
    databasePath: ":memory:",
    whatsapp,
    ...(options.handler ? { handler: options.handler } : {}),
  });

  const app = await buildServer({ context });

  return {
    app,
    context,
    whatsapp,
    close: async () => {
      await app.close();
    },
  };
}

/**
 * Produces a genuine Twilio signature so the tests exercise the real validation
 * path rather than a stub. Mirrors Twilio's documented algorithm: the full URL,
 * then each parameter name and value concatenated in alphabetical order by name,
 * HMAC-SHA1'd with the auth token and base64-encoded.
 */
export function signTwilioRequest(
  url: string,
  params: Record<string, string>,
  authToken = TEST_AUTH_TOKEN,
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  return createHmac("sha1", authToken).update(Buffer.from(payload, "utf-8")).digest("base64");
}

export function inboundPayload(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    From: "whatsapp:+447700900123",
    To: "whatsapp:+14155238886",
    Body: "what's the wifi password?",
    MessageSid: "SM_test_inbound",
    ...overrides,
  };
}
