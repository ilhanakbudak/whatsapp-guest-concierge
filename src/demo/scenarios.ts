import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoEventSeed, DemoGuest } from "./dataset.js";

/**
 * A worked example of the concierge serving a different kind of trip.
 *
 * Each scenario is data, not code: a guest list, an itinerary, and a knowledge
 * base. That is the whole surface the product adapts through, which is the point
 * the examples are there to make — a ski chalet and a wedding weekend need no
 * code changes, only different documents.
 */
export interface Scenario {
  slug: string;
  name: string;
  summary: string;
  timezone: string;
  guests: DemoGuest[];
  itinerary: DemoEventSeed[];
  /** filename → markdown, in filename order. */
  knowledgeBase: Record<string, string>;
}

export interface ScenarioSummary {
  slug: string;
  name: string;
  summary: string;
  timezone: string;
  guests: number;
  events: number;
}

interface ScenarioFile {
  name: string;
  summary: string;
  timezone: string;
  guests: DemoGuest[];
  itinerary: DemoEventSeed[];
}

export const EXAMPLES_DIR = "examples";

export function listScenarios(dir = EXAMPLES_DIR): ScenarioSummary[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "scenario.json")))
    .map((entry) => {
      const scenario = loadScenario(entry.name, dir);
      return {
        slug: scenario.slug,
        name: scenario.name,
        summary: scenario.summary,
        timezone: scenario.timezone,
        guests: scenario.guests.length,
        events: scenario.itinerary.length,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function loadScenario(slug: string, dir = EXAMPLES_DIR): Scenario {
  const root = join(dir, slug);
  const manifest = join(root, "scenario.json");

  if (!existsSync(manifest)) {
    const available = listScenarios(dir).map((s) => s.slug);
    throw new Error(
      `No scenario "${slug}" in ${dir}/.` +
        (available.length ? ` Available: ${available.join(", ")}` : ""),
    );
  }

  let parsed: ScenarioFile;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf-8")) as ScenarioFile;
  } catch (err) {
    throw new Error(`${manifest} is not valid JSON: ${(err as Error).message}`);
  }

  for (const field of ["name", "summary", "timezone"] as const) {
    if (!parsed[field]) throw new Error(`${manifest} is missing "${field}"`);
  }
  if (!Array.isArray(parsed.guests) || parsed.guests.length === 0) {
    throw new Error(`${manifest} needs at least one guest`);
  }
  if (!Array.isArray(parsed.itinerary)) {
    throw new Error(`${manifest} needs an "itinerary" array`);
  }

  const kbDir = join(root, "kb");
  const knowledgeBase: Record<string, string> = {};

  if (existsSync(kbDir)) {
    for (const file of readdirSync(kbDir).filter((f) => f.endsWith(".md")).sort()) {
      knowledgeBase[file] = readFileSync(join(kbDir, file), "utf-8");
    }
  }

  return {
    slug,
    name: parsed.name,
    summary: parsed.summary,
    timezone: parsed.timezone,
    guests: parsed.guests,
    itinerary: parsed.itinerary,
    knowledgeBase,
  };
}
