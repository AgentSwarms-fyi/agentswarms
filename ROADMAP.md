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
- **NL-to-SQL accuracy — no valid number currently exists.** The last figure,
  88.9% (40/45, strict, three runs), was measured against AlaSQL; DuckDB has
  been the default since, and the engine moves the score on its own. Do not
  quote it.

  The question set has been rebuilt to make the next measurement worth having.
  It was 45 questions with **zero joins and zero window functions** — the
  engine's limits had become the measurement's limits, so the score said
  nothing about the operations a BI tool is most asked for. v3 is 61 questions
  including 7 joins and 6 window/CTE questions, with floors in
  `tests/unit/nl2sqlEval.test.ts` so it cannot narrow again.

  What remains is the run itself: it needs a live app, an access token and some
  model spend. Expect the number to move in both directions at once — AlaSQL's
  reserved-word failures disappear, and harder questions arrive.

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
