import type { CalendarClient, CalendarEvent, EventQuery } from "./types.js";

export interface CachedCalendarOptions {
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  events: CalendarEvent[];
  expiresAt: number;
}

/**
 * Short-lived cache in front of the calendar.
 *
 * The requirement is that a change made an hour before a boat departure is
 * reflected immediately, so the TTL is deliberately tiny — this exists to absorb
 * a burst of guests all asking about the same afternoon within a few seconds of
 * each other, not to avoid calling Google.
 */
export class CachedCalendarClient implements CalendarClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly inner: CalendarClient,
    options: CachedCalendarOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  async listEvents(query: EventQuery): Promise<CalendarEvent[]> {
    const key = `${query.from.toISOString()}|${query.to.toISOString()}`;
    const now = this.now();

    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.events;
    }

    const events = await this.inner.listEvents(query);
    this.cache.set(key, { events, expiresAt: now + this.ttlMs });

    // The window shifts constantly (it is derived from "now"), so old keys are
    // dead weight rather than future hits.
    for (const [existingKey, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(existingKey);
    }

    return events;
  }

  invalidate(): void {
    this.cache.clear();
  }
}
