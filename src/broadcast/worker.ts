import type { BroadcastsRepository, GuestsRepository } from "../db/repositories/index.js";
import type { RecipientStatus } from "../db/types.js";
import type { Logger } from "../lib/logger.js";
import { normalizePhone } from "../lib/phone.js";
import { WhatsAppSendError, type WhatsAppClient } from "../whatsapp/types.js";
import { renderBroadcast } from "./render.js";

export interface BroadcastRunResult {
  broadcastId: number;
  sent: number;
  failed: number;
  counts: Record<RecipientStatus, number>;
}

export interface BroadcastWorkerOptions {
  broadcasts: BroadcastsRepository;
  guests: GuestsRepository;
  whatsapp: WhatsAppClient;
  logger: Logger;
  concurrency: number;
  maxAttempts: number;
  /** Where Twilio should report delivery. Omitted when there is no public URL. */
  statusCallbackUrl?: string;
  /** Injected in tests so backoff doesn't actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Drains a broadcast's recipient rows.
 *
 * The alternative — `await Promise.all(guests.map(send))` — looks fine until
 * Twilio rate-limits halfway through and nobody can tell which of twelve guests
 * actually heard that the boat leaves in ninety minutes. Here every recipient is
 * a row with its own status, attempt count and error, so a partial failure is
 * visible, re-runnable, and safe across a restart.
 */
export class BroadcastWorker {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly active = new Set<number>();

  constructor(private readonly options: BroadcastWorkerOptions) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  async run(broadcastId: number): Promise<BroadcastRunResult> {
    const { broadcasts, logger } = this.options;

    if (this.active.has(broadcastId)) {
      // Two concurrent runs would fight over the same rows. The claim is atomic
      // so it would still be safe, but this keeps the logs honest.
      logger.warn({ broadcastId }, "broadcast already running");
      return this.result(broadcastId, 0, 0);
    }

    this.active.add(broadcastId);
    broadcasts.setStatus(broadcastId, "running");

    let sent = 0;
    let failed = 0;
    let pass = 0;

    try {
      for (;;) {
        const batch = broadcasts.claimQueued(broadcastId, this.options.concurrency);
        if (batch.length === 0) break;

        let requeued = 0;

        await Promise.all(
          batch.map(async (recipient) => {
            const guest = this.options.guests.findById(recipient.guestId);
            const broadcast = broadcasts.findById(broadcastId);
            if (!broadcast) return;

            const body = guest
              ? renderBroadcast(broadcast.body, guest)
              : broadcast.body;

            try {
              const result = await this.options.whatsapp.send({
                to: normalizePhone(recipient.phone),
                body,
                ...(this.options.statusCallbackUrl
                  ? { statusCallbackUrl: this.options.statusCallbackUrl }
                  : {}),
              });

              broadcasts.markSent(recipient.id, result.sid);
              sent++;
            } catch (err) {
              const sendError =
                err instanceof WhatsAppSendError
                  ? err
                  : new WhatsAppSendError(String(err), null, false);

              const exhausted = recipient.attempts >= this.options.maxAttempts;

              if (sendError.retryable && !exhausted) {
                broadcasts.requeue(recipient.id);
                requeued++;
                return;
              }

              broadcasts.markFailed(
                recipient.id,
                sendError.code,
                // The session-window failure is the one the team will actually
                // hit, so name it in terms they can act on.
                sendError.isSessionWindowError
                  ? "Outside the 24-hour window — this guest must message the bot first"
                  : sendError.message,
              );
              failed++;
            }
          }),
        );

        if (requeued > 0) {
          pass++;
          // Exponential backoff between passes, so a rate limit isn't met with
          // an immediate identical burst.
          const delay = Math.min(2 ** (pass - 1) * 1000, 30_000);
          logger.info({ broadcastId, requeued, delay }, "backing off before retry pass");
          await this.sleep(delay);
        }
      }

      const summary = broadcasts.summary(broadcastId);
      const allResolved = (summary?.counts.queued ?? 0) === 0;
      broadcasts.setStatus(
        broadcastId,
        allResolved && failed > 0 && sent === 0 ? "failed" : "completed",
      );

      logger.info({ broadcastId, sent, failed }, "broadcast finished");
      return this.result(broadcastId, sent, failed);
    } finally {
      this.active.delete(broadcastId);
    }
  }

  /**
   * Picks up broadcasts interrupted by a restart.
   *
   * Rows stranded mid-send are returned to the queue first: the process died
   * before it learned whether Twilio accepted them, and a duplicate
   * announcement is a far smaller problem than a guest never hearing that the
   * boat is leaving.
   */
  async resumeInterrupted(): Promise<number[]> {
    const resumable = this.options.broadcasts.findResumable();
    if (resumable.length === 0) return [];

    this.options.logger.warn(
      { broadcasts: resumable.map((b) => b.id) },
      "resuming broadcasts interrupted by a restart",
    );

    for (const broadcast of resumable) {
      for (const recipient of this.options.broadcasts.recipients(broadcast.id)) {
        if (recipient.status === "sending") {
          this.options.broadcasts.requeue(recipient.id);
        }
      }
    }

    for (const broadcast of resumable) {
      await this.run(broadcast.id);
    }

    return resumable.map((b) => b.id);
  }

  private result(broadcastId: number, sent: number, failed: number): BroadcastRunResult {
    const summary = this.options.broadcasts.summary(broadcastId);
    return {
      broadcastId,
      sent,
      failed,
      counts:
        summary?.counts ??
        ({
          queued: 0,
          sending: 0,
          sent: 0,
          delivered: 0,
          read: 0,
          failed: 0,
          undelivered: 0,
        } satisfies Record<RecipientStatus, number>),
    };
  }
}
