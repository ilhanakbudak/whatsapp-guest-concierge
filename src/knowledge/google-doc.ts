import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
// Per-API package — see the note in src/calendar/google.ts.
import { auth, docs, type docs_v1 } from "@googleapis/docs";
import { UpstreamError } from "../lib/errors.js";
import type { KnowledgeBaseProvider, KnowledgeBaseSnapshot } from "./types.js";

const SCOPES = ["https://www.googleapis.com/auth/documents.readonly"];

export interface GoogleDocOptions {
  documentId: string;
  serviceAccountFile?: string | undefined;
  serviceAccountJson?: string | undefined;
  api?: Pick<docs_v1.Docs, "documents">;
}

/** Google's heading style names mapped to Markdown levels. */
const HEADING_LEVELS: Record<string, string> = {
  TITLE: "#",
  SUBTITLE: "##",
  HEADING_1: "#",
  HEADING_2: "##",
  HEADING_3: "###",
  HEADING_4: "####",
  HEADING_5: "#####",
  HEADING_6: "######",
};

/**
 * Renders a Google Doc to Markdown.
 *
 * The same service account that reads the calendar can read the doc, so a team
 * already set up for the calendar has nothing extra to configure beyond sharing
 * the document with it.
 */
export class GoogleDocKnowledgeBase implements KnowledgeBaseProvider {
  readonly source: string;
  private readonly api: Pick<docs_v1.Docs, "documents">;

  constructor(private readonly options: GoogleDocOptions) {
    this.source = `google-doc:${options.documentId}`;

    if (options.api) {
      this.api = options.api;
      return;
    }

    const raw = options.serviceAccountJson
      ? options.serviceAccountJson
      : options.serviceAccountFile
        ? readFileSync(options.serviceAccountFile, "utf-8")
        : null;

    if (!raw) {
      throw new Error(
        "Google Docs needs GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE",
      );
    }

    const key = JSON.parse(raw) as { client_email: string; private_key: string };

    this.api = docs({
      version: "v1",
      auth: new auth.JWT({
        email: key.client_email,
        key: key.private_key.replace(/\\n/g, "\n"),
        scopes: SCOPES,
      }),
    });
  }

  async fetch(): Promise<KnowledgeBaseSnapshot> {
    let content: string;

    try {
      const response = await this.api.documents.get({ documentId: this.options.documentId });
      content = renderBody(response.data.body?.content ?? [])
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    } catch (err) {
      throw toUpstreamError(err);
    }

    return {
      content,
      hash: createHash("sha256").update(content).digest("hex").slice(0, 16),
      fetchedAt: new Date(),
    };
  }
}

function renderBody(elements: docs_v1.Schema$StructuralElement[]): string[] {
  const lines: string[] = [];

  for (const element of elements) {
    if (element.paragraph) {
      const line = renderParagraph(element.paragraph);
      if (line !== null) lines.push(line);
      continue;
    }

    if (element.table) {
      for (const row of element.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((cell) =>
          renderBody(cell.content ?? [])
            .join(" ")
            .trim(),
        );
        lines.push(`| ${cells.join(" | ")} |`);
      }
      lines.push("");
      continue;
    }

    // A generated table of contents is navigation, not information — it would
    // cost tokens to duplicate the headings that follow it.
  }

  return lines;
}

function renderParagraph(paragraph: docs_v1.Schema$Paragraph): string | null {
  const text = (paragraph.elements ?? [])
    .map((element) => element.textRun?.content ?? "")
    .join("")
    // Google encodes a soft line break (shift+enter) as a vertical tab.
    .replace(/\v/g, " ")
    .trimEnd();

  if (!text.trim()) return "";

  const style = paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";
  const heading = HEADING_LEVELS[style];
  if (heading) return `\n${heading} ${text.trim()}`;

  // A paragraph carrying a bullet belongs to a list; the nesting level comes
  // from the bullet, not from the text.
  if (paragraph.bullet) {
    const depth = paragraph.bullet.nestingLevel ?? 0;
    return `${"  ".repeat(depth)}- ${text.trim()}`;
  }

  return text.trim();
}

function toUpstreamError(err: unknown): UpstreamError {
  const apiError = err as { code?: number; status?: number; message?: string };
  const status = apiError.code ?? apiError.status;

  const hint =
    status === 404
      ? " (check GOOGLE_DOC_ID)"
      : status === 403
        ? " (share the document with the service account email)"
        : "";

  return new UpstreamError(
    "google-docs",
    `${apiError.message ?? "request failed"}${hint}`,
    status === 429 || (status !== undefined && status >= 500),
    err,
  );
}
