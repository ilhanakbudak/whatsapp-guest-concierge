import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleDocKnowledgeBase } from "../src/knowledge/google-doc.js";
import { LocalMarkdownKnowledgeBase } from "../src/knowledge/local.js";
import { NotionKnowledgeBase } from "../src/knowledge/notion.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { scheduleKnowledgeRefresh } from "../src/knowledge/schedule.js";
import type { KnowledgeBaseProvider } from "../src/knowledge/types.js";
import { UpstreamError } from "../src/lib/errors.js";
import { createLogger } from "../src/lib/logger.js";
import { createTestDb, type TestContext } from "./helpers/db.js";

const logger = createLogger({ LOG_LEVEL: "fatal", isProduction: false, isTest: true });

let ctx: TestContext;
beforeEach(() => (ctx = createTestDb()));
afterEach(() => ctx.close());

// --- Local Markdown ---------------------------------------------------------

describe("LocalMarkdownKnowledgeBase", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "kb-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("concatenates markdown files in filename order", async () => {
    writeFileSync(join(dir, "20-second.md"), "second");
    writeFileSync(join(dir, "10-first.md"), "first");

    const { content } = await new LocalMarkdownKnowledgeBase(dir).fetch();
    // The numeric prefixes are how the team controls what the model reads first.
    expect(content.indexOf("first")).toBeLessThan(content.indexOf("second"));
  });

  it("ignores non-markdown files", async () => {
    writeFileSync(join(dir, "notes.txt"), "should not appear");
    writeFileSync(join(dir, "kb.md"), "should appear");

    const { content } = await new LocalMarkdownKnowledgeBase(dir).fetch();
    expect(content).toBe("should appear");
  });

  it("returns empty rather than throwing when the directory is missing", async () => {
    const { content } = await new LocalMarkdownKnowledgeBase(join(dir, "nope")).fetch();
    expect(content).toBe("");
  });

  it("produces a stable hash for unchanged content", async () => {
    writeFileSync(join(dir, "kb.md"), "stable");
    const kb = new LocalMarkdownKnowledgeBase(dir);

    expect((await kb.fetch()).hash).toBe((await kb.fetch()).hash);
  });

  it("changes the hash when content changes", async () => {
    writeFileSync(join(dir, "kb.md"), "before");
    const kb = new LocalMarkdownKnowledgeBase(dir);
    const first = await kb.fetch();

    writeFileSync(join(dir, "kb.md"), "after");
    expect((await kb.fetch()).hash).not.toBe(first.hash);
  });
});

// --- Notion -----------------------------------------------------------------

function notionBlock(type: string, body: Record<string, unknown>, hasChildren = false) {
  return { object: "block", id: `b-${type}`, type, has_children: hasChildren, ...body };
}
const rt = (text: string) => [{ plain_text: text, type: "text" }];

function notionClient(pages: Array<{ results: unknown[]; next_cursor?: string | null }>) {
  const list = vi.fn();
  for (const page of pages) {
    list.mockResolvedValueOnce({ results: page.results, next_cursor: page.next_cursor ?? null });
  }
  list.mockResolvedValue({ results: [], next_cursor: null });
  return { list, client: { blocks: { children: { list } } } };
}

describe("NotionKnowledgeBase", () => {
  it("renders headings, paragraphs and lists as markdown", async () => {
    const { client } = notionClient([
      {
        results: [
          notionBlock("heading_1", { heading_1: { rich_text: rt("Practical") } }),
          notionBlock("paragraph", { paragraph: { rich_text: rt("The WiFi password is abc.") } }),
          notionBlock("bulleted_list_item", { bulleted_list_item: { rich_text: rt("Shoes off") } }),
          notionBlock("numbered_list_item", { numbered_list_item: { rich_text: rt("Step one") } }),
        ],
      },
    ]);

    const { content } = await new NotionKnowledgeBase({
      apiKey: "k",
      pageId: "p",
      client: client as never,
    }).fetch();

    expect(content).toContain("# Practical");
    expect(content).toContain("The WiFi password is abc.");
    expect(content).toContain("- Shoes off");
    expect(content).toContain("1. Step one");
  });

  it("joins split rich-text runs into one line", async () => {
    // Notion splits styled text into separate runs; naive handling loses words.
    const { client } = notionClient([
      {
        results: [
          notionBlock("paragraph", {
            paragraph: {
              rich_text: [
                { plain_text: "The password is ", type: "text" },
                { plain_text: "turquoise-2026", type: "text" },
              ],
            },
          }),
        ],
      },
    ]);

    const { content } = await new NotionKnowledgeBase({
      apiKey: "k",
      pageId: "p",
      client: client as never,
    }).fetch();

    expect(content).toBe("The password is turquoise-2026");
  });

  it("renders table rows as markdown table lines", async () => {
    const { client } = notionClient([
      {
        results: [
          notionBlock("table_row", { table_row: { cells: [rt("Sofia"), rt("+44 7700 900010")] } }),
        ],
      },
    ]);

    const { content } = await new NotionKnowledgeBase({
      apiKey: "k",
      pageId: "p",
      client: client as never,
    }).fetch();

    expect(content).toBe("| Sofia | +44 7700 900010 |");
  });

  it("follows pagination", async () => {
    const { client, list } = notionClient([
      {
        results: [notionBlock("paragraph", { paragraph: { rich_text: rt("page one") } })],
        next_cursor: "cursor-2",
      },
      { results: [notionBlock("paragraph", { paragraph: { rich_text: rt("page two") } })] },
    ]);

    const { content } = await new NotionKnowledgeBase({
      apiKey: "k",
      pageId: "p",
      client: client as never,
    }).fetch();

    expect(content).toContain("page one");
    expect(content).toContain("page two");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("skips block types it cannot render rather than failing", async () => {
    const { client } = notionClient([
      {
        results: [
          notionBlock("image", { image: {} }),
          notionBlock("paragraph", { paragraph: { rich_text: rt("kept") } }),
        ],
      },
    ]);

    const { content } = await new NotionKnowledgeBase({
      apiKey: "k",
      pageId: "p",
      client: client as never,
    }).fetch();

    expect(content).toBe("kept");
  });

  it("explains a 404 in terms of the likely cause", async () => {
    const list = vi.fn().mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
    const kb = new NotionKnowledgeBase({
      apiKey: "k",
      pageId: "p",
      client: { blocks: { children: { list } } } as never,
    });

    await expect(kb.fetch()).rejects.toThrow(/shared with your integration/);
    await expect(kb.fetch()).rejects.toBeInstanceOf(UpstreamError);
  });
});

// --- Google Docs ------------------------------------------------------------

function docClient(content: unknown[]) {
  const get = vi.fn().mockResolvedValue({ data: { body: { content } } });
  return { get, api: { documents: { get } } };
}

const para = (text: string, style = "NORMAL_TEXT", bullet?: { nestingLevel?: number }) => ({
  paragraph: {
    elements: [{ textRun: { content: text } }],
    paragraphStyle: { namedStyleType: style },
    ...(bullet ? { bullet } : {}),
  },
});

describe("GoogleDocKnowledgeBase", () => {
  it("maps named heading styles to markdown levels", async () => {
    const { api } = docClient([
      para("Villa Handbook", "TITLE"),
      para("Practical", "HEADING_1"),
      para("WiFi", "HEADING_2"),
      para("The password is abc."),
    ]);

    const { content } = await new GoogleDocKnowledgeBase({
      documentId: "d",
      api: api as never,
    }).fetch();

    expect(content).toContain("# Villa Handbook");
    expect(content).toContain("# Practical");
    expect(content).toContain("## WiFi");
    expect(content).toContain("The password is abc.");
  });

  it("renders bullets with their nesting level", async () => {
    const { api } = docClient([
      para("Top", "NORMAL_TEXT", { nestingLevel: 0 }),
      para("Nested", "NORMAL_TEXT", { nestingLevel: 1 }),
    ]);

    const { content } = await new GoogleDocKnowledgeBase({
      documentId: "d",
      api: api as never,
    }).fetch();

    expect(content).toContain("- Top");
    expect(content).toContain("  - Nested");
  });

  it("renders tables as markdown rows", async () => {
    const { api } = docClient([
      {
        table: {
          tableRows: [
            { tableCells: [{ content: [para("Sofia")] }, { content: [para("+44 7700 900010")] }] },
          ],
        },
      },
    ]);

    const { content } = await new GoogleDocKnowledgeBase({
      documentId: "d",
      api: api as never,
    }).fetch();

    expect(content).toContain("| Sofia | +44 7700 900010 |");
  });

  it("converts soft line breaks to spaces", async () => {
    const { api } = docClient([para("line one\vline two")]);

    const { content } = await new GoogleDocKnowledgeBase({
      documentId: "d",
      api: api as never,
    }).fetch();

    expect(content).toBe("line one line two");
  });

  it("points at document sharing on a 403", async () => {
    const get = vi.fn().mockRejectedValue({ code: 403, message: "Forbidden" });
    const kb = new GoogleDocKnowledgeBase({ documentId: "d", api: { documents: { get } } as never });

    await expect(kb.fetch()).rejects.toThrow(/share the document with the service account/);
  });
});

// --- KnowledgeService -------------------------------------------------------

class CountingProvider implements KnowledgeBaseProvider {
  readonly source = "test:kb";
  calls = 0;
  content = "original content";
  failure: Error | null = null;

  async fetch() {
    this.calls++;
    if (this.failure) throw this.failure;
    const { createHash } = await import("node:crypto");
    return {
      content: this.content,
      hash: createHash("sha256").update(this.content).digest("hex").slice(0, 16),
      fetchedAt: new Date(),
    };
  }
}

function service(provider: KnowledgeBaseProvider, now?: () => number) {
  return new KnowledgeService({
    provider,
    repository: ctx.repos.knowledge,
    logger,
    ttlMs: 60_000,
    ...(now ? { now } : {}),
  });
}

describe("KnowledgeService", () => {
  it("fetches once and serves the cached content within the TTL", async () => {
    const provider = new CountingProvider();
    const svc = service(provider, () => 0);

    await svc.getContent();
    await svc.getContent();

    expect(provider.calls).toBe(1);
  });

  it("collapses concurrent refreshes into a single fetch", async () => {
    const provider = new CountingProvider();
    const svc = service(provider);

    await Promise.all([svc.getContent(), svc.getContent(), svc.getContent()]);
    expect(provider.calls).toBe(1);
  });

  it("persists a snapshot on first fetch", async () => {
    const provider = new CountingProvider();
    await service(provider).refresh();

    expect(ctx.repos.knowledge.latest("test:kb")?.rendered).toBe("original content");
  });

  it("does not store a new snapshot when the content is unchanged", async () => {
    const provider = new CountingProvider();
    const svc = service(provider);

    const first = await svc.refresh();
    const second = await svc.refresh();

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    // History records changes, not cron firings.
    expect(ctx.repos.knowledge.history("test:kb")).toHaveLength(1);
  });

  it("stores a new snapshot when the content changes", async () => {
    const provider = new CountingProvider();
    const svc = service(provider);

    await svc.refresh();
    provider.content = "updated content";
    const result = await svc.refresh();

    expect(result.changed).toBe(true);
    expect(ctx.repos.knowledge.history("test:kb")).toHaveLength(2);
    expect(await svc.getContent()).toBe("updated content");
  });

  it("returns the identical string across unchanged refreshes", async () => {
    // Byte-identical content is what keeps the provider-side prompt cache warm;
    // an equivalent-but-new string would silently destroy the hit rate.
    const provider = new CountingProvider();
    const svc = service(provider);

    const first = await svc.getContent();
    await svc.refresh();
    const second = await svc.getContent();

    expect(second).toBe(first);
  });

  it("serves the last known copy when the source goes down", async () => {
    const provider = new CountingProvider();
    const svc = service(provider, (() => {
      let t = 0;
      return () => (t += 120_000);
    })());

    await svc.refresh();
    provider.failure = new Error("notion is down");

    // Better a day-old handbook than telling a guest nothing.
    expect(await svc.getContent()).toBe("original content");
    expect(svc.status.lastError).toContain("notion is down");
  });

  it("recovers a stored snapshot after a restart with a dead source", async () => {
    const seeding = new CountingProvider();
    await service(seeding).refresh();

    // Fresh service, empty memory, failing provider — the store is all it has.
    const dead = new CountingProvider();
    dead.failure = new Error("notion is down");

    expect(await service(dead).getContent()).toBe("original content");
  });

  it("propagates the error when there is no copy to fall back to", async () => {
    const provider = new CountingProvider();
    provider.failure = new Error("notion is down");

    await expect(service(provider).getContent()).rejects.toThrow("notion is down");
  });

  it("reports status for the dashboard", async () => {
    const svc = service(new CountingProvider());
    await svc.refresh();

    expect(svc.status).toMatchObject({ source: "test:kb", characters: 16, lastError: null });
    expect(svc.status.hash).toBeTruthy();
  });

  it("prunes old snapshots", async () => {
    const provider = new CountingProvider();
    const svc = service(provider);

    for (let i = 0; i < 25; i++) {
      provider.content = `revision ${i}`;
      await svc.refresh();
    }

    expect(ctx.repos.knowledge.history("test:kb", 100).length).toBeLessThanOrEqual(20);
  });
});

describe("scheduleKnowledgeRefresh", () => {
  it("rejects an invalid cron expression rather than never running", () => {
    const svc = service(new CountingProvider());
    expect(() => scheduleKnowledgeRefresh(svc, "not a cron", logger)).toThrow(
      /not a valid cron expression/,
    );
  });

  it("accepts a valid expression and can be stopped", () => {
    const svc = service(new CountingProvider());
    const job = scheduleKnowledgeRefresh(svc, "0 4 * * *", logger);
    expect(() => job.stop()).not.toThrow();
  });
});
