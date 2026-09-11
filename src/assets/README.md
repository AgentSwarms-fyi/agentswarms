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

### Which ones are missing

There used to be a hand-written list here, and it went stale the moment a
connector was added: it claimed "12 of 22 warehouses and all 5 apps" while the
app had grown to 23 warehouses and 17 apps. Nothing kept it in step, and
nothing could — so the list is gone rather than wrong.

Ask the running app instead, where the answer cannot be out of date: open
**Integrations → Data Sources** and **Integrations → Apps**, and every tile
showing two letters instead of a mark is a provider without a logo. Against the
tree, it is the difference between the ids in `WAREHOUSE_PROVIDERS` /
`SAAS_PROVIDERS` and the `.svg` filenames in the two directories above.

No app logos are bundled at all today — they are trademarked marks the project
may not have the right to redistribute, which is the next section's subject.
Initials are a deliberate fallback rather than a gap to close in a hurry:
**a connector must never be blocked on sourcing a logo.**

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
