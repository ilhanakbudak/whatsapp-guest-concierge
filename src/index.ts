import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);

const server = await buildServer();
await server.listen({ port, host: "0.0.0.0" });
