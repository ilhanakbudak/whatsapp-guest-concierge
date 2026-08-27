import type { Logger } from "./logger.js";

/**
 * Runs work after the HTTP response has been sent.
 *
 * Twilio retries a webhook that doesn't answer quickly, and an LLM round-trip
 * plus a Twilio send is far too slow to do inline — a slow reply would be
 * delivered twice. So the webhook acknowledges immediately and the actual reply
 * happens here.
 *
 * Tracking the in-flight promises rather than truly forgetting them buys two
 * things: tests can await `drain()` instead of sleeping, and shutdown can finish
 * replies already in progress instead of dropping them.
 */
export interface TaskRunner {
  run(name: string, fn: () => Promise<void>): void;
  drain(): Promise<void>;
  readonly pending: number;
}

export class BackgroundTaskRunner implements TaskRunner {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly logger: Logger) {}

  get pending(): number {
    return this.inFlight.size;
  }

  run(name: string, fn: () => Promise<void>): void {
    const promise = fn()
      .catch((err: unknown) => {
        // A background failure must never take the process down, but it must be
        // loud — this is where a guest silently gets no answer.
        this.logger.error({ err, task: name }, "background task failed");
      })
      .finally(() => {
        this.inFlight.delete(promise);
      });

    this.inFlight.add(promise);
  }

  async drain(): Promise<void> {
    // Tasks can enqueue further tasks, so loop until genuinely empty.
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }
}
