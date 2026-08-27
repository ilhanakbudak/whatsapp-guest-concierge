# Architecture

The README covers the shape of the system. This document covers the reasoning —
what each boundary is for, and what would break without it.

---

## Composition

There are no module-level singletons. [`src/app.ts`](../src/app.ts) builds an
`AppContext` once at boot and every dependency is passed explicitly:

```
AppContext
├── config          validated env (zod), fails fast at boot
├── logger          pino; redacts phone numbers in production
├── db / repos      SQLite + one repository per table
├── whatsapp        WhatsAppClient    → Twilio | Mock
├── calendar        CalendarClient    → Google  | Mock, behind a 60s cache
├── schedule        ScheduleService   — the API the LLM tool calls
├── llm             LlmProvider       → Anthropic | OpenAI | Gemini | Mock
├── knowledgeBase   KnowledgeService  → Markdown | Notion | Google Doc
├── broadcasts      queue + worker
├── handler         MessageHandler    — the seam between transport and AI
└── tasks           background runner, drained on shutdown
```

Tests build their own container against an in-memory database and mock clients,
which is why the suite runs in under a second and needs no credentials.

---

## The inbound path

```
POST /webhooks/twilio/inbound
  │
  ├─ verify X-Twilio-Signature ................ 403 if invalid
  ├─ normalise From → E.164 ................... strips whatsapp: prefix
  ├─ allowlist lookup ......................... unknown → fixed decline, no LLM
  ├─ per-guest token bucket ................... over limit → throttle notice
  ├─ persist inbound message
  └─ answer
       ├─ TWILIO_REPLY_MODE=api ...... ack now, reply out-of-band
       └─ TWILIO_REPLY_MODE=twiml .... reply inline in the response
```

### Why the allowlist runs before the model

An unauthorised number is declined *before* the handler is entered. If the check
ran afterwards, anyone who discovered the number could spend the client's tokens
by messaging it repeatedly. The decline is a fixed string, not a generated one.

### Why replies are normally sent out-of-band

Twilio retries a webhook that doesn't answer quickly. A round trip through the
model takes 2–6 seconds, and doing that inline risks Twilio timing out and
re-delivering — which would answer the guest twice.

So the webhook acknowledges immediately and the reply is dispatched through
[`BackgroundTaskRunner`](../src/lib/tasks.ts). Tracking those promises rather than
truly forgetting them buys two things: tests await `drain()` instead of sleeping,
and shutdown finishes replies already in progress.

`twiml` mode is the exception, and exists because Twilio trial accounts reject
free-form API sends. See [SETUP.md](SETUP.md#trial-accounts-read-this-first).

---

## The LLM layer

```
ConciergeHandler
   └── runConversation()          provider-neutral loop
         ├── LlmProvider.complete()
         ├── tool dispatch          get_schedule · find_event
         └── max-iteration guard    then one final tool-free request
```

### The neutral contract

```ts
interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
}
```

`LlmRequest` carries system *blocks* with a `cacheable` flag rather than any one
vendor's caching mechanism. Each adapter honours the intent however its provider
can: Anthropic gets an explicit `cache_control` breakpoint, OpenAI caches long
prefixes automatically so ordering is what matters, Gemini has its own cached
content lifecycle. Exposing intent instead of mechanism is what keeps the
abstraction honest.

`LlmResponse` normalises usage to `{inputTokens, outputTokens, cachedInputTokens}`
so cost reporting works regardless of provider.

### What the adapters actually reconcile

| | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| Tool schema | `input_schema` | `function.parameters` | `functionDeclarations` |
| Tool results | `tool_result` blocks inside a **user** message | flat `function_call_output` items | `functionResponse` parts |
| Assistant role | `assistant` | `assistant` | `model` |
| Tool call ids | provided | provided | **not provided** — synthesised |
| Sampling | removed on current models | rejected on gpt-5 / o-series | supported |

The last two rows are live-fire lessons: Gemini issues no correlation ids, and
gpt-5 returns a 400 for `temperature` rather than ignoring it.

### The loop's failure modes

- **Unknown tool name** — answered as a tool result (`No tool named "x" exists`),
  not thrown. The model recovers on the next turn.
- **Tool throws** — caught, reported back as a result.
- **Iteration limit** — one final request with tools withheld, so the guest gets a
  real answer from what was already gathered rather than silence.
- **Provider fails** — fixed fallback message, and the turn is *not* written to
  history. Persisting it would feed the model its own error next time.

---

## Prompt assembly

Order is load-bearing:

```
┌─ persona ─────────────────┐  stable
├─ knowledge base ──────────┤  stable   ← cache breakpoint
├─ guest name + notes ──────┤  volatile
└─ current local time ──────┘  volatile
```

Everything above the breakpoint is byte-identical across every request. Putting
the timestamp higher would invalidate the cache on every single call, and the only
symptom would be the bill — so it is asserted in tests rather than left to
discipline.

`KnowledgeService` reinforces this: when a refresh finds an unchanged content
hash, it returns the *existing* string rather than the freshly-built equivalent.

---

## Time

Every date decision happens in the villa's timezone, not the server's. At 21:30
UTC it is already tomorrow in Istanbul, so a UTC-based *"what's on tomorrow?"*
would confidently give guests the wrong day.

[`src/lib/datetime.ts`](../src/lib/datetime.ts) is dependency-free, built on
`Intl`, and handles the cases that actually bite:

- All-day events (`start.date`) vs timed events (`start.dateTime`)
- Day boundaries that are 23 or 25 hours long across DST
- Sub-hour offsets such as `Pacific/Chatham` at UTC+12:45
- Adding a day by wall-clock rather than by 86,400,000 ms

---

## Broadcasts

State lives in `broadcast_recipients`, one row per guest, so a partial failure is
visible and re-runnable.

The claim is the important detail:

```sql
UPDATE broadcast_recipients
SET status = 'sending', attempts = attempts + 1
WHERE id IN (SELECT id FROM broadcast_recipients
             WHERE broadcast_id = ? AND status = 'queued'
             ORDER BY id LIMIT ?)
RETURNING *
```

Selecting and claiming in one statement is what makes concurrent workers safe.
An earlier version only incremented `attempts` and left the status at `queued` —
which a test caught by proving the same recipient could be claimed twice.

Retry is two-layered on purpose: the Twilio client retries 429/5xx within a single
send, and the worker requeues for a later pass with backoff if that still fails.
Attempt counts live in the database, so the cap survives a restart.

---

## Storage

SQLite via `better-sqlite3`: one file, no service to run, prebuilt binaries.
Repository interfaces keep the door open to Postgres.

Migrations are TypeScript modules rather than `.sql` files, so the compiled output
needs no asset copying, and each runs inside a transaction together with its
bookkeeping row — a crash cannot leave a half-applied schema.

---

## Testability

Every external dependency has a mock, which is not a shortcut but the design:

- The suite runs with no credentials and no network
- `DEMO_MODE=true` makes the whole application runnable by a reviewer
- Each integration can be mocked *independently*, so Twilio can run live against a
  mocked calendar

`npm run verify` additionally **boots the compiled output** and probes it, because
vitest's transpiler is more forgiving about CommonJS interop than real ESM — a
named import from a CJS dependency can pass every test and still crash on start.
That is not hypothetical; it happened, and the smoke step exists because of it.
