import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RecipientStatus } from "../db/types.js";
import { normalizePhone, tryNormalizePhone } from "../lib/phone.js";
import { getSignatureHeader, verifyTwilioSignature } from "../whatsapp/signature.js";
import type { InboundWebhookPayload, StatusWebhookPayload } from "../whatsapp/types.js";

/** Twilio expects TwiML. An empty Response means "I handled it, say nothing now". */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const DECLINE_MESSAGE =
  "Hi! This number is for guests of the villa only. " +
  "If you think you should have access, please contact your host.";

const THROTTLE_MESSAGE =
  "You're sending messages faster than I can answer. Give me a moment and try again.";

/**
 * Twilio's message statuses mapped onto ours. `sending`/`queued` are transient
 * states we already track ourselves, so they're ignored rather than written back.
 */
const STATUS_MAP: Record<string, RecipientStatus> = {
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
  undelivered: "undelivered",
};

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  const { config, repos, logger, whatsapp, handler, tasks, rateLimiter } = app.context;

  /**
   * Signature verification runs before any handler logic, on the raw parsed body.
   * Disabling it is allowed only for local development — loadConfig refuses the
   * combination of production and a disabled signature check.
   */
  async function verifySignature(request: FastifyRequest, reply: FastifyReply) {
    if (!config.TWILIO_VALIDATE_SIGNATURE) {
      request.log.warn("twilio signature validation is disabled");
      return;
    }

    const valid = verifyTwilioSignature({
      authToken: config.TWILIO_AUTH_TOKEN ?? "",
      signature: getSignatureHeader(request),
      publicUrl: config.PUBLIC_URL,
      requestUrl: request.url,
      params: (request.body ?? {}) as Record<string, unknown>,
    });

    if (!valid) {
      request.log.warn({ url: request.url }, "rejected webhook with invalid signature");
      // 403 with no detail: a caller who can't sign gets no help debugging why.
      return reply.status(403).send({ error: "invalid_signature" });
    }
  }

  app.post(
    "/webhooks/twilio/inbound",
    { preHandler: verifySignature },
    async (request, reply) => {
      const payload = request.body as InboundWebhookPayload;
      const phone = tryNormalizePhone(payload.From ?? "");

      if (!phone) {
        request.log.warn("inbound webhook with unparseable From");
        return reply.type("text/xml").send(EMPTY_TWIML);
      }

      const guest = repos.guests.findByPhone(phone);

      // Allowlist gate. Unknown numbers are recorded (so the team can see who
      // tried) but get a fixed reply — never an LLM call, which would let anyone
      // with the number spend the client's tokens.
      if (!guest || !guest.active) {
        repos.messages.record({
          guestId: guest?.id ?? null,
          phone,
          direction: "inbound",
          body: payload.Body ?? "",
          twilioSid: payload.MessageSid ?? null,
        });

        request.log.info({ authorized: false }, "message from unauthorized number");
        tasks.run("decline", async () => {
          await whatsapp.send({ to: phone, body: DECLINE_MESSAGE });
        });

        return reply.type("text/xml").send(EMPTY_TWIML);
      }

      const decision = rateLimiter.check(phone);
      if (!decision.allowed) {
        request.log.info({ guestId: guest.id, retryAfterSeconds: decision.retryAfterSeconds }, "guest rate limited");
        tasks.run("throttle-notice", async () => {
          await whatsapp.send({ to: phone, body: THROTTLE_MESSAGE });
        });
        return reply.type("text/xml").send(EMPTY_TWIML);
      }

      repos.messages.record({
        guestId: guest.id,
        phone,
        direction: "inbound",
        body: payload.Body ?? "",
        twilioSid: payload.MessageSid ?? null,
      });

      // Acknowledge now; answer out-of-band. See lib/tasks.ts for why.
      tasks.run("reply", async () => {
        const answer = await handler.handle({
          guest,
          body: payload.Body ?? "",
          messageSid: payload.MessageSid ?? "",
        });

        if (!answer) return;

        const sent = await whatsapp.send({ to: phone, body: answer });
        repos.messages.record({
          guestId: guest.id,
          phone,
          direction: "outbound",
          body: answer,
          twilioSid: sent.sid,
        });
      });

      return reply.type("text/xml").send(EMPTY_TWIML);
    },
  );

  app.post(
    "/webhooks/twilio/status",
    { preHandler: verifySignature },
    async (request, reply) => {
      const payload = request.body as StatusWebhookPayload;
      const status = STATUS_MAP[payload.MessageStatus];

      if (status && payload.MessageSid) {
        const matched = repos.broadcasts.updateStatusBySid(payload.MessageSid, status);
        if (matched) {
          logger.debug({ status, sid: payload.MessageSid }, "broadcast delivery status updated");
        }
      }

      return reply.status(204).send();
    },
  );
}

export { DECLINE_MESSAGE, THROTTLE_MESSAGE, EMPTY_TWIML };
export { normalizePhone };
