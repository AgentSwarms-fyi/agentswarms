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
3. Run the checks CI runs, before opening a PR:
   ```bash
   npm run lint
   npm run format
   npm run typecheck
   npm run test
   ```

   `npm run typecheck` generates `src/routeTree.gen.ts` first, and that is not
   incidental. The route tree is built by the TanStack Router plugin during
   `vite dev` / `vite build` and is **gitignored** — tracking it put a
   meaningless 3,000-line diff on nearly every branch. But `src/router.tsx`
   imports it, so a clone that has never run the dev server cannot typecheck:
   you get `Cannot find module './routeTree.gen'` followed by around forty
   cascading errors naming route files that are perfectly fine. Run
   `npm run generate:routes` (or the dev server, or a build) and they all go
   away.
4. If your change touches the database schema, add a new migration under
   `supabase/migrations/` rather than editing an existing one — migrations
   are append-only and already applied to running instances.

   **Take the next number after the highest file already there — do not use
   today's date.** The version prefixes in this directory are a synthetic
   counter that has run ahead of the calendar (you will see a "day" of 32 or
   71), and `supabase db push` keys on that prefix: a version that duplicates
   an existing one, or sorts before it, is treated as **already applied and
   silently skipped**. The failure surfaces much later as "table not found in
   schema cache" against a migration that looks present in the repo.
   `tests/unit/migrations.test.ts` fails on a duplicate, but only after you
   have created it.

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
