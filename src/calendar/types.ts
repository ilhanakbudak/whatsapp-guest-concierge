export interface CalendarEvent {
  id: string;
  title: string;
  /** UTC instant the event starts. For all-day events, local midnight. */
  start: Date;
  /** UTC instant the event ends. Exclusive. */
  end: Date;
  allDay: boolean;
  location?: string;
  description?: string;
}

export interface EventQuery {
  /** Inclusive lower bound. */
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
}

export interface CalendarClient {
  /**
   * Events overlapping the window, ordered by start time, with recurring events
   * already expanded into individual occurrences.
   */
  listEvents(query: EventQuery): Promise<CalendarEvent[]>;
}
