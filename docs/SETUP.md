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

_Arrives with the calendar integration._

## 4. Notion or Google Docs knowledge base

_Arrives with the knowledge base providers._
