# Deployment

One Node process and one SQLite file. No database server, no queue, no Redis.

Deploy it as a container, or let the platform build it natively — both work.
`Dockerfile`, `railway.json` and `render.yaml` are in the repository.

---

## Docker

```bash
docker build -t concierge .
docker run -p 3000:3000 -e DEMO_MODE=true -v concierge-data:/data concierge
```

Multi-stage, so TypeScript sources and dev dependencies never reach the published
image. It runs as the unprivileged `node` user, uses `tini` as PID 1 so `SIGTERM`
reaches Node and the graceful shutdown path actually drains in-flight replies, and
its `HEALTHCHECK` hits `/health/ready` rather than `/health` — a liveness-only
check would report healthy with an unreachable database.

**The image is built and exercised in CI on every push**, not verified once on a
developer's machine and left to rot. The `docker` job builds it, boots it, and
asserts that it becomes ready, runs unprivileged, still rejects unsigned webhooks
with a 403, still returns 401 on the admin API, and contains no `.env` or
`secrets/`.

> You do not need Docker locally to work on this repository. CI is the
> verification.

The image is ~330 MB. It was 505 MB until the `googleapis` meta-package was
replaced with `@googleapis/calendar` and `@googleapis/docs` — the meta-package
bundles every Google API and is 182 MB on its own, of which this service uses two.

### Without Docker

Both target platforms detect Node and build natively — Railway via Nixpacks,
Render via its Node runtime. Delete `dockerfilePath` from `railway.json` or set
`runtime: node` in `render.yaml` and the same `npm ci && npm run build && npm start`
applies.

## Requirements

- Node 22 or newer
- A persistent disk for the SQLite file
- A public HTTPS URL — Twilio signs the URL it calls, so it must be stable

## Build and run

```bash
npm ci
npm run build
npm start
```

## Environment

Copy `.env.example` and fill it in. The variables that must be right in
production:

| Variable | Why it matters |
|---|---|
| `PUBLIC_URL` | Must **exactly** match the webhook URL configured in Twilio, including protocol. Signature validation rebuilds this URL. |
| `DEMO_MODE` | `false`. Config validation then requires credentials for every integration not individually mocked. |
| `ADMIN_API_TOKEN` | Boot fails in production if this is still `change-me`. |
| `TWILIO_VALIDATE_SIGNATURE` | Boot fails in production if this is `false`. |
| `DATABASE_PATH` | Point at the mounted disk, not the ephemeral filesystem. |
| `CALENDAR_TIMEZONE` | The **villa's** timezone, not the server's. It decides what "tomorrow" means. |

Secrets go in the platform's environment settings, never in the repository. For
the Google service account, paste the JSON into `GOOGLE_SERVICE_ACCOUNT_JSON`
rather than uploading a file — escaped newlines in the private key are handled.

---

## Railway

1. **New Project → Deploy from GitHub repo.**
2. Railway detects Node and runs `npm run build` then `npm start`.
3. **Variables** — paste the contents of your `.env`.
4. **Settings → Volumes** — mount a volume at `/data`, then set
   `DATABASE_PATH=/data/concierge.db`. Without this the database is wiped on every
   deploy.
5. **Settings → Networking → Generate Domain**, and set `PUBLIC_URL` to it.
6. Point the Twilio webhooks at `https://<domain>/webhooks/twilio/inbound` and
   `/webhooks/twilio/status`.

## Render

1. **New → Web Service**, connect the repository.
2. Build `npm ci && npm run build`, start `npm start`.
3. **Disks** — add a disk mounted at `/data`, set `DATABASE_PATH=/data/concierge.db`.
4. **Environment** — paste your variables.
5. Set `PUBLIC_URL` to the `.onrender.com` URL, then configure the Twilio webhooks.

> On Render's free tier the service sleeps when idle. The first message after a
> sleep will be slow enough that Twilio may time out. Use a paid instance for
> anything a guest depends on.

---

## After deploying

```bash
curl https://your-app/health/ready
```

```json
{ "status": "ok", "demoMode": false,
  "llm": { "provider": "anthropic", "model": "claude-opus-5" }, "guests": 12 }
```

Then verify each integration:

```bash
npm run check:twilio      # sender, who has joined, open messaging windows
npm run check:calendar    # credentials, visible calendars, upcoming events
npm run check:llm         # a real conversation, with token cost
```

### Health endpoints

| Endpoint | Use for |
|---|---|
| `GET /health` | Liveness — the process is up |
| `GET /health/ready` | Readiness — database reachable, integrations resolved |

---

## Operational notes

**Backups.** The whole application state is one SQLite file. Copy it.

**Restarts are safe.** Broadcasts interrupted mid-flight resume automatically;
recipients stranded mid-send are requeued.

**Logs.** JSON via pino. Phone numbers are redacted when `NODE_ENV=production`.

**Cost.** `GET /admin/kb` and the `usage_events` table expose token spend and the
prompt-cache hit rate. A hit rate near zero means something volatile has crept
above the cache breakpoint in the system prompt.

**Scaling.** Designed for one instance. The rate limiter is in-process, so running
several instances makes the limit per-instance — a documented weakening rather
than a silent bug. A holiday group is a dozen people; one instance is correct.
