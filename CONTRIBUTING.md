# Contributing

Thanks for looking. This is a small, deliberately opinionated codebase, so this
document is mostly about the opinions — knowing them up front should save you a
review round.

## Getting it running

You need Node ≥ 22. You do not need Twilio, Google, Notion, Docker, or a phone.

```bash
git clone https://github.com/ilhanakbudak/whatsapp-guest-concierge
cd whatsapp-guest-concierge
npm install
cp .env.example .env          # DEMO_MODE=true is the default
npm run seed                  # synthetic guests, schedule and knowledge base
npm run dev                   # http://localhost:3000
```

Then send the bot a message without a phone:

```bash
npm run simulate -- "what time is the boat?"
```

Every external dependency sits behind an interface with a mock implementation,
and `DEMO_MODE=true` selects the mocks. If a change you are making requires real
credentials to test, that is usually a sign the seam is in the wrong place —
raise it in the issue before writing the code.

## Before you open a pull request

```bash
npm run verify
```

That is exactly what CI runs, and it fails on the first problem: typecheck →
lint → tests → build → smoke. The smoke step boots the *compiled* output and
probes it, because vitest's transpiler is more forgiving about CommonJS interop
than real ESM — a named import from a CJS dependency can pass every test and
still crash on start.

If `npm run verify` passes locally and CI does not, that is a bug in `verify`
and worth reporting on its own.

## How the code is organised

```
src/
├── app.ts          builds the AppContext at boot — the only composition root
├── ai/             the tool-use loop, and one adapter per provider
├── calendar/       CalendarClient  → Google  | Mock
├── whatsapp/       WhatsAppClient  → Twilio  | Mock
├── knowledge/      KnowledgeService → Markdown | Notion | Google Doc
├── broadcast/      queue, worker, delivery log
├── db/             SQLite, one repository per table
└── routes/         HTTP — thin, translating between transport and services
```

There are **no module-level singletons.** `src/app.ts` builds an `AppContext`
once and every dependency is passed explicitly. That is why the suite runs in
under two seconds against an in-memory database with no credentials, and it is
the constraint most likely to be violated by an otherwise reasonable patch.

`docs/ARCHITECTURE.md` explains what each boundary is for and what would break
without it. Worth ten minutes before a first change.

## Conventions

**Commits.** Conventional Commits, short imperative subject, lower case, no
trailing period:

```
feat: add twiml reply mode for trial accounts
fix: stop the broadcast worker double-sending after a restart
docs: rewrite readme with diagrams
```

The body is optional and usually unnecessary. If it takes a paragraph to explain
*what* the commit does, the commit is probably two commits.

**Tests.** Every behaviour change needs one. The suite is 412 tests and it is
fast on purpose — that is what makes it worth running before every commit rather
than hoping CI catches it.

Name the test after the behaviour, not the function:

```ts
// yes
it("does not silence the remaining recipients when one number is invalid")

// no
it("sendBroadcast works")
```

**Comments.** Explain *why*, never *what*. A comment restating the line below it
is noise; a comment recording the reason for a non-obvious choice is the most
valuable thing in the file. If you are tempted to write a comment explaining
what the code does, the code needs a better name instead.

**TypeScript.** `strict`, plus `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. No `any`, no non-null assertions to make the
compiler quiet. If the types are fighting you, the model is usually wrong.

**Formatting.** Prettier and ESLint decide. `npm run format` before you commit
and do not argue with either of them in review.

## Adding a provider

The most likely kind of contribution, so here is the shape of it.

A new LLM provider is one file in `src/ai/providers/` implementing
`LlmProvider`, registered in `src/ai/registry.ts`. It then automatically runs
against `tests/ai-conformance.test.ts`, which asserts every adapter agrees on
tool translation, usage normalisation and error wrapping — one suite, every
provider. If your adapter passes that, it works.

The same pattern holds for a calendar, knowledge or messaging backend: implement
the interface, add a mock if the real one needs credentials, and the existing
suites cover you.

## What is deliberately out of scope

So nobody spends a weekend on something I will decline with regret:

- **Multi-tenancy.** One deployment serves one group. Scaling that is a product
  decision, not a patch.
- **A second database.** SQLite is the right size for this, and one file that
  can be copied is a feature for the people who operate it.
- **Voice, images or payments.** Text and the four documented tools.
- **A front-end framework.** The admin dashboard is hand-written and small on
  purpose; it does not need React and would not be improved by it.

If you disagree with one of these, open an issue and make the case. I have been
wrong before.

## Reporting things

- **Bugs and features:** open an issue — the templates ask for the things I will
  otherwise have to ask for.
- **Security vulnerabilities:** do *not* open an issue. See
  [SECURITY.md](SECURITY.md).
- **Questions:** an issue is fine. There is no separate discussion forum.

## Licence

This project is MIT. Contributions are accepted under the same licence.
