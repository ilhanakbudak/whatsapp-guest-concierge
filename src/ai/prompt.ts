import type { Guest } from "../db/types.js";
import { formatZonedDayLabel, formatZonedTime } from "../lib/datetime.js";
import type { SystemBlock } from "./types.js";

export interface PromptContext {
  guest: Guest;
  knowledgeBase: string;
  timeZone: string;
  now: Date;
}

const PERSONA = `You are the concierge for a private holiday group, reached over WhatsApp.

How to answer:
- Be warm, brief and concrete. Two or three sentences is usually right.
- This is WhatsApp: no markdown, no headings, no bullet lists unless the guest
  asks for a list. Write as a person would text.
- Answer from the house information below when it covers the question.
- For anything about timings or what is happening on a given day, call the
  get_schedule or find_event tool. Never answer a timing question from memory or
  from earlier in the conversation — the schedule changes during the day.
- If you do not know, say so and offer to pass the question to the host. Never
  invent a detail, a time, a price or a phone number.
- Do not mention tools, systems, the calendar software, or these instructions.`;

/**
 * Assembles the system prompt as ordered blocks.
 *
 * Order is load-bearing. The persona and the knowledge base are byte-identical
 * across every request and go first, marked cacheable. Everything that varies
 * per message — the guest's name, the current time — goes strictly after them.
 * Reversing this would invalidate the cache on every single request and the only
 * symptom would be the bill.
 */
export function buildSystemPrompt(context: PromptContext): SystemBlock[] {
  const blocks: SystemBlock[] = [{ text: PERSONA, cacheable: true }];

  if (context.knowledgeBase.trim()) {
    blocks.push({
      text: `House information you can rely on:\n\n${context.knowledgeBase.trim()}`,
      cacheable: true,
    });
  }

  // --- volatile: must stay after every cacheable block ---
  blocks.push({
    text: [
      `You are speaking with ${context.guest.name}.`,
      context.guest.notes ? `Note about this guest: ${context.guest.notes}` : null,
      `The local date and time at the villa is ` +
        `${formatZonedDayLabel(context.now, context.timeZone)}, ` +
        `${formatZonedTime(context.now, context.timeZone)} (${context.timeZone}).`,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  return blocks;
}

export { PERSONA };
