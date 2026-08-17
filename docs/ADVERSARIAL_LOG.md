# Adversarial pass — running log

A module-by-module hunt for the failures that do not announce themselves: a
number that is wrong rather than missing, a badge that outlives what it vouched
for, a message that names a cause it cannot support, an empty state that claims
there is nothing when the truth is that nothing could be read.

Each pass drives the real UI against the real database and **checks what the
screen says against what the data says**. A page that renders without an error
has not been tested; it has been visited.

## Method

1. Load the page in the browser, capture console and network.
2. Enumerate every control: tab, filter, toggle, menu, dialog, empty state.
3. For every displayed figure, compute the same figure independently from the
   database and compare. A match is the evidence; a plausible-looking number is
   not.
4. Push each control to its edges: zero rows, one row, a range with no data,
   a deleted referent, a value that is null for a legitimate reason.
5. Log what is found, fix it with a regression test, mutation-verify the test.

## Severity

- **S1** — states something false, or lets a wrong number reach a decision.
- **S2** — hides something true (silent failure, swallowed error, misleading empty).
- **S3** — correct but confusing, or a control that does nothing.
- **S4** — cosmetic.

## Coverage map

| #   | Module              | Route                      | Pass | Date       | Findings                                                |
| --- | ------------------- | -------------------------- | ---- | ---------- | ------------------------------------------------------- |
| 1   | Dashboard           | `/dashboard`               | ✅ 1 | 2026-08-16 | 5 (2×S1, 1×S2, 2×S3)                                    |
| 2   | Documentation       | `/docs`                    | ✅ 1 | 2026-08-16 | 4 (2×S1, 1×S2, 1×S1 self-inflicted)                     |
| 3   | Agent Builder       | `/agents`                  | ✅ 1 | 2026-08-16 | 3 (2×S1, 1×S2)                                          |
| 4   | Knowledge Base      | `/knowledge`               | ✅ 1 | 2026-08-16 | 1 (1×S1)                                                |
| 5   | Agent Chat          | `/playground`              | ✅ 1 | 2026-08-16 | 2 (1×S1 self-inflicted, 1×S2); guardrails verified live |
| 6   | Agent Swarms        | `/swarms`                  | ✅ 1 | 2026-08-16 | 1 (1×S2)                                                |
| 7   | MCP Builder         | `/mcp-builder`             | ✅ 1 | 2026-08-16 | 1 (1×S2)                                                |
| 8   | AI Analyst          | `/ai-analyst`              | ✅ 1 | 2026-08-16 | 0 — held; no live turn (over budget cap)                |
| 9   | Data Catalog        | `/data-sql`                | ✅ 1 | 2026-08-16 | 2 (1×S1, 1×S3)                                          |
| 10  | Semantic Layer      | `/semantics`               | ✅ 1 | 2026-08-16 | 1 (1×S1) + one wrong hypothesis, recorded               |
| 11  | Metrics             | `/metrics`                 | ✅ 1 | 2026-08-16 | 2 (2×S2) + one hypothesis dropped                       |
| 12  | BI Workspace        | `/bi`                      | ✅ 1 | 2026-08-16 | 1 (1×S1) — widget count read the page-1 mirror          |
| 13  | Developer workspace | `/notebooks`               | ✅ 1 | 2026-08-17 | 4 (1×S1, 2×S2, 1×S3) — failed reads rendered as absence |
| 14  | Prompt Library      | `/prompts`                 | —    | —          | —                                                       |
| 15  | Skill Library       | `/skills`                  | —    | —          | —                                                       |
| 16  | Integrations        | `/integrations`            | —    | —          | —                                                       |
| 17  | Web Embedding       | `/embeds`                  | —    | —          | —                                                       |
| 18  | Secrets             | `/secrets`                 | —    | —          | —                                                       |
| 19  | MCP Servers         | `/mcp`                     | —    | —          | —                                                       |
| 20  | Model Registry      | `/model-registry`          | —    | —          | —                                                       |
| 21  | Analytics           | `/analytics`               | —    | —          | —                                                       |
| 22  | Swarm Traces        | `/analytics/observability` | —    | —          | —                                                       |
| 23  | Traces & Logs       | `/traces`                  | —    | —          | —                                                       |
| 24  | Audit Log           | `/audit`                   | —    | —          | —                                                       |
| 25  | Budgets             | `/budgets`                 | —    | —          | —                                                       |
| 26  | Monitoring          | `/monitoring`              | —    | —          | —                                                       |
| 27  | Prompt Compare      | `/prompt-compare`          | —    | —          | —                                                       |
| 28  | Evaluations         | `/evaluations`             | —    | —          | —                                                       |
| 29  | Image Playground    | `/image-playground`        | —    | —          | —                                                       |
| 30  | IAM                 | `/admin/iam`               | —    | —          | —                                                       |
| 31  | Developer runtime   | `/admin/runtime`           | —    | —          | —                                                       |

## Findings

<!-- newest first -->

### 2026-08-17 — Module 13, Developer workspace (`/notebooks`)

Four findings, and they are the same finding four times: **every read on this
page treated its own failure as a fact about the account.** No arithmetic was
wrong here. The notebook count badge matched an exact PostgREST count
(`content-range: 0-2/3`) and the four samples on screen matched the four
declared in `lib/sampleNotebooks`. What was wrong is what the page says when it
does not know.

Each was measured by failing exactly one request in the live page and reading
what rendered — never by reasoning about the code.

**S1 — the notebook list called a refused read an empty account.**
`usePyNotebooks` destructured only `data`, and `data` is null on failure, so a
403 produced:

```
{"badgeText":"0","saysNoNotebooks":true,"anyErrorWordOnScreen":false}
```

for an account holding **three** notebooks. Badge `0`, the words "No notebooks
yet — create one to start experimenting.", and nothing anywhere on the page
indicating a failure. The invitation is the sharp edge: the page does not merely
withhold the notebooks, it tells the user their account is empty and offers to
start them over.

**S2 — the running-kernels panel vanished when the runtime was unreachable.**
`load()` collapsed both failure paths to `[]`, and the render hid the panel on
an empty list, so a 503 gave `{"panelVisible":false,"anyErrorOnScreen":false}`.
This panel exists for exactly one moment — you were refused a new kernel with
"you already have the maximum of N" and came to free a slot — so the failure
mode contradicted the only reason to be on the page. The Refresh button lives
_inside_ the hidden panel, so there was no way to retry either.

**S2 — the editor reported a failed read as a deleted notebook.** The load did
`if (!data) setNotFound(true)`, and the copy went further than absence:
"Notebook not found (it may belong to another account)." A network blip named a
cause it had no evidence for, to the owner of a notebook visible in the sidebar
one click earlier.

That page now also promises "It has not been deleted; nothing was saved over
it." That promise was **verified rather than assumed**: the read was failed, the
1200 ms autosave debounce was waited out, and all three notebook rows came back
byte-identical with `updated_at` unchanged and zero writes attempted. The guard
holding it up was one incidental condition in a `useEffect`, so it is now
`mayAutosave` — named, exported and mutation-covered, because the refactor that
defaults `cells` to `[]` instead of `null` would silently turn that sentence
into a lie.

**S3 — the publish dialog said "Loading…" for ever after a failed key read.**
Better than the others (it never claimed "No keys yet." for a notebook with live
keys) but it reported a finished, failed read as still in progress, with a toast
as the only signal. On a panel whose job is telling you which keys can reach
your notebook, that is not good enough.

**The rule extracted.** Two pure modules, because the same sentence kept needing
saying: `lib/kernelPanelState` (the panel's visibility and count) and
`lib/listClaim` (`listClaim` for count-and-empty-state, `mayAutosave` for the
write guard). One line each carries it — _an empty list is a CLAIM, and only a
read that succeeded is allowed to make it._

**A guard that reported a page for getting stricter.** Routing `notebooks.tsx`
through `listClaim` broke `emptyStateLoadGate.test.ts`, which recognises four
source shapes for "a load signal reaches the JSX" and now saw none — even though
the new code gates on the error _as well as_ the load, which none of the four
do. The right fix was to teach the guard the fifth shape, not to loosen it, and
that was checked in both directions: with the gate stripped from `notebooks.tsx`
and, separately, from `secrets.tsx`, the guard reported each one.

**Tests:** 31 across `tests/unit/kernelPanelState.test.ts` (13) and
`tests/unit/listClaim.test.ts` (18). Mutation-verified 19/19 — 6 on
`kernelPanelState`, 7 on `listClaim`, 6 on `mayAutosave` — each applied,
confirmed on disk, killed, restored, restore confirmed. Full suite 3878 tests,
209 files, green; the non-skipped total was checked against the previous run so
a silently-dropped test could not hide in it. No fixtures created, and all three
notebook rows verified byte-identical at the end.

---

### 2026-08-16 — Module 12, BI Workspace (`/bi`)

#### P1 · S1 · A four-page dashboard was advertised as having seven widgets

Every project card prints "N widgets · M views · updated …". The view counts
and timestamps all matched `view_count` and `updated_at` exactly. The widget
count did not.

`BiDashboardRow` documents the rule in the type itself: _"pages — Source of
truth for the dashboard's content; top-level widgets/layout mirror page 1."_
The card counted `parseWidgets(d.widgets)` — the mirror.

Measured across all eleven projects on the account:

| Dashboard               | Card said | Truth  | Pages |
| ----------------------- | --------- | ------ | ----- |
| **Formula 1 Analytics** | **7**     | **15** | **4** |
| Every other project     | correct   | —      | 1     |

Formula 1 holds 7 + 4 + 4 + 0 across its four pages. The other ten have one
page each, so `pages[0]` and the mirror are the same list and the count was
right **by accident everywhere it was checked** — which is why a page whose
whole job is telling projects apart had been understating its largest by 53%
without anyone noticing.

The bias is the familiar shape: never too high, always too low, and it only
goes wrong once someone adds pages — the very thing that makes a dashboard
substantial. `dashboardSize` now counts through `parsePages`, so a
pre-multi-page row still collapses to its single page exactly as the editor
sees it rather than being special-cased twice. The card also shows the page
count when there is more than one; its absence is what let a four-page
dashboard read like a small one.

Verified live: Formula 1 now reads **"15 widgets · 4 pages · 29 views"**, every
single-page project unchanged.

`tests/unit/biDashboardPages.test.ts` (+6 → 13) — the file that already guards
this exact mirror-vs-source invariant for writes, now guarding it for reads.
Mutation: count `pages[0]` only → 1 fails.

#### Note: a generated file lost a route mid-edit

`src/routeTree.gen.ts` came back 21 lines shorter, with the `/bi` route gone —
the dev server regenerated it while an edit had `bi.tsx` transiently
unparseable, and `tsc` then failed in four unrelated files. Restored from git.
Worth recording because the symptom (type errors about `"/bi"` in
`dashboard.tsx`) points nowhere near the cause.

### 2026-08-16 — Module 11, Metrics (`/metrics`)

Everything the page computes was checked against the database and matched
exactly: **23 metrics in 3 models · 0 certified · 23 draft · 0 deprecated**
(7 + 6 + 10 across the three models, all draft), and the freshness stamps —
27d for `saas_sales`, 9d for the other two — matched `data_loaded_at` to the
day. The usage claim was checked too: all 11 dashboards scanned, none
references any of the three models, so "No dashboard widget references it" is
true. The two findings are both about what the page says when it cannot see
everything.

#### P1 · S2 · The identifier the page publishes was not searchable

Every card prints `saas_sales_model.total_sales` as the metric's identity. It
is the form the compiler resolves and the form a colleague pastes. Typing that
exact string into the page's own search returned **nothing** — and the empty
state then said:

> Nothing matches "saas_sales_model.total_sales". Synonyms are searched too, so
> a metric with no match here **genuinely has none of these words**.

The metric has exactly those words; the page had just rendered them. This is
not a missing feature but a false statement, in the one sentence written to be
trusted.

`matchesQuery` tested each field independently, so `saas_sales_model` found ten
metrics and `total_sales` found one while the qualified form found none. Adding
`qualifiedName(m)` to the searched list fixes it, and the partial forms fall
out: `saas_sales_model.` finds ten, `.total_sales` and `model.total` find their
metrics, and `hr_roster_model.total_sales` correctly finds nothing. The route
now renders `qualifiedName(m)` too, so the published string and the searched
string cannot drift.

#### P2 · S2 · The usage scan could be cut short without saying so

This file's header names the expensive mistake outright: _"deprecating a metric
on the strength of an incomplete scan"_. Its disclosure names threads and
embeds as unscanned. It did not name the ceiling on the scan itself.

All three reads were bare selects. `lib/pagedSelect` documents, from a
measurement against this instance, that PostgREST caps a response at 1000 rows
silently — the same cap that made the dashboard's spend panel report $1.84 for
a $5.77 window. The bias is what matters: truncation only ever REMOVES
references, so a capped read pushes every metric toward "no widget uses this" —
the one direction that gets a metric deprecated.

Not reproducible on this account (11 dashboards, 3 models, 33 tables — every
read complete, confirmed against exact counts), so this is a latent defect
reported on the repo's own evidence rather than a wrong number observed. The
reads now page, `describeUsage` takes the truncation flag, and a cut-short scan
says "treat this as unknown" instead of reporting a clean absence. A truncated
POSITIVE result is kept but reported as a floor — a partial scan can still
prove use, it just cannot prove the count.

`tests/unit/metricsCatalog.test.ts` (+9 → 38). Mutations: drop the qualified
name from the search fields → 2 fail; report a truncated scan as clean → 1
fails.

#### One hypothesis dropped

`dataFreshness` resolves the dataset by NAME while the model also carries a
`table_id`, which looked like the "diff two lists that should match" class —
rename the dataset and freshness silently becomes "unknown". There is no
dataset rename anywhere in the product, so the scenario is unreachable; and for
the reachable case (delete and re-upload under the same name) the name lookup
is the more robust of the two. Left alone.

### 2026-08-16 — Connector operations: re-sync, schedule, disconnect

Requested rather than found, but two of the four were defects.

#### R4 · S2 · A connected source could show no sign of being connected

The provider card's "Connected" badge was keyed off
`last_sync_status === "ok"`. A source that was connected but had never synced,
or whose last run failed, showed **no badge at all** — indistinguishable from
one never set up. The card also had no way to disconnect: the only path was the
trash icon in the table below, which is not where anyone looks after reading
"Connected".

Connected now means a connection row exists, with the count when there are
several. Sync health is a different question and stays where it is answered per
row. Disconnect is offered on the card only when there is exactly ONE owned
connection for that provider — with several, a card-level button would have to
guess which, so the per-row buttons remain the only way to say it.

#### R5 · S3 · The disconnect warning could not tell you what it cost

It said credentials are deleted and "datasets already synced are KEPT", which
is true and unhelpful: the reader cannot tell whether that means one table or
forty, and nothing mentioned that scheduled syncs stop. `saas_connection_id`
(R3) makes the number available, so `listSaasConnections` now returns
`dataset_count` and the dialog states both halves — what stops, and what stays,
with the count. A failed count leaves the field UNDEFINED and the dialog falls
back to its general wording: printing a confident "0 datasets" because a query
failed is how someone deletes a source believing it had none. A shared source's
datasets belong to its owner and are invisible to the grantee's read, so those
rows are left uncounted for the same reason.

Verified live: the dialog reported **7 datasets** for `sftest`, matching the
attribution exactly.

#### Re-sync and schedule, wired to the same server functions

The catalog's SaaS rail entries now carry the crawled sources' affordances —
status dot, schedule clock, and a menu with Re-sync now / Schedule / Manage
connection. Both actions call the SAME server functions the Integration Hub
calls, which is what makes a sync started in one place visible in the other:
measured end to end, a re-sync run from the Data Catalog moved the Hub's "Last
sync" from 16 Aug 20:45 to **21:39**, and a cadence changed from the catalog
menu read back as "Every hour · Next in 59 min" on the Hub.

`setSaasSchedule` is a new server function rather than a call to
`saveSaasConnection`, which re-encrypts the whole config: changing a cadence
through that one would demand the credential again and stamp
`credentials_rotated_at` on a change that rotated nothing. It is owner-only —
a grantee may run a sync, but changing the cadence spends the owner's API quota
on the owner's account. A manual run deliberately does NOT move `next_sync_at`;
the scheduled slot is the owner's setting, not a side effect of a button.

`scheduleSummary` is the pure part, and its rules are all about the case where
a cadence is set and the run is **not** coming: an overdue `next_sync_at` reads
"Due now" rather than a countdown, a cadence with no due time is flagged
(the scheduler's claim query can never match it, so it will never run again),
and a manual source with a leftover due time is flagged too.
`tests/unit/saasScheduleSummary.test.ts` (12). Mutations: render overdue as a
countdown → 2 fail; report a missing due time as healthy → 1 fails.

#### Process note: I overwrote an existing test file

Writing `tests/unit/saasSchedule.test.ts` destroyed 145 lines covering the
scheduler's atomic claim, its tenant scoping and its migration constraints. The
full suite still passed — it was 4 tests SHORT and nothing said so. Caught by
comparing the run's totals against the previous run rather than reading
"passed". Restored from git; the new cases live in
`saasScheduleSummary.test.ts` beside it.

### 2026-08-16 — Reported from use: Salesforce connector → BI dashboard

Not a module sweep. Three things reported from a real session, chased with the
same method.

#### R1 · S1 · A `(date)` column is physically text, and nothing said so

Generating a dashboard from a synced Salesforce `opportunities` table:

```
Binder Error: No function matches the given name and argument types
'date_trunc(STRING_LITERAL, VARCHAR)' ... GROUP BY DATE_TRUNC('month', CloseDate)
```

The obvious reading — bad catalog metadata — was wrong. `CloseDate` is typed
`date` and holds clean ISO values (`"2026-06-19"`). `duckType()` maps
`date → VARCHAR` **deliberately**, in both engines
([browserDuckdb.ts:202](../src/lib/browserDuckdb.ts), [duckdb.server.ts:228](../src/utils/data/duckdb.server.ts)),
because values arrive in mixed formats and a failed CAST would drop the row
rather than the value. So the storage was deliberate and the schema description
was accurate; **the sentence connecting them did not exist**. Neither
`biAgent.ts` nor `aiAnalyst.ts` contained `CAST`, `TRY_CAST`, `::DATE` or
`strptime` anywhere.

Measured across the 254 saved widget queries on this account: six use a date
function, **four cast and two do not**. The model was coin-flipping on a rule
nobody had stated.

Fixed in `describeSchema` — shared by the BI agent and the AI Analyst — as a
rule that appears only when a date column is actually present, and that says
plain grouping needs no cast so it does not over-correct.
`tests/unit/schemaDateCast.test.ts` (7). Mutation: change the trigger condition
to `"string"` → 6 of 7 fail.

#### R2 · S2 · A recoverable engine error ended the widget

Verifying R1 end to end: twelve widget plans, eleven built. "Quarterly Win Rate
by Close Date" died on `STRFTIME(CAST(CloseDate AS DATE), '%Y-Q%q')` — DuckDB
has no `%q`. The cast was right; the format specifier was not.

`buildSqlPrompt` has supported a repair pass since it was written, and
`aiAnalyst.ts:1099` uses it — its comment even reads _"One repair pass with the
engine's own error, like the BI analyst."_ **The BI analyst had no such pass.**
`runBiTurn` executed once and went straight to `status = "error"`, so a mistake
the model fixes on sight cost a whole widget.

Given one pass, the same model produced
`EXTRACT(QUARTER FROM CAST(CloseDate AS DATE))` and the widget built and
rendered. When the retry also fails, `repairFailureMessage` reports **both**
errors and says a retry happened — one message reads as a single failed query
and hides that the model was already shown its mistake.
`tests/unit/biSqlRepair.test.ts` (9). Mutation: return only the second error →
2 fail.

Worth recording that the drop was _disclosed_: the dialog already toasts
`Added 11. 1 couldn't be built (…) — <error>`. The defect was giving up early,
not lying about it.

#### R3 · S3 · Seven Salesforce tables filed under "Local tables"

Connector-synced datasets land in `user_data_tables` exactly like an upload —
deliberately, so a synced dataset cannot behave differently to an uploaded one.
The Data Catalog therefore filed them under the only thing it knew: local
storage. True about the bytes, useless as an answer to "where did this come
from", which is the question the rail exists to answer.

The provenance was already written — `source_filename` holds
`"Salesforce · opportunities"` — but as text for a human to read. Parsing that
string back into structure would be inventing the fact; the connection id **is**
the fact. Migration `20260832000000` adds `saas_connection_id` / `saas_stream`,
backfilled by matching on both signals the sync already writes (7/7 attributed,
0 orphans). `ingestRows` and `promoteStaging` now persist it — including the
**replace** branch, the re-sync case that would otherwise never receive it.

Storage did not move. Only what the catalog can say about it changed.

`src/lib/catalogSources.ts` is the mapping, and its load-bearing rule is the
one for a source it _cannot name_: a dataset whose connection row is missing
falls back to "Local tables" rather than to a source id with no rail entry,
because an asset filed under a category that does not exist disappears from
every filter except "All". `tests/unit/catalogSources.test.ts` (11). Mutation:
drop the `known.has(connId)` guard → 2 fail.

Verified live: rail reads `All assets 113 · Local tables 26 · sftest 7 ·
My Snow 80` — 26 + 7 + 80 = 113, and no `sftest_*` row remains under Local. A
synced table's format now reads `table · salesforce` rather than
`table · csv`, which was the same mistake in miniature.

Re-sync verified by writing NULL over `sftest_accounts`' attribution and
running a real connection sync: the write path restored it
(`last_sync_status: ok`, 7 streams, 24s). Probe dashboard deleted, confirmed
gone.

### 2026-08-16 — Module 10, Semantic Layer (`/semantics`)

#### The hypothesis that was wrong, kept because it nearly shipped

The opening move was: certification is gated on clean validation, so does the
badge survive an edit? The save path's UPDATE payload contains name, joins,
dimensions, metrics, assertions, grain — and **not** `status`, `certified_by`
or `certified_at`. Two UI tooltips promise "editing the definition drops this
back to draft". That looked like a false promise and a badge outliving what it
vouched for: the strongest possible finding in this product.

**It was wrong.** `trg_semantic_decertify` (migration 20260820000000) is a
BEFORE UPDATE trigger doing exactly that, placed in the database deliberately
so no write path can skip it. The application omitting `status` is correct —
the trigger is the stronger place for it.

Recorded because the only thing standing between that and a confidently
reported non-defect was checking the alternative explanation. This schema
already uses triggers for version history and audit; not looking would have
been an easy, plausible mistake.

#### P1 · S1 · The decertify trigger watched nine fields; the save path writes fifteen

Diffing the two lists is what turned the wrong hypothesis into a real one. Six
definition fields were written and unwatched:

| Field                     | What changing it does                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `table_id`                | repoints the model at a **different local dataset** — the local twin of `source_table`, which _was_ watched |
| `rollups`                 | aggregate awareness sends the query to a different summary table                                            |
| `calendar`                | redefines what a fiscal period contains (4-4-5)                                                             |
| `fiscal_year_start_month` | changes what "Q1" means, so every fiscal-grain query returns different numbers                              |
| `parameters`              | declared defaults feed computed values and what-if baselines                                                |
| `hierarchies`             | declared drill paths                                                                                        |

The first four **change numbers**. A model could be certified, repointed at
another dataset or given a different fiscal year, and keep a badge whose entire
meaning is "every validation check passed against the live source" — the exact
failure the trigger exists to prevent, reached through a column it did not
happen to name.

`label` and `description` stay excluded, for the original's stated reason:
renaming a display label does not change what "revenue" computes.

Migration `20260831000000_semantic_decertify_full_definition.sql`, applied to
the live database and **proven in both directions** against it:

| Step                                      | Result                       |
| ----------------------------------------- | ---------------------------- |
| create                                    | `draft`                      |
| certify                                   | `certified`                  |
| change **only** `fiscal_year_start_month` | `draft`, `certified_at` null |
| re-certify, change **only** `label`       | stays `certified`            |

The second row is the fix firing; the third is the control proving it does not
over-fire on metadata. Probe model deleted, 0 rows left.

Latent on this account — all 3 semantic models are `draft`, so nothing was
mis-certified in practice. Live for anyone using certification.

### 2026-08-16 — Module 9, Data Catalog (`/data-sql`)

#### N1 · S1 · Every local dataset claimed it was crawled seconds ago

The asset drawer rendered
`Crawled {formatDistanceToNow(new Date(asset.last_crawled_at))}`, and the local
mapping set `last_crawled_at: new Date().toISOString()`. So **every** local
table reported "Crawled less than a minute ago".

Measured: 26 tables whose real `data_loaded_at` runs from **2026-07-20 to
2026-08-07** — up to 27 days stale, every one of them displayed as fresh. The
true value was one column away in the same row.

Two errors in one line, worth separating because they have different fixes:

- **A timestamp was invented** where a real one existed.
- **The verb was wrong.** An uploaded CSV was never "crawled". And a warehouse
  table is queried in place and never loaded here at all — for that one there
  is no local timestamp, so the honest output is to say so rather than
  manufacture one.

`last_crawled_at` is now nullable end to end, which is what stops the gap being
filled by invention. `data_loaded_at` and `parquet_bytes` are carried through
`DatasetMeta`; tsc found all five construction sites, and each got the value
that is actually true there — "now" only where rows had just been written, null
for warehouse tables.

Verified live: `hr_dept_monthly` now reads **"Data loaded 9 days ago"**
(`data_loaded_at` 2026-08-07, today the 16th).

#### N2 · S3 · A known size displayed as unknown

`size_bytes: null` was hardcoded in the local mapping while `parquet_bytes` sat
unread on the row. `summary_segment_data` had **83,651 bytes** recorded and its
SIZE column showed "—". Now reads **81.7 KB**.

#### Checked and found honest

The stale row-count problem was already found and fixed, with the reasoning in
the code: local assets go stale within a session, so `reloadLocal` re-reads them
rather than trusting the mount-time snapshot. The comment records the observed
symptom — "a dataset replaced with 10 rows still read ROWS 364".

**Tests:** 8 in `tests/unit/catalogFreshness.test.ts`, mutation-verified — four
reversions, all killed, including a restore of the invented timestamp.

### 2026-08-16 — Deferred live verification (cap raised to $20)

The budget cap was raised from $5 to $20, so the work Modules 4, 5 and 8 had to
skip was run for real. Spend at the time: $5.95 of $20.

#### M4 · The empty-retrieval fix, exercised end to end

Three turns against an agent with a knowledge base attached:

1. **"What is the refund policy for AgentSwarms subscriptions?"** — retrieval
   returned 5 citations, so this exercised the pre-existing non-empty path. The
   agent refused to invent a policy, named what the knowledge base _does_ cover,
   and pointed elsewhere.
2. **"What is our parental leave entitlement in Portugal?"** — also matched
   citations. Worth recording: the document-level keyword fallback has **loose
   recall**, matching an unrelated blog document on common terms. Not a defect
   (recall over precision is the right bias for a fallback) but it makes the
   empty branch rare in practice on a populated KB.
3. **A Portuguese-language question** with no term present in an English
   corpus — **zero citations**, the empty branch. The model answered that it did
   not have access to that data, named what it _did_ have, and fabricated
   nothing.

**What this proves and does not.** It proves the empty path executes cleanly
after the change and the model does not confabulate. It does **not** prove the
new prompt text was the decisive cause — one sample against a capable model that
might have said the same thing regardless. Causation would need an A/B, and
n=1 per arm of a non-deterministic model would not settle it either. The unit
tests prove the instruction is present; this proves the path works.

#### M5 · PII redaction genuinely fires

No existing agent had guardrails switched on, so a disposable probe agent was
created with `piiMode: "redact"` rather than mutating a real one. Sending an
email address and a card number through `/api/chat`, the model replied:

> "I can't repeat that message exactly as written because it contains
> **redacted sensitive information placeholders**."

Neither the real email nor the card reached the model. The agent had been told
to echo verbatim, which is what makes the reply evidence rather than inference.
Probe agent deleted afterwards; its traces are left in place because they are
real spend and belong in the ledger.

#### Correction carried into Module 3

Reading those guardrails is what exposed the overstatement corrected in the
Module 3 entry above — 18 guardrail _keys_, nearly all off, cited as if they
measured lost protection.

### 2026-08-16 — Module 8, AI Analyst (`/ai-analyst`)

**No defect found.** Recorded in full because a log that only lists faults says
nothing about where the ground is solid, and because "I looked and found
nothing" is only useful if it also says _where_ it looked.

This module was built most recently and with these invariants stated up front,
and it held under exactly the lens that broke the six before it.

#### What was attacked, and what held

- **The verdict fingerprint.** `fingerprintSteps` pins each step's `sql` plus
  the governed model that compiled it. Row filters and rollup routing compile
  _into_ the SQL, so a change to either moves the fingerprint and voids the
  verdict. `verificationStatus` recomputes and compares on every read rather
  than trusting a stored flag.
- **Verifying nothing.** `markTurn` refuses a turn with no steps — "a turn that
  never produced steps has no analysis to have checked" — so a verdict can
  never be minted against an empty analysis.
- **Prior-verdict matching.** `normaliseQuestion` only lowercases, strips
  punctuation and collapses whitespace. Deliberately crude, with the reasoning
  written down: a false match is a false claim that someone checked it, a miss
  costs nothing. Empty question returns null rather than matching every other
  empty one. Only `active` verdicts are offered, newest first, so a later
  "wrong" beats an earlier "verified".
- **The export.** `analystExport` calls `verificationStatus` and
  `describeVerification`, so a void verdict travels as _"a verdict was
  recorded… but a step has changed since — it no longer applies"_ rather than
  as a bare "Verified". The artifact that leaves the building carries the
  caveat.
- **Scenarios.** A what-if adds SQL the verifier never saw, which under this
  campaign's own rule looked like a scope mismatch. It is not: the block is
  amber, labelled "not measured data; what the numbers would be under this
  assumption", kept beside the measured result and never folded into the
  findings. Calling it a defect would have been manufacturing one.
- **The "empty means something" lens** (the class named in Modules 3, 5 and 7)
  found nothing here. Every empty case — no steps, no verdict, no question —
  is handled explicitly.

#### Verified against real data

The one live thread has 7 turns. Two carry **zero steps** and both are
`status: "error"` with honest model-timeout messages, not silently empty
answers. The verified turn has 4 steps and a matching fingerprint.

#### Not covered, and why

No live analyst turn — spend is over the $5 cap. That leaves **untested**: the
reasoning loop end to end, self-check correction, clarifying questions, driver
analysis, forecast/anomaly computation, and parallel step execution. Zero
schedules and zero shares exist, so scheduled re-runs and sharing were read but
not exercised. These are gaps in the pass, not passes.

### 2026-08-16 — Module 7, MCP Builder (`/mcp-builder`)

#### L1 · S2 · The most powerful API key was the one with nothing written on it

The key list rendered its scope as:

```js
{
  k.tool_allowlist.length ? ` · ${k.tool_allowlist.length} tools` : "";
}
```

A key narrowed to three tools read "· 3 tools". A key that can call **every tool
the server exposes** read nothing at all. The proxy uses the same encoding —
`allowed.length > 0` is what gates `tools/call`, so an empty list is
unrestricted — but the screen inverted its meaning:

```
prod-key      abc123… · 42 calls              ← can call anything
readonly-key  def456… · 7 calls · 3 tools     ← can call three things
```

An operator auditing their keys saw the unrestricted one as the row with _less_
information rather than _more_ reach. Scope is now always stated, with the
unrestricted case in amber and a tooltip explaining it.

**Third instance of one pattern in this campaign.** Swarm import: an empty
`sql_table_names` meant every table. Model policy: an empty rule array meant
deny-all. Here: an empty allow-list means every tool. The encoding differs each
time; what repeats is a UI reading "empty" as "nothing worth saying".

Latent on this account — zero MCP keys exist — so it is correct by absence, not
by design. Same standing as K1 and J1.

#### Checked and found honest

`tools/call` **is** enforced, not merely filtered from `tools/list`: a
non-permitted name returns 403 with a message naming the tool. The list-side
fail-closed fix from earlier today is still in place.

**Tests:** 7 in `tests/unit/mcpKeyScope.test.ts`, mutation-verified — four
reversions, all killed, including a restore of the original blank label.

### 2026-08-16 — Module 6, Agent Swarms (`/swarms`)

#### K1 · S2 · The "deployed" badge was wired to a column nothing writes

`swarms.is_deployed` appears in the migrations only as `DEFAULT false`, is
**written by nothing anywhere in the application**, and is read in exactly one
place — the gallery badge. It could therefore never become true.

The consequence runs the other way from how it looks. This is not a badge that
lies; it is a badge that can never appear. A swarm with a live API key —
reachable from outside the app right now — showed nothing, and the gallery, the
one screen that lists every swarm, could not answer "which of these are live".

`/api/swarm.run` never consults the column either: it authorises on an API key
row and serves the published graph. **A key that has not been revoked is the
deployment.** The badge now derives from that same fact, so it appears when
traffic can arrive and disappears when the last key is revoked.

Zero API keys exist on this account, so the badge count was 0 before and is 0
now — but for a different reason. It was previously the only possible answer;
it is now the correct one.

#### Checked and left alone

- **Draft vs published is sound.** `swarm.run` serves `published_nodes` via
  `resolveDeployedGraph`, with a documented fallback to the draft for swarms
  deployed before snapshots existed, so editing the canvas cannot change what a
  key returns mid-flight.
- **The executor inlines node config** rather than passing `agentId`, which is
  why the `/api/chat` internal-channel gate does not reach swarm runs (see
  Module 3).

**Tests:** 9 in `tests/unit/swarmDeployment.test.ts`, mutation-verified — four
reversions, all killed, including one that keeps the badge alive after a key is
revoked.

#### Also this session

Sidebar label "Budgets" → **"AI Budgets"** (`src/lib/appNav.ts`). The command
palette reads the same `NAV_GROUPS`, so both update together. The page heading
stays "Budgets & Guardrails", which is accurate — the page covers guardrails as
well as spend.

### 2026-08-16 — Module 5, Agent Chat (`/playground`)

Run **read-only**: month-to-date spend is $5.94 against a $5 cap, so no model
turn was sent. That rules out testing streaming, tool calls and guardrails from
this surface, and those remain uncovered — noted here rather than left to look
like they passed.

#### J1 · S2 (latent) · The recovery dialog offered models IAM would refuse

`use-iam` states the invariant in its own comment: the matcher is shared with
the server "so the UI can never offer a model the server would refuse". Three
pickers honour it — `AgentForm`, `BiModelSelect`, `NodeInspector`.
`ModelFallbackDialog` did not reference it at all, building its list from a
hardcoded array plus the full `PROVIDER_MODELS` catalogue.

**It is the worst of the four to miss.** This dialog opens only after a model
has already failed. It is the recovery path, so a restricted user was being sent
from one refusal to another, with nothing on screen explaining why.

Latent on this account — `iam_model_rules` is empty, so everything is permitted
and the dialog is correct by accident. It is live for any deployment that uses
the feature, which is the same shape as D2 on the dashboard: right today, wrong
by construction.

#### J2 · S1 · My own first fix had the inversion it was fixing

The empty-state guard I wrote read `(modelRules?.length ?? 0) > 0`. But
`collapseModelPolicy` encodes **null as "no restriction"** and an **empty array
as "deny by default, nothing granted"** — opposite meanings that a length check
collapses into one. So the explanation would have been suppressed in the single
most restricted state there is: the user sees an empty dialog and is told
nothing.

Corrected to `modelRules !== null`. Caught by reading the matcher's contract
before trusting the shape, which is the only reason it did not ship. A test now
pins both directions, including a live demonstration of what the length check
would have returned.

**Tests:** 12 in `tests/unit/fallbackModelPolicy.test.ts`, mutation-verified —
five reversions, all killed, including one that turns deny-all into allow-all.

### 2026-08-16 — Module 4, Knowledge Base (`/knowledge`)

The best-built module so far. Most of this pass was spent confirming that
things which looked like defects were not, which is worth recording as
carefully as the one that was.

#### H1 · S1 · A retrieval that found nothing told the model nothing

`buildGroundingPrompt` opened with:

```js
if (citations.length === 0) return userSystemPrompt || "";
```

An empty result therefore dropped the **entire** grounding block — including the
one sentence that matters most in exactly that case: _"If the sources do not
contain the answer, say so explicitly and do not fabricate citations."_ That
instruction was present only when sources **were** found, and absent in the
single situation where a model is most likely to answer from memory and sound
precisely as grounded doing it.

Both call sites confirmed it. `/api/chat` only built the prompt
`if (citations.length > 0)`; `/api/embed.chat` called it unconditionally and got
the bare prompt back. So a user attaches a knowledge base, asks something it
cannot answer, and receives a confident answer that never touched their
documents, with nothing on screen saying so.

Now takes a `searched` flag. When a knowledge base was consulted and returned
nothing, the model is told that and asked to say it could not find it rather
than fall back on general knowledge. **Deliberately not a forced refusal** — an
attached knowledge base does not make "hello" unanswerable — and deliberately
opt-in, because claiming a search happened when no KB is wired would be the same
lie pointing the other way.

#### Checked and found honest

- **Embedding state.** 16 of 17 knowledge bases hold documents with zero chunks.
  Every one of those documents renders an amber **"Pending embedding"** badge,
  and the page header states unembedded documents fall back to a keyword scan.
- **That fallback is real**, not a claim. `kb.server` computes which documents
  are chunked, pages `knowledge_documents` in 1,000-row batches to a declared
  5,000-doc cap, warns when the cap is hit, and keyword-scans the remainder.
  Both hybrid RPCs read `kb_chunks`, so without this the promise would be false.
- **ACL enforcement fails closed.** A candidate the ACL query did not return
  "cannot be judged — drop it". The one availability exception is narrow and
  documented (pre-migration schema, where no restrictive scope can exist).
- **Retrieved text is treated as data, not instructions**, with document names
  defanged as well as bodies — names are often an ingested page's `<title>` and
  just as attacker-controlled.

#### Not verified, and why

No live LLM turn was run. Month-to-date spend is $5.94 against a $5 cap, so a
chat call would either be refused by the budget guard or spend past the user's
own limit. The change is a pure string builder, mutation-verified, with both
call sites typechecked; the behaviour it produces in a real turn is untested and
is flagged as such rather than assumed.

**Tests:** 20 in `tests/unit/groundingPrompt.test.ts` (7 new), mutation-verified
— five reversions including a full restore of the original line, all killed.

### 2026-08-16 — Module 3, Agent Builder (`/agents`)

A config surface fails differently from a metrics surface. The question is not
"is this number right" but **"does this setting do anything, and does it still
do it somewhere else"**. So the pass began by listing every key the form
persists and finding each one's runtime consumer.

That part came back clean: all twelve keys the builder writes are read by
`api/chat.ts`. No dead settings. The defect was one layer out — what happens to
those settings when the agent is used somewhere other than chat.

#### G1 · S1 · Importing an agent into a swarm silently dropped everything that restricts it

`NodeInspector.importFromLibrary` copied label, prompt, provider, model,
temperature, primary KB and reranker. It did not copy **guardrails**,
**toolConfigs**, or **skills**, and it mapped **3 of 11** tool ids.

`SwarmNodeData` already declares `guardrails`, `toolConfigs` and `skillIds`, and
`swarmExecute.server` already reads them. Nothing architectural prevented the
copy — the shapes simply differ (`toolConfigs.sql_query.table_names` on the
agent, flat `sql_table_names` on the node), which is a good explanation for how
it survived review.

**The sharp edge is that one of the dropped settings does not fail safe.** Per
`SwarmToolConfigs`, `sql_table_names` empty or undefined means _every table the
owner can see_, while `metric_model_names` empty means _no models_. So dropping
the SQL allow-list **widened** what the node could read.

Measured on a real agent, "Demo · Friendly Assistant": `sql_query` limited to
`saas_sales`, `metric_query` limited to `saas_sales_model`, four tools on.
Imported, it produced a node with no table limit and only two of its four tools.

**CORRECTION (same day, on re-measurement).** The first version of this entry
said that agent carried "18 guardrail settings", and used it as evidence of
dropped protection. It has 18 guardrail _keys_, and they are almost all **off** —
`blockPII: false`, `piiMode: "off"`, `contentSafetyLevel: "off"`, both filter
toggles false, patterns and topics empty. Only the numeric defaults
(`maxInputLength`, `rateLimitPerMinute`, `maxTurnsPerConversation`) are set.

The code defect is unaffected: `importFromLibrary` copied **no** guardrails at
all, so any agent that does have them enabled loses them entirely, and the SQL
allow-list drop is unambiguous because empty means every table. But the number
was cited as if it measured lost protection, and it did not. Counting fields and
calling it evidence of enforcement is the same error this log exists to catch.

Fixed in `src/lib/agentToSwarmNode.ts` — pure, exported, and the only mapping.
Verified by driving the real picker in the canvas: the node now shows SQL Query
and Semantic Metrics enabled (previously unmapped), with `saas_sales` and
`saas_sales_model` both checked.

#### G2 · S2 · What genuinely cannot cross is now said

Some settings have no node equivalent — webhooks, the gateway preference, extra
knowledge bases, `send_notification`. The import now returns them and the
inspector lists them under "Not copied into this node", each with a reason.
A copy that arrives quietly smaller is worse than one that says what it left
behind.

#### G3 · S1 · A comment vouching for a guarantee that cannot happen

`swarmRuntime.ts` stated that per-node guardrails are "merged OVER the linked
agent's saved guardrails, so a swarm node can be stricter than its source
agent", and the inspector repeated it to the user. **There is no linked agent.**
`importFromLibrary` deliberately sets `agentId: null`, nothing else ever sets
it, and `swarmExecute.server` never reads it. A node with empty guardrails
therefore ran with none, while the UI implied it had inherited the agent's.
Both the comment and the help text now say what is true.

#### Verified and left alone

`swarmExecute.server` inlines each node's own config rather than passing
`agentId` to `/api/chat`, so the documented internal-channel gate
(`if (body.agentId && authToken)`, which makes `/api/chat` accept and ignore an
agentId) does not bite swarm runs. The snapshot-not-link design is deliberate
and correct — a reviewed, deployed swarm must not change because someone edited
the source agent afterwards. That was kept, and pinned by a test.

The `python-agent.ts` limitation comment is worth singling out as a model of the
kind of honesty this campaign is looking for: it documents a known 401, explains
why the obvious repair is wrong, and corrects an earlier version of itself.

#### Fixture hygiene

The live check ran on an already-empty swarm with Save never pressed. Verified
afterwards from the database: 0 nodes, `updated_at` still 2026-08-09. The first
attempt to verify that returned **HTTP 400** and my check reported "UNCHANGED"
anyway, because the node count defaulted to 0 on a failed query — the same
absence-of-evidence bug this campaign exists to find, committed by the
verification itself. Re-queried against the real column (`nodes`, not `graph`)
for an actual answer.

**Tests:** 22 in `tests/unit/agentToSwarmNode.test.ts`, mutation-verified —
eight reversions, each restoring one piece of the original behaviour, all
killed, restore confirmed.

### 2026-08-16 — Module 2, Documentation (`/docs`)

All 27 pages render, every page is reachable from the sidebar, no dangling nav
entries, no orphans. The defects are all one thing: **the handbook describing a
product that had moved on.**

Root cause worth naming — there are **two documentation sets**, `docs/*.md` in
the repo and `src/routes/docs.*.tsx` in the app, and nothing keeps them in step.
Three features shipped over the last two days; all three updated the repo docs
and none reached the in-app handbook. The in-app one is what a user reads.

#### F1 · S1 · The BI export row still described a world without PowerPoint

`docs.bi.tsx` listed exports as "PDF for the page, Excel/CSV for the data" —
phrased as the complete set — after deck export shipped with its own dialog.
`docs/BUSINESS_INTELLIGENCE.md` documented it the same day. Added the row plus a
section covering what the deck does and, more importantly, what it refuses to
do (the model may quote figures, never compute them).

#### F2 · S2 · Governed dashboard generation was undocumented, and the old advice was wrong for it

The page described the AI tab as writing "a whole dashboard… from a sentence.
Read the generated query before trusting the chart." On the governed path that
advice is specifically wrong: the planner never writes SQL, the compiler does,
and "read the query" misdescribes where the guarantee comes from. Added a
section covering the two sources, the declared-vocabulary confinement, and the
refusal-with-reason behaviour.

#### F3 · S1 · The price-resolution table was missing its top layer

`docs.budgets.tsx` documented four price layers with "Operator override"
winning. Provider-reported cost shipped yesterday and **outranks all four** — it
is what you were actually billed. A reader reconciling a figure against that
table would have concluded their override was in force when the provider's own
number was. Added the layer, plus callouts for two facts the app now
communicates and the docs did not: totals render as `$12.34+?` when a call
underneath had no known rate, and a provider-reported zero is a measurement
rather than a missing price.

#### F4 · S1 · Self-inflicted: I introduced an SSR crash while writing F2

`<Callout kind="note">` — there is no `note` kind; the valid set is
`info | warn | why`. `/docs/bi` threw during server rendering, returned **200**,
and silently fell back to client rendering with its body truncated from 100,813
bytes to 24,487.

Two process failures, both mine, both worth keeping:

- **I validated the value against a file I had just edited.** Grepping for
  `kind="..."` across `docs.*.tsx` returned `note` — because my own unsaved-yet
  change was the only source of it. A check whose evidence is your own change
  confirms nothing.
- **I did not run `tsc` between editing and moving on.** The prop is typed
  `keyof typeof CALLOUT_STYLES`; the compiler had the answer immediately.

#### Method note · an SSR crash returns 200

This is the reason F4 nearly escaped. A page whose server render throws still
answers **200 OK** and recovers on the client, so status codes and a rendered
screenshot both look fine. The reliable marker is the string
`Switched to client rendering because the server rendering errored` in the HTML.
Every future module sweep should check for it, and should re-run **after** edits,
not only before.

#### Weak assertion, caught by mutation

The first version of the deck-prose check was one alternation —
`/prohibition|enforcement/` — and **survived** a mutation deleting the
prohibition, because the other branch still matched. Split into two required
regexes; the mutation then killed it. Same class as the `indexOf` ordering test
found earlier: an assertion that passes when half its subject is gone is not
asserting the claim.

**Tests:** 12 in `tests/unit/docsCurrency.test.ts`, mutation-verified — six
reversions, all killed, restore confirmed. Each case ties a capability that
exists in code to the phrases the page documenting it must contain, and asserts
the code marker still exists so a case cannot vouch for a deleted feature. It
catches "shipped it, forgot the handbook" for the listed capabilities; it cannot
prove the handbook is complete, so new features still need a case added by hand.

### 2026-08-16 — Module 1, Dashboard (`/dashboard`)

Five findings, all of the "renders fine, says something false" kind. Nothing on
this page threw, logged, or looked broken.

#### D1 · S1 · "Activity — last 24h" reported 51 hours

The card fetched the newest 200 traces and filtered only the RUN COUNT to 24
hours. Success rate, average latency and spend were computed over the whole
page. On this account those 200 rows spanned **51.3 hours**, so the card read:

| Figure       | Card said | True for 24h | Error     |
| ------------ | --------- | ------------ | --------- |
| Success rate | 96%       | 98%          | −2pt      |
| Avg latency  | 19.4s     | 12.2s        | +59%      |
| Spend        | $1.31     | $0.56        | **+134%** |

Fixed in `src/lib/dashboardActivity.ts` — the window is applied first and every
figure derives from it. Verified live afterwards against the server-side
aggregate (`/dashboard` Spend panel set to "Last 24 hours"): both paths now
report 59 runs, 98%, $0.54 from independent code.

`src/lib/budgetSpendClient.ts` already documented this failure mode. The fix
landed on month-to-date spend and never reached this card — worth remembering
that naming a bug class in one file does not retire it elsewhere.

#### D2 · S1 (latent) · The run count silently capped at 200

`runs24h` filtered an already-capped fetch, so above 200 calls in a day it
reported a prefix as the total with no disclosure. Today's 61 runs made it
correct by luck. Now `activityWindow` PROVES coverage — the window is complete
only when the fetch ran past its far edge — and the card renders "≥N runs" plus
an explicit notice when it cannot see the whole window.

#### D3 · S2 · "Where your tokens went" plotted run counts

Not merely a wrong label: ranking by runs put `google/gemini-3-flash-preview`
4th with 6 runs, where by tokens 4th belongs to `~anthropic/claude-haiku-latest`
with 11,873 — a different model. The leader's margin changed too, 2.3x by runs
versus 1.09x by tokens. Now ranks by tokens, prints the token count, and says
how many models the top-4 cut left out.

#### D4 · S3 · The hourly bars read backwards across midnight

Bucketing by `getHours()` into a fixed 0..23 array puts today's 00:00 on the
left and yesterday's 23:00 on the right. Now bucketed by hours-ago, so the axis
is chronological, and each bar's tooltip names the hour it actually covers.

#### D5 · S3 · "BY MODEL" showed 6 of 22 without saying so

Ranked by cost, so the six shown covered 95% of spend but only **37% of runs** —
`openai/gpt-4o-mini`, the busiest model on the account at 1,256 of 2,576 runs,
was absent from a panel headed "BY MODEL". Now discloses:
"top 6 by cost · 16 more models not shown (1,631 runs, $0.3612)".

#### Verified correct, left alone

Hero tiles (7/15/17/3/17) match the database exactly. The Spend panel's totals
($7.65, 2,576 runs, 3,601,015 tokens, 94%) match a paged recount exactly — the
server-side aggregation holds. The budget badge's 119% is arithmetically right
($5.94 month-to-date against a $5 cap); the overage is real and follows today's
repricing of 116 previously-unpriced calls, not a counting error.

A `TeamSpend` null-`.slice` crash and two failed requests in the console turned
out to be a stale buffer from earlier navigation in a long-lived tab; that crash
was fixed earlier today and all five of this page's queries return 200.

**Tests:** 26 in `tests/unit/dashboardActivity.test.ts`, mutation-verified —
five reversions applied one at a time, each killed (5/2/2/4/2 failures), restore
confirmed on disk after every run.
