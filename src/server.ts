import Fastify, { type FastifyInstance } from "fastify";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
