# Acknowledgements

AgentSwarms is built on the shoulders of many excellent open-source
projects. This page credits the ones we depend on directly, with their
licenses and repositories. Thank you to every maintainer and contributor
behind them.

**License audit summary** — the direct dependencies use permissive licenses
(MIT, Apache-2.0, ISC, BSD-2-Clause, MIT-0). There is **no strong copyleft**
in the tree — **no GPL-only or AGPL** code — so AgentSwarms can be distributed
under its own terms, the **source-available [Elastic License 2.0](./LICENSE)**.
A few transitive dependencies carry weak or dual licenses, both compatible with
that redistribution: **jszip** (`MIT OR GPL-3.0`, used under MIT — reached via
`docx`, `mammoth` and `pptxgenjs`) and **lightningcss** (MPL-2.0 — a build-time
CSS tool reached via Vite, weak per-file copyleft, not part of the shipped
bundle). Apache-2.0 dependencies require their
license and notice files to travel with their source, which `npm install`
preserves inside `node_modules`. To regenerate the full list at any time:

```bash
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));for(const n of Object.keys({...p.dependencies,...p.devDependencies}).sort()){try{console.log(n,'—',JSON.parse(fs.readFileSync('node_modules/'+n+'/package.json')).license)}catch{}}"
```

## Application framework

| Project                                                                                                                                                                                                            | License | Used for                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | -------------------------------------------------------------- |
| [React](https://github.com/facebook/react)                                                                                                                                                                         | MIT     | UI runtime                                                     |
| [TanStack Start / Router / Query](https://github.com/TanStack/router)                                                                                                                                              | MIT     | Framework, file-based routing, server functions, data fetching |
| [Vite](https://github.com/vitejs/vite)                                                                                                                                                                             | MIT     | Build tooling and dev server                                   |
| [Nitro](https://github.com/nitrojs/nitro)                                                                                                                                                                          | MIT     | Server runtime                                                 |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss)                                                                                                                                                        | MIT     | Styling                                                        |
| [shadcn/ui](https://github.com/shadcn-ui/ui) + [Radix UI](https://github.com/radix-ui/primitives)                                                                                                                  | MIT     | Accessible UI primitives and components                        |
| [Framer Motion](https://github.com/motiondivision/motion)                                                                                                                                                          | MIT     | Animations                                                     |
| [Lucide](https://github.com/lucide-icons/lucide)                                                                                                                                                                   | ISC     | Icon set                                                       |
| [Zod](https://github.com/colinhacks/zod)                                                                                                                                                                           | MIT     | Runtime validation                                             |
| [sonner](https://github.com/emilkowalski/sonner), [cmdk](https://github.com/pacocoursey/cmdk), [vaul](https://github.com/emilkowalski/vaul), [react-hook-form](https://github.com/react-hook-form/react-hook-form) | MIT     | Toasts, command menu, drawers, forms                           |

## Agents & AI

| Project                                                                                                                                                                                | License | Used for                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------- |
| [LangChain.js / LangGraph](https://github.com/langchain-ai/langchainjs)                                                                                                                | MIT     | Agent runtime, RAG pipelines, swarm export targets |
| [XYFlow (React Flow)](https://github.com/xyflow/xyflow)                                                                                                                                | MIT     | The visual swarm canvas                            |
| [CodeMirror](https://github.com/codemirror/dev)                                                                                                                                        | MIT     | Code editors (SQL, Python, Markdown)               |
| [react-markdown](https://github.com/remarkjs/react-markdown) + [remark-gfm](https://github.com/remarkjs/remark-gfm) + [rehype-highlight](https://github.com/rehypejs/rehype-highlight) | MIT     | Markdown rendering with syntax highlighting        |

## Business Intelligence & data

| Project                                                                                                                                                  | License      | Used for                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| [Recharts](https://github.com/recharts/recharts)                                                                                                         | MIT          | Chart rendering                                                                                          |
| [DuckDB](https://github.com/duckdb/duckdb) ([duckdb-wasm](https://github.com/duckdb/duckdb-wasm), [node-api](https://github.com/duckdb/duckdb-node-neo)) | MIT          | The default SQL engine for local datasets — in the browser via WASM, and server-side for refreshes       |
| [AlaSQL](https://github.com/AlaSQL/alasql)                                                                                                               | MIT          | Fallback SQL engine for local datasets, selected with `LOCAL_ENGINE=alasql`                              |
| [d3-force](https://github.com/d3/d3-force) / [d3-geo](https://github.com/d3/d3-geo)                                                                      | ISC          | Ontology graph layout, filled & bubble maps                                                              |
| [topojson-client](https://github.com/topojson/topojson-client) + [world-atlas](https://github.com/topojson/world-atlas)                                  | ISC          | Map geometry (derived from the public-domain [Natural Earth](https://www.naturalearthdata.com/) dataset) |
| [pdf-lib](https://github.com/Hopding/pdf-lib)                                                                                                            | MIT          | Dashboard PDF export                                                                                     |
| [html2canvas-pro](https://github.com/yorickshan/html2canvas-pro)                                                                                         | MIT          | Widget/dashboard rasterisation for PDF & PNG export                                                      |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS)                                                                                                       | MIT          | AI-generated PowerPoint files (Agent Chat)                                                               |
| [docx](https://github.com/dolanmiu/docx)                                                                                                                 | MIT          | AI-generated Word documents (Agent Chat)                                                                 |
| [write-excel-file](https://gitlab.com/catamphetamine/write-excel-file)                                                                                   | MIT          | AI-generated Excel workbooks with live formulas (Agent Chat)                                             |
| [Papa Parse](https://github.com/mholt/PapaParse)                                                                                                         | MIT          | CSV parsing                                                                                              |
| [node-sql-parser](https://github.com/taozhi8833998/node-sql-parser)                                                                                      | Apache-2.0   | SQL validation                                                                                           |
| [pdfjs-dist](https://github.com/mozilla/pdf.js)                                                                                                          | Apache-2.0   | PDF text extraction for knowledge bases                                                                  |
| [mammoth](https://github.com/mwilliamson/mammoth.js)                                                                                                     | BSD-2-Clause | DOCX text extraction for knowledge bases                                                                 |

### Bundled open datasets

The sample datasets under `src/assets/sample-data/` include cleaned extracts
of these open data sources (all CC-BY 4.0 — attribution required, retained
here and in the in-app dashboard descriptions):

- **[FiveThirtyEight NBA Elo](https://github.com/fivethirtyeight/data/tree/master/nba-elo)**
  — `nba_team_seasons.csv`, game-level Elo aggregated to team-seasons
  (1977–2015).
- **[World Bank Open Data](https://data.worldbank.org/)** —
  `world_health_indicators.csv`: life expectancy, health expenditure,
  physicians, infant mortality and population for 45 countries (2000–2022).
- **[Our World in Data — Energy](https://github.com/owid/energy-data)**
  (Ember & Energy Institute source data) — `global_electricity.csv`:
  electricity generation by source for the world and 28 countries
  (1990–2023).

Sample dashboard backgrounds use public-domain NASA imagery
([NASA Image and Video Library](https://images.nasa.gov/): Black Marble city
lights, ISS aurora, SDO sun).

## Backend & connectivity

| Project                                                                                                     | License          | Used for                                               |
| ----------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------ |
| [Supabase](https://github.com/supabase/supabase) (+ [supabase-js](https://github.com/supabase/supabase-js)) | Apache-2.0 / MIT | Postgres, Auth, Storage, pgvector — the entire backend |
| [node-postgres (pg)](https://github.com/brianc/node-postgres)                                               | MIT              | PostgreSQL / Redshift-compatible connections           |
| [mysql2](https://github.com/sidorares/node-mysql2)                                                          | MIT              | MySQL / MariaDB connections                            |
| [tedious](https://github.com/tediousjs/tedious)                                                             | MIT              | Azure Synapse (T-SQL) connections                      |
| [Nodemailer](https://github.com/nodemailer/nodemailer)                                                      | MIT-0            | Budget alert e-mails                                   |
| [React Email](https://github.com/resend/react-email)                                                        | MIT              | E-mail templates                                       |

## Tooling

[TypeScript](https://github.com/microsoft/TypeScript) (Apache-2.0),
[ESLint](https://github.com/eslint/eslint) (MIT),
[Prettier](https://github.com/prettier/prettier) (MIT),
[date-fns](https://github.com/date-fns/date-fns) (MIT),
[js-yaml](https://github.com/nodeca/js-yaml) (MIT).

## Assets & fonts

- **[Simple Icons](https://github.com/simple-icons/simple-icons)** (CC0-1.0) —
  the PostgreSQL, MySQL, Snowflake, Databricks and BigQuery brand marks under
  `src/assets/warehouses/`.
- **[benc-uk/icon-collection](https://github.com/benc-uk/icon-collection)**
  (MIT) — the Azure Synapse icon.
- The Amazon Redshift mark is sourced from
  [Wikimedia Commons](https://commons.wikimedia.org/).
- **[Inter & Inter Tight](https://github.com/rsms/inter)** (SIL OFL 1.1) —
  loaded from Google Fonts.
- All third-party product names and logos (PostgreSQL, MySQL, Snowflake,
  Databricks, Google BigQuery, Amazon Redshift, Azure Synapse, and model
  provider marks) are trademarks of their respective owners, used solely to
  identify the corresponding integration. No endorsement is implied.

## Runtime services (not bundled)

The pdf.js worker and the Simple Icons provider logos are fetched at runtime
from [jsDelivr](https://www.jsdelivr.com/); fonts from Google Fonts.
Self-hosters who need a fully offline build can vendor these locally.
