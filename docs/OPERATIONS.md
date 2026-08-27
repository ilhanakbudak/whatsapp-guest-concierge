# Operations

Day-to-day tasks for the team running the villa. Everything here needs the admin
token from `.env` (`ADMIN_API_TOKEN`).

---

## Sending an announcement

**Always preview first.** A broadcast reaches every guest at once and cannot be
recalled.

```bash
curl -X POST https://your-app/admin/broadcast \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Boat departs in 90 minutes. Meet at the south jetty.","dryRun":true}'
```

The preview returns the exact recipient count, the rendered message for the first
few guests, and any warnings. Drop `"dryRun": true` to actually send.

### Personalising

| Placeholder | Becomes |
|---|---|
| `{first_name}` | Priya |
| `{name}` | Priya Patel |

A misspelled placeholder (`{frist_name}`) is reported as a warning in the preview
rather than sent verbatim to everyone.

### Watching it go out

```bash
curl https://your-app/admin/broadcasts/12 -H "Authorization: Bearer $ADMIN_API_TOKEN"
```

Each recipient moves through `queued → sending → sent → delivered → read`.
`sent` means Twilio accepted it; `delivered` means it reached the phone.

### When a guest does not receive it

Check the recipient's `errorMessage` in the detail view.

| What you see | What it means |
|---|---|
| *Outside the 24-hour window — this guest must message the bot first* | WhatsApp only allows free-form messages within 24 hours of the guest's last message. Ask them to send anything to the bot, then resend. |
| `63003` | The number is not on WhatsApp, or has not joined the sandbox. |
| `undelivered` | The phone was unreachable. Twilio does not retry these. |

The 24-hour window is a WhatsApp policy, not a limitation of this bot. The
permanent fix is an approved message template; for a holiday group, asking guests
to message the bot on arrival is usually simpler.

---

## Managing the guest list

Only guests on the list can use the bot or receive broadcasts. Everyone else gets
a polite decline and never reaches the AI.

```bash
sqlite3 data/concierge.db \
  "INSERT INTO guests (phone, name) VALUES ('+447700900123', 'Priya Patel');"
```

Numbers must be **E.164** — a `+`, the country code, no spaces, no `whatsapp:`
prefix.

Removing someone deactivates them rather than deleting: their message history and
past delivery records survive.

```bash
sqlite3 data/concierge.db \
  "UPDATE guests SET active = 0 WHERE phone = '+447700900123';"
```

> A dashboard for this arrives with the admin interface; until then these are the
> commands.

---

## Updating the house information

Edit the source (`kb/` files, the Notion page, or the Google Doc), then either
wait for the nightly refresh or push it live immediately:

```bash
curl -X POST https://your-app/admin/kb/refresh \
  -H "Authorization: Bearer $ADMIN_API_TOKEN"
```

`changed: true` means the content genuinely differed. `changed: false` means the
document is identical to what the bot already had — usually a sign the edit was
not saved.

Check what is currently loaded:

```bash
curl https://your-app/admin/kb -H "Authorization: Bearer $ADMIN_API_TOKEN"
```

---

## Updating the schedule

Edit the Google Calendar directly. There is nothing to refresh — the bot reads it
at the moment a guest asks, so a change made a minute ago is already live.

---

## Health checks

| Endpoint | Tells you |
|---|---|
| `GET /health` | The process is up |
| `GET /health/ready` | The database is reachable, which integrations are mocked, active guest count |
