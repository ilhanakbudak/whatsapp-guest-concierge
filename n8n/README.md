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

The service already performs the daily knowledge-base refresh internally via
`KB_REFRESH_CRON`. These workflows are an **optional** layer for teams who want
the run visible in their own tooling and a notification when something changes —
not a dependency.

Both are deliberately quiet. The refresh posts to Slack only when the content
actually changed; the digest says nothing on a day with no announcements. A daily
message that is almost always identical gets muted within a week, and then the
one that mattered gets muted with it.

## Importing

**Workflows → Import from File**, then set two environment variables on your n8n
instance:

| | |
|---|---|
| `CONCIERGE_URL` | Your deployed base URL, no trailing slash |
| `ADMIN_API_TOKEN` | The same value as the service's `ADMIN_API_TOKEN` |

Both workflows send `Authorization: Bearer {{ $env.ADMIN_API_TOKEN }}`, so the
token is never stored in the workflow JSON — which matters, because these files
are committed.

The Slack nodes post to `#villa-ops`. Change the channel, or swap them for email,
Telegram, or anything else; nothing downstream depends on Slack.

## Why the logic is not in n8n

Signature verification, an agentic tool-use loop, and a broadcast queue with retry
and delivery tracking are code. They belong somewhere they can be typechecked,
tested and reviewed in a diff. A visual workflow gives up all three.

What n8n is genuinely good at is scheduled glue between systems that already have
APIs — which is exactly and only what these two workflows do.
