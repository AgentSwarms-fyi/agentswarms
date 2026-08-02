# Roadmap

Last reviewed: **2 August 2026**.

> Recently completed and no longer listed below: connection sharing through
> IAM, connection pooling, retry/backoff, corporate proxy support, scheduled
> connection health checks, credential-age surfacing, the admin UI for trace
> retention, and **one SQL engine everywhere** — the browser now runs
> DuckDB-Wasm instead of AlaSQL, closing a divergence that returned silently
> wrong answers for window functions. See [CHANGELOG.md](./CHANGELOG.md).

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
- **The scope switcher covers SPEND, not the whole dashboard.** The Spend &
  usage panel can be read as you / your teams / the organisation, but the
  workspace tiles, activity chart and recent runs above it are still your own
  rows only. Widening those means moving each to a server function with the
  same authorisation, which is worth doing and is not done.
- **The BI builder pane is still 1,754 lines**, down from 2,664, across seven
  components. What is left that could come out is the **field-slot mapping** —
  ~132 lines deciding which field pickers each chart type needs. It touches
  **35** of the parent's values, which is roughly fifteen field/setter pairs
  that any extraction has to take together, so making it separable means a
  reducer or a config object for the field state: a design change, not a split.

  This entry previously said the whole 751-line chart editor was staying put
  because it needed 84 of the parent's values. **That measurement was wrong**,
  and the way it was wrong is worth keeping. The chart editor is a chain of
  `chartType === …` tests that are mutually exclusive, so 84 was a union over
  branches that never render together, not the coupling of anything in it.
  Measured per region, the conditional-formatting editor buried inside needed
  six, and four more regions were in the same position. A union over exclusive
  branches is not a coupling measure. The rule that survives is lines-per-prop:
  everything extracted carries **≥ 9**, what remains carries **3.8**, and
  `tests/unit/biBuilderSplit.test.ts` enforces the floor.

- **365 lint warnings** (0 errors), tracked as debt. Previously recorded here
  as "~360 `no-explicit-any`", which was wrong — that is one of three rules and
  not the largest:
  - `react-refresh/only-export-components` — 210. Cosmetic: it costs
    HMR granularity in dev, nothing at runtime. Mostly files that export a
    lookup table alongside their components.
  - `@typescript-eslint/no-explicit-any` — 139. The real type debt.
  - `react-hooks/exhaustive-deps` — 16. The ones worth a human: mostly a
    `load()` deliberately omitted so an effect runs once, which is usually
    right, but each needs checking individually rather than a blanket fix that
    could turn one into a render loop.

## Not planned

- **A hosted multi-tenant version of this repository.** The hosted service at
  agentswarms.fyi is separate. See [Licensing](./src/routes/license.tsx).
- **Bundled model weights or an inference server.** Bring your own provider.
