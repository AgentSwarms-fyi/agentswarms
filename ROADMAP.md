# Roadmap

Last reviewed: **2 August 2026**.

> Recently completed and no longer listed below: connection sharing through
> IAM, connection pooling, retry/backoff, corporate proxy support, scheduled
> connection health checks, credential-age surfacing, and the admin UI for
> trace retention. See [CHANGELOG.md](./CHANGELOG.md).

A roadmap is worth more to someone evaluating this project than to someone
using it: it is how they judge whether the gaps they just found are known.
So this lists what is _not_ done as plainly as what is planned, and it carries
a review date so you can tell whether it is being kept up.

Nothing here is a commitment or a delivery date. Items move.

---

## Now

- **Connector breadth.** 22 databases and warehouses, 5 SaaS apps. The
  connector subsystem is built and exercised, so each new source is a
  `listStreams` + `fetchRows` pair rather than new architecture. Next
  candidates by demand: Google Analytics, Zendesk, Jira, NetSuite, QuickBooks,
  Xero, Klaviyo, Intercom.
- **NL-to-SQL accuracy: 75.4% (46/61) on DuckDB, v3, single pass.** This
  replaces the old 88.9%, which was AlaSQL against a 45-question set with no
  joins and no window functions — the engine's limits had become the
  measurement's limits. v3 adds 7 join and 6 window/CTE questions, with floors
  in `tests/unit/nl2sqlEval.test.ts` so it cannot narrow again.

  **Provisional until someone runs `EVAL_REPEATS=3`** — both v3 passes so far
  are single runs, and the 1.6-point gap between them is inside the noise.

  Known work, in rough order of value:
  - `ratio` (1/3) and `window` (3/6) are the weak categories. Two failures are
    the same shape: an aggregate computed per-row then averaged, instead of
    summed then divided.
  - Two failures are harness defects, not model ones — see
    [TESTING.md](./docs/TESTING.md#two-failures-that-are-the-harnesss-fault-not-the-models).
  - DuckDB is stricter than AlaSQL about comparing a text column to a date;
    the prompt does not mention casting, and one question fails on it.

## Next

- **Scheduled sync for warehouse-backed datasets**, matching what SaaS sources
  now have.
- **Cost attribution by team**, so spend can be charged back rather than only
  totalled per user.
- **A time-range selector on the dashboard.** Figures are month-to-date with no
  way to change the window.
- **OAuth connectors.** Everything today uses a pasted credential — a service
  account, an API key, a private app token — because a redirect flow needs a
  public callback URL a self-hosted deployment may not have. Sources that
  offer no server-to-server credential are blocked on solving that properly.

## Known gaps

Stated because you will find them anyway.

- **No third-party certification.** Not SOC 2, ISO 27001 or HIPAA certified,
  and no penetration-test report to share. See [Security](./src/routes/security.tsx)
  for the posture and the limits.
- **No managed key rotation.** `PROVIDER_CREDS_SECRET` is an environment
  variable; rotating it does not re-encrypt anything automatically. Connection
  credentials now surface their **age** so a stale one is visible, but rotating
  is still a manual re-save.
- **Pool and rate limits are per process.** Behind a load balancer each replica
  enforces its own, so multiply by replica count when sizing against a
  warehouse's `max_connections`. A cluster-wide budget needs shared state.
- **No numbered releases.** The project ships from `main`. Versioned releases
  and an upgrade guide are wanted, not yet done.
- **Local datasets run on two engines.** The SQL workbench and the BI
  Workspace's "Ask AI" execute local datasets in the **browser on AlaSQL**;
  scheduled refreshes, prep flows, the semantic runner and the agents'
  `sql_query` tool run on the **server, DuckDB by default**. Measured with
  `npx vite-node evals/nl2sql/engine-gap.ts`: **56/61 vs 61/61**, every failure
  a window function, and three of the five return a wrong answer silently
  rather than erroring — a running total comes back as `0` for every row.

  All five are now in the differential corpus with recorded reasons, so the
  gap cannot widen unnoticed. Closing it means either routing browser SQL to
  the server (a network round trip per run) or shipping DuckDB-WASM to the
  browser (a large bundle). Neither is obviously right, which is why it is
  written down rather than decided.

- **Single-tenant dashboard view.** No org/workspace switcher — the dashboard
  shows what your account can see, with no scope selector.
- **The BI builder pane is a 2,660-line component.** Its pure logic has been
  extracted and tested; the component split itself is outstanding.
- **364 lint warnings** (0 errors), tracked as debt. Previously recorded here
  as "~360 `no-explicit-any`", which was wrong — that is one of three rules and
  not the largest:
  - `react-refresh/only-export-components` — 208. Cosmetic: it costs
    HMR granularity in dev, nothing at runtime. Mostly files that export a
    lookup table alongside their components.
  - `@typescript-eslint/no-explicit-any` — 140. The real type debt.
  - `react-hooks/exhaustive-deps` — 16. The ones worth a human: mostly a
    `load()` deliberately omitted so an effect runs once, which is usually
    right, but each needs checking individually rather than a blanket fix that
    could turn one into a render loop.

## Not planned

- **A hosted multi-tenant version of this repository.** The hosted service at
  agentswarms.fyi is separate. See [Licensing](./src/routes/license.tsx).
- **Bundled model weights or an inference server.** Bring your own provider.
