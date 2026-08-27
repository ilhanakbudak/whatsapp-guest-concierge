import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorMessage, ValidationError } from "../lib/errors.js";
import { maskPhone, tryNormalizePhone } from "../lib/phone.js";

/** Constant-time compare, so the token can't be recovered by timing the 401. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireAdminToken(expected: string) {
  return async function guard(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!provided || !tokensMatch(provided, expected)) {
      request.log.warn({ url: request.url }, "rejected unauthenticated admin request");
      return reply.status(401).send({ error: "unauthorized" });
    }
  };
}

interface BroadcastBody {
  message?: string;
  dryRun?: boolean;
}

interface GuestBody {
  phone?: string;
  name?: string;
  role?: "guest" | "admin";
  notes?: string;
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const { config, knowledgeBase, repos, broadcasts, broadcastWorker, tasks } = app.context;
  const guard = requireAdminToken(config.ADMIN_API_TOKEN);

  // --- guests ---------------------------------------------------------------

  app.get("/admin/guests", { preHandler: guard }, async (request) => {
    const includeInactive = (request.query as { all?: string }).all === "true";
    return repos.guests
      .list(includeInactive ? {} : { activeOnly: true })
      .map((guest) => ({ ...guest, phone: guest.phone, masked: maskPhone(guest.phone) }));
  });

  app.post<{ Body: GuestBody }>("/admin/guests", { preHandler: guard }, async (request, reply) => {
    const phone = tryNormalizePhone(request.body?.phone ?? "");
    if (!phone) {
      throw new ValidationError(
        "A valid international phone number is required, e.g. +447700900123",
      );
    }

    const name = (request.body?.name ?? "").trim();
    if (!name) throw new ValidationError("A name is required");

    const existed = repos.guests.findByPhone(phone) !== null;
    const guest = repos.guests.upsert({
      phone,
      name,
      ...(request.body?.role ? { role: request.body.role } : {}),
      notes: request.body?.notes ?? null,
    });

    return reply.status(existed ? 200 : 201).send(guest);
  });

  app.delete<{ Params: { phone: string } }>(
    "/admin/guests/:phone",
    { preHandler: guard },
    async (request, reply) => {
      const phone = tryNormalizePhone(decodeURIComponent(request.params.phone));
      if (!phone) throw new ValidationError("Invalid phone number");

      // Deactivate rather than delete: message history and delivery records
      // must survive removing a guest.
      const removed = repos.guests.deactivate(phone);
      if (!removed) return reply.status(404).send({ error: "not_found" });

      return { ok: true, phone: maskPhone(phone) };
    },
  );

  // --- usage ----------------------------------------------------------------

  app.get("/admin/usage", { preHandler: guard }, async (request) => {
    const days = Number((request.query as { days?: string }).days ?? 7);
    const since = new Date(Date.now() - days * 86_400_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    return { since, days, ...repos.usage.totalsSince(since) };
  });

  /** Recent traffic, so the team can see the bot is actually being used. */
  app.get("/admin/activity", { preHandler: guard }, async (request) => {
    const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 12), 100);
    const guests = new Map(repos.guests.list().map((guest) => [guest.id, guest.name]));

    return repos.messages.recent(limit).map((message) => ({
      direction: message.direction,
      body: message.body,
      at: message.createdAt,
      guest: message.guestId ? (guests.get(message.guestId) ?? "Unknown") : "Unknown number",
    }));
  });

  // --- knowledge base -------------------------------------------------------

  app.get("/admin/kb", { preHandler: guard }, async () => ({
    ...knowledgeBase.status,
    history: repos.knowledge.history(knowledgeBase.source, 5).map((snapshot) => ({
      hash: snapshot.contentHash,
      fetchedAt: snapshot.fetchedAt,
      characters: snapshot.rendered.length,
    })),
  }));

  /**
   * On-demand refresh. The daily cron covers the normal case; this exists for
   * the one that matters — someone corrects a wrong phone number and needs it
   * live now, not tomorrow morning.
   */
  app.get("/admin/broadcasts", { preHandler: guard }, async () =>
    repos.broadcasts.list(25).map((broadcast) => ({
      ...broadcast,
      counts: repos.broadcasts.summary(broadcast.id)?.counts,
    })),
  );

  app.get<{ Params: { id: string } }>(
    "/admin/broadcasts/:id",
    { preHandler: guard },
    async (request, reply) => {
      const id = Number(request.params.id);
      const summary = repos.broadcasts.summary(id);
      if (!summary) return reply.status(404).send({ error: "not_found" });

      return {
        ...summary,
        recipients: repos.broadcasts.recipients(id).map((recipient) => ({
          ...recipient,
          phone: maskPhone(recipient.phone),
        })),
      };
    },
  );

  /**
   * Queues an announcement. `dryRun` returns the preview without sending, which
   * the dashboard always calls first — a message to every guest is not undoable.
   */
  app.post<{ Body: BroadcastBody }>(
    "/admin/broadcast",
    { preHandler: guard },
    async (request, reply) => {
      const message = request.body?.message ?? "";

      if (request.body?.dryRun) {
        return { dryRun: true, ...broadcasts.preview(message) };
      }

      const { broadcast, recipients } = broadcasts.create({
        body: message,
        createdBy: "dashboard",
      });

      // Sending happens in the background: the caller gets an id immediately
      // rather than holding an HTTP connection open for the whole run.
      tasks.run(`broadcast-${broadcast.id}`, async () => {
        await broadcastWorker.run(broadcast.id);
      });

      return reply.status(202).send({
        id: broadcast.id,
        queued: recipients.length,
        status: "queued",
      });
    },
  );

  app.post("/admin/kb/refresh", { preHandler: guard }, async (request, reply) => {
    try {
      const result = await knowledgeBase.refresh();
      return { ok: true, ...result };
    } catch (err) {
      request.log.error({ err }, "manual knowledge base refresh failed");
      return reply.status(502).send({ ok: false, error: errorMessage(err) });
    }
  });
}
