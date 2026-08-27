import { pino, type Logger } from "pino";
import type { AppConfig } from "../config/env.js";

/**
 * Guest phone numbers are personal data. In production we redact them; in
 * development we keep them, because debugging Twilio without the number is
 * miserable.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers['x-twilio-signature']",
  "*.from",
  "*.to",
  "*.phone",
  "*.WaId",
  "*.From",
  "*.To",
];

export function createLogger(config: Pick<AppConfig, "LOG_LEVEL" | "isProduction">): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: config.isProduction ? { paths: REDACT_PATHS, censor: "[redacted]" } : { paths: [] },
    ...(config.isProduction
      ? {}
      : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }),
  });
}

export type { Logger };
