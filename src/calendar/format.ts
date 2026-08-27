import {
  formatZonedDayLabel,
  formatZonedTime,
  relativeDayLabel,
  zonedDayKey,
} from "../lib/datetime.js";
import type { CalendarEvent } from "./types.js";

export interface FormatOptions {
  timeZone: string;
  now: Date;
  /** Included so the model can say "the boat leaves from the south jetty". */
  includeDescriptions?: boolean;
}

/**
 * Renders events as compact text for the model to read.
 *
 * Deliberately not JSON: the model reproduces this shape almost verbatim when
 * answering, and a plain day-by-day agenda reads back to a guest far better than
 * anything it would compose from a nested object. It is also markedly fewer
 * tokens.
 */
export function formatSchedule(events: CalendarEvent[], options: FormatOptions): string {
  if (events.length === 0) {
    return "No scheduled events in this period.";
  }

  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = zonedDayKey(event.start, options.timeZone);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(event);
    else byDay.set(key, [event]);
  }

  const sections: string[] = [];

  for (const [, dayEvents] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const first = dayEvents[0]!;
    const relative = relativeDayLabel(first.start, options.now, options.timeZone);
    const absolute = formatZonedDayLabel(first.start, options.timeZone);

    // "today (Thursday 27 August)" — the relative word is what a guest wants to
    // hear, the date keeps the model from drifting if the conversation is long.
    const heading =
      relative === absolute ? absolute : `${relative} (${absolute})`;

    const lines = dayEvents.map((event) => formatEvent(event, options));
    sections.push(`${heading}\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

function formatEvent(event: CalendarEvent, options: FormatOptions): string {
  const when = event.allDay
    ? "all day"
    : sameZonedDay(event, options.timeZone)
      ? `${formatZonedTime(event.start, options.timeZone)}–${formatZonedTime(event.end, options.timeZone)}`
      : // A multi-day event needs its end date or "until 14:00" is ambiguous.
        `${formatZonedTime(event.start, options.timeZone)} until ${formatZonedDayLabel(event.end, options.timeZone)} ${formatZonedTime(event.end, options.timeZone)}`;

  const parts = [`  ${when}  ${event.title}`];
  if (event.location) parts.push(`(${event.location})`);

  let line = parts.join(" ");

  if (options.includeDescriptions !== false && event.description) {
    // Collapse newlines: calendar descriptions are often multi-line and would
    // break the one-event-per-line shape the model relies on.
    line += ` — ${event.description.replace(/\s*\n\s*/g, " ").trim()}`;
  }

  return line;
}

function sameZonedDay(event: CalendarEvent, timeZone: string): boolean {
  // An event ending exactly at midnight belongs to the day it started on.
  const endForComparison =
    event.end.getTime() > event.start.getTime()
      ? new Date(event.end.getTime() - 1)
      : event.end;

  return zonedDayKey(event.start, timeZone) === zonedDayKey(endForComparison, timeZone);
}
