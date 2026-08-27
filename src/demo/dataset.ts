/**
 * The fictional villa used by DEMO_MODE, the seed script and the tests.
 *
 * Every phone number is drawn from Ofcom's +44 7700 900xxx range, which is
 * permanently reserved for drama and documentation and can never be allocated to
 * a real subscriber. Addresses and names are invented. Nothing here should ever
 * be mistaken for a real person's data.
 */

export interface DemoGuest {
  phone: string;
  name: string;
  role: "guest" | "admin";
  notes?: string;
}

export const DEMO_TIMEZONE = "Europe/Istanbul";

export const DEMO_GUESTS: DemoGuest[] = [
  { phone: "+447700900001", name: "Priya Patel", role: "guest", notes: "Vegetarian" },
  { phone: "+447700900002", name: "Tom Okafor", role: "guest" },
  { phone: "+447700900003", name: "Elena Rossi", role: "guest", notes: "Shellfish allergy" },
  { phone: "+447700900004", name: "Marcus Bell", role: "guest" },
  { phone: "+447700900005", name: "Yuki Tanaka", role: "guest", notes: "Arrives Thursday" },
  { phone: "+447700900010", name: "Sofia Marsh", role: "admin", notes: "Guest liaison / PA" },
];

export interface DemoEventSeed {
  /** Days from "today" in the villa's timezone. */
  dayOffset: number;
  /** Local start time, HH:MM. Omit for an all-day entry. */
  start?: string;
  /** Local end time, HH:MM. Defaults to one hour after start. */
  end?: string;
  title: string;
  location?: string;
  description?: string;
}

/**
 * Relative to the current day so the demo is never stale — a fixed date would
 * make "what's happening tomorrow?" return nothing a week after seeding.
 */
export const DEMO_ITINERARY: DemoEventSeed[] = [
  // Today
  { dayOffset: 0, start: "08:30", end: "10:30", title: "Breakfast on the terrace", location: "Main terrace" },
  {
    dayOffset: 0,
    start: "14:00",
    end: "18:00",
    title: "Boat trip to the blue caves",
    location: "South jetty",
    description: "Bring swimwear, a towel and sun cream. Departs promptly.",
  },
  { dayOffset: 0, start: "20:30", title: "Dinner at Meze Bahçe", location: "Kalkan old town", description: "Smart casual. Taxis leave from the front gate at 20:00." },

  // Tomorrow
  { dayOffset: 1, title: "Dress code: whites", description: "For the evening party only." },
  { dayOffset: 1, start: "09:00", end: "10:00", title: "Yoga by the pool", location: "Lower pool deck" },
  { dayOffset: 1, start: "13:00", end: "15:00", title: "Lunch at the villa", location: "Main terrace" },
  {
    dayOffset: 1,
    start: "19:30",
    title: "White party",
    location: "Upper terrace",
    description: "Welcome drinks at 19:30, dinner served at 21:00.",
  },

  // Day after
  { dayOffset: 2, start: "10:00", end: "13:00", title: "Kayaking at Kaputaş", location: "Kaputaş beach" },
  { dayOffset: 2, start: "20:00", title: "Barbecue by the pool", location: "Lower pool deck" },

  // Later in the week
  { dayOffset: 3, start: "11:00", end: "16:00", title: "Free day", description: "No planned activities." },
  { dayOffset: 4, start: "07:00", title: "Airport transfers begin", location: "Front gate", description: "Check the group chat for your assigned car." },
];

export const DEMO_KB_FILES: Record<string, string> = {
  "00-welcome.md": `# Welcome to Villa Meltem

Villa Meltem sits above Kalkan on Türkiye's Turquoise Coast. This handbook is the
answer to almost anything you might ask.

Your hosts are Sofia and Deniz. Sofia handles the schedule and logistics; Deniz
looks after the house itself.
`,

  "10-practical.md": `# Practical Information

## WiFi

| Network | Password |
|---|---|
| \`VillaMeltem\` | \`turquoise-2026\` |
| \`VillaMeltem-Pool\` | \`turquoise-2026\` |

The pool network is a separate access point — use it on the lower terrace, where
the main signal is weak.

## Addresses

**The villa**
Yalı Mahallesi 42, Kalkan, Kaş/Antalya

**For taxis**, say "Villa Meltem, above the Kalkan marina, past the Patara Road
junction". Drivers know it.

## Contacts

| Who | When to call | Number |
|---|---|---|
| Sofia (guest liaison) | Schedule, bookings, anything at all | +44 7700 900010 |
| Deniz (house manager) | The house itself, maintenance | +44 7700 900011 |
| Villa landline | If mobiles fail | +44 7700 900012 |

## Getting around

Taxis take about 8 minutes to reach the old town. The villa has two cars
available — ask Deniz. Walking down takes 25 minutes; walking back up takes
considerably longer, and most people regret trying.
`,

  "20-house-rules.md": `# House Rules

- **Shoes off** inside the house. There are baskets by both doors.
- **Pool hours are 07:00 to 23:00.** Sound carries a long way up the hillside.
- **No smoking indoors.** The upper terrace has ashtrays.
- **Air conditioning**: please close the doors when it is running.
- **Water** is drinkable from the filtered tap in the kitchen. Bottled water is
  in the pantry fridge.
- **Housekeeping** comes daily between 10:00 and 12:00.
- **Departures**: rooms free by 10:00 on your last day.
`,

  "30-dining.md": `# Dining

## Booked for the group

**Meze Bahçe** — Kalkan old town. Traditional meze, long tables, excellent grilled
fish. Smart casual: no swimwear, no vests.

**Liman Balık** — on the marina. Seafood. This is the smartest booking of the
week — jackets are not required but most people dress up.

## Recommended nearby

- **Kalamaki** — rooftop, best sunset view in Kalkan. Book a day ahead.
- **Fıstık Kafe** — casual lunch, very good lahmacun, walkable from the marina.
- **Patara Beach Club** — 25 minutes by car, worth it for a long lunch.

## Dietary notes

The kitchen is briefed on all dietary requirements collected before arrival.
Vegetarian and gluten-free options are available at every group meal. Elena has a
shellfish allergy — the kitchen and both restaurants have been told.

## Dress codes

| Occasion | Code |
|---|---|
| Breakfast and lunch | Anything, cover-ups fine |
| Dinner at the villa | Casual |
| Meze Bahçe | Smart casual |
| Liman Balık | Smart |
| White party | All white |
`,

  "40-emergency.md": `# Emergency Information

## Emergency numbers in Türkiye

**112** reaches ambulance, fire and police.

## Nearest medical care

**Kalkan Sağlık Ocağı** (health centre) — 10 minutes by car, open 08:00–17:00.
**Kaş Devlet Hastanesi** (state hospital) — 30 minutes by car, 24 hours, has an
emergency department.

For anything serious, call Sofia first if you can — she speaks Turkish and can
call ahead.

## At the villa

- The first aid kit is in the kitchen, in the cupboard left of the fridge.
- The fuse box is in the utility room behind the kitchen.
- The water shut-off valve is beside the pool pump housing.
- Fire extinguishers are in the kitchen and on each landing.

## If you get locked out

There is a key safe by the side gate. Ask Sofia or Deniz for the code — it is not
written down here on purpose.
`,
};
