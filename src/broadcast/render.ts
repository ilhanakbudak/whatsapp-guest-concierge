import type { Guest } from "../db/types.js";

/** Placeholders an announcement may use. Unknown ones are left untouched. */
export const PLACEHOLDERS = ["{name}", "{first_name}"] as const;

/**
 * Substitutes guest details into an announcement body.
 *
 * Left deliberately tiny — this is not a template language. Anything richer
 * would be a content management system, which the brief explicitly rules out.
 */
export function renderBroadcast(body: string, guest: Pick<Guest, "name">): string {
  const firstName = guest.name.trim().split(/\s+/)[0] ?? guest.name;

  return body.replaceAll("{first_name}", firstName).replaceAll("{name}", guest.name);
}

/** Placeholders actually used by a body, for the dashboard preview. */
export function usedPlaceholders(body: string): string[] {
  return PLACEHOLDERS.filter((token) => body.includes(token));
}
