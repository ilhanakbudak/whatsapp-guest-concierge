import type { FastifyInstance } from "fastify";
import { requireAdminToken } from "./admin.js";
import { ValidationError } from "../lib/errors.js";
import { tryNormalizePhone } from "../lib/phone.js";

interface SimulatorBody {
  message?: string;
  from?: string;
}

/**
 * A browser chat that drives the real pipeline.
 *
 * It deliberately skips Twilio signature verification, which is exactly why it
 * is gated: on by default outside production so a reviewer can clone and talk to
 * the bot, and behind the admin token when a deployed instance enables it.
 */
export async function registerSimulatorRoutes(app: FastifyInstance): Promise<void> {
  const { config, handler, repos, logger } = app.context;

  if (!config.simulatorEnabled) {
    logger.info("simulator disabled");
    return;
  }

  if (config.isProduction) {
    logger.warn("simulator is enabled in production and requires the admin token");
  }

  const preHandler = config.isProduction
    ? { preHandler: requireAdminToken(config.ADMIN_API_TOKEN) }
    : {};

  app.post<{ Body: SimulatorBody }>("/simulator/message", preHandler, async (request) => {
    const message = (request.body?.message ?? "").trim();
    if (!message) throw new ValidationError("A message is required");

    const phone = tryNormalizePhone(request.body?.from ?? "+447700900001");
    if (!phone) throw new ValidationError("Invalid phone number");

    const guest = repos.guests.findByPhone(phone);
    if (!guest || !guest.active) {
      // Mirrors the webhook's allowlist behaviour rather than special-casing it,
      // so the simulator shows the same refusal a real guest would see.
      return {
        authorized: false,
        reply:
          "This number is not on the guest list. Add it from the dashboard, " +
          "then try again.",
      };
    }

    const started = Date.now();
    repos.messages.record({
      guestId: guest.id,
      phone,
      direction: "inbound",
      body: message,
      twilioSid: null,
    });

    const reply = await handler.handle({ guest, body: message, messageSid: "SIMULATOR" });

    if (reply) {
      repos.messages.record({
        guestId: guest.id,
        phone,
        direction: "outbound",
        body: reply,
        twilioSid: null,
      });
    }

    return {
      authorized: true,
      reply: reply ?? "",
      elapsedMs: Date.now() - started,
      guest: { name: guest.name, role: guest.role },
    };
  });

  /** Lets the page restore the conversation after a reload. */
  app.get<{ Querystring: { from?: string; limit?: string } }>(
    "/simulator/history",
    preHandler,
    async (request) => {
      const phone = tryNormalizePhone(request.query.from ?? "+447700900001");
      if (!phone) throw new ValidationError("Invalid phone number");

      const guest = repos.guests.findByPhone(phone);
      if (!guest) return { messages: [] };

      const limit = Math.min(Number(request.query.limit ?? 40), 200);
      return {
        guest: { name: guest.name, role: guest.role },
        messages: repos.messages.recentForGuest(guest.id, limit).map((m) => ({
          direction: m.direction,
          body: m.body,
          at: m.createdAt,
        })),
      };
    },
  );

  app.get("/simulator/guests", preHandler, async () =>
    repos.guests.list({ activeOnly: true }).map((g) => ({
      phone: g.phone,
      name: g.name,
      role: g.role,
    })),
  );
}
