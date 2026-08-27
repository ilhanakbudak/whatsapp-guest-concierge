# Use cases

The concierge was written for a private villa holiday, but nothing in the code is
about villas. A trip is three things — **a guest list, a calendar, and a document
of house information** — and every scenario here supplies its own.

No code changes. No redeploy. Different documents.

```bash
npm run seed -- --list                      # everything available
npm run seed -- --scenario ski-chalet       # load one
npm run dev                                 # then talk to it at /simulator
```

| Scenario | | |
|---|---|---|
| [`villa-holiday`](villa-holiday/) | Private villa holiday | Friends sharing a villa on the Turkish coast. The original brief. |
| [`wedding-weekend`](wedding-weekend/) | Wedding weekend | Ninety guests at a country house over three days. |
| [`corporate-offsite`](corporate-offsite/) | Company offsite | Forty employees at a three-day strategy offsite. |
| [`yacht-charter`](yacht-charter/) | Yacht charter week | Eight guests sailing the Cyclades. |
| [`ski-chalet`](ski-chalet/) | Catered ski chalet | A chalet week in Saas-Fee. |

---

## What actually changes

Loading `ski-chalet` and asking the same bot four questions, unedited:

> **what time does the minibus leave?**
> The minibus leaves the chalet at 09:15 for the gondola, with a 09:45 return run.
> Afternoon pickups from the gondola base are at 16:00 and 16:45, and it leaves
> promptly.

> **can I keep my ski boots in my room?**
> Ski boots can't be kept upstairs in the rooms, as they can permanently mark the
> soft-wood floors. Please leave them in the heated boot room downstairs, on the
> pegs rather than the floor.

> **what do I do if there's an emergency on the mountain?**
> Call 1414 for mountain rescue or 112 for a general emergency. Give your location
> as precisely as possible, including the piste number and nearest lift.

> **who's cooking dinner on Ana's day off?**
> No one — the chalet doesn't serve dinner on Ana's day off. Breakfast is laid out
> cold, and you can eat at a village restaurant such as Zur Mühle, La Ferme or
> Pizzeria Boccalino.

The last answer is the interesting one. Nothing in the knowledge base says "no
dinner is cooked on the host's day off" as a sentence — the calendar has a day
marked *"Chalet host's day off — no dinner served"* and the knowledge base lists
village restaurants. The assistant read both and joined them.

---

## Why the scenarios differ in more than wording

Each was chosen because it stresses a different part of the system.

| Scenario | What it exercises |
|---|---|
| **Villa holiday** | The baseline: a fixed week, one timezone, a stable itinerary. |
| **Wedding weekend** | Hard deadlines. *"Be seated by 13:15"* is the kind of fact that must never be paraphrased loosely, and ninety people will ask it separately. |
| **Corporate offsite** | Policy questions — what expenses are covered — rather than logistics. Different question shape entirely. |
| **Yacht charter** | **Timings that genuinely move.** Wind decides the schedule, so an answer read from a static prompt would be wrong daily. This is the case the live calendar lookup exists for. |
| **Ski chalet** | Safety information that must be reproduced exactly, and a mid-week gap in service that the assistant has to reason about rather than recite. |

---

## Anatomy of a scenario

```
examples/ski-chalet/
├── scenario.json          guest list, itinerary, timezone
└── kb/
    ├── 00-welcome.md      concatenated in filename order,
    ├── 10-the-chalet.md   which is how the operator controls
    ├── 20-skiing.md       what the assistant reads first
    ├── 30-dining-and-village.md
    └── 40-safety-and-medical.md
```

`scenario.json`:

```jsonc
{
  "name": "Catered ski chalet",
  "summary": "…",
  "timezone": "Europe/Zurich",
  "guests": [
    { "phone": "+447700900403", "name": "Diego Salas",
      "notes": "Nut allergy, carries an EpiPen" }
  ],
  "itinerary": [
    { "dayOffset": 1, "start": "09:15", "title": "Minibus to the gondola",
      "location": "Chalet front",
      "description": "Leaves promptly. The next run is 09:45." }
  ]
}
```

`dayOffset` is relative to the day you seed, so a scenario never goes stale.
Timezone is per scenario — a ski week in Saas-Fee is not on Istanbul time, and
"what's on tomorrow" has to respect that.

## Writing your own

Copy any directory, change the three things. Guest `notes` reach the assistant, so
dietary requirements and allergies are answered without anyone asking a human.

Every phone number here is from Ofcom's `+44 7700 900xxx` range, which is reserved
permanently for fiction and can never reach a real subscriber. Keep that when
adding scenarios.
