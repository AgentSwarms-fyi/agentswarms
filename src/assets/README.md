# Bundled assets

## Connector logos

Logos are **discovered by filename**, not registered in code. Drop an SVG in
and it appears on the next build; there is nothing to import and no list to
edit.

| Directory                | Used by                             | Filename must be |
| ------------------------ | ----------------------------------- | ---------------- |
| `src/assets/warehouses/` | Integrations → **Data Sources** tab | `<provider>.svg` |
| `src/assets/saas/`       | Integrations → **Apps** tab         | `<provider>.svg` |

`<provider>` is the id in `WarehouseProvider` / `SaasProvider`
(`src/utils/warehouse/types.ts`, `src/utils/saas/types.ts`) — not the display
label. So `sqlserver.svg`, not `SQL Server.svg`.

A provider with no asset renders its initials instead. That is a deliberate
fallback, not a bug: **a connector must never be blocked on sourcing a logo.**

### Currently missing

12 of 22 warehouses and all 5 apps. These render initials today:

```
src/assets/warehouses/sqlserver.svg      src/assets/warehouses/singlestore.svg
src/assets/warehouses/clickhouse.svg     src/assets/warehouses/starrocks.svg
src/assets/warehouses/cockroachdb.svg    src/assets/warehouses/doris.svg
src/assets/warehouses/timescaledb.svg    src/assets/warehouses/planetscale.svg
src/assets/warehouses/alloydb.svg        src/assets/warehouses/mariadb.svg
src/assets/warehouses/greenplum.svg      src/assets/warehouses/yugabytedb.svg

src/assets/saas/google_sheets.svg        src/assets/saas/hubspot.svg
src/assets/saas/stripe.svg               src/assets/saas/salesforce.svg
src/assets/saas/shopify.svg
```

### Before adding one — licensing

This repository is redistributed under ELv2, so a bundled logo is a logo you
are redistributing. Check the source before adding it.

**Safe by default — [Simple Icons](https://simpleicons.org) (CC0 1.0).** The
icons themselves are public domain. Covers most of the list above, including
ClickHouse, CockroachDB, MariaDB, PlanetScale, SingleStore, Stripe, Shopify,
HubSpot, Salesforce and Google Sheets. This is where the existing Snowflake,
Databricks and BigQuery marks came from.

**Needs a check — vendor brand pages.** AlloyDB, Greenplum, YugabyteDB,
StarRocks, Doris and Azure SQL are not all in Simple Icons. Their brand
guidelines usually permit **nominative use** — identifying the product you
integrate with — while prohibiting anything implying partnership or
endorsement. Read the specific terms; they are not interchangeable.

**Never** redraw a trademark by hand or generate an approximation. A wrong logo
is worse than initials: it looks careless and invites a complaint.

### Conventions

- **SVG only**, so the mark stays sharp at any size and in both themes.
- Strip `width`/`height` from the root element and keep the `viewBox` — the
  tile sizes it with `object-contain`.
- Keep the file small. These load on the Integrations page; a 200 KB SVG with
  embedded raster data defeats the point.
- Record where it came from and under what licence in
  [`ACKNOWLEDGEMENTS.md`](../../ACKNOWLEDGEMENTS.md).

Simple Icons ships single-colour paths that inherit `currentColor`. That is
usually what you want — a marketing-coloured logo can look wrong on a dark
background, and the tile already provides its own white backing.
