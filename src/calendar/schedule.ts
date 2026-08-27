import {
  addDaysZoned,
  dayKeyToDate,
  zonedEndOfDay,
  zonedStartOfDay,
} from "../lib/datetime.js";
import { ValidationError } from "../lib/errors.js";
import { formatSchedule } from "./format.js";
import type { CalendarClient, CalendarEvent } from "./types.js";

/** The vocabulary the LLM tool accepts. Anything else must be an explicit date. */
export const NAMED_RANGES = ["today", "tomorrow", "this_week", "next_7_days"] as const;
export type NamedRange = (typeof NAMED_RANGES)[number];

export interface ScheduleQuery {
  range?: NamedRange;
  /** `YYYY-MM-DD` in the villa's timezone. Overrides `range` when present. */
  date?: string;
  endDate?: string;
}

export interface ScheduleResult {
  events: CalendarEvent[];
  /** Ready to drop into a prompt. */
  text: string;
  from: Date;
  to: Date;
}

export interface ScheduleServiceOptions {
  timeZone: string;
  now?: () => Date;
  /** Guards against a model asking for a year of events. */
  maxDays?: number;
}

export class ScheduleService {
  private readonly timeZone: string;
  private readonly now: () => Date;
  private readonly maxDays: number;

  constructor(
    private readonly calendar: CalendarClient,
    options: ScheduleServiceOptions,
  ) {
    this.timeZone = options.timeZone;
    this.now = options.now ?? (() => new Date());
    this.maxDays = options.maxDays ?? 30;
  }

  async get(query: ScheduleQuery = {}): Promise<ScheduleResult> {
    const now = this.now();
    const { from, to } = this.resolveWindow(query, now);

    const events = await this.calendar.listEvents({ from, to });

    return {
      events,
      text: formatSchedule(events, { timeZone: this.timeZone, now }),
      from,
      to,
    };
  }

  /** Substring match over title, location and description. */
  async find(term: string, withinDays = 14): Promise<ScheduleResult> {
    const now = this.now();
    const from = zonedStartOfDay(now, this.timeZone);
    const to = zonedEndOfDay(addDaysZoned(from, withinDays, this.timeZone), this.timeZone);

    const needle = term.trim().toLowerCase();
    const events = (await this.calendar.listEvents({ from, to })).filter((event) =>
      [event.title, event.location, event.description]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(needle)),
    );

    return {
      events,
      text: formatSchedule(events, { timeZone: this.timeZone, now }),
      from,
      to,
    };
  }

  private resolveWindow(query: ScheduleQuery, now: Date): { from: Date; to: Date } {
    if (query.date) {
      const from = dayKeyToDate(query.date, this.timeZone);
      const to = query.endDate
        ? zonedEndOfDay(dayKeyToDate(query.endDate, this.timeZone), this.timeZone)
        : zonedEndOfDay(from, this.timeZone);

      if (to <= from) {
        throw new ValidationError("endDate must be on or after date");
      }

      const days = (to.getTime() - from.getTime()) / 86_400_000;
      if (days > this.maxDays) {
        throw new ValidationError(`Date range is too wide (max ${this.maxDays} days)`);
      }

      return { from, to };
    }

    const today = zonedStartOfDay(now, this.timeZone);

    switch (query.range ?? "today") {
      case "today":
        return { from: today, to: zonedEndOfDay(today, this.timeZone) };

      case "tomorrow": {
        const tomorrow = addDaysZoned(today, 1, this.timeZone);
        return { from: tomorrow, to: zonedEndOfDay(tomorrow, this.timeZone) };
      }

      case "this_week":
      case "next_7_days":
        return {
          from: today,
          to: zonedEndOfDay(addDaysZoned(today, 6, this.timeZone), this.timeZone),
        };
    }
  }
}
