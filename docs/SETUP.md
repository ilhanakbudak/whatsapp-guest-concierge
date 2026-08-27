# Setup

Everything here is optional for a demo — with `DEMO_MODE=true` the bot runs with
no accounts at all. Follow these sections when connecting real services.

---

## 1. Twilio WhatsApp

### Getting credentials

1. Sign in at [console.twilio.com](https://console.twilio.com).
2. On the dashboard, copy **Account SID** and **Auth Token** into your `.env`:

   ```bash
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   ```

The auth token is also the key Twilio signs webhooks with, so it must be correct
or every inbound message is rejected as unsigned.

### Joining the sandbox (for testing)

The WhatsApp sandbox lets you test without waiting for a WhatsApp Business
approval.

1. Go to **Messaging → Try it out → Send a WhatsApp message**.
2. Note the sandbox number (usually `+1 415 523 8886`) and the join code, which
   looks like `join <two-words>`.
3. From the phone you want to test with, send that join code to the sandbox
   number on WhatsApp.
4. Set the sender in `.env`:

   ```bash
   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
   ```

> **The sandbox only talks to numbers that have joined it.** Every phone you want
> to receive broadcasts must send the join code first. This is a sandbox
> limitation, not a limitation of the bot.

### Pointing Twilio at your machine

Twilio needs a public HTTPS URL. For local development, tunnel it:

```bash
# either one works
ngrok http 3000
cloudflared tunnel --url http://localhost:3000
```

Copy the HTTPS URL the tunnel prints, then:

1. Put it in `.env` — **this must match exactly what you give Twilio**:

   ```bash
   PUBLIC_URL=https://your-tunnel-subdomain.ngrok-free.app
   ```

2. In the Twilio console, under the sandbox settings, set:

   | Field | Value |
   |---|---|
   | When a message comes in | `https://<your-url>/webhooks/twilio/inbound` (POST) |
   | Status callback URL | `https://<your-url>/webhooks/twilio/status` (POST) |

3. Restart the service so it picks up the new `PUBLIC_URL`.

### Why PUBLIC_URL matters

Twilio signs the URL *it* called. The service rebuilds that URL from `PUBLIC_URL`
rather than from the incoming request, because behind a tunnel — or behind
Railway and Render, where TLS terminates upstream — the request arrives as plain
`http://` with an internal hostname, and a signature computed from that will
never match.

If every inbound message is being rejected with `403 invalid_signature`, the
cause is almost always one of:

- `PUBLIC_URL` doesn't exactly match the webhook URL configured in Twilio
  (a trailing slash counts, `http` vs `https` counts)
- `TWILIO_AUTH_TOKEN` is wrong or belongs to a different Twilio project
- The tunnel restarted and issued a new URL

As a last resort for local debugging only, set `TWILIO_VALIDATE_SIGNATURE=false`.
Never do this on a deployed instance — it leaves the webhook open to anyone who
finds the URL.

### Authorising a test guest

The bot only answers numbers on the allowlist. Until the admin dashboard lands,
add one directly:

```bash
npm run seed   # loads the sample villa, or add your own number below
```

```bash
sqlite3 data/concierge.db \
  "INSERT INTO guests (phone, name) VALUES ('+447700900123', 'Your Name');"
```

Use the number in **E.164** format, with no `whatsapp:` prefix — the service adds
and strips that itself.

### Verifying it works

Message the sandbox number from the phone you registered. You should get a reply
within a couple of seconds. Until the LLM layer lands, that reply is a
placeholder that says so.

Check the logs for `applied migration`, then a line per inbound message. A
`rejected webhook with invalid signature` warning points back to the checklist
above.

---

## 2. Claude / OpenAI / Gemini

_Arrives with the LLM layer. Set `LLM_PROVIDER` and the matching key; see
`.env.example`._

## 3. Google Calendar

The calendar is read with a **service account** — a robot Google account with its
own email address. Nobody has to stay logged in, and it can only read.

### Create the service account

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create
   a project (or pick an existing one).
2. **APIs & Services → Library →** search "Google Calendar API" → **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Give it a name like `villa-concierge`. No roles are needed — access is granted
   on the calendar itself, in the next step.
4. Open the new service account → **Keys → Add key → Create new key → JSON.**
   A `.json` file downloads. Treat it like a password.

### Share the calendar with it

**This is the step everyone forgets.** Creating the service account does not give
it access to anything.

1. Copy the service account's email address. It looks like
   `villa-concierge@your-project.iam.gserviceaccount.com`.
2. In Google Calendar, open the villa calendar's **Settings and sharing**.
3. Under **Share with specific people**, add that email with
   **See all event details**.
4. On the same settings page, copy the **Calendar ID** (often an address ending
   `@group.calendar.google.com`).

### Configure

```bash
GOOGLE_CALENDAR_ID=...@group.calendar.google.com
GOOGLE_SERVICE_ACCOUNT_FILE=./google-credentials.json
CALENDAR_TIMEZONE=Europe/Istanbul
CALENDAR_DEMO=false
```

Put the downloaded JSON at that path. It is already covered by `.gitignore`.

For hosts like Railway and Render that have no filesystem to upload to, paste the
entire JSON into `GOOGLE_SERVICE_ACCOUNT_JSON` instead — escaped newlines in the
private key are handled.

`CALENDAR_TIMEZONE` must be the **villa's** timezone, not the server's. It decides
what "tomorrow" means: at 21:30 UTC it is already the next day in Istanbul, and
getting this wrong gives guests the wrong day's schedule.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `404 ... check GOOGLE_CALENDAR_ID` | Wrong calendar ID, or the calendar isn't shared with the service account |
| `403 ... must be shared with the service account email` | Calendar exists but the service account has no access |
| Recurring events missing | Not possible via this client — it always expands them — but check the event actually repeats into the window |
| Times an hour or three off | `CALENDAR_TIMEZONE` doesn't match the villa's actual timezone |

### No calendar to test against?

The service account can create and own one itself, populated with the demo
itinerary — no manual setup, and no sharing step to forget:

```bash
npm run setup:calendar
```

It prints the new calendar's ID; put that in `GOOGLE_CALENDAR_ID` and set
`CALENDAR_DEMO=false`. To edit the events yourself in the normal Google Calendar
interface, share it with your own account:

```bash
npm run setup:calendar -- --share you@example.com
```

`--reset` replaces the events, `--delete` removes the calendar. This script asks
for read/write scope; the bot at runtime only ever requests read-only.

### Testing without Google

Set `CALENDAR_DEMO=true` and the bot uses a built-in villa itinerary that is
generated relative to today, so it never goes stale. This works even with
`DEMO_MODE=false`, which is how you test a real Twilio number before the Google
project exists.

## 4. Knowledge base

The bot answers house questions from a document your team maintains. Pick
whichever tool the team already lives in — `KB_PROVIDER` decides.

### Option A — Markdown files (default, no accounts)

```bash
KB_PROVIDER=local
KB_LOCAL_PATH=./kb
```

Files are read in filename order, which is why the samples are numbered
(`00-welcome.md`, `10-practical.md`, …). That numbering is how you control what
the assistant reads first.

### Option B — Notion

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) →
   **New integration**. Give it a name and copy the **Internal Integration Secret**.
2. Open the page you want the bot to read → **⋯** menu → **Connections** →
   add your integration. **Without this the page is invisible to the API**, even
   with a valid key.
3. Copy the page ID from its URL — the 32-character string after the title:
   `notion.so/Villa-Handbook-`**`8a3f...`**

```bash
KB_PROVIDER=notion
NOTION_API_KEY=ntn_...
NOTION_PAGE_ID=8a3f...
```

Headings, paragraphs, bullet and numbered lists, to-dos, quotes, callouts,
toggles, code blocks and tables are all converted to Markdown. Images and embeds
are skipped — the bot cannot read a picture to a guest over WhatsApp.

### Option C — Google Doc

The same service account that reads the calendar reads the document, so there is
nothing new to create.

1. Enable the **Google Docs API** in the same Cloud project.
2. Share the document with the service account email
   (`villa-concierge@…iam.gserviceaccount.com`), Viewer is enough.
3. Copy the document ID from its URL:
   `docs.google.com/document/d/`**`1AbC...`**`/edit`

```bash
KB_PROVIDER=google-doc
GOOGLE_DOC_ID=1AbC...
```

Heading styles become Markdown headings, so use Google Docs' built-in **Heading 1
/ Heading 2** styles rather than just making text bold — that is what gives the
assistant its structure.

### Refreshing

| How | When to use it |
|---|---|
| Automatic | Daily, per `KB_REFRESH_CRON` (default 04:00) |
| `POST /admin/kb/refresh` | You corrected something and need it live now |
| `GET /admin/kb` | Check what is loaded and when it last changed |

Both admin endpoints need the header `Authorization: Bearer $ADMIN_API_TOKEN`.

```bash
curl -X POST https://your-app/admin/kb/refresh \
  -H "Authorization: Bearer $ADMIN_API_TOKEN"
```

A refresh reports `changed: true` only when the content actually differs — the
history is a record of edits, not of how often the job ran.

If the source is unreachable, the bot keeps serving the last copy it stored
rather than losing its house knowledge until the outage ends.
