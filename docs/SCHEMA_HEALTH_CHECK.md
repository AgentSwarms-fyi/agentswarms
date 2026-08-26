# Database schema health check

A contributor runs `git pull`, gets code that reads or writes a column or
table a recent migration added, but never re-applies migrations against
their local or linked Supabase project. PostgREST rejects the query —
`42703 undefined_column` for a missing column, `PGRST205` (hosted
Supabase's own "not in the schema cache" error — see below) for a missing
table — and without this feature that shows up as a broken page or an
unhandled rejection, with nothing telling the contributor "run your
migrations" is the fix.

This page is the integration guide. For how the detection itself works, read
the comments in [`src/lib/schemaHealthCheck.ts`](../src/lib/schemaHealthCheck.ts) —
they're kept in sync with the code and are more likely to stay accurate than
a duplicate explanation here.

## How it's wired into the app

Three pieces, already in place:

1. **`src/lib/schemaHealthCheck.ts`** — the detection logic. Two layers:
   - `checkSchemaHealth()`: a proactive startup check against
     `REQUIRED_SCHEMA_CHECKS`, a short maintainer-curated list of
     "recently added, load-bearing" columns/tables.
   - `installSchemaHealthFetchInterceptor()`: a reactive `window.fetch`
     patch that inspects (never alters) every response from the Supabase
     REST endpoint, so a missing column/table not in the curated list still
     gets caught — just one query later, whenever something actually
     queries it.
2. **`src/components/SchemaHealthModal.tsx`** — the self-contained,
   presentational modal: diagnostic text, the list of issues found, and
   copyable `supabase db push` / `migration up` / `db reset` commands.
3. **`src/components/SchemaHealthGuard.tsx`** — the orchestrator. Mounted
   once in [`src/routes/__root.tsx`](../src/routes/__root.tsx) alongside
   `<Toaster />` and `<CookieConsent />`, so it runs for every route, authed
   or not. Runs both detection layers on mount and renders the modal if
   either one finds something. Renders nothing on a healthy database.

**If you're integrating this pattern into your own project** (a different
app, or a rewrite of this one), the one place to add it is the root
layout/shell component that every route renders through — for a plain SPA
that's usually the top-level `<App />`; for this router it's `__root.tsx`'s
`RootComponent`. Don't put it inside an auth-gated layout only: an
unapplied migration can break the public landing page's queries just as
easily as a dashboard's.

## Registering a new check

Whenever you ship a migration that adds a column or table a page reads on
first render (so a contributor hits it immediately, not three clicks in),
add one entry to `REQUIRED_SCHEMA_CHECKS` in `schemaHealthCheck.ts`:

```ts
{
  table: "agents",
  column: "my_new_column",
  migration: "20261231000000_my_migration.sql",
  description: "One line of human context, shown in the modal.",
},
```

Omit `column` to check that the table itself exists instead of one column
on it (see the `slack_workspaces` entry for an example).

**Keep this list short.** It's a deliberately curated set of "known
landmines," not a mirror of every migration the project has ever shipped —
anything you don't add still gets caught by the reactive fetch interceptor
the moment it's actually queried. Only add the ones load-bearing enough
that a contributor would hit them on their very first click around the app.

## A real gotcha this caught during development

The first version of `checkSchemaHealth` used `{ head: true }` to keep each
probe as cheap as possible (no rows fetched). Verified against a live
Supabase project, that turned out to silently defeat every check: an HTTP
`HEAD` response has no body by spec, so PostgREST can't attach error
details to a failed one — every failure came back as a bodyless
`{ message: "" }` with no `.code`, so nothing was ever detected. The fix was
`.limit(0)` instead: still fetches zero rows, but as a real `GET`, so the
error body (and its `.code`) actually comes through.

The same verification pass found that hosted Supabase's PostgREST resolves
table names against its own schema cache _before_ a query reaches Postgres,
so a genuinely missing table surfaces as `PGRST205` ("Could not find the
table ... in the schema cache"), not the raw Postgres `42P01`. The code
checks for both, but if you're running this against a different
PostgREST/Postgres setup and a table-check silently doesn't fire, that
code mismatch is the first thing to check.

## Limitations (by design)

- **RLS-locked tables can produce false negatives.** If the `anon`/
  `authenticated` role has no `GRANT` at all on a table, Postgres may
  reject the query on permission grounds before it would have reported a
  missing column, so that specific check just won't fire. This is an
  accepted trade-off for a lightweight, no-auth-required startup check
  rather than something the tool tries to work around.
- **The curated list only covers what maintainers remember to add.**
  That's what the reactive fetch interceptor is for — treat the proactive
  list as "catch the common ones immediately," not as exhaustive coverage.
- **Dismissing the modal is session-scoped**, not permanent — the
  underlying problem (an unapplied migration) hasn't gone away just because
  the modal was closed, so it resurfaces on the next fresh load rather than
  staying silent indefinitely.
