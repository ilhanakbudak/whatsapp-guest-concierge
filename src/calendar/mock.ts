import { DEMO_ITINERARY, type DemoEventSeed } from "../demo/dataset.js";
import { addDaysZoned, fromZonedTime, zonedParts, zonedStartOfDay } from "../lib/datetime.js";
import type { CalendarClient, CalendarEvent, EventQuery } from "./types.js";

export interface MockCalendarOptions {
  timeZone: string;
  seeds?: DemoEventSeed[];
  /** Injectable so tests get a stable "today". */
  now?: () => Date;
}

/**
 * Builds the demo itinerary relative to the current day, so the schedule is
 * never stale — a fixture with hard-coded dates would answer "what's on
 * tomorrow?" with nothing a week after it was written.
 */
export class MockCalendarClient implements CalendarClient {
  private readonly timeZone: string;
  private readonly seeds: DemoEventSeed[];
  private readonly now: () => Date;

  /** Set to make the next call throw, for exercising failure handling. */
  private failure: Error | null = null;

  constructor(options: MockCalendarOptions) {
    this.timeZone = options.timeZone;
    this.seeds = options.seeds ?? DEMO_ITINERARY;
    this.now = options.now ?? (() => new Date());
  }

  async listEvents(query: EventQuery): Promise<CalendarEvent[]> {
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }

    return this.materialise()
      .filter((event) => event.start < query.to && event.end > query.from)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  failNextWith(error: Error): void {
    this.failure = error;
  }

  private materialise(): CalendarEvent[] {
    const today = zonedStartOfDay(this.now(), this.timeZone);

    return this.seeds.map((seed, index) => {
      const day = addDaysZoned(today, seed.dayOffset, this.timeZone);
      const p = zonedParts(day, this.timeZone);

      if (!seed.start) {
        return {
          id: `demo-${index}`,
          title: seed.title,
          start: fromZonedTime(this.timeZone, p.year, p.month, p.day),
          end: fromZonedTime(this.timeZone, p.year, p.month, p.day + 1),
          allDay: true,
          ...(seed.location ? { location: seed.location } : {}),
          ...(seed.description ? { description: seed.description } : {}),
        };
      }

      const [startHour, startMinute] = seed.start.split(":").map(Number);
      const start = fromZonedTime(this.timeZone, p.year, p.month, p.day, startHour, startMinute);

      const end = seed.end
        ? (() => {
            const [h, m] = seed.end!.split(":").map(Number);
            return fromZonedTime(this.timeZone, p.year, p.month, p.day, h, m);
          })()
        : new Date(start.getTime() + 3_600_000);

      return {
        id: `demo-${index}`,
        title: seed.title,
        start,
        end,
        allDay: false,
        ...(seed.location ? { location: seed.location } : {}),
        ...(seed.description ? { description: seed.description } : {}),
      };
    });
  }
}
