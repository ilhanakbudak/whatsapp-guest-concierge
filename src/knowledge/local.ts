import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeBaseProvider, KnowledgeBaseSnapshot } from "./types.js";

/**
 * Reads Markdown files from a directory, concatenated in filename order — hence
 * the numeric prefixes on the sample files, which give the team explicit control
 * over what the model reads first.
 */
export class LocalMarkdownKnowledgeBase implements KnowledgeBaseProvider {
  readonly source: string;

  constructor(private readonly directory: string) {
    this.source = `local:${directory}`;
  }

  async fetch(): Promise<KnowledgeBaseSnapshot> {
    let files: string[];
    try {
      files = (await readdir(this.directory)).filter((f) => f.endsWith(".md")).sort();
    } catch {
      // A missing directory is not fatal — the bot still answers schedule
      // questions, it just has no house information.
      files = [];
    }

    const parts = await Promise.all(
      files.map((file) => readFile(join(this.directory, file), "utf-8")),
    );
    const content = parts.join("\n\n").trim();

    return {
      content,
      hash: createHash("sha256").update(content).digest("hex").slice(0, 16),
      fetchedAt: new Date(),
    };
  }
}
