import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// quiet: dotenv v17 prints a promotional banner on load otherwise.
loadDotenv({ quiet: true });

/** Providers the LLM layer can be pointed at. See src/ai/registry.ts. */
export const LLM_PROVIDERS = ["anthropic", "openai", "gemini", "mock"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** Default model per provider, overridable with LLM_MODEL. */
export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.6-terra",
  gemini: "gemini-3.7-flash",
  mock: "mock-1",
};

/**
 * Which env var holds the credential for each provider. Typed as a key of the
 * parsed config so validation reads the same source the caller passed in, rather
 * than reaching back into process.env.
 */
export const PROVIDER_KEY_VAR = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  mock: null,
} as const satisfies Record<LlmProvider, keyof RawEnv | null>;

export const KB_PROVIDERS = ["local", "notion", "google-doc"] as const;
export type KbProvider = (typeof KB_PROVIDERS)[number];

const bool = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .or(z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  DEMO_MODE: bool.default(true),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_PATH: z.string().default("./data/concierge.db"),

  LLM_PROVIDER: z.enum(LLM_PROVIDERS).default("anthropic"),
  LLM_MODEL: z.string().optional(),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  LLM_MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().max(20).default(5),

  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().default("whatsapp:+14155238886"),
  TWILIO_VALIDATE_SIGNATURE: bool.default(true),

  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().optional(),
  CALENDAR_TIMEZONE: z.string().default("Europe/Istanbul"),

  KB_PROVIDER: z.enum(KB_PROVIDERS).default("local"),
  KB_LOCAL_PATH: z.string().default("./kb"),
  KB_REFRESH_CRON: z.string().default("0 4 * * *"),
  NOTION_API_KEY: z.string().optional(),
  NOTION_PAGE_ID: z.string().optional(),
  GOOGLE_DOC_ID: z.string().optional(),

  ADMIN_API_TOKEN: z.string().default("change-me"),
  ADMIN_PHONE_NUMBERS: z.string().default(""),

  BROADCAST_CONCURRENCY: z.coerce.number().int().positive().max(50).default(5),
  BROADCAST_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  GUEST_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  CONVERSATION_HISTORY_TURNS: z.coerce.number().int().positive().max(50).default(8),
});

export type RawEnv = z.infer<typeof schema>;

export interface AppConfig extends RawEnv {
  /** Resolved model: LLM_MODEL if set, else the provider default. */
  llmModel: string;
  /** Parsed ADMIN_PHONE_NUMBERS. */
  adminPhoneNumbers: string[];
  isProduction: boolean;
  isTest: boolean;
}

/**
 * Requirements that only apply once DEMO_MODE is off — in demo mode every
 * external dependency is mocked, so none of these are needed.
 */
function liveModeIssues(env: RawEnv): string[] {
  const issues: string[] = [];

  const keyVar = PROVIDER_KEY_VAR[env.LLM_PROVIDER];
  if (keyVar && !env[keyVar]) {
    issues.push(`LLM_PROVIDER is "${env.LLM_PROVIDER}" but ${keyVar} is not set`);
  }

  if (!env.TWILIO_ACCOUNT_SID) issues.push("TWILIO_ACCOUNT_SID is required");
  if (!env.TWILIO_AUTH_TOKEN) issues.push("TWILIO_AUTH_TOKEN is required");
  if (!env.GOOGLE_CALENDAR_ID) issues.push("GOOGLE_CALENDAR_ID is required");

  if (!env.GOOGLE_SERVICE_ACCOUNT_FILE && !env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    issues.push(
      "one of GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON is required",
    );
  }

  if (env.KB_PROVIDER === "notion") {
    if (!env.NOTION_API_KEY) issues.push("KB_PROVIDER is notion but NOTION_API_KEY is not set");
    if (!env.NOTION_PAGE_ID) issues.push("KB_PROVIDER is notion but NOTION_PAGE_ID is not set");
  }
  if (env.KB_PROVIDER === "google-doc" && !env.GOOGLE_DOC_ID) {
    issues.push("KB_PROVIDER is google-doc but GOOGLE_DOC_ID is not set");
  }

  if (env.NODE_ENV === "production" && env.ADMIN_API_TOKEN === "change-me") {
    issues.push("ADMIN_API_TOKEN must be changed from its default in production");
  }

  return issues;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const env = parsed.data;

  if (!env.DEMO_MODE) {
    const issues = liveModeIssues(env);
    if (issues.length > 0) {
      throw new Error(
        `DEMO_MODE is off, so live credentials are required:\n` +
          issues.map((i) => `  - ${i}`).join("\n") +
          `\n\nSet DEMO_MODE=true to run without any credentials.`,
      );
    }
  }

  return {
    ...env,
    llmModel: env.LLM_MODEL ?? DEFAULT_MODELS[env.LLM_PROVIDER],
    adminPhoneNumbers: env.ADMIN_PHONE_NUMBERS.split(",")
      .map((n) => n.trim())
      .filter(Boolean),
    isProduction: env.NODE_ENV === "production",
    isTest: env.NODE_ENV === "test",
  };
}
