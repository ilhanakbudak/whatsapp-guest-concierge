# n8n workflows

The brief preferred n8n for automation. This repository takes a deliberate split:

**n8n orchestrates; it does not host the logic.**

Signature verification, an agentic tool-use loop, and a broadcast queue with retry
and delivery tracking are code. They belong in a repository where they can be
reviewed, typechecked and tested — not in a visual workflow where none of that is
possible.

What n8n *is* genuinely good at is scheduled glue between systems, so that is what
lives here.

| Workflow | What it does |
|---|---|
| `kb-daily-refresh.json` | Calls `POST /admin/kb/refresh` on a schedule, posts the result to Slack |
| `daily-summary.json` | Pulls delivery stats and posts a morning digest |

> These exports land with the deployment phase. The service already performs the
> daily knowledge-base refresh internally via `KB_REFRESH_CRON`, so n8n is an
> optional layer for teams that want the run visible in their own tooling.

## Importing

**Workflows → Import from File**, then set two credentials:

- `CONCIERGE_URL` — your deployed base URL
- `ADMIN_API_TOKEN` — the same token as the service's `.env`
