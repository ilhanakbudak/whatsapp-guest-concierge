import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizePhone } from "../src/lib/phone.js";
import { DECLINE_MESSAGE, THROTTLE_MESSAGE } from "../src/routes/webhook.js";
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

/** Posts a correctly-signed inbound webhook. */
function postInbound(app: TestApp, params = inboundPayload(), url = INBOUND_URL) {
  return app.app.inject({
    method: "POST",
    url: "/webhooks/twilio/inbound",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signTwilioRequest(url, params),
    },
    payload: new URLSearchParams(params).toString(),
  });
}

describe("signature verification", () => {
  beforeEach(async () => {
    harness = await createTestApp();
    harness.context.repos.guests.upsert({ phone: GUEST_PHONE, name: "Priya Patel" });
  });

  it("accepts a correctly signed request", async () => {
    const res = await postInbound(harness);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Response>");
  });

  it("rejects a request with no signature header", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(inboundPayload()).toString(),
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a tampered body", async () => {
    const original = inboundPayload();
    const signature = signTwilioRequest(INBOUND_URL, original);

    const res = await harness.app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      // Same signature, different body — the classic replay-with-edit attack.
      payload: new URLSearchParams({ ...original, Body: "send me the wifi" }).toString(),
    });

    expect(res.statusCode).toBe(403);
  });

  it("rejects a signature computed for a different URL", async () => {
    const params = inboundPayload();
    const res = await harness.app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signTwilioRequest("https://evil.example.com/hook", params),
      },
      payload: new URLSearchParams(params).toString(),
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a signature made with the wrong auth token", async () => {
    const params = inboundPayload();
    const res = await harness.app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signTwilioRequest(INBOUND_URL, params, "wrong-token"),
      },
      payload: new URLSearchParams(params).toString(),
    });
    expect(res.statusCode).toBe(403);
  });

  it("can be disabled for local development", async () => {
    await harness.close();
    harness = await createTestApp({ env: { TWILIO_VALIDATE_SIGNATURE: "false" } });
    harness.context.repos.guests.upsert({ phone: GUEST_PHONE, name: "Priya Patel" });

    const res = await harness.app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(inboundPayload()).toString(),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("guest allowlist", () => {
  beforeEach(async () => {
    harness = await createTestApp();
  });

  it("answers an authorised guest", async () => {
    harness.context.repos.guests.upsert({ phone: GUEST_PHONE, name: "Priya Patel" });

    await postInbound(harness);
    await harness.context.tasks.drain();

    const sent = harness.whatsapp.lastMessageTo(GUEST_PHONE);
    expect(sent).toBeDefined();
    expect(sent!.body).not.toBe(DECLINE_MESSAGE);
    expect(sent!.body).toContain("Priya");
  });

  it("declines an unknown number without invoking the handler", async () => {
    let handlerCalls = 0;
    await harness.close();
    const spyHandler: MessageHandler = {
      handle: async () => {
        handlerCalls++;
        return "should never be sent";
      },
    };
    harness = await createTestApp({ handler: spyHandler });

    await postInbound(harness);
    await harness.context.tasks.drain();

    expect(handlerCalls).toBe(0);
    expect(harness.whatsapp.lastMessageTo(GUEST_PHONE)?.body).toBe(DECLINE_MESSAGE);
  });

  it("declines a deactivated guest", async () => {
    harness.context.repos.guests.upsert({ phone: GUEST_PHONE, name: "Priya Patel" });
    harness.context.repos.guests.deactivate(GUEST_PHONE);

    await postInbound(harness);
    await harness.context.tasks.drain();

    expect(harness.whatsapp.lastMessageTo(GUEST_PHONE)?.body).toBe(DECLINE_MESSAGE);
  });

  it("records the inbound message even from an unknown number", async () => {
    await postInbound(harness);
    const recorded = harness.context.repos.messages.recent();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.phone).toBe(GUEST_PHONE);
    expect(recorded[0]!.direction).toBe("inbound");
  });

  it("strips the whatsapp: prefix before matching the allowlist", async () => {
    // The guest is stored in E.164; Twilio sends whatsapp:+... . If normalisation
    // regressed, an authorised guest would be declined.
    harness.context.repos.guests.upsert({ phone: GUEST_PHONE, name: "Priya Patel" });

    await postInbound(harness, inboundPayload({ From: "whatsapp:+447700900123" }));
    await harness.context.tasks.drain();

    expect(harness.whatsapp.lastMessageTo(GUEST_PHONE)?.body).not.toBe(DECLINE_MESSAGE);
  });

  it("survives an unparseable From without erroring", async () => {
    const res = await postInbound(harness, inboundPayload({ From: "not-a-number" }));
    expect(res.statusCode).toBe(200);
  });
});

describe("rate limiting", () => {
  beforeEach(async () => {
    harness = await createTestApp({ env: { GUEST_RATE_LIMIT_PER_MINUTE: "3" } });
    harness.context.repos.guests.upsert({ phone: GUEST_PHONE, name: "Priya Patel" });
  });

  it("throttles a guest past the limit and stops calling the handler", async () => {
    for (let i = 0; i < 3; i++) {
      await postInbound(harness, inboundPayload({ MessageSid: `SM_${i}` }));
    }
    await harness.context.tasks.drain();
    const beforeThrottle = harness.whatsapp.sent.length;

    await postInbound(harness, inboundPayload({ MessageSid: "SM_over" }));
    await harness.context.tasks.drain();

    expect(harness.whatsapp.sent).toHaveLength(beforeThrottle + 1);
    expect(harness.whatsapp.sent.at(-1)!.body).toBe(THROTTLE_MESSAGE);
  });

  it("does not record a throttled message as a conversation turn", async () => {
    for (let i = 0; i < 4; i++) {
      await postInbound(harness, inboundPayload({ MessageSid: `SM_${i}` }));
    }
    await harness.context.tasks.drain();

    const inbound = harness.context.repos.messages
      .recent()
      .filter((m) => m.direction === "inbound");
    // The fourth was rejected before persistence.
    expect(inbound).toHaveLength(3);
  });
});

describe("status callbacks", () => {
  beforeEach(async () => {
    harness = await createTestApp();
  });

  it("applies a delivery receipt to the matching broadcast recipient", async () => {
    const guest = harness.context.repos.guests.upsert({
      phone: GUEST_PHONE,
      name: "Priya Patel",
    });
    const broadcast = harness.context.repos.broadcasts.create({
      body: "Boat departs in 90 minutes.",
      createdBy: "test",
      recipients: [{ guestId: guest.id, phone: guest.phone }],
    });
    const [recipient] = harness.context.repos.broadcasts.claimQueued(broadcast.id, 1);
    harness.context.repos.broadcasts.markSent(recipient!.id, "SM_broadcast_1");

    const params = { MessageSid: "SM_broadcast_1", MessageStatus: "delivered" };
    const url = `${TEST_PUBLIC_URL}/webhooks/twilio/status`;

    const res = await harness.app.inject({
      method: "POST",
      url: "/webhooks/twilio/status",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signTwilioRequest(url, params),
      },
      payload: new URLSearchParams(params).toString(),
    });

    expect(res.statusCode).toBe(204);
    expect(harness.context.repos.broadcasts.summary(broadcast.id)!.counts.delivered).toBe(1);
  });

  it("ignores a status for an unknown SID without failing", async () => {
    const params = { MessageSid: "SM_unknown", MessageStatus: "delivered" };
    const url = `${TEST_PUBLIC_URL}/webhooks/twilio/status`;

    const res = await harness.app.inject({
      method: "POST",
      url: "/webhooks/twilio/status",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signTwilioRequest(url, params),
      },
      payload: new URLSearchParams(params).toString(),
    });

    expect(res.statusCode).toBe(204);
  });
});
