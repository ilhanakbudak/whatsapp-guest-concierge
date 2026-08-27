import type { ScheduleService } from "../calendar/schedule.js";
import { NAMED_RANGES } from "../calendar/schedule.js";
import { errorMessage } from "../lib/errors.js";
import type { ToolDefinition } from "./types.js";

/** A tool definition bound to the code that runs it. */
export interface RegisteredTool {
  definition: ToolDefinition;
  execute(input: Record<string, unknown>): Promise<string>;
}

/**
 * Exposing the calendar as a tool rather than pasting a week of events into the
 * system prompt is the central design choice of this bot: the model fetches the
 * schedule at answer time, so a change made an hour ago is reflected, and the
 * majority of messages — which are not about the schedule — never touch Google.
 */
export function createTools(schedule: ScheduleService): RegisteredTool[] {
  return [
    {
      definition: {
        name: "get_schedule",
        description:
          "Look up the group's schedule. Use this for any question about timings, " +
          "what is happening on a given day, or when something starts. Always call " +
          "this rather than guessing or relying on earlier messages, because the " +
          "schedule changes throughout the day.",
        parameters: {
          type: "object",
          properties: {
            range: {
              type: "string",
              enum: [...NAMED_RANGES],
              description: "Which period to look up. Defaults to today.",
            },
            date: {
              type: "string",
              description:
                "A specific day as YYYY-MM-DD. Use instead of range when the guest " +
                "names a date. Prefer range for 'today' and 'tomorrow'.",
            },
            endDate: {
              type: "string",
              description: "Optional end of a date range, as YYYY-MM-DD.",
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      execute: async (input) => {
        try {
          const result = await schedule.get({
            ...(typeof input.range === "string"
              ? { range: input.range as (typeof NAMED_RANGES)[number] }
              : {}),
            ...(typeof input.date === "string" ? { date: input.date } : {}),
            ...(typeof input.endDate === "string" ? { endDate: input.endDate } : {}),
          });
          return result.text;
        } catch (err) {
          // Returned as a tool result, not thrown: the model can recover by
          // asking the guest to clarify, whereas an exception ends the turn.
          return `Could not read the schedule: ${errorMessage(err)}`;
        }
      },
    },

    {
      definition: {
        name: "find_event",
        description:
          "Search the schedule for a specific activity by name, place or keyword, " +
          "for example 'boat' or 'dinner'. Use when the guest asks when something " +
          "is happening without naming a day.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Word or phrase to search for.",
            },
            withinDays: {
              type: "number",
              description: "How many days ahead to search. Defaults to 14.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      execute: async (input) => {
        const query = typeof input.query === "string" ? input.query : "";
        if (!query.trim()) return "No search term was provided.";

        try {
          const withinDays = typeof input.withinDays === "number" ? input.withinDays : 14;
          const result = await schedule.find(query, withinDays);

          return result.events.length === 0
            ? `Nothing matching "${query}" is scheduled in the next ${withinDays} days.`
            : result.text;
        } catch (err) {
          return `Could not search the schedule: ${errorMessage(err)}`;
        }
      },
    },
  ];
}
