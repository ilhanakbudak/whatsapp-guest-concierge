import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyBaseLogger } from "fastify";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import { createContext, type AppContext } from "./app.js";
import { isAppError } from "./lib/errors.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerSimulatorRoutes } from "./routes/simulator.js";
import { registerWebhookRoutes } from "./routes/webhook.js";

declare module "fastify" {
  interface FastifyInstance {
    /** The application container, reachable from any route handler. */
    context: AppContext;
  }
}

export interface BuildServerOptions {
  context?: AppContext;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const context = options.context ?? createContext();

  const app = Fastify({
    // Widened to FastifyBaseLogger deliberately: passing the concrete pino type
    // narrows FastifyInstance's logger generic, which then fails to match the
    // plain FastifyInstance that route modules accept.
    loggerInstance: context.logger as FastifyBaseLogger,
    // Railway and Render terminate TLS upstream. Twilio signature validation
    // rebuilds the URL Twilio called, so getting the protocol wrong here breaks
    // every inbound message with an invalid-signature error.
    trustProxy: true,
  });

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      request.log.warn({ code: error.code, err: error }, "request failed");
      return reply
        .status(error.statusCode)
        .send({ error: error.code, message: error.message, details: error.details });
    }

    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: "internal_error", message: "Something went wrong" });
  });

  // Twilio posts application/x-www-form-urlencoded, which Fastify does not
  // parse out of the box.
  await app.register(formbody);

  // Decorating is how route handlers reach the container without a
  // module-level singleton — every handler gets it via `this` or `request.server`.
  app.decorate("context", context);

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/health/ready", async () => {
    // Cheap query that fails loudly if the database file is gone or locked.
    context.db.prepare("SELECT 1").get();
    return {
      status: "ok",
      demoMode: context.config.DEMO_MODE,
      llm: { provider: context.config.LLM_PROVIDER, model: context.config.llmModel },
      guests: context.repos.guests.list({ activeOnly: true }).length,
    };
  });

  // The admin pages are plain static HTML with no build step. They hold no
  // secrets: every data call they make carries the bearer token, which the
  // operator supplies in the browser. Resolving relative to this module puts
  // public/ at the repository root for both `tsx src` and `node dist`.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  await app.register(fastifyStatic, { root: publicDir, prefix: "/", index: false });

  app.get("/", async (_request, reply) => reply.redirect("/dashboard"));
  app.get("/dashboard", async (_request, reply) => reply.sendFile("dashboard.html"));

  if (context.config.simulatorEnabled) {
    app.get("/simulator", async (_request, reply) => reply.sendFile("simulator.html"));
  }

  await registerWebhookRoutes(app);
  await registerAdminRoutes(app);
  await registerSimulatorRoutes(app);

  // Resume anything a restart interrupted, once the server is listening.
  // Not in tests: it would race with each test's own fixtures.
  if (!context.config.isTest) {
    app.addHook("onReady", async () => {
      context.tasks.run("resume-broadcasts", async () => {
        await context.broadcastWorker.resumeInterrupted();
      });

      // Pre-load the knowledge base and today's schedule. Without this the first
      // guest of the day pays for both cold fetches on top of the model call,
      // which in TwiML mode can push the reply past Twilio's webhook timeout.
      context.tasks.run("warm-caches", async () => {
        await Promise.allSettled([
          context.knowledgeBase.refresh(),
          context.schedule.get({ range: "today" }),
        ]);
        context.logger.info("caches warmed");
      });
    });
  }

  app.addHook("onClose", async () => context.shutdown());

  return app;
}

export type AppServer = Awaited<ReturnType<typeof buildServer>>;
