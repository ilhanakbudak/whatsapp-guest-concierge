# Security policy

## Reporting a vulnerability

**Please do not open a public issue.**

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/ilhanakbudak/whatsapp-guest-concierge/security/advisories/new).
That opens a draft advisory only you and I can see.

Useful to include, if you have it: what an attacker can do, the smallest steps
that reproduce it, and the commit or version you were on.

I will acknowledge within 72 hours, tell you whether I agree it is a
vulnerability and what I intend to do about it, and credit you in the advisory
unless you would rather I did not. If you plan to disclose publicly, 90 days is
a reasonable window and I will usually be finished well inside it.

## Scope

This repository is a reference implementation. It is not a hosted service, so
there is no production system to attack — reports are about the code and its
defaults.

**In scope**

- Bypassing Twilio webhook signature verification
- Bypassing the guest allowlist to reach the model
- Authentication or authorisation flaws in the admin API or dashboard
- Prompt injection that causes the assistant to leak another guest's data or
  take an action outside its declared tools
- Secrets or personal data leaking into logs, error responses or the built image
- Insecure defaults in `.env.example`, the Dockerfile, or the deployment configs

**Out of scope**

- Anything requiring the attacker to already hold the admin token or the host's
  credentials
- Vulnerabilities in Twilio, Google, Notion or a model provider — report those to
  them
- Denial of service by sending a very large volume of messages; rate limiting is
  per-guest by design and the platform in front of it is expected to do the rest
- Findings from an automated scanner with no demonstrated impact

## What this project already does

So you can skip the ground that is covered:

- Inbound webhooks are rejected unless the Twilio signature verifies against the
  exact request URL and body
- Unknown numbers get a fixed decline and never reach the model
- The admin API requires a bearer token; the dashboard holds it in
  `sessionStorage`, never in a cookie or the URL
- Phone numbers are redacted from logs in production
- The Docker image runs unprivileged, and CI asserts the built image contains no
  credentials

## Supported versions

The `main` branch. This is not a versioned product; fixes land there.
