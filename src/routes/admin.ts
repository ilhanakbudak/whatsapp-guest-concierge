import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorMessage } from "../lib/errors.js";
import { maskPhone } from "../lib/phone.js";

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

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const { config, knowledgeBase, repos, broadcasts, broadcastWorker, tasks } = app.context;
  const guard = requireAdminToken(config.ADMIN_API_TOKEN);

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
