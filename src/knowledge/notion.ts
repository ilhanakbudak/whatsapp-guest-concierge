import { createHash } from "node:crypto";
import { Client, isFullBlock } from "@notionhq/client";
import type {
  BlockObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import { UpstreamError } from "../lib/errors.js";
import type { KnowledgeBaseProvider, KnowledgeBaseSnapshot } from "./types.js";

export interface NotionOptions {
  apiKey: string;
  pageId: string;
  /** How deep to follow nested blocks. Guards against a pathological page. */
  maxDepth?: number;
  client?: Pick<Client, "blocks">;
}

/**
 * Renders a Notion page to Markdown.
 *
 * Markdown rather than Notion's JSON because the result is pasted straight into
 * the system prompt: headings and lists survive as structure the model reads,
 * at a fraction of the tokens the block objects would cost.
 */
export class NotionKnowledgeBase implements KnowledgeBaseProvider {
  readonly source: string;

  private readonly client: Pick<Client, "blocks">;
  private readonly maxDepth: number;

  constructor(private readonly options: NotionOptions) {
    this.source = `notion:${options.pageId}`;
    this.maxDepth = options.maxDepth ?? 4;
    this.client = options.client ?? new Client({ auth: options.apiKey });
  }

  async fetch(): Promise<KnowledgeBaseSnapshot> {
    let content: string;
    try {
      const lines = await this.renderChildren(this.options.pageId, 0);
      content = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    } catch (err) {
      throw toUpstreamError(err);
    }

    return {
      content,
      hash: createHash("sha256").update(content).digest("hex").slice(0, 16),
      fetchedAt: new Date(),
    };
  }

  private async renderChildren(blockId: string, depth: number): Promise<string[]> {
    if (depth > this.maxDepth) return [];

    const lines: string[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });

      for (const block of response.results) {
        if (!isFullBlock(block)) continue;
        lines.push(...(await this.renderBlock(block, depth)));
      }

      cursor = response.next_cursor ?? undefined;
    } while (cursor);

    return lines;
  }

  private async renderBlock(block: BlockObjectResponse, depth: number): Promise<string[]> {
    const indent = "  ".repeat(Math.max(0, depth));
    const nested = block.has_children ? await this.renderChildren(block.id, depth + 1) : [];

    switch (block.type) {
      case "heading_1":
        return [`\n# ${text(block.heading_1.rich_text)}`, ...nested];
      case "heading_2":
        return [`\n## ${text(block.heading_2.rich_text)}`, ...nested];
      case "heading_3":
        return [`\n### ${text(block.heading_3.rich_text)}`, ...nested];
      case "paragraph": {
        const body = text(block.paragraph.rich_text);
        return body ? [body, ...nested] : nested;
      }
      case "bulleted_list_item":
        return [`${indent}- ${text(block.bulleted_list_item.rich_text)}`, ...nested];
      case "numbered_list_item":
        return [`${indent}1. ${text(block.numbered_list_item.rich_text)}`, ...nested];
      case "to_do":
        return [
          `${indent}- [${block.to_do.checked ? "x" : " "}] ${text(block.to_do.rich_text)}`,
          ...nested,
        ];
      case "quote":
        return [`> ${text(block.quote.rich_text)}`, ...nested];
      case "callout":
        return [`> ${text(block.callout.rich_text)}`, ...nested];
      case "toggle":
        return [`**${text(block.toggle.rich_text)}**`, ...nested];
      case "code":
        return [
          "```" + (block.code.language ?? ""),
          text(block.code.rich_text),
          "```",
          ...nested,
        ];
      case "divider":
        return ["\n---\n"];
      case "table":
        // Rows arrive as children; renderRow handles the cells.
        return nested;
      case "table_row":
        return [
          `| ${block.table_row.cells.map((cell) => text(cell)).join(" | ")} |`,
        ];
      case "child_page":
        return [`\n## ${block.child_page.title}`, ...nested];
      default:
        // Unknown or non-textual block (image, embed, breadcrumb...). Skipping is
        // correct: the bot cannot read an image to a guest over WhatsApp.
        return nested;
    }
  }
}

/** Notion splits styled runs into separate items; concatenate the plain text. */
function text(richText: RichTextItemResponse[]): string {
  return richText
    .map((item) => item.plain_text)
    .join("")
    .trim();
}

function toUpstreamError(err: unknown): UpstreamError {
  const status = (err as { status?: number }).status;
  const message = (err as Error).message ?? "request failed";

  const hint =
    status === 404
      ? " (check NOTION_PAGE_ID, and that the page is shared with your integration)"
      : status === 401
        ? " (check NOTION_API_KEY)"
        : "";

  return new UpstreamError(
    "notion",
    `${message}${hint}`,
    status === 429 || (status !== undefined && status >= 500),
    err,
  );
}
