import { afterEach, describe, expect, it } from "vitest";
import { escapeXml, messageTwiml, withReplyTimeout } from "../src/whatsapp/twiml.js";
import { normalizePhone } from "../src/lib/phone.js";
import { DECLINE_MESSAGE, SLOW_REPLY_MESSAGE } from "../src/routes/webhook.js";
import type { MessageHandler } from "../src/whatsapp/handler.js";
import {
  createTestApp,
  inboundPayload,
  signTwilioRequest,
  TEST_PUBLIC_URL,
  type TestApp,
} from "./helpers/app.js";

const INBOUND_URL = `${TEST_PUBLIC_URL}/webhooks/twilio/inbound`;
const GUEST_PHONE = normalizePhone("+447700900123");

let harness: TestApp;
afterEach(async () => harness?.close());

function postInbound(app: TestApp, params = inboundPayload()) {
  return app.app.inject({
    method: "POST",
    url: "/webhooks/twilio/inbound",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signTwilioRequest(INBOUND_URL, params),
    },
    payload: new URLSearchParams(params).toString(),
  });
}

async function twimlApp(handler?: MessageHandler) {
  const app = await createTestApp({
    env: { TWILIO_REPLY_MODE: "twiml" },
    ...(handler ? { handler } : {}),
  });
  app.context.repos.guests.upsert({ phone: GUEST_PHONE, name: "Priya Patel" });
  return app;
}

describe("escapeXml", () => {
  it("escapes characters that would break the document", () => {
    expect(escapeXml('Tom & Priya <3 "quotes"')).toBe(
      "Tom &amp; Priya &lt;3 &quot;quotes&quot;",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(escapeXml("Boat departs at 14:00")).toBe("Boat departs at 14:00");
  });
});

describe("messageTwiml", () => {
  it("wraps the body in a Response", () => {
    expect(messageTwiml("hello")).toContain("<Message>hello</Message>");
  });

  it("escapes a body containing markup", () => {
    // An unescaped & from a guest's message would produce invalid XML and
    // Twilio would deliver nothing at all.
    const xml = messageTwiml("Sofia & Deniz");
    expect(xml).toContain("Sofia &amp; Deniz");
    expect(xml).not.toContain("Sofia & Deniz");
  });
});

describe("withReplyTimeout", () => {
  it("returns the answer when it arrives in time", async () => {
    expect(await withReplyTimeout(Promise.resolve("answer"), 1000, "late")).toBe("answer");
  });

  it("returns the fallback when the work is too slow", async () => {
    const slow = new Promise<string>((r) => setTimeout(() => r("answer"), 200));
    expect(await withReplyTimeout(slow, 20, "late")).toBe("late");
  });

  it("treats a null answer as empty", async () => {
    expect(await withReplyTimeout(Promise.resolve(null), 1000, "late")).toBe("");
  });
});

describe("twiml reply mode", () => {
  it("answers inline in the webhook response", async () => {
    harness = await twimlApp({ handle: async () => "The password is turquoise-2026." });

    const res = await postInbound(harness);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("xml");
    expect(res.body).toContain("<Message>The password is turquoise-2026.</Message>");
  });

  it("does not call the Messages API at all", async () => {
    // The whole point on a trial account: REST sends are rejected there.
    harness = await twimlApp({ handle: async () => "hello" });

    await postInbound(harness);
    await harness.context.tasks.drain();

    expect(harness.whatsapp.sent).toHaveLength(0);
  });

  it("records the outbound message for the transcript", async () => {
    harness = await twimlApp({ handle: async () => "recorded reply" });

    await postInbound(harness);

    const outbound = harness.context.repos.messages
      .recent()
      .filter((m) => m.direction === "outbound");
    expect(outbound[0]!.body).toBe("recorded reply");
  });

  it("declines an unknown number inline", async () => {
    harness = await createTestApp({ env: { TWILIO_REPLY_MODE: "twiml" } });

    const res = await postInbound(harness);
    expect(res.body).toContain(DECLINE_MESSAGE);
  });

  it("falls back rather than letting Twilio time out", async () => {
    harness = await twimlApp({
      handle: () => new Promise((r) => setTimeout(() => r("too late"), 500)),
    });
    harness.context.config.TWILIO_TWIML_TIMEOUT_MS = 20;

    const res = await postInbound(harness);
    // The apostrophe in the message is XML-escaped, so match the plain portion.
    expect(res.body).toContain("taking me longer than expected");
    expect(res.body).toContain("&apos;");
    expect(SLOW_REPLY_MESSAGE).toContain("taking me longer than expected");
  });

  it("returns an empty Response when the handler declines to answer", async () => {
    harness = await twimlApp({ handle: async () => null });

    const res = await postInbound(harness);
    expect(res.body).toContain("<Response></Response>");
  });

  it("escapes a reply containing an ampersand", async () => {
    harness = await twimlApp({ handle: async () => "Ask Sofia & Deniz" });

    const res = await postInbound(harness);
    expect(res.body).toContain("Sofia &amp; Deniz");
  });
});

describe("api reply mode is unchanged", () => {
  it("acknowledges with empty twiml and sends via the api", async () => {
    harness = await createTestApp({ handler: { handle: async () => "api reply" } });
    harness.context.repos.guests.upsert({ phone: GUEST_PHONE, name: "Priya Patel" });

    const res = await postInbound(harness);
    await harness.context.tasks.drain();

    expect(res.body).toContain("<Response></Response>");
    expect(harness.whatsapp.sent[0]!.body).toBe("api reply");
  });
});
