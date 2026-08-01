# Roadmap

Last reviewed: **2 August 2026**.

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
- **NL-to-SQL accuracy.** Last measured 88.9% (40/45, strict, three runs) —
  but that was against AlaSQL, and DuckDB is now the default engine, so the
  number needs re-measuring before it means anything. The question set also
  needs to grow past 45 with multi-table joins and genuine ambiguity.

## Next

- **Scheduled sync for warehouse-backed datasets**, matching what SaaS sources
  now have.
- **Cost attribution by team**, so spend can be charged back rather than only
  totalled per user.
- **An admin UI for trace retention.** The purge is implemented and runs; the
  setting can currently only be changed by writing to the database.
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
  variable; rotating it does not re-encrypt anything automatically.
- **No numbered releases.** The project ships from `main`. Versioned releases
  and an upgrade guide are wanted, not yet done.
- **Single-tenant dashboard view.** No org/workspace switcher — the dashboard
  shows what your account can see, with no scope selector.
- **The BI builder pane is a 2,700-line component.** Its pure logic has been
  extracted and tested; the component split itself is outstanding.
- **~360 `no-explicit-any` lint warnings**, tracked as debt.

## Not planned

- **A hosted multi-tenant version of this repository.** The hosted service at
  agentswarms.fyi is separate. See [Licensing](./src/routes/license.tsx).
- **Bundled model weights or an inference server.** Bring your own provider.
