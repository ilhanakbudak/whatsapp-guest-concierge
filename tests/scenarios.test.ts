import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listScenarios, loadScenario } from "../src/demo/scenarios.js";
import { DEMO_GUESTS, DEMO_ITINERARY, DEMO_TIMEZONE } from "../src/demo/dataset.js";
import { MockCalendarClient } from "../src/calendar/mock.js";
import { ScheduleService } from "../src/calendar/schedule.js";
import { normalizePhone } from "../src/lib/phone.js";

const scenarios = listScenarios();

describe("the examples directory", () => {
  it("ships several worked scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(5);
  });

  it("has an index that lists every one of them", () => {
    const readme = readFileSync("examples/README.md", "utf-8");
    for (const scenario of scenarios) {
      expect(readme, `${scenario.slug} missing from examples/README.md`).toContain(scenario.slug);
    }
  });
});

describe.each(scenarios)("scenario: $slug", (summary) => {
  const scenario = loadScenario(summary.slug);

  it("declares a name, summary and timezone", () => {
    expect(scenario.name).toBeTruthy();
    expect(scenario.summary).toBeTruthy();
    // Throws for an invalid IANA zone, which is the point of the assertion.
    expect(() => new Intl.DateTimeFormat("en", { timeZone: scenario.timezone })).not.toThrow();
  });

  it("has guests with valid E.164 numbers", () => {
    expect(scenario.guests.length).toBeGreaterThan(0);
    for (const guest of scenario.guests) {
      expect(() => normalizePhone(guest.phone)).not.toThrow();
      expect(guest.name.trim()).toBeTruthy();
    }
  });

  it("uses only reserved fictional phone numbers", () => {
    // Ofcom's +44 7700 900xxx range can never reach a real subscriber.
    for (const guest of scenario.guests) {
      expect(guest.phone, `${guest.name} has a non-reserved number`).toMatch(/^\+447700900\d{3}$/);
    }
  });

  it("has no duplicate numbers", () => {
    const phones = scenario.guests.map((g) => g.phone);
    expect(new Set(phones).size).toBe(phones.length);
  });

  it("nominates at least one admin", () => {
    expect(scenario.guests.some((g) => g.role === "admin")).toBe(true);
  });

  it("has a well-formed itinerary", () => {
    expect(scenario.itinerary.length).toBeGreaterThan(0);
    for (const event of scenario.itinerary) {
      expect(Number.isInteger(event.dayOffset)).toBe(true);
      expect(event.title.trim()).toBeTruthy();
      if (event.start) expect(event.start).toMatch(/^\d{2}:\d{2}$/);
      if (event.end) expect(event.end).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it("ships a knowledge base", () => {
    const files = Object.keys(scenario.knowledgeBase);
    expect(files.length).toBeGreaterThan(0);
    for (const [name, body] of Object.entries(scenario.knowledgeBase)) {
      expect(name).toMatch(/\.md$/);
      expect(body.trim().length, `${name} is empty`).toBeGreaterThan(50);
    }
  });

  it("renders a schedule in its own timezone", async () => {
    const now = new Date();
    const calendar = new MockCalendarClient({
      timeZone: scenario.timezone,
      seeds: scenario.itinerary,
      now: () => now,
    });
    const schedule = new ScheduleService(calendar, {
      timeZone: scenario.timezone,
      now: () => now,
    });

    const result = await schedule.get({ range: "next_7_days" });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.text).not.toBe("No scheduled events in this period.");
  });
});

describe("villa-holiday stays in sync with the built-in dataset", () => {
  // The mock calendar uses the TypeScript dataset at runtime while the seed
  // script reads examples/. If the two drift, the demo and the documented
  // example stop matching.
  const villa = loadScenario("villa-holiday");

  it("matches the built-in guests", () => {
    expect(villa.guests).toEqual(DEMO_GUESTS);
  });

  it("matches the built-in itinerary", () => {
    expect(villa.itinerary).toEqual(DEMO_ITINERARY);
  });

  it("matches the built-in timezone", () => {
    expect(villa.timezone).toBe(DEMO_TIMEZONE);
  });
});

describe("loadScenario", () => {
  it("names the alternatives when asked for one that does not exist", () => {
    expect(() => loadScenario("does-not-exist")).toThrow(/Available: /);
  });

  it("reads knowledge base files in filename order", () => {
    const scenario = loadScenario("ski-chalet");
    const files = Object.keys(scenario.knowledgeBase);
    expect([...files].sort()).toEqual(files);
  });

  it("every scenario directory has a manifest", () => {
    for (const scenario of scenarios) {
      expect(existsSync(`examples/${scenario.slug}/scenario.json`)).toBe(true);
    }
  });
});
