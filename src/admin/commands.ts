import type { BroadcastService } from "../broadcast/service.js";
import type { BroadcastWorker } from "../broadcast/worker.js";
import type { GuestsRepository, UsageRepository } from "../db/repositories/index.js";
import type { Guest } from "../db/types.js";
import type { KnowledgeService } from "../knowledge/service.js";
import { errorMessage } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { normalizePhone, tryNormalizePhone } from "../lib/phone.js";
import type { TaskRunner } from "../lib/tasks.js";
import { isUnknown, parseCommand, suggestCommand } from "./parse.js";

/** How long a staged broadcast waits for confirmation before expiring. */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

interface StagedBroadcast {
  body: string;
  recipientCount: number;
  stagedAt: number;
}

export interface AdminCommandOptions {
  guests: GuestsRepository;
  usage: UsageRepository;
  broadcasts: BroadcastService;
  worker: BroadcastWorker;
  knowledgeBase: KnowledgeService;
  tasks: TaskRunner;
  logger: Logger;
  /** Numbers granted admin rights by configuration, in addition to role=admin. */
  adminPhoneNumbers: string[];
  llm: { provider: string; model: string };
  now?: () => number;
}

const HELP = [
  "Admin commands",
  "",
  "!status              system health at a glance",
  "!guests              list active guests",
  "!add <number> <name> add or reactivate a guest",
  "!remove <number>     deactivate a guest",
  "!refresh             reload the house information now",
  "!broadcast <message> stage an announcement (asks you to confirm)",
  "!confirm             send the staged announcement",
  "!cancel              discard the staged announcement",
  "!help                this message",
].join("\n");

/**
 * Runs admin commands sent over WhatsApp.
 *
 * The team runs a holiday from a boat, not a laptop, so the important operations
 * are reachable by text. That makes an accidental send genuinely dangerous, which
 * is why `!broadcast` stages and waits: a mistyped message reaches nobody until a
 * second, deliberate `!confirm`.
 */
export class AdminCommandService {
  private readonly staged = new Map<string, StagedBroadcast>();
  private readonly now: () => number;

  constructor(private readonly options: AdminCommandOptions) {
    this.now = options.now ?? Date.now;
  }

  isAdmin(guest: Guest): boolean {
    return guest.role === "admin" || this.options.adminPhoneNumbers.includes(guest.phone);
  }

  async execute(guest: Guest, body: string): Promise<string> {
    const parsed = parseCommand(body);
    if (!parsed) return HELP;

    if (!this.isAdmin(guest)) {
      this.options.logger.warn(
        { guestId: guest.id },
        "non-admin attempted an admin command",
      );
      // Deliberately vague: a guest does not need to learn the command surface.
      return "Sorry, I don't recognise that. Ask me a question about the villa instead.";
    }

    if (isUnknown(parsed)) {
      const suggestion = suggestCommand(parsed.attempted);
      return (
        `Unknown command "!${parsed.attempted}".` +
        (suggestion ? ` Did you mean !${suggestion}?` : "") +
        `\n\nSend !help for the full list.`
      );
    }

    switch (parsed.name) {
      case "help":
        return HELP;
      case "status":
        return this.status();
      case "guests":
        return this.listGuests();
      case "add":
        return this.addGuest(parsed.args);
      case "remove":
        return this.removeGuest(parsed.args);
      case "refresh":
        return this.refreshKnowledgeBase();
      case "broadcast":
        return this.stageBroadcast(guest, parsed.rest);
      case "confirm":
        return this.confirmBroadcast(guest);
      case "cancel":
        return this.cancelBroadcast(guest);
    }
  }

  // --- individual commands --------------------------------------------------

  private status(): string {
    const guests = this.options.guests.list({ activeOnly: true });
    const kb = this.options.knowledgeBase.status;
    const usage = this.options.usage.totalsSince(
      new Date(this.now() - 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19),
    );

    return [
      "Status",
      "",
      `Guests: ${guests.length} active`,
      `Knowledge base: ${kb.characters} characters` +
        (kb.fetchedAt ? `, loaded ${formatAge(this.now() - kb.fetchedAt.getTime())} ago` : ", not loaded"),
      kb.lastError ? `  last error: ${kb.lastError}` : null,
      `Assistant: ${this.options.llm.provider} / ${this.options.llm.model}`,
      `Last 24h: ${usage.events} replies, ${Math.round(usage.cacheHitRate * 100)}% of input cached`,
      // filter on null, not Boolean — Boolean would also strip the intentional
      // blank line that separates the heading.
    ]
      .filter((line) => line !== null)
      .join("\n");
  }

  private listGuests(): string {
    const guests = this.options.guests.list({ activeOnly: true });
    if (guests.length === 0) return "No active guests. Add one with !add <number> <name>";

    const lines = guests.map((g) => `${g.name}${g.role === "admin" ? " (admin)" : ""}\n  ${g.phone}`);
    return [`${guests.length} active guest${guests.length === 1 ? "" : "s"}`, "", ...lines].join("\n");
  }

  private addGuest(args: string[]): string {
    const [rawPhone, ...nameParts] = args;
    if (!rawPhone) return "Usage: !add <number> <name>\nExample: !add +447700900123 Priya Patel";

    const phone = tryNormalizePhone(rawPhone);
    if (!phone) {
      return `"${rawPhone}" is not a valid number. Use the international format, e.g. +447700900123`;
    }

    const name = nameParts.join(" ").trim();
    if (!name) return "Please include a name: !add <number> <name>";

    const existing = this.options.guests.findByPhone(phone);
    const guest = this.options.guests.upsert({ phone, name });

    return existing
      ? `Updated ${guest.name} (${guest.phone})${existing.active ? "" : " and reactivated them"}.`
      : `Added ${guest.name} (${guest.phone}). They can message the bot now.`;
  }

  private removeGuest(args: string[]): string {
    const [rawPhone] = args;
    if (!rawPhone) return "Usage: !remove <number>";

    const phone = tryNormalizePhone(rawPhone);
    if (!phone) return `"${rawPhone}" is not a valid number.`;

    const guest = this.options.guests.findByPhone(phone);
    if (!guest) return `${phone} is not on the guest list.`;

    this.options.guests.deactivate(phone);
    // Deactivated, not deleted — their history and delivery records survive.
    return `Removed ${guest.name} (${phone}). They can no longer message the bot.`;
  }

  private async refreshKnowledgeBase(): Promise<string> {
    try {
      const result = await this.options.knowledgeBase.refresh();
      return result.changed
        ? `House information updated — ${result.characters} characters loaded.`
        : `House information is already up to date (${result.characters} characters). ` +
            `If you just made an edit, check it was saved.`;
    } catch (err) {
      return `Could not reload the house information: ${errorMessage(err)}`;
    }
  }

  private stageBroadcast(admin: Guest, message: string): string {
    if (!message) {
      return "Usage: !broadcast <message>\nExample: !broadcast Boat departs in 90 minutes.";
    }

    let preview;
    try {
      preview = this.options.broadcasts.preview(message);
    } catch (err) {
      return errorMessage(err);
    }

    if (preview.recipientCount === 0) {
      return "There are no active guests to send to.";
    }

    this.staged.set(admin.phone, {
      body: message,
      recipientCount: preview.recipientCount,
      stagedAt: this.now(),
    });

    const sample = preview.samples[0];

    return [
      `Ready to send to ${preview.recipientCount} guest${preview.recipientCount === 1 ? "" : "s"}:`,
      "",
      sample ? `"${sample.body}"` : `"${message}"`,
      ...(preview.warnings.length > 0 ? ["", ...preview.warnings.map((w) => `Note: ${w}`)] : []),
      "",
      "Reply !confirm to send, or !cancel to discard.",
    ].join("\n");
  }

  private confirmBroadcast(admin: Guest): string {
    const staged = this.staged.get(admin.phone);
    if (!staged) return "Nothing is staged. Use !broadcast <message> first.";

    if (this.now() - staged.stagedAt > CONFIRMATION_TTL_MS) {
      this.staged.delete(admin.phone);
      // Expiry matters: confirming an announcement composed an hour ago could
      // send something no longer true.
      return "That announcement expired. Send !broadcast again to compose a new one.";
    }

    this.staged.delete(admin.phone);

    const { broadcast, recipients } = this.options.broadcasts.create({
      body: staged.body,
      createdBy: `whatsapp:${admin.phone}`,
    });

    this.options.tasks.run(`broadcast-${broadcast.id}`, async () => {
      await this.options.worker.run(broadcast.id);
    });

    return `Sending to ${recipients.length} guest${recipients.length === 1 ? "" : "s"} now.`;
  }

  private cancelBroadcast(admin: Guest): string {
    return this.staged.delete(admin.phone)
      ? "Announcement discarded."
      : "Nothing was staged.";
  }
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export { HELP as ADMIN_HELP, normalizePhone };
