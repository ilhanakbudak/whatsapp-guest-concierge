import { buildServer } from "./server.js";

const server = await buildServer();
const { config, logger } = server.context;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    void server.close().then(() => process.exit(0));
  });
}

try {
  await server.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (err) {
  logger.error({ err }, "failed to start");
  process.exit(1);
}
