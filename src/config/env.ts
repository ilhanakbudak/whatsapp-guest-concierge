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

/**
 * Model-name prefixes each provider answers to. Used to catch a mismatched
 * LLM_PROVIDER / LLM_MODEL pair at boot rather than as a confusing 404 on the
 * first guest message.
 */
export const PROVIDER_MODEL_PREFIXES: Record<LlmProvider, readonly string[]> = {
  anthropic: ["claude-"],
  openai: ["gpt-", "o1-", "o3-", "o4-", "ft:"],
  gemini: ["gemini-"],
  mock: ["mock"],
};

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
  // Per-integration overrides. Each defaults to DEMO_MODE, so the single switch
  // still works, but a real Twilio can be tested against a mock calendar (and
  // vice versa) without inventing credentials for the parts you aren't testing.
  TWILIO_DEMO: bool.optional(),
  CALENDAR_DEMO: bool.optional(),
  LLM_DEMO: bool.optional(),
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
  /**
   * How the bot answers a guest. "api" posts to the Messages API after
   * acknowledging the webhook; "twiml" replies inline in the webhook response.
   * Trial accounts must use "twiml" — see src/whatsapp/twiml.ts.
   */
  TWILIO_REPLY_MODE: z.enum(["api", "twiml"]).default("api"),
  TWILIO_TWIML_TIMEOUT_MS: z.coerce.number().int().positive().max(15_000).default(10_000),

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

  /**
   * The browser chat at /simulator. It runs the real pipeline without a Twilio
   * signature, so it is a deliberate bypass: defaults to on outside production,
   * and requires the admin token when production has it enabled.
   */
  SIMULATOR_ENABLED: bool.optional(),

  ADMIN_API_TOKEN: z.string().default("change-me"),
  ADMIN_PHONE_NUMBERS: z.string().default(""),

  BROADCAST_CONCURRENCY: z.coerce.number().int().positive().max(50).default(5),
  BROADCAST_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  GUEST_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  CONVERSATION_HISTORY_TURNS: z.coerce.number().int().positive().max(50).default(8),
});

export type RawEnv = z.infer<typeof schema>;

/** Which integrations are mocked, after applying DEMO_MODE and its overrides. */
export interface DemoFlags {
  twilio: boolean;
  calendar: boolean;
  llm: boolean;
}

export interface AppConfig extends RawEnv {
  demo: DemoFlags;
  /** Resolved model: LLM_MODEL if set, else the provider default. */
  llmModel: string;
  /** Parsed ADMIN_PHONE_NUMBERS. */
  adminPhoneNumbers: string[];
  /** Whether the browser simulator is served. */
  simulatorEnabled: boolean;
  isProduction: boolean;
  isTest: boolean;
}

/**
 * A heuristic, deliberately: it only fires when the model clearly belongs to a
 * *different* known provider, so an unfamiliar or fine-tuned name passes through.
 */
function modelProviderMismatch(provider: LlmProvider, model: string): string | null {
  const expected = PROVIDER_MODEL_PREFIXES[provider];
  if (expected.some((prefix) => model.startsWith(prefix))) return null;

  const actual = (Object.keys(PROVIDER_MODEL_PREFIXES) as LlmProvider[]).find(
    (candidate) =>
      candidate !== provider &&
      PROVIDER_MODEL_PREFIXES[candidate].some((prefix) => model.startsWith(prefix)),
  );

  if (!actual) return null;

  return (
    `LLM_MODEL "${model}" looks like a ${actual} model but LLM_PROVIDER is "${provider}". ` +
    `Set LLM_PROVIDER=${actual}, or choose a model starting with ` +
    `${expected.map((e) => `"${e}"`).join(" / ")}.`
  );
}

function resolveDemoFlags(env: RawEnv): DemoFlags {
  return {
    twilio: env.TWILIO_DEMO ?? env.DEMO_MODE,
    calendar: env.CALENDAR_DEMO ?? env.DEMO_MODE,
    llm: env.LLM_DEMO ?? env.DEMO_MODE,
  };
}

/**
 * Credentials are required only for the integrations actually running live.
 * A mocked integration needs nothing, so `DEMO_MODE=false CALENDAR_DEMO=true`
 * is a valid way to test Twilio end to end before you have a Google project.
 */
function liveModeIssues(env: RawEnv, demo: DemoFlags, model: string): string[] {
  const issues: string[] = [];

  const mismatch = modelProviderMismatch(env.LLM_PROVIDER, model);
  if (mismatch) issues.push(mismatch);

  if (!demo.llm) {
    const keyVar = PROVIDER_KEY_VAR[env.LLM_PROVIDER];
    if (keyVar && !env[keyVar]) {
      issues.push(`LLM_PROVIDER is "${env.LLM_PROVIDER}" but ${keyVar} is not set`);
    }
  }

  if (!demo.twilio) {
    if (!env.TWILIO_ACCOUNT_SID) issues.push("TWILIO_ACCOUNT_SID is required");
    if (!env.TWILIO_AUTH_TOKEN) issues.push("TWILIO_AUTH_TOKEN is required");
  }

  if (!demo.calendar) {
    if (!env.GOOGLE_CALENDAR_ID) issues.push("GOOGLE_CALENDAR_ID is required");
    if (!env.GOOGLE_SERVICE_ACCOUNT_FILE && !env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      issues.push(
        "one of GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON is required",
      );
    }
  }

  if (env.KB_PROVIDER === "notion") {
    if (!env.NOTION_API_KEY) issues.push("KB_PROVIDER is notion but NOTION_API_KEY is not set");
    if (!env.NOTION_PAGE_ID) issues.push("KB_PROVIDER is notion but NOTION_PAGE_ID is not set");
  }
  if (env.KB_PROVIDER === "google-doc" && !env.GOOGLE_DOC_ID) {
    issues.push("KB_PROVIDER is google-doc but GOOGLE_DOC_ID is not set");
  }

  if (env.NODE_ENV === "production") {
    if (env.ADMIN_API_TOKEN === "change-me") {
      issues.push("ADMIN_API_TOKEN must be changed from its default in production");
    }
    if (!env.TWILIO_VALIDATE_SIGNATURE) {
      issues.push("TWILIO_VALIDATE_SIGNATURE must not be disabled in production");
    }
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
  const demo = resolveDemoFlags(env);
  const llmModel = env.LLM_MODEL ?? DEFAULT_MODELS[env.LLM_PROVIDER];

  const issues = liveModeIssues(env, demo, llmModel);
  if (issues.length > 0) {
    throw new Error(
      `Missing configuration for the integrations running live:\n` +
        issues.map((i) => `  - ${i}`).join("\n") +
        `\n\nSet DEMO_MODE=true to mock everything, or mock just one integration ` +
        `with TWILIO_DEMO / CALENDAR_DEMO / LLM_DEMO.`,
    );
  }

  return {
    ...env,
    demo,
    llmModel,
    adminPhoneNumbers: env.ADMIN_PHONE_NUMBERS.split(",")
      .map((n) => n.trim())
      .filter(Boolean),
    simulatorEnabled: env.SIMULATOR_ENABLED ?? env.NODE_ENV !== "production",
    isProduction: env.NODE_ENV === "production",
    isTest: env.NODE_ENV === "test",
  };
}
