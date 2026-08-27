/**
 * Timezone-aware date helpers built on Intl, with no dependencies.
 *
 * Everything here exists because "what's happening tomorrow?" must mean tomorrow
 * *at the villa*, not on the server. A container running in UTC at 21:30 Istanbul
 * time is already on the next calendar day — answering from the server's clock
 * would confidently give guests the wrong day's schedule.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsOf(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    // h23 rather than hour12:false — some ICU builds render midnight as "24"
    // under hour12:false, which silently shifts the day.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  return partsOf(date, timeZone);
}

/** Milliseconds to add to UTC to get local wall-clock time in `timeZone`. */
export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const p = partsOf(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
}

/**
 * The UTC instant at which the given wall-clock time occurs in `timeZone`.
 *
 * Two passes: the offset depends on the instant, and the instant depends on the
 * offset. The first guess lands within an hour, which is close enough for the
 * second pass to pick the correct side of a DST transition.
 */
export function fromZonedTime(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);

  let instant = wallClock - timeZoneOffsetMs(new Date(wallClock), timeZone);
  instant = wallClock - timeZoneOffsetMs(new Date(instant), timeZone);

  return new Date(instant);
}

/** Midnight at the start of `date`'s local day in `timeZone`. */
export function zonedStartOfDay(date: Date, timeZone: string): Date {
  const p = partsOf(date, timeZone);
  return fromZonedTime(timeZone, p.year, p.month, p.day);
}

/**
 * Midnight ending `date`'s local day — i.e. the start of the next one.
 *
 * Advances by wall-clock, not by 86,400,000ms: on the autumn DST day the local
 * day is 25 hours long, so adding a fixed 24 hours lands back inside the *same*
 * day and the range silently collapses to nothing.
 */
export function zonedEndOfDay(date: Date, timeZone: string): Date {
  return addDaysZoned(zonedStartOfDay(date, timeZone), 1, timeZone);
}

/**
 * Adds days by wall-clock, not by 24-hour blocks, so a DST transition doesn't
 * shift the result by an hour.
 */
export function addDaysZoned(date: Date, days: number, timeZone: string): Date {
  const p = partsOf(date, timeZone);
  return fromZonedTime(timeZone, p.year, p.month, p.day + days, p.hour, p.minute);
}

/** `YYYY-MM-DD` for the local day in `timeZone`. Used to group events by day. */
export function zonedDayKey(date: Date, timeZone: string): string {
  const p = partsOf(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Parses a `YYYY-MM-DD` string into that day's start instant in `timeZone`. */
export function dayKeyToDate(dayKey: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) throw new Error(`Invalid date "${dayKey}", expected YYYY-MM-DD`);

  return fromZonedTime(timeZone, Number(match[1]), Number(match[2]), Number(match[3]));
}

/** `14:00` in the villa's timezone. */
export function formatZonedTime(date: Date, timeZone: string): string {
  const p = partsOf(date, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** `Thursday 27 August` — the heading the model reads and repeats to guests. */
export function formatZonedDayLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

/** Days between two instants, counted by local calendar day. */
export function daysBetweenZoned(from: Date, to: Date, timeZone: string): number {
  const a = zonedStartOfDay(from, timeZone).getTime();
  const b = zonedStartOfDay(to, timeZone).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** `today`, `tomorrow`, `Thursday` — how the bot should refer to a day. */
export function relativeDayLabel(date: Date, now: Date, timeZone: string): string {
  const delta = daysBetweenZoned(now, date, timeZone);
  if (delta === 0) return "today";
  if (delta === 1) return "tomorrow";
  if (delta === -1) return "yesterday";
  return formatZonedDayLabel(date, timeZone);
}
