# Changelog

Notable changes to AgentSwarms. Newest first.

This file exists partly for you and partly for the person evaluating whether
this project is maintained — an absent changelog reads as abandonment risk
regardless of how active the commit log is.

Dates are the date work landed, not a release date. The project does not yet
cut numbered releases; see [ROADMAP.md](./ROADMAP.md).

---

## Unreleased

### Data sources

- **SaaS connectors.** Google Sheets, Stripe, Shopify, HubSpot and Salesforce
  sync into datasets on a shared ingest path — the same type inference,
  staging and snapshot-then-swap a CSV upload uses, so a synced dataset
  behaves identically to an uploaded one. Sync runs manually or on an hourly,
  daily or weekly schedule.
- **12 more databases and warehouses**, taking the total to 22: Microsoft SQL
  Server / Azure SQL, ClickHouse, CockroachDB, TimescaleDB, AlloyDB,
  Greenplum, YugabyteDB, MariaDB, SingleStore, StarRocks, Apache Doris and
  PlanetScale. Wire-compatible providers share one proven driver per protocol
  rather than getting near-duplicate implementations.
- **Fixed: 17 of 22 warehouse providers could not be saved.** The `provider`
  CHECK constraint had never been widened past the original five, so
  PostgreSQL, MySQL, Trino, Athena and Oracle — all long shipped — failed on
  insert with a constraint violation that named neither the provider nor the
  reason. A test now parses the constraint from the migrations and fails CI if
  it drifts from the TypeScript union again.

### Semantic layer

- **Relative date filters**: `last_n_days`, `this_month`, `last_month`,
  `this_quarter`, `last_quarter`, `ytd`. Half-open UTC windows resolved at
  query time, so a dashboard does not need editing as time passes.
- **Period-over-period**: `yoy`, `mom`, `prior_period`, adding `_prev`,
  `_change` and `_pct_change` per metric. Implemented as a date-shifted
  self-join rather than `LAG`, so a gap in the series cannot line a period up
  against the wrong predecessor.

### Query engine

- **DuckDB is now the default local engine**; `LOCAL_ENGINE=alasql` is the
  escape hatch. Rows load through DuckDB's appender rather than one
  parameterised INSERT per row: a 5,000-row aggregate went from 2,152 ms to
  19.6 ms.

### Security & governance

- **Per-agent semantic model allow-list**, deny by default. Enabling the
  Semantic Metrics tool alone no longer grants an agent every model in the
  account; it is also enforced when the tool runs, not only in what the agent
  is shown.
- **Swarm scheduler correctness**: the "claim" before a scheduled run was an
  unconditional update and claimed nothing, so two app instances could each
  fire the same scheduled swarm. Also, an interval of zero meant the swarm ran
  every tick, for ever.
- First test coverage for the AES-GCM credential encryption paths and for the
  scheduler.

### Site

- Public [Security](/security) and [Licensing & support](/license) pages.
- Dashboard surfaces failed syncs, unreachable connections, failed scheduled
  runs, and budget used this month.
