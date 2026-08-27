import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/lib/logger.js";
import { normalizePhone } from "../src/lib/phone.js";
import { TwilioWhatsAppClient } from "../src/whatsapp/twilio.js";
import { MockWhatsAppClient } from "../src/whatsapp/mock.js";
import { WhatsAppSendError } from "../src/whatsapp/types.js";

const logger = createLogger({ LOG_LEVEL: "fatal", isProduction: false, isTest: true });
const TO = normalizePhone("+447700900123");

function buildClient(create: ReturnType<typeof vi.fn>, maxAttempts = 3) {
  return new TwilioWhatsAppClient({
    accountSid: "AC_test",
    authToken: "token",
    from: "whatsapp:+14155238886",
    logger,
    maxAttempts,
    sleep: async () => {},
    client: { messages: { create } } as never,
  });
}

describe("TwilioWhatsAppClient", () => {
  it("adds the whatsapp: prefix to the recipient", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SM1" });
    await buildClient(create).send({ to: TO, body: "hello" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ to: "whatsapp:+447700900123", from: "whatsapp:+14155238886" }),
    );
  });

  it("retries a 429 and succeeds", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, code: 63018, message: "rate limited" })
      .mockResolvedValue({ sid: "SM_ok" });

    const result = await buildClient(create).send({ to: TO, body: "hello" });

    expect(result.sid).toBe("SM_ok");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries a 500 and succeeds", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce({ status: 503, message: "unavailable" })
      .mockResolvedValue({ sid: "SM_ok" });

    await expect(buildClient(create).send({ to: TO, body: "hi" })).resolves.toEqual({
      sid: "SM_ok",
    });
  });

  it("gives up after maxAttempts", async () => {
    const create = vi.fn().mockRejectedValue({ status: 500, message: "boom" });

    await expect(buildClient(create, 3).send({ to: TO, body: "hi" })).rejects.toThrow(
      WhatsAppSendError,
    );
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 400-class rejection", async () => {
    // 63016 means the 24-hour session window has closed. Retrying can only fail
    // again — the fix is an approved template, so burning attempts is pointless.
    const create = vi
      .fn()
      .mockRejectedValue({ status: 400, code: 63016, message: "outside window" });

    await expect(buildClient(create).send({ to: TO, body: "hi" })).rejects.toMatchObject({
      code: "63016",
      retryable: false,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("flags the session-window error distinctly", async () => {
    const create = vi.fn().mockRejectedValue({ status: 400, code: 63016, message: "closed" });

    await expect(buildClient(create).send({ to: TO, body: "hi" })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WhatsAppSendError && error.isSessionWindowError === true,
    );
  });

  it("passes a status callback URL through when given", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SM1" });
    await buildClient(create).send({
      to: TO,
      body: "hi",
      statusCallbackUrl: "https://example.com/status",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ statusCallback: "https://example.com/status" }),
    );
  });
});

describe("MockWhatsAppClient", () => {
  it("records sends and issues plausible SIDs", async () => {
    const client = new MockWhatsAppClient();
    const result = await client.send({ to: TO, body: "hello" });

    expect(result.sid).toMatch(/^SM[0-9a-f]{30}$/);
    expect(client.sent).toHaveLength(1);
    expect(client.lastMessageTo(TO)?.body).toBe("hello");
  });

  it("can be told to fail exactly once", async () => {
    const client = new MockWhatsAppClient();
    client.failNextWith(new WhatsAppSendError("nope", "63016", false));

    await expect(client.send({ to: TO, body: "a" })).rejects.toThrow("nope");
    await expect(client.send({ to: TO, body: "b" })).resolves.toBeDefined();
  });
});
