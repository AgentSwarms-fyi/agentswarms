# Acknowledgements

AgentSwarms is built on the shoulders of many excellent open-source
projects. This page credits the ones we depend on directly, with their
licenses and repositories — the application's npm packages, the Python
packages inside the two service images, the container images the stack runs,
and the data and artwork bundled in the repository. Thank you to every
maintainer and contributor behind them.

**License audit summary** — the application's direct dependencies use
permissive licenses (MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, MIT-0).
There is **no strong copyleft** in the npm tree — **no GPL-only or AGPL** code
— so AgentSwarms can be distributed under its own terms, the
**source-available [Elastic License 2.0](./LICENSE.md)**. A few transitive
dependencies carry weak or dual licenses, both compatible with that
redistribution: **jszip** (`MIT OR GPL-3.0`, used under MIT — reached via
`docx`, `mammoth` and `pptxgenjs`) and **lightningcss** (MPL-2.0 — a build-time
CSS tool reached via Vite, weak per-file copyleft, not part of the shipped
bundle). Apache-2.0 dependencies require their license and notice files to
travel with their source, which `npm install` preserves inside `node_modules`.

The optional service containers are a separate matter, stated plainly: the
document-rendering image installs LibreOffice (MPL-2.0), poppler (GPL-2.0) and
CairoSVG (LGPL-3.0), and the notebook egress proxy is Squid (GPL-2.0). Each
runs as its own process or container and is invoked over a socket or as an
executable; none is linked into AgentSwarms' code, and none ships in the
application bundle. They are listed under
[Document rendering service](#document-rendering-service-optional) and
[Runtime services](#runtime-services-not-bundled) below. To regenerate the npm
list at any time:

```bash
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));for(const n of Object.keys({...p.dependencies,...p.devDependencies}).sort()){try{console.log(n,'—',JSON.parse(fs.readFileSync('node_modules/'+n+'/package.json')).license)}catch{}}"
```

## Application framework

| Project                                                                                                                                                                                                                                                              | License          | Used for                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------- |
| [React](https://github.com/facebook/react)                                                                                                                                                                                                                           | MIT              | UI runtime                                                     |
| [TanStack Start / Router / Query](https://github.com/TanStack/router)                                                                                                                                                                                                | MIT              | Framework, file-based routing, server functions, data fetching |
| [Vite](https://github.com/vitejs/vite)                                                                                                                                                                                                                               | MIT              | Build tooling and dev server                                   |
| [Nitro](https://github.com/nitrojs/nitro)                                                                                                                                                                                                                            | MIT              | Server runtime                                                 |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) + [tw-animate-css](https://github.com/Wombosvideo/tw-animate-css) + [tailwind-merge](https://github.com/dcastil/tailwind-merge)                                                                          | MIT              | Styling, animation utilities, class merging                    |
| [shadcn/ui](https://github.com/shadcn-ui/ui) + [Radix UI](https://github.com/radix-ui/primitives)                                                                                                                                                                    | MIT              | Accessible UI primitives and components                        |
| [class-variance-authority](https://github.com/joe-bell/cva) + [clsx](https://github.com/lukeed/clsx)                                                                                                                                                                 | Apache-2.0 / MIT | Component variants and class names                             |
| [Framer Motion](https://github.com/motiondivision/motion)                                                                                                                                                                                                            | MIT              | Animations                                                     |
| [Lucide](https://github.com/lucide-icons/lucide)                                                                                                                                                                                                                     | ISC              | Icon set                                                       |
| [Zod](https://github.com/colinhacks/zod)                                                                                                                                                                                                                             | MIT              | Runtime validation                                             |
| [sonner](https://github.com/emilkowalski/sonner), [cmdk](https://github.com/pacocoursey/cmdk), [vaul](https://github.com/emilkowalski/vaul), [react-hook-form](https://github.com/react-hook-form/react-hook-form)                                                   | MIT              | Toasts, command menu, drawers, forms                           |
| [react-day-picker](https://github.com/gpbl/react-day-picker), [embla-carousel](https://github.com/davidjerleke/embla-carousel), [input-otp](https://github.com/guilhermerodz/input-otp), [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) | MIT              | Calendar, carousel, one-time-code input, split panes           |
| [react-dropzone](https://github.com/react-dropzone/react-dropzone)                                                                                                                                                                                                   | MIT              | Drag-and-drop uploads for knowledge bases and agent imports    |

## Agents & AI

| Project                                                                                                                                                                                | License | Used for                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| [LangChain.js / LangGraph](https://github.com/langchain-ai/langchainjs)                                                                                                                | MIT     | Agent runtime, RAG pipelines, swarm export targets                                          |
| [XYFlow (React Flow)](https://github.com/xyflow/xyflow)                                                                                                                                | MIT     | The visual swarm and ETL canvases                                                           |
| [CodeMirror](https://github.com/codemirror/dev) + [react-codemirror](https://github.com/uiwjs/react-codemirror)                                                                        | MIT     | Code editors (SQL, Python, JavaScript, Markdown)                                            |
| [react-markdown](https://github.com/remarkjs/react-markdown) + [remark-gfm](https://github.com/remarkjs/remark-gfm) + [rehype-highlight](https://github.com/rehypejs/rehype-highlight) | MIT     | Markdown rendering with syntax highlighting                                                 |
| [Mermaid](https://github.com/mermaid-js/mermaid)                                                                                                                                       | MIT     | Diagrams drawn from agent replies                                                           |
| [cheerio](https://github.com/cheeriojs/cheerio) + [Turndown](https://github.com/mixmark-io/turndown)                                                                                   | MIT     | The keyless web reader and the Confluence connector: page chrome stripped, HTML to Markdown |
| [undici](https://github.com/nodejs/undici)                                                                                                                                             | MIT     | The connector HTTP client behind the SSRF guard                                             |

[Firecrawl](https://github.com/firecrawl/firecrawl) is an optional external
service for JavaScript-rendered pages and ranked web search, reached over its
HTTP API when a key is configured; no Firecrawl code ships in the bundle.

## Business Intelligence & data

| Project                                                                                                                                                                                                                             | License      | Used for                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| [Recharts](https://github.com/recharts/recharts)                                                                                                                                                                                    | MIT          | Chart rendering                                                                                                               |
| [DuckDB](https://github.com/duckdb/duckdb) ([duckdb-wasm](https://github.com/duckdb/duckdb-wasm), [node-api](https://github.com/duckdb/duckdb-node-neo))                                                                            | MIT          | The default SQL engine for local datasets — in the browser via WASM, and server-side for refreshes — and the lakehouse engine |
| [DuckLake](https://github.com/duckdb/ducklake) + the DuckDB [httpfs](https://github.com/duckdb/duckdb-httpfs), [postgres](https://github.com/duckdb/duckdb-postgres) and [azure](https://github.com/duckdb/duckdb-azure) extensions | MIT          | The lakehouse's transactional catalog, object-storage reads and Azure lakes                                                   |
| [AlaSQL](https://github.com/AlaSQL/alasql)                                                                                                                                                                                          | MIT          | Fallback SQL engine for local datasets, selected with `LOCAL_ENGINE=alasql`                                                   |
| [d3-force](https://github.com/d3/d3-force) / [d3-geo](https://github.com/d3/d3-geo)                                                                                                                                                 | ISC          | Ontology graph layout, filled & bubble maps                                                                                   |
| [topojson-client](https://github.com/topojson/topojson-client) + [world-atlas](https://github.com/topojson/world-atlas)                                                                                                             | ISC          | Map geometry (derived from the public-domain [Natural Earth](https://www.naturalearthdata.com/) dataset)                      |
| [pdf-lib](https://github.com/Hopding/pdf-lib)                                                                                                                                                                                       | MIT          | Dashboard PDF export                                                                                                          |
| [html2canvas-pro](https://github.com/yorickshan/html2canvas-pro)                                                                                                                                                                    | MIT          | Widget/dashboard rasterisation for PDF & PNG export                                                                           |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS)                                                                                                                                                                                  | MIT          | AI-generated PowerPoint files (Agent Chat, browser renderer)                                                                  |
| [docx](https://github.com/dolanmiu/docx)                                                                                                                                                                                            | MIT          | AI-generated Word documents (Agent Chat, browser renderer)                                                                    |
| [write-excel-file](https://gitlab.com/catamphetamine/write-excel-file) + [read-excel-file](https://gitlab.com/catamphetamine/read-excel-file)                                                                                       | MIT          | AI-generated Excel workbooks with live formulas; Excel ingest for datasets                                                    |
| [Papa Parse](https://github.com/mholt/PapaParse)                                                                                                                                                                                    | MIT          | CSV parsing                                                                                                                   |
| [node-sql-parser](https://github.com/taozhi8833998/node-sql-parser)                                                                                                                                                                 | Apache-2.0   | SQL validation, and the parse-tree rewrite that applies lakehouse row filters and column masks                                |
| [pdfjs-dist](https://github.com/mozilla/pdf.js)                                                                                                                                                                                     | Apache-2.0   | PDF text extraction for knowledge bases                                                                                       |
| [mammoth](https://github.com/mwilliamson/mammoth.js)                                                                                                                                                                                | BSD-2-Clause | DOCX text extraction for knowledge bases                                                                                      |

The model pricing table (`src/utils/observability/priceTable.generated.ts`) is
built by `npm run prices:refresh` from
[LiteLLM's](https://github.com/BerriAI/litellm) community price dataset (MIT)
and OpenRouter's public models endpoint; see
[docs/MODEL_PRICING.md](./docs/MODEL_PRICING.md).

### Bundled open datasets

The sample datasets under `src/assets/sample-data/` include cleaned extracts
of these open data sources. Attribution is required for all of them and is
retained here and in the in-app dashboard descriptions; the four Formula 1
files additionally carry a ShareAlike term, so those files stay under their
own licence rather than ELv2:

- **[FiveThirtyEight NBA Elo](https://github.com/fivethirtyeight/data/tree/master/nba-elo)**
  (CC-BY 4.0) — `nba_team_seasons.csv`, game-level Elo aggregated to
  team-seasons (1977–2015).
- **[World Bank Open Data](https://data.worldbank.org/)** (CC-BY 4.0) —
  `world_health_indicators.csv`: life expectancy, health expenditure,
  physicians, infant mortality and population for 45 countries (2000–2022).
- **[Our World in Data — Energy](https://github.com/owid/energy-data)**
  (CC-BY 4.0; Ember & Energy Institute source data) — `global_electricity.csv`:
  electricity generation by source for the world and 28 countries
  (1990–2023).
- **[Ergast Motor Racing Data](https://ergast.com/mrd/)**, via its successor
  the **[Jolpica F1 API](https://github.com/jolpica/jolpica-f1)** (data
  CC-BY-SA 4.0, provided for non-commercial use; API code Apache-2.0) —
  `f1_driver_standings.csv`, `f1_constructor_standings.csv`,
  `f1_world_champions.csv`, `f1_constructor_champions.csv`: the 2025
  standings and the 1950–2025 champions history behind the "Formula 1
  Analytics" sample dashboard.

Every other sample table — SaaS sales, budget variance, adverse-event reports,
auto claims, factory defects, SIEM alerts, e-commerce returns, the supply-chain
shipments and carrier scorecard, the HR roster and department rollup, and the
messy-orders and ETL sample files under `public/etl-samples/` — is synthetic,
generated by scripts in this repository, and contains no third-party data.

Sample dashboard backgrounds use public-domain NASA imagery
([NASA Image and Video Library](https://images.nasa.gov/): Black Marble city
lights, ISS aurora, SDO sun).

## Backend & connectivity

| Project                                                                                                     | License          | Used for                                                              |
| ----------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| [Supabase](https://github.com/supabase/supabase) (+ [supabase-js](https://github.com/supabase/supabase-js)) | Apache-2.0 / MIT | Postgres, Auth, Storage, pgvector — the application backend           |
| [node-postgres (pg)](https://github.com/brianc/node-postgres)                                               | MIT              | PostgreSQL-family, Redshift and lakehouse-catalog connections         |
| [mysql2](https://github.com/sidorares/node-mysql2)                                                          | MIT              | MySQL / MariaDB / SingleStore / PlanetScale connections               |
| [tedious](https://github.com/tediousjs/tedious)                                                             | MIT              | Microsoft SQL Server, Azure SQL and Azure Synapse (T-SQL) connections |
| [ws](https://github.com/websockets/ws)                                                                      | MIT              | The notebook gateway's WebSocket bridge to kernels                    |
| [Nodemailer](https://github.com/nodemailer/nodemailer)                                                      | MIT-0            | Alert and report e-mails                                              |
| [React Email](https://github.com/resend/react-email)                                                        | MIT              | E-mail templates                                                      |

## Notebook runtime & machine learning (Python)

Installed in the `agentswarms/notebook-runtime` image
(`docker/notebook-runtime/requirements.txt`), which runs notebook kernels, ETL
runs, MCP servers and ML training and inference in sandboxes. Not part of the
application bundle.

| Project                                                                                                                                                                    | License                           | Used for                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| [Jupyter Kernel Gateway](https://github.com/jupyter-server/kernel_gateway) + [ipykernel](https://github.com/ipython/ipykernel)                                             | BSD-3-Clause                      | Kernels behind the notebook gateway                     |
| [LangChain](https://github.com/langchain-ai/langchain), [LangGraph](https://github.com/langchain-ai/langgraph), [LlamaIndex](https://github.com/run-llama/llama_index)     | MIT                               | Agentic frameworks available to notebooks               |
| [FastMCP](https://github.com/jlowin/fastmcp) + the [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)                                                    | Apache-2.0 / MIT                  | MCP Builder servers                                     |
| [pandas](https://github.com/pandas-dev/pandas), [NumPy](https://github.com/numpy/numpy), [SciPy](https://github.com/scipy/scipy)                                           | BSD-3-Clause                      | Data frames and numerics in ETL runs and the ML trainer |
| [scikit-learn](https://github.com/scikit-learn/scikit-learn), [LightGBM](https://github.com/microsoft/LightGBM), [statsmodels](https://github.com/statsmodels/statsmodels) | BSD-3-Clause / MIT / BSD-3-Clause | Model candidates, preprocessing, forecasting            |
| [DuckDB (Python)](https://github.com/duckdb/duckdb-python) + [Apache Arrow (pyarrow)](https://github.com/apache/arrow)                                                     | MIT / Apache-2.0                  | Reading lakehouse tables in sandboxes                   |
| [s3fs](https://github.com/fsspec/s3fs) + [joblib](https://github.com/joblib/joblib)                                                                                        | BSD-3-Clause                      | Model artifacts in object storage                       |
| [httpx](https://github.com/encode/httpx) + [pydantic](https://github.com/pydantic/pydantic)                                                                                | BSD-3-Clause / MIT                | HTTP and validation for the sandbox helper              |

## Document rendering service (optional)

The `agentswarms/docgen` image (`docgen-service/`) renders native PowerPoint,
Word and Excel files server-side and verifies them by rasterising. It is an
optional container behind `--profile docgen`; the browser renderer above needs
none of it.

| Project                                                                                                                                                                     | License                  | Used for                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| [FastAPI](https://github.com/fastapi/fastapi) + [Uvicorn](https://github.com/encode/uvicorn)                                                                                | MIT / BSD-3-Clause       | The service                                                                               |
| [python-pptx](https://github.com/scanny/python-pptx), [python-docx](https://github.com/python-openxml/python-docx), [openpyxl](https://foss.heptapod.net/openpyxl/openpyxl) | MIT                      | Native Office output                                                                      |
| [Pillow](https://github.com/python-pillow/Pillow)                                                                                                                           | MIT-CMU                  | Image handling                                                                            |
| [pdf2image](https://github.com/Belval/pdf2image) → [poppler](https://poppler.freedesktop.org/)                                                                              | MIT → GPL-2.0            | PDF to PNG for the visual review loop; poppler's `pdftoppm` runs as a separate executable |
| [CairoSVG](https://github.com/Kozea/CairoSVG) (on cairo and pango)                                                                                                          | LGPL-3.0-or-later        | SVG rasterisation, in this container only                                                 |
| [LibreOffice](https://www.libreoffice.org/) Impress, Writer and Calc                                                                                                        | MPL-2.0                  | Converts the generated files to PDF for review, invoked as a separate process             |
| [DejaVu](https://dejavu-fonts.github.io/) and [Liberation](https://github.com/liberationfonts/liberation-fonts) fonts                                                       | Bitstream Vera / OFL 1.1 | Fonts available to LibreOffice inside the image                                           |

## Tooling

[TypeScript](https://github.com/microsoft/TypeScript) (Apache-2.0),
[ESLint](https://github.com/eslint/eslint) with
[typescript-eslint](https://github.com/typescript-eslint/typescript-eslint)
(MIT), [Prettier](https://github.com/prettier/prettier) (MIT),
[Vitest](https://github.com/vitest-dev/vitest) (MIT),
[cross-env](https://github.com/kentcdodds/cross-env) (MIT),
[date-fns](https://github.com/date-fns/date-fns) (MIT),
[js-yaml](https://github.com/nodeca/js-yaml) (MIT), and the type definitions
from [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) (MIT).

## Assets & fonts

- **[Simple Icons](https://github.com/simple-icons/simple-icons)** (CC0-1.0) —
  the PostgreSQL, MySQL, Snowflake, Databricks and BigQuery brand marks under
  `src/assets/warehouses/`, and the model-provider logos on the Integrations
  page (fetched at runtime, see below).
- **[benc-uk/icon-collection](https://github.com/benc-uk/icon-collection)**
  (MIT) — the Azure Synapse icon.
- The Amazon Redshift mark is sourced from
  [Wikimedia Commons](https://commons.wikimedia.org/).
- The Amazon Athena, Oracle and Trino tiles are generic pictograms drawn for
  this repository, not the vendors' marks.
- The OpenRouter logo under `public/provider-logos/` identifies that
  integration on the Integrations page.
- **[Inter & Inter Tight](https://github.com/rsms/inter)** (SIL OFL 1.1) —
  self-hosted as variable Latin subsets under `public/fonts/`; nothing is
  fetched from Google Fonts.
- All third-party product names and logos (PostgreSQL, MySQL, Snowflake,
  Databricks, Google BigQuery, Amazon Redshift, Amazon Athena, Azure Synapse,
  Oracle, Trino, OpenRouter, and the model provider marks) are trademarks of
  their respective owners, used solely to identify the corresponding
  integration. No endorsement is implied.

## Runtime services (not bundled)

Programs the stack runs beside the application, each in its own container.
Their licences apply to them, not to AgentSwarms; none is linked into the
application.

| Project                                                                                                                                                                  | License                            | Role                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Supabase](https://github.com/supabase/supabase) — Postgres, GoTrue, PostgREST, Realtime, Storage, Kong, Studio, postgres-meta, Logflare, Vector, imgproxy, Edge Runtime | Apache-2.0 / MIT (Vector: MPL-2.0) | The backend, as a hosted project, the official Docker stack (`setup-selfhosted.sh`), or the [community Helm chart](https://github.com/supabase-community/supabase-kubernetes) (Apache-2.0) on Kubernetes |
| [MinIO](https://github.com/minio/minio)                                                                                                                                  | AGPL-3.0                           | The Helm chart's storage backend on Kubernetes; a separate service the application talks to over S3                                                                                                      |
| [PostgreSQL](https://github.com/postgres/postgres) (`postgres:16`)                                                                                                       | PostgreSQL License                 | The lakehouse catalog                                                                                                                                                                                    |
| [Squid](https://github.com/squid-cache/squid) (`ubuntu/squid`)                                                                                                           | GPL-2.0-or-later                   | The notebook egress proxy that enforces the allow-list                                                                                                                                                   |
| [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) (on [HAProxy](https://www.haproxy.org/))                                                         | Apache-2.0 (HAProxy: GPL-2.0)      | Least-privilege access to the Docker socket for the notebook gateway                                                                                                                                     |
| [curl](https://github.com/curl/curl) (`curlimages/curl`)                                                                                                                 | curl license                       | The Kubernetes cron job that fires the scheduler                                                                                                                                                         |
| [Node.js](https://github.com/nodejs/node) (`node:22-slim`), [Python](https://github.com/python/cpython) (`python:3.12-slim`), [Debian](https://www.debian.org/)          | MIT / PSF-2.0 / various            | Base images                                                                                                                                                                                              |

The pdf.js worker and the Simple Icons provider logos are fetched at runtime
from [jsDelivr](https://www.jsdelivr.com/). Self-hosters who need a fully
offline build can vendor these two locally; fonts already are.
