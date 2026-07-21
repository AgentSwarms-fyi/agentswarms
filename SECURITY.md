# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AgentSwarms, please **do not**
open a public GitHub issue.

Instead, email **hello@agentswarms.fyi** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal proof of concept helps a lot)
- Any suggested fix, if you have one

We'll acknowledge your report as soon as we can and follow up once the
issue is triaged. Please give us a reasonable amount of time to address the
issue before any public disclosure.

## Supported Versions

This project is deployed as a single continuously-updated application
rather than versioned releases, so security fixes are applied to the `main`
branch — there isn't a separate matrix of supported versions to track.

## Scope notes

- If you self-host this app, `SUPABASE_SERVICE_ROLE_KEY` and any provider
  API keys in your `.env` bypass Row Level Security / call billed
  third-party APIs directly — treat them as secrets and never expose them
  to client-side code (anything without a `VITE_` prefix stays server-only
  by design).
- See the [installation guide](./docs/INSTALL.md)
  for how environment variables and Supabase Row Level Security are
  expected to be configured.
