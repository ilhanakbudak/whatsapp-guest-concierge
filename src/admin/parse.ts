export const COMMAND_PREFIX = "!";

export const COMMANDS = [
  "help",
  "status",
  "guests",
  "add",
  "remove",
  "refresh",
  "broadcast",
  "confirm",
  "cancel",
] as const;

export type CommandName = (typeof COMMANDS)[number];

export interface ParsedCommand {
  name: CommandName;
  /** Everything after the command word, untouched. */
  rest: string;
  /** `rest` split on whitespace, for commands that take positional arguments. */
  args: string[];
}

export interface UnknownCommand {
  name: null;
  attempted: string;
}

/** True for anything that looks like a command attempt, including unknown ones. */
export function looksLikeCommand(body: string): boolean {
  return body.trimStart().startsWith(COMMAND_PREFIX);
}

/**
 * Parses a command line.
 *
 * Returns `UnknownCommand` rather than null for an unrecognised word, so the
 * caller can say "no such command" instead of silently forwarding `!brodcast` to
 * the model — which would answer it conversationally and never send anything.
 */
export function parseCommand(body: string): ParsedCommand | UnknownCommand | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) return null;

  const withoutPrefix = trimmed.slice(COMMAND_PREFIX.length);
  const match = /^(\S*)\s*([\s\S]*)$/.exec(withoutPrefix);
  if (!match) return { name: null, attempted: "" };

  const word = (match[1] ?? "").toLowerCase();
  const rest = (match[2] ?? "").trim();

  if (!COMMANDS.includes(word as CommandName)) {
    return { name: null, attempted: word };
  }

  return {
    name: word as CommandName,
    rest,
    args: rest.length > 0 ? rest.split(/\s+/) : [],
  };
}

export function isUnknown(
  result: ParsedCommand | UnknownCommand,
): result is UnknownCommand {
  return result.name === null;
}

/** Closest known command by edit distance, for "did you mean" hints. */
export function suggestCommand(attempted: string): CommandName | null {
  if (!attempted) return null;

  let best: CommandName | null = null;
  let bestDistance = Infinity;

  for (const candidate of COMMANDS) {
    const distance = editDistance(attempted, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  // Only suggest when it is plausibly a typo rather than a different word.
  return bestDistance <= Math.max(1, Math.floor(attempted.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, j) => j);

  for (let i = 1; i < rows; i++) {
    const current = [i, ...Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[cols - 1]!;
}
