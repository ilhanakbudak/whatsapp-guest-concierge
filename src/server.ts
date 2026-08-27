import Fastify from "fastify";
import { createContext, type AppContext } from "./app.js";
import { isAppError } from "./lib/errors.js";

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
    loggerInstance: context.logger,
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

  app.addHook("onClose", async () => context.shutdown());

  return app;
}

export type AppServer = Awaited<ReturnType<typeof buildServer>>;
