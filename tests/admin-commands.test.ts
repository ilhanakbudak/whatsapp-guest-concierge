import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminCommandService, CONFIRMATION_TTL_MS } from "../src/admin/commands.js";
import { isUnknown, looksLikeCommand, parseCommand, suggestCommand } from "../src/admin/parse.js";
import { RoutingHandler } from "../src/admin/routing-handler.js";
import { BroadcastService } from "../src/broadcast/service.js";
import { BroadcastWorker } from "../src/broadcast/worker.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import type { KnowledgeBaseProvider } from "../src/knowledge/types.js";
import { createLogger } from "../src/lib/logger.js";
import { normalizePhone } from "../src/lib/phone.js";
import { BackgroundTaskRunner } from "../src/lib/tasks.js";
import { MockWhatsAppClient } from "../src/whatsapp/mock.js";
import { createTestDb, type TestContext } from "./helpers/db.js";

const logger = createLogger({ LOG_LEVEL: "fatal", isProduction: false, isTest: true });

class StaticKb implements KnowledgeBaseProvider {
  readonly source = "test:kb";
  content = "WiFi password is turquoise-2026.";
  failure: Error | null = null;

  async fetch() {
    if (this.failure) throw this.failure;
    const { createHash } = await import("node:crypto");
    return {
      content: this.content,
      hash: createHash("sha256").update(this.content).digest("hex").slice(0, 16),
      fetchedAt: new Date(),
    };
  }
}

let ctx: TestContext;
let whatsapp: MockWhatsAppClient;
let tasks: BackgroundTaskRunner;
let kbProvider: StaticKb;
let clock: number;

function build(adminPhoneNumbers: string[] = []) {
  whatsapp = new MockWhatsAppClient();
  tasks = new BackgroundTaskRunner(logger);
  kbProvider = new StaticKb();
  clock = 1_000_000;

  const worker = new BroadcastWorker({
    broadcasts: ctx.repos.broadcasts,
    guests: ctx.repos.guests,
    whatsapp,
    logger,
    concurrency: 4,
    maxAttempts: 2,
    sleep: async () => {},
  });

  return new AdminCommandService({
    guests: ctx.repos.guests,
    usage: ctx.repos.usage,
    broadcasts: new BroadcastService(ctx.repos.guests, ctx.repos.broadcasts),
    worker,
    knowledgeBase: new KnowledgeService({
      provider: kbProvider,
      repository: ctx.repos.knowledge,
      logger,
    }),
    tasks,
    logger,
    adminPhoneNumbers,
    llm: { provider: "mock", model: "mock-1" },
    now: () => clock,
  });
}

function seed() {
  const admin = ctx.repos.guests.upsert({
    phone: normalizePhone("+447700900010"),
    name: "Sofia Marsh",
    role: "admin",
  });
  const guest = ctx.repos.guests.upsert({
    phone: normalizePhone("+447700900001"),
    name: "Priya Patel",
  });
  return { admin, guest };
}

beforeEach(() => (ctx = createTestDb()));
afterEach(() => ctx.close());

// --- parsing ---------------------------------------------------------------

describe("parseCommand", () => {
  it("recognises a command line", () => {
    expect(looksLikeCommand("!help")).toBe(true);
    expect(looksLikeCommand("  !help")).toBe(true);
    expect(looksLikeCommand("what's the wifi?")).toBe(false);
  });

  it("returns null for ordinary messages", () => {
    expect(parseCommand("what time is the boat?")).toBeNull();
  });

  it("splits the command from its arguments", () => {
    const parsed = parseCommand("!add +447700900123 Priya Patel");
    expect(parsed).toMatchObject({ name: "add", args: ["+447700900123", "Priya", "Patel"] });
  });

  it("keeps the broadcast body intact, punctuation and all", () => {
    const parsed = parseCommand("!broadcast Boat departs in 90 minutes. Meet at the jetty!");
    expect(parsed && !isUnknown(parsed) && parsed.rest).toBe(
      "Boat departs in 90 minutes. Meet at the jetty!",
    );
  });

  it("is case-insensitive about the command word", () => {
    expect(parseCommand("!HELP")).toMatchObject({ name: "help" });
  });

  it("flags an unknown command rather than forwarding it to the model", () => {
    const parsed = parseCommand("!brodcast hello");
    expect(parsed && isUnknown(parsed)).toBe(true);
  });

  it("suggests the closest command for a typo", () => {
    expect(suggestCommand("brodcast")).toBe("broadcast");
    expect(suggestCommand("gusts")).toBe("guests");
    // Not a typo of anything — better to say nothing than to guess wildly.
    expect(suggestCommand("xyzzy")).toBeNull();
  });
});

// --- authorisation ---------------------------------------------------------

describe("authorisation", () => {
  it("grants access by role", () => {
    const { admin } = seed();
    expect(build().isAdmin(admin)).toBe(true);
  });

  it("grants access by configured phone number", () => {
    const { guest } = seed();
    expect(build([guest.phone]).isAdmin(guest)).toBe(true);
  });

  it("refuses an ordinary guest", async () => {
    const { guest } = seed();
    const service = build();

    expect(service.isAdmin(guest)).toBe(false);
    const reply = await service.execute(guest, "!guests");

    // Deliberately vague — a guest should not learn the command surface.
    expect(reply).not.toContain("!add");
    expect(reply).toContain("question about the villa");
  });

  it("does not let a non-admin send a broadcast", async () => {
    const { guest } = seed();
    const service = build();

    await service.execute(guest, "!broadcast everyone to the jetty");
    await service.execute(guest, "!confirm");
    await tasks.drain();

    expect(whatsapp.sent).toHaveLength(0);
    expect(ctx.repos.broadcasts.list()).toHaveLength(0);
  });
});

// --- guest management ------------------------------------------------------

describe("guest commands", () => {
  it("adds a guest", async () => {
    const { admin } = seed();
    const reply = await build().execute(admin, "!add +447700900123 Marcus Bell");

    expect(reply).toContain("Added Marcus Bell");
    expect(ctx.repos.guests.findByPhone("+447700900123")?.name).toBe("Marcus Bell");
  });

  it("reactivates a previously removed guest", async () => {
    const { admin, guest } = seed();
    const service = build();

    await service.execute(admin, `!remove ${guest.phone}`);
    expect(ctx.repos.guests.isAuthorized(guest.phone)).toBe(false);

    const reply = await service.execute(admin, `!add ${guest.phone} Priya Patel`);
    expect(reply).toContain("reactivated");
    expect(ctx.repos.guests.isAuthorized(guest.phone)).toBe(true);
  });

  it("rejects a malformed number with guidance", async () => {
    const { admin } = seed();
    const reply = await build().execute(admin, "!add 07700900123 Marcus");
    expect(reply).toContain("international format");
  });

  it("requires a name", async () => {
    const { admin } = seed();
    expect(await build().execute(admin, "!add +447700900123")).toContain("include a name");
  });

  it("reports removing someone who is not on the list", async () => {
    const { admin } = seed();
    expect(await build().execute(admin, "!remove +447700900999")).toContain("not on the guest list");
  });

  it("lists active guests and marks admins", async () => {
    const { admin } = seed();
    const reply = await build().execute(admin, "!guests");

    expect(reply).toContain("Sofia Marsh (admin)");
    expect(reply).toContain("Priya Patel");
  });
});

// --- broadcast confirmation -------------------------------------------------

describe("broadcast confirmation", () => {
  it("stages rather than sending immediately", async () => {
    const { admin } = seed();
    const service = build();

    const reply = await service.execute(admin, "!broadcast Boat departs in 90 minutes.");
    await tasks.drain();

    expect(reply).toContain("Ready to send to 2 guests");
    expect(reply).toContain("!confirm");
    // The whole point: a mistyped announcement reaches nobody yet.
    expect(whatsapp.sent).toHaveLength(0);
  });

  it("sends only after an explicit confirm", async () => {
    const { admin } = seed();
    const service = build();

    await service.execute(admin, "!broadcast Boat departs in 90 minutes.");
    const reply = await service.execute(admin, "!confirm");
    await tasks.drain();

    expect(reply).toContain("Sending to 2 guests");
    expect(whatsapp.sent).toHaveLength(2);
  });

  it("personalises the staged preview", async () => {
    const { admin } = seed();
    const reply = await build().execute(admin, "!broadcast Hi {first_name}!");
    expect(reply).toMatch(/"Hi \w+!"/);
  });

  it("discards on cancel", async () => {
    const { admin } = seed();
    const service = build();

    await service.execute(admin, "!broadcast Boat departs in 90 minutes.");
    expect(await service.execute(admin, "!cancel")).toContain("discarded");

    expect(await service.execute(admin, "!confirm")).toContain("Nothing is staged");
    await tasks.drain();
    expect(whatsapp.sent).toHaveLength(0);
  });

  it("expires a stale confirmation instead of sending it", async () => {
    const { admin } = seed();
    const service = build();

    await service.execute(admin, "!broadcast Boat departs in 90 minutes.");
    clock += CONFIRMATION_TTL_MS + 1;

    // Confirming an hour later could send something no longer true.
    const reply = await service.execute(admin, "!confirm");
    await tasks.drain();

    expect(reply).toContain("expired");
    expect(whatsapp.sent).toHaveLength(0);
  });

  it("keeps each admin's staged message separate", async () => {
    const { admin } = seed();
    const second = ctx.repos.guests.upsert({
      phone: normalizePhone("+447700900011"),
      name: "Deniz Yilmaz",
      role: "admin",
    });
    const service = build();

    await service.execute(admin, "!broadcast From Sofia");
    expect(await service.execute(second, "!confirm")).toContain("Nothing is staged");
  });

  it("refuses an empty announcement", async () => {
    const { admin } = seed();
    expect(await build().execute(admin, "!broadcast")).toContain("Usage:");
  });

  it("reports when there is nobody to send to", async () => {
    const admin = ctx.repos.guests.upsert({
      phone: normalizePhone("+447700900010"),
      name: "Sofia",
      role: "admin",
    });
    ctx.repos.guests.deactivate(admin.phone);

    expect(await build().execute(admin, "!broadcast hello")).toContain("no active guests");
  });
});

// --- other commands --------------------------------------------------------

describe("status and refresh", () => {
  it("reports system status", async () => {
    const { admin } = seed();
    const reply = await build().execute(admin, "!status");

    expect(reply).toContain("2 active");
    expect(reply).toContain("mock / mock-1");
  });

  it("refreshes the knowledge base", async () => {
    const { admin } = seed();
    const service = build();

    expect(await service.execute(admin, "!refresh")).toContain("updated");
    // Unchanged content should say so rather than claim an update.
    expect(await service.execute(admin, "!refresh")).toContain("already up to date");
  });

  it("reports a refresh failure without throwing", async () => {
    const { admin } = seed();
    const service = build();
    kbProvider.failure = new Error("notion is down");

    expect(await service.execute(admin, "!refresh")).toContain("notion is down");
  });
});

// --- routing ---------------------------------------------------------------

describe("RoutingHandler", () => {
  it("sends a command to the command service, never to the model", async () => {
    const { admin } = seed();
    let modelCalls = 0;
    const routing = new RoutingHandler(build(), {
      handle: async () => {
        modelCalls++;
        return "model answer";
      },
    });

    const reply = await routing.handle({ guest: admin, body: "!help", messageSid: "SM1" });

    expect(modelCalls).toBe(0);
    expect(reply).toContain("!broadcast");
  });

  it("sends an ordinary question to the model", async () => {
    const { guest } = seed();
    const routing = new RoutingHandler(build(), { handle: async () => "model answer" });

    expect(await routing.handle({ guest, body: "what's the wifi?", messageSid: "SM1" })).toBe(
      "model answer",
    );
  });

  it("routes an unknown command to the command service, not the model", async () => {
    const { admin } = seed();
    let modelCalls = 0;
    const routing = new RoutingHandler(build(), {
      handle: async () => {
        modelCalls++;
        return "model answer";
      },
    });

    // Otherwise the model would answer "!brodcast" conversationally and nothing
    // would ever be sent.
    const reply = await routing.handle({ guest: admin, body: "!brodcast hi", messageSid: "SM1" });

    expect(modelCalls).toBe(0);
    expect(reply).toContain("Did you mean !broadcast?");
  });
});
