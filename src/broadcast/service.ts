import type { BroadcastsRepository, GuestsRepository } from "../db/repositories/index.js";
import type { Broadcast, Guest } from "../db/types.js";
import { ValidationError } from "../lib/errors.js";
import { maskPhone } from "../lib/phone.js";
import { renderBroadcast, usedPlaceholders } from "./render.js";

/** WhatsApp's own limit is far higher, but an announcement this long is a mistake. */
export const MAX_BROADCAST_LENGTH = 1500;

export interface BroadcastPreview {
  recipientCount: number;
  placeholders: string[];
  /** A handful of rendered examples, with phone numbers masked. */
  samples: Array<{ name: string; phone: string; body: string }>;
  warnings: string[];
}

export interface CreateBroadcastOptions {
  body: string;
  createdBy: string;
}

export class BroadcastService {
  constructor(
    private readonly guests: GuestsRepository,
    private readonly broadcasts: BroadcastsRepository,
  ) {}

  private validate(body: string): string {
    const trimmed = body.trim();

    if (!trimmed) throw new ValidationError("A broadcast needs a message body");
    if (trimmed.length > MAX_BROADCAST_LENGTH) {
      throw new ValidationError(
        `Message is ${trimmed.length} characters; the limit is ${MAX_BROADCAST_LENGTH}`,
      );
    }

    return trimmed;
  }

  /**
   * Dry run. Sending a message to every guest at once is not undoable, so the
   * dashboard shows exactly who would receive what before anything is queued.
   */
  preview(body: string): BroadcastPreview {
    const trimmed = this.validate(body);
    const recipients = this.guests.list({ activeOnly: true });
    const warnings: string[] = [];

    if (recipients.length === 0) {
      warnings.push("No active guests — this broadcast would reach nobody.");
    }

    const unknownTokens = [...trimmed.matchAll(/\{(\w+)\}/g)]
      .map((match) => `{${match[1]}}`)
      .filter((token) => !usedPlaceholders(token).length);

    if (unknownTokens.length > 0) {
      // A typo'd placeholder would otherwise be sent verbatim to every guest.
      warnings.push(
        `Unrecognised placeholder(s) will be sent as-is: ${[...new Set(unknownTokens)].join(", ")}`,
      );
    }

    return {
      recipientCount: recipients.length,
      placeholders: usedPlaceholders(trimmed),
      samples: recipients.slice(0, 3).map((guest) => ({
        name: guest.name,
        phone: maskPhone(guest.phone),
        body: renderBroadcast(trimmed, guest),
      })),
      warnings,
    };
  }

  /** Queues a broadcast to every active guest. Does not send — the worker does. */
  create(options: CreateBroadcastOptions): { broadcast: Broadcast; recipients: Guest[] } {
    const body = this.validate(options.body);
    const recipients = this.guests.list({ activeOnly: true });

    if (recipients.length === 0) {
      throw new ValidationError("There are no active guests to send to");
    }

    const broadcast = this.broadcasts.create({
      body,
      createdBy: options.createdBy,
      recipients: recipients.map((guest) => ({ guestId: guest.id, phone: guest.phone })),
    });

    return { broadcast, recipients };
  }
}
