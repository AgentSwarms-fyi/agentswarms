# Contributing to AgentSwarms

Thanks for taking the time to contribute!

## Getting set up

Follow the [installation guide](./docs/INSTALL.md)
to get a local dev environment running (Node/Bun, your own Supabase project,
environment variables).

## Workflow

1. Fork the repo and create a branch off `main`:
   `git checkout -b your-name/short-description`
2. Make your changes. Keep pull requests focused — one logical change per
   PR is easier to review than a bundle of unrelated fixes.
3. Run the linter and formatter before opening a PR:
   ```bash
   npm run lint
   npm run format
   ```
4. If your change touches the database schema, add a new migration under
   `supabase/migrations/` rather than editing an existing one — migrations
   are append-only and already applied to running instances.
5. Open a pull request describing **what** changed and **why**. Link any
   related issue.

## Reporting bugs

Open a GitHub issue with:

- Steps to reproduce
- What you expected vs. what happened
- Browser/OS and Node version, if relevant

## Reporting security issues

Please don't open a public issue for security vulnerabilities — see
[SECURITY.md](./SECURITY.md) instead.

## Code style

- TypeScript, formatted with Prettier (`npm run format`) and linted with
  ESLint (`npm run lint`) — both are configured in the repo, just run them.
- Match the conventions of the surrounding code (naming, file
  organization) rather than introducing a new pattern for a single change.

## Code of Conduct

This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md). By
participating, you're expected to uphold it.
