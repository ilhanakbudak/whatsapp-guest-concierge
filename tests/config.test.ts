import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, loadConfig } from "../src/config/env.js";

/** A minimal env that satisfies live mode, so tests can remove one key at a time. */
const liveEnv = {
  DEMO_MODE: "false",
  LLM_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "sk-test",
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "token",
  GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com",
  GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
} satisfies NodeJS.ProcessEnv;

describe("demo mode", () => {
  it("needs no credentials at all", () => {
    const config = loadConfig({ DEMO_MODE: "true" });
    expect(config.DEMO_MODE).toBe(true);
    expect(config.llmModel).toBe(DEFAULT_MODELS.anthropic);
  });

  it("is the default, so a bare clone runs", () => {
    expect(loadConfig({}).DEMO_MODE).toBe(true);
  });
});

describe("llm provider selection", () => {
  it.each([
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["gemini", "GEMINI_API_KEY"],
  ])("resolves the default model for %s", (provider) => {
    const config = loadConfig({ DEMO_MODE: "true", LLM_PROVIDER: provider });
    expect(config.llmModel).toBe(DEFAULT_MODELS[provider as keyof typeof DEFAULT_MODELS]);
  });

  it("LLM_MODEL overrides the provider default", () => {
    const config = loadConfig({
      DEMO_MODE: "true",
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "claude-sonnet-5",
    });
    expect(config.llmModel).toBe("claude-sonnet-5");
  });

  it.each([
    ["openai", "OPENAI_API_KEY"],
    ["gemini", "GEMINI_API_KEY"],
  ])("in live mode, %s requires its own key and not another provider's", (provider, keyVar) => {
    const { ANTHROPIC_API_KEY: _drop, ...rest } = liveEnv;
    expect(() => loadConfig({ ...rest, LLM_PROVIDER: provider, ANTHROPIC_API_KEY: "sk-test" }))
      .toThrow(new RegExp(keyVar));

    expect(() =>
      loadConfig({ ...rest, LLM_PROVIDER: provider, [keyVar]: "key" }),
    ).not.toThrow();
  });

  it("rejects an unknown provider", () => {
    expect(() => loadConfig({ LLM_PROVIDER: "llama" })).toThrow(/LLM_PROVIDER/);
  });

  it("mock needs no key even in live mode", () => {
    const { ANTHROPIC_API_KEY: _drop, ...rest } = liveEnv;
    expect(() => loadConfig({ ...rest, LLM_PROVIDER: "mock" })).not.toThrow();
  });
});

describe("live mode validation", () => {
  it("accepts a complete configuration", () => {
    expect(() => loadConfig(liveEnv)).not.toThrow();
  });

  it.each(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "GOOGLE_CALENDAR_ID"])(
    "reports %s when it is missing",
    (key) => {
      const env = { ...liveEnv } as Record<string, string>;
      delete env[key];
      expect(() => loadConfig(env)).toThrow(new RegExp(key));
    },
  );

  it("accepts either google credential form but requires one", () => {
    const { GOOGLE_SERVICE_ACCOUNT_JSON: _drop, ...rest } = liveEnv;
    expect(() => loadConfig(rest)).toThrow(/GOOGLE_SERVICE_ACCOUNT_FILE/);
    expect(() =>
      loadConfig({ ...rest, GOOGLE_SERVICE_ACCOUNT_FILE: "./sa.json" }),
    ).not.toThrow();
  });

  it("collects every problem at once instead of one per run", () => {
    const message = (() => {
      try {
        loadConfig({ DEMO_MODE: "false", LLM_PROVIDER: "anthropic" });
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    })();

    expect(message).toContain("ANTHROPIC_API_KEY");
    expect(message).toContain("TWILIO_ACCOUNT_SID");
    expect(message).toContain("GOOGLE_CALENDAR_ID");
  });

  it("requires the notion credentials only when notion is the kb provider", () => {
    expect(() => loadConfig({ ...liveEnv, KB_PROVIDER: "notion" })).toThrow(/NOTION_API_KEY/);
    expect(() =>
      loadConfig({ ...liveEnv, KB_PROVIDER: "notion", NOTION_API_KEY: "k", NOTION_PAGE_ID: "p" }),
    ).not.toThrow();
  });

  it("refuses the default admin token in production", () => {
    expect(() => loadConfig({ ...liveEnv, NODE_ENV: "production" })).toThrow(/ADMIN_API_TOKEN/);
  });
});

describe("derived values", () => {
  it("parses and trims the admin phone list", () => {
    const config = loadConfig({
      DEMO_MODE: "true",
      ADMIN_PHONE_NUMBERS: " +447700900123 , +447700900124 ,, ",
    });
    expect(config.adminPhoneNumbers).toEqual(["+447700900123", "+447700900124"]);
  });

  it("defaults to an empty admin list", () => {
    expect(loadConfig({ DEMO_MODE: "true" }).adminPhoneNumbers).toEqual([]);
  });

  it("rejects a non-numeric port with a readable message", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(/PORT/);
  });
});
