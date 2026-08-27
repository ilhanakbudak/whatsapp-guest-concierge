import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorMessage } from "../lib/errors.js";

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

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const { config, knowledgeBase, repos } = app.context;
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
