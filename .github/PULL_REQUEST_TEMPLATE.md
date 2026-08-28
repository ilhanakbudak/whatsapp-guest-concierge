## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The reasoning, not a restatement of the diff. This is the part I will read
     most carefully, and the part that ends up in the commit message. -->

## How it was verified

<!-- Beyond `npm run verify`. If you exercised a real integration, say which. -->

---

- [ ] `npm run verify` passes
- [ ] Behaviour changes have tests, named after the behaviour
- [ ] New external dependencies sit behind an interface with a mock, so
      `DEMO_MODE=true` still runs with no credentials
- [ ] Comments explain *why*, not *what*
- [ ] No secrets, real phone numbers or real customer data — including
      invented ones realistic enough to be mistaken for a leak
- [ ] Documentation updated if behaviour or configuration changed
