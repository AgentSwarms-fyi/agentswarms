# Adversarial queue — what to hunt next, and where the loop is

> Part of the [AgentSwarms docs](../README.md#documentation).

The [Adversarial log](./ADVERSARIAL_LOG.md) records what was found. This file
records **what to look at next**, so a session that has never seen the others
can pick the work up and keep going.

The coverage map in the log finished a first pass over all 31 modules in August
2026: walk a module, press every control, compare every displayed figure against
the database. That pass is done. Running it again module-by-module would mostly
re-read pages that were already read.

So the loop now runs the other way round: **one defect class swept across every
module**, because that is how the last thirteen rounds actually found things. A
class is chosen because it has already been caught more than once in unrelated
places, which is the evidence that it is a pattern rather than an incident.

## The loop

1. **Pick the next row** from the sweep table below — top unstarted row.
2. **Read for the class, not for bugs in general.** The sweep names one
   question. Ask only that question, of that module.
3. **Prove it before fixing it.** A grep hit is a hypothesis. Find the line
   that states something, and establish what it states when the class applies.
   If it turns out to be handled, mark the row `clear` and move on — three of
   the last five candidates were already correct, and saying so is the result.
4. **Fix the statement, not the symptom.** These are almost never arithmetic
   bugs. They are a true sentence about the wrong rows, or a sentence that
   outlived its data.
5. **Tests, then mutants, then a control.** Every new guard gets a mutation run
   against a verified-green baseline, and a control mutant that must survive. A
   surviving mutant is either a test gap or an equivalent one — decide which by
   applying it and running the typecheck, never from the armchair.
6. **`npm run check` must exit 0**, read from the shell, not from a wrapper's
   status line.
7. **Record it**: a finding in the log with a severity, this row marked, and a
   commit whose message explains the reasoning rather than the diff.
8. **Go to 1.**

A round that finds nothing is a successful round. It converts "probably fine"
into "checked, on this date, against this question".

## Sweep 2 — partiality: a prefix presented as the whole

**The question to ask of a module:** _does anything here state a figure, a
verdict or a sentence computed from a read that may have been capped, sampled or
snapshotted — without saying so?_

Why this class: every engine and table read in the product has a cap
(`widgetRowCap`, `DATA_QUALITY_ROW_CAP`, PostgREST's max-rows, a `LIMIT` in a
picker). Below the cap the prefix IS the data and nothing is wrong, which is why
this never shows up in development and is systematic in production. It has now
been found in nine unrelated places.

The three shapes it takes:

- **A total over a prefix** — sums, counts, averages, shares. `count` is the
  worst: it returns the cap itself.
- **A verdict over a prefix** — a quality test, an alert threshold, a "no
  results" empty state. Note the asymmetry: some verdicts survive capping (a
  freshness _pass_ does, because the true maximum is at least the prefix's) and
  some cannot (the matching _fail_).
- **A sentence that outlived its rows** — prose or a caveat stored beside data
  that a later refresh replaced.

| Module / surface       | Status   | Date       | Result                                                                                                       |
| ---------------------- | -------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| BI widgets & refresh   | ✅ fixed | 2026-09-19 | R24, R27 — notes outlived their rows on three write paths                                                    |
| BI insight card        | ✅ fixed | 2026-09-20 | R29 — a prefix's total stated as the total, and the checker grounded it                                      |
| BI reports & PDF       | ✅ fixed | 2026-09-20 | R30 — the Partial badge did not survive the export                                                           |
| BI alerts              | ✅ fixed | 2026-09-20 | R28 — thresholds compared against the first 500 rows; `count` = the cap                                      |
| Data quality           | ✅ fixed | 2026-09-20 | R31 — freshness called data stale on rows it never read                                                      |
| Analytics `/analytics` | ✅ fixed | 2026-09-20 | R32 — a spend trend from two floors, on the card that already said "+?"                                      |
| AI analyst             | ✅ clear | 2026-09-20 | Already states the truncation first and drops shares — nothing to do                                         |
| Scan / insight sweep   | ✅ clear | 2026-09-20 | Refuses truncated widgets by name, with the remedy                                                           |
| Public embeds          | ✅ clear | 2026-09-20 | Reuses `BiWidgetCard`, so it inherits Partial and freshness                                                  |
| Evaluations            | ✅ fixed | 2026-09-20 | R33 — baselines were filtered out of the 50 most recent runs across ALL datasets                             |
| Traces & Logs          | ✅ clear | 2026-09-20 | Every figure exact, scoped to "loaded traces", or covered by its own banner; costs carry `+?`                |
| Audit log              | ✅ clear | 2026-09-20 | `auditWindowHeadline` already states shown-of-total and the retention boundary                               |
| Budgets                | ✅ fixed | 2026-09-21 | R34 the gate counted unpriced calls as free; R39 the admin display re-implemented the sum from a capped page |
| Swarm traces           | ✅ fixed | 2026-09-20 | R35 — `.limit(200)` then "N swarm runs"; the sibling page's fix had not been applied here                    |
| Monitoring             | ✅ fixed | 2026-09-20 | R36 — a failed poll kept the probes and the verdict; the board froze green                                   |
| Model registry         | ✅ fixed | 2026-09-20 | R37 — `.limit(2000)` against a 1,000-row server cap, on an alphabetical read                                 |
| Knowledge base         | ✅ fixed | 2026-09-20 | R38 — membership asked of a 1,000-row prefix; indexed documents re-embedded                                  |
| Agent swarms / runs    | ✅ fixed | 2026-09-21 | R40 — a run's steps, data flow and canvas DAG were an unbounded read of a bounded API                        |
| `lib/pagedSelect`      | ✅ fixed | 2026-09-21 | R41 — out of order: the shared pager read a short page as the end of the filter                              |
| Pagers that persist    | ✅ fixed | 2026-09-21 | R43 — lakehouse import, Parquet mirror and widget refresh; a failed page became a shorter table              |
| Offsets that skipped   | ✅ fixed | 2026-09-21 | R44 — `start += PAGE` left holes, not a tail; the SQL tool an agent calls, prep, and version copies          |
| Audit export           | ✅ fixed | 2026-09-21 | R45 — the one close that ended the evidence stream without an error line                                     |
| Local SQL engine       | ✅ fixed | 2026-09-21 | R46 — five parallel windows, any one of which could end the read; a failed shared read registered empty      |
| Pager sweep tail       | ✅ fixed | 2026-09-21 | R47 — `capped` and `truncated` described a prefix over rows that were a scatter                              |
| Workbench refresh      | ✅ fixed | 2026-09-21 | R48 — the first caller to meet R46's throw had no try; spun forever and said nothing                         |
| Dataset list read      | ✅ fixed | 2026-09-21 | R49 — a failed table list answered as an empty account: sidebar wiped, samples seeded, seeder's own reads unchecked|
| Catalog local half     | ✅ fixed | 2026-09-21 | R50 — a failed local hydration counted as zero: 21 · 0 · "21 of 21" over a warn nobody sees                        |
| Catalog attribution    | ✅ fixed | 2026-09-21 | R51 — a failed read of where a table came from filed every synced dataset as an upload                             |
| Catalog first paint    | ✅ fixed | 2026-09-21 | R52 — loading rendered as `Local tables 0`; a pass before the session painted 33 for two seconds                   |
| IAM policy reads       | ✅ fixed | 2026-09-21 | R53 — a failed settings or memberships read evaluated the model policy as unrestricted; grants and roles the same shape|
| Deck generation fill   | ✅ fixed | 2026-09-21 | R54 — a failed dataset read answered as "no data connected"; the deck shipped chartless and silent                     |
| BI generate dialogs    | ✅ fixed | 2026-09-21 | R55 — "upload data on the Data & SQL page first" over a failed read of thirty-three datasets                           |
| Credential and audit reads| ✅ fixed | 2026-09-21 | R56 — a failed own-credential read became "not configured"; a failed Auth page showed people as ids                    |
| Scheduler pass            | ✅ fixed | 2026-09-21 | R57 — twenty folded sweeps and three folded reads answered ok: true with zeros; the result carries errors now          |
| KB retrieval              | ✅ fixed | 2026-09-21 | R58 — a failed ACL read showed restricted documents; every failed search told the model "no match"                     |
| Scheduler surface         | ✅ fixed | 2026-09-21 | R59 — the pass's failures and a stopped scheduler now show on Monitoring, beside every other service                   |
| SQL model stamps          | ✅ fixed | 2026-09-21 | R60 — a definition edit is marked by the database and the page stops calling the previous build this one's             |
| Semantic layer            | ✅ fixed | 2026-09-21 | R61 — the runner fetches one past its cap and says when it cut; the preview, a widget's parameter re-run, the analyst's step and the refresh all say partial|
| ML predictions            | ✅ fixed | 2026-09-21 | R62 — Jobs (20) on a model with twenty-one versions; both list handlers now throw on a failed read and say when the list is the newest N|

## Sweeps after this one

### Closed: the hand-rolled pagers

Nine were found by grepping for one assumption — `chunk.length < PAGE` as
proof that a filter is exhausted — and all nine are done: three that persisted
what they read (R43), three that skipped rows with nothing downstream able to
tell (R44), the audit export (R45), the five-window parallel reader (R46), and
the tail whose disclosure flags described the wrong defect (R47).

`src/utils/audit.functions.ts` is deliberately not in this set. It pages the
Supabase Auth admin API, which honours its own `perPage` and has its own
pagination contract, so a short page there really is the end. Its `error ||`
fold belongs to the failed-read sweep instead, where a failed page means the
user list behind audit attribution is quietly short and audit rows show ids
where they should show people.

Queued, in the order the evidence supports. Each is a class already seen at
least twice, not a hypothetical.

1. **A failed read rendered as absence.** "No results", "none connected", "0
   items" shown when the read threw. Pass 1 found this in eight modules, each
   fixed locally — the sweep asks whether the NEXT eight have it too. R49 is
   the first of them and it was load-bearing: the dataset list every data
   surface hydrates from. Three of its callers still render absence on catch
   and are next. Two seen in the browser during R49's validation were fixed
   as R50 — the catalog's `setLocalAssets([])` and the prep tab's section
   badge; and as R51 the catalog's attribution reads, seen by accident after
   a rebuild and first misattributed to the container starting up; and as R52
   the paint before the session resolves; as R54 `lib/docGen/biData`; and as
   R55 `bi_.report` with both generate dialogs; and as R56 `audit.functions`
   and `credentials.server`, both server-side. The named list is done; a
   survey of the shape (40 `.catch(() => [] | null)`, 45 `catch { return … }`,
   420 error-less server destructures) found most benign — JSON fallbacks,
   optional caches — and two that are not: the scheduler's pass
   (`bi/refresh.server` `runCronPass`: twenty steps folded to a warn, three
   reads folded to "nothing due", `/api/bi/cron` answering ok: true over
   all of it) and the KB keyword path (`tools/kb.server`: a failed page
   breaks the loop, and `page.length < KEYWORD_PAGE` is R41's short-page
   assumption again). The scheduler is R57 and the retrieval path R58 —
   which turned out to hold a fail-open ACL catch as well; the surface for
   the pass result is R59, on the Monitoring page.
2. **A badge that outlives what it vouched for.** Verified/priced/fresh/healthy
   stamped once and never revisited. R24 and R26 are the BI instances. R60
   is the SQL model whose `built · N rows` survived a replaced SQL — fixed
   with a definition-change mark set by the database. The same shape, an
   edit that keeps the last result, is in: the lakehouse materialized-view
   upsert (`matviews.server` — `last_status`, "Last rebuilt"); the ETL
   pipeline save (`etl.functions` — `last_run_status` chip); the workflow
   saves (`workflows.functions`); the data-monitor config update
   (`dataMonitors.functions` — `ok` and `last_value` over a changed rule;
   server-function only, the page has no edit); the app-source re-save
   (`saas.functions` — `last_test_status` over replaced credentials; the
   warehouse and provider saves clear it; the Apps tab cannot reach the
   update path). The materialized view was CHECKED in R101 and its stamps
   are honest: a save always rebuilds, and a failure sets `error` while
   "Last rebuilt" keeps the last good time. What the same path held
   instead was worse. "Save as view" on the name of an ordinary table
   replaced that table's data and reported "Built". That is fixed as
   R101. Still open there, at S3: a failed rebuild shows only in the
   badge's hover title, while the badge itself reads "materialized" as
   before. Next in this sweep: the ETL pipeline save's `last_run_status`
   chip.
3. **A cause named that the evidence cannot support.** R31's freshness test, and
   Prompt Compare crowning the model that failed fastest. R63's dashboard
   chip is the degenerate case: a count of `last_status = 'error'` on a
   column whose constraint allows `built`, `failed`, `skipped` — a zero
   that could never be anything else. Surveyed the same day: every literal
   `.eq/.neq/.in` on a status-like column (72 predicates) against the
   column's CHECK (78 constrained columns in the migrations) — the
   dashboard's was the only mismatch; the survey re-run with the old
   predicate in place catches it, so the zero is a real zero.
4. **Two surfaces, two answers.** The same figure computed twice by different
   code — the browser engine and the server refresh disagreeing on a row cap is
   the recorded instance.

## Rules that came out of doing this

- A test that asserts source text is pinning a USE, not a definition; bound it
  by something structural (the next export), never a byte window.
- Never hard-code the output of a locale-aware call — Node here resolves en-IN
  and writes `10,00,000`.
- A harness that rewrites a source file computes the bytes first and asserts
  they are non-empty. `open(p, "w").write(x)` truncates before evaluating `x`,
  and emptied a 1,491-line file once already.
- Keep the fixtures a round created, and say in the log where they are.
- `.limit(n)` is not a ceiling you control. PostgREST answers every request
  with at most `db-max-rows` — **1,000** on a default Supabase project, measured
  twice — and supabase-js returns the short page with no error and no flag. An
  unbounded `.select()` is a select of the first thousand rows. A read that must
  be complete pages by CURSOR and compares against an exact count; a read that
  answers MEMBERSHIP must page too, because absence from a prefix and absence
  from the table are the same shape.
- Never stop paging at the first short page. That test is wrong the moment the
  server's cap is below the page size asked for, which is the exact assumption
  these bugs were made of.
- `git add` a new module before running the gate. `scripts/check-md-docs.mjs`
  resolves a documented path against git's index, so a paragraph naming an
  untracked file fails — correctly.
- Drive the page. Seven rounds of unit tests and mutants missed a shipped S1
  (every group spend query returning 400) and a defect in a fix from the round
  before, both of which a browser found in minutes. A source-anchored test reads
  the code; it never puts an argument on the wire.
- A disclosure helper is written for ONE situation. The call site decides
  whether it is in that situation — "partial" and "failed" both produce an empty
  array, and only the caller knows which happened.
- An anchor a SIBLING can satisfy checks nothing. Where a rule must hold at
  several symmetric sites — two pagers, three branches — count the occurrences
  instead of looking for one. Four mutants survived a run on that alone.
- A test double shaped to a buggy caller votes for the bug. When a fix makes a
  stub fail, ask which of the two was describing the real system — one stub here
  ignored the page window entirely and faked an ending, because the loop it was
  written for could not find one honestly.
- Run ALL of what the grep returns, not the interesting-looking half. Eighteen
  files were found; eleven were run; the gate found the twelfth.
- Before the gate, grep `tests/` for the files the round touched and run those
  first. Three rounds in a row cost an extra ten-minute gate to an existing
  source-anchored test that a two-second run would have shown.
- A caller that meets a new throw needs somewhere to put it. R46 made the
  reader throw; the first call site to meet it had no try, and only a browser
  saw the spinner. When a fix changes a function from returning to throwing,
  read every caller before the gate, not after.
- A word in a comment satisfies a keyword regex. `/catch[^}]*…/` matched
  "catches" in prose and ran into the next block. Pin the keyword with its
  syntax — `catch (e) {` — and read only the block it opens.
- A read that answers `[]` on failure reaches every caller as an empty
  account, and the callers that act on emptiness — seed, wipe, drop the
  charts — act on the failure. The read throws; absence is the caller's to
  decide, and only after a read that succeeded.
- A comment that says "not an empty account" above `setLocalAssets([])` is
  not a disclosure. Read what the catch DOES, not what it says.
- A reading taken once is not a measurement. "Local tables 33" after a rebuild
  was blamed on a server call failing while the container came up; sampled
  every two seconds it is a two-second paint made before the session had
  resolved, with zero server calls. Sample a first load over time before
  naming its cause.
- "Not read yet" is a third state. Empty, failed and loading all render as
  the same zero unless each has its own mark; R50 covered failed and left
  loading as a count for ten seconds of every page load.
- A pass that cannot ask the question must not paint an answer. Before the
  session resolved the catalog could not ask for its connections, ran
  anyway, and filed every synced dataset as an upload until the re-run.
- A policy read that fails must fail CLOSED. `settings?.mode === "deny"`
  reads a failed settings query as allow; a dropped memberships error reads
  as "no groups". Every access decision that reads `{ data }` without
  `error` is a decision made on a failure.
- A warning gated on a count is silenced by the failure that zeroes the
  count. "N of M could be filled" needs M > 0; the read that failed
  reported M = 0 and was the one case that said nothing. Count what was
  asked for before reading anything.
- Advice is a claim. "Upload data first" asserts there is no data; over a
  failed read it is wrong twice — the data exists, and uploading changes
  nothing. An empty list that has a reason shows the reason.
- `.catch(() => null)` around a function that already answers null for
  "none" has exactly one effect: it makes a failure look like none. Read
  what the callee answers before deciding what its throw means.
- A job that folds every step to a warning has one observable outcome,
  success. `console.warn` is not a report; a result the caller can read is.
  Fold the step, record the fold.
- A catch written for one failure catches every failure. The comment says
  "availability guard for ONE state only"; the code has no test for the
  state. Match the error you mean, and fail closed on the rest.
- "It returned no matching passages" is a claim about the documents. A
  search that could not be completed has no standing to make it, and the
  model it is told to will repeat it as fact.
- The worst a dropped write does is not a stale badge but wrong numbers
  (R87): a rebuild whose clearing delete failed appended its rows instead
  of replacing them, and nothing downstream recomputes a row count. Where
  a write is half of a replace, the other half must not run unless it
  landed — and the action fails, leaving the data as it was.
- A try/catch around a supabase call is not a guard, it is a comment
  (R86): the call answers with its error, so the catch never runs and the
  write is unconditionally silent. Three rounds found this shape —
  `writeLineage` (R83), `touch` (R77), the whole swarm tracer (R86) — so
  `catch { /* best-effort */ }` around a `.from(...)` chain is worth a
  grep of its own.
- Some columns are not display: they are the clock and the edge (R85).
  `next_run_at` decides whether the work runs again; `last_state` decides
  whether a person is told again. A dropped error on either does not show
  as a stale badge — it shows as a loop. Find the writes whose value is
  read back by the code that decides, and guard those first.
- A notification is a claim about a row, and it must not outrun the write
  that would make it true (R84): "Recovered" over an incident that could
  not be resolved is worse than silence, because the person stops looking.
  Where the event is real but its record is not, send the message and say
  what could not be recorded in it. The single-site files continue:
  `mcpApps/service` (5), `bi/prep`, `bi/refresh`, `bi/versions`, the swarm
  and notification writers.
- A guard added in one round is a write like any other (R83): R60's "edited
  — not built since" mark was cleared by a write whose error was dropped,
  so the badge could lie the other way. A state the build's own result can
  carry is carried there, where the person who pressed Build reads it. The
  single-site files continue: `bi/prep`, `bi/refresh`, `bi/versions`,
  `dataMonitors/run`, `mcpApps/service`, the swarm and notification writers.
- A replace is a delete and an insert, and the insert must wait for the
  delete's answer (R82): written beside edges that could not be cleared, a
  lineage graph shows a past that never was. Claim a removal only once the
  rows are gone; a status row that cannot take its terminal state fails the
  action with the reason rather than leaving "running". The server-side
  write survey's multi-site files are done (R73–R82); the single-site files
  remain (`bi/*`, `dataMonitors`, `mcpApps`, `swarms`, `sqlModels`, the
  notification and email senders).
- A fix on one path is a defect left on its twin (R81): the page's promotion
  was guarded in R73 while the API's and the schedule's copy of it kept the
  old order and dropped every error. When a fix lands, grep for the second
  implementation and route it through the first. The survey continues:
  `catalog/crawler.server` (6, with the ETL lineage delete), then the
  remaining single-site files.
- The record everything else's record rests on gets the same rule (R80): a
  sandbox whose session row could not take its container ref is stopped
  while the ref is in hand, never left for a reaper that stops by the ref
  it does not have. Seen on the way: with `NOTEBOOK_GATEWAY_URL` unset the
  notebook page reports `Kernel connect timed out` over a kernel that is
  ready — a deployment gap to document, not a write. The survey continues:
  `ml/api.server` (8, the API-path promotion), `catalog/crawler.server` (6).
- An outcome claimed on one row and dropped on the next is two records that
  disagree for ever (R79): a job "succeeded" over a version "training".
  When the second write fails after a retry, un-claim the first with the
  reason rather than leave the pair. The survey continues: `ml/api.server`
  (8, with the API-path promotion that drops the three writes R73 fixed on
  the page path), `notebookRuntime/service.server` (7: the container ref
  and stopped mark every sandbox depends on), `catalog/crawler.server` (6).
- A cancel writes its record before it stops anything (R78): stopping first
  and failing the write leaves a "running" row over nothing, which is the
  state nothing corrects. And a cursor a successful run could not save is
  the next run's duplicates: say it on the run, where they will be looked
  for. The survey continues: `ml/train.server` (9), `ml/api.server` (8),
  `notebookRuntime/service.server` (7), `catalog/crawler.server` (6, with
  the ETL lineage delete).
- A record that cannot describe what is running is corrected by stopping
  what is running (R77): a sandbox whose session id, ready state or name
  the row could not take is stopped again while the id is in hand, rather
  than left warm, unused and unstoppable. Where the irreversible step is
  already done — copies gone, row still `ready` — the answer names the
  state left and the button to press. The survey continues:
  `etl/service.server` (13), `ml/train.server` (9), `ml/api.server` (8),
  `notebookRuntime/service.server` (7), `catalog/crawler.server` (6).
- Two timeouts that do not agree (seen while driving R89): the MCP deploy's
  server budget is 90 s of cold start, and the request in front of it gives
  up sooner — so a first deploy after a container restart reports "The
  operation was aborted due to timeout" and marks the app Error while its
  sandbox finishes starting and answers. The write is not the problem; the
  two numbers are. Candidate for a round: find every pair where the caller's
  patience is shorter than the work it waits on, and make the shorter one
  say what is still happening. CORRECTED (R98): for the MCP deploy this was
  the wrong diagnosis. The only timer on that path that produces the
  message is the handshake's own 15 s, and what it waited for was the END
  of a `tools/list` stream that had already delivered its answer. The
  general question about mismatched timeouts still stands; this example
  does not support it. FOUND for real in R100, one door along: the
  endpoint's CLIENTS (agents, swarm Tool nodes, Test connection) gave
  `initialize` 12–15 s against a cold start of up to 90 s. The rule that
  came out of it is that a client's patience must outlast the server's own
  budget, so the server's answer, whatever it is, is the one that arrives.
  Other pairs to check the same way: the gateway's provider calls against
  a provider's queueing, ETL run starts against the Spark session's
  start-up, and warm-endpoint deploys against the runtime image pull.
- Two ways to end, one cleanup (R93): a sandbox could be ended BY something
  or end BY ITSELF, and the teardown lived only on the first path — so
  every kernel that finished normally left its container on the host for
  ever. The shape to look for is a resource whose release hangs off a
  cancel/stop/delete handler, and a second exit (completion, crash,
  expiry, external removal) that merely records the outcome. Ask of every
  such pair: which exit frees the thing? SWEPT (R94), and it took two more
  exits, one of them the commonest of all — the sandbox that posts its own
  result. The lesson from that: when you fix one exit, ENUMERATE the others
  by asking who else can write the terminal status, not by reading the
  function you just changed. The pattern still wants looking for outside
  sandboxes: a temp file, a lock, a lease, a reserved slot, anything whose
  release hangs off one exit of several.
- One piece of work, two records (R92): a resume inserted a second
  `swarm_runs` row and left the parked one open for ever, although the
  option's own comment promised the timeline would continue rather than
  fork. Two lessons. A comment that states an intention is a claim to
  TEST, not documentation to trust — the promise and the code sat four
  lines apart. And a record that is only ever written by the path that
  finishes normally is a record that the interesting path leaves wrong:
  look for every `insert`-then-`update` pair whose update lives in one
  branch, and ask what the other branch leaves behind. Siblings to check:
  workflow runs, ETL runs and notebook sessions, all of which can pause
  and be continued.
- A create that is secretly a replace (R101): "Save as view" builds with
  `CREATE OR REPLACE TABLE`, and nothing asked what was at the name, so it
  overwrote an existing table and reported "Built". Look for every write
  whose verb is CREATE OR REPLACE, `upsert`, `overwrite`, or `mode("overwrite")`
  behind a control that reads as "save" or "create", and ask what is
  already at the target. Siblings to check: the ETL sink's write modes, a
  Data Prep flow saved as a dataset over an existing name, the CSV upload's
  table name, the Iceberg publish, and the SQL model build target.
- A protocol step skipped because one server let it slide (R99): the
  agents' MCP client never sent `initialize`, and worked against whatever
  it was first tried on. A stateless server accepts a cold request, and a
  stateful one refuses it, and stateful is FastMCP's default. The Builder
  deploys that default and told its owner "your agents can call it now".
  Everything a person could look at did the handshake, so the one caller
  that skipped it was the only one that failed. The class is a client
  written against one server's leniency. Ask of every protocol client
  here which steps the protocol requires and which ones this code happens
  to get away with skipping. Siblings: the A2A client, the OAuth/token
  refresh paths, and the webhook signature checks. Found while driving
  it:
  - **The first agent call to an idle Builder server always failed.**
    DONE (R100): every client of the endpoint now gives `initialize` the
    endpoint's own cold-start budget plus one request's worth. A 5xx
    initialize is taken as the answer rather than retried bare. Still
    open from it: Test connection (`src/lib/mcp/probe.functions.ts`)
    opens a session and never ends it, so each press leaves a row in
    `mcp_app_sessions` for a Builder server. That is R99's leak in its
    other client. It should end its session, or share
    `mcpApps/session.ts`.
  - Each request through `/api/mcp/s/<slug>` costs about 1.1 s before it
    reaches the sandbox, because `ensureRunning` re-probes it every time.
    A session is three requests, so an agent tool call costs about 3.8 s.
  - The first `tools/call` in a freshly started sandbox took about 10 s,
    against 0.44 s for the same FastMCP with no container limits. It was
    not diagnosed.
- A reply read to the end of a stream that need not end (R98): five MCP
  clients did `await res.text()` on an event stream the spec only asks the
  server to close, so a server that kept it open cost each one its whole
  timer and turned an answer into a timeout. The class is a reader whose
  completion depends on the other side doing something OPTIONAL: closing
  a stream, sending a trailer, ending a chunked body. Siblings to read for
  it: the A2A client in `src/routes/api/a2a.ts`, which asks for
  `text/event-stream`, and anything else that buffers a stream it should
  consume. Seen in passing and not fixed:
  - **the agents' MCP client** (`mcpRequest` in `tools/registry.server.ts`)
    sent `tools/list` and `tools/call` with no `initialize` and no session
    id. DONE (R99): FastMCP refused it with `400 Missing session ID`, and
    the call now runs in a session of its own.
  - A deploy whose handshake fails leaves its sandbox running under an app
    marked Error.
  - The Builder page's own Deploy handler awaits without a `try`, the shape
    the console had.
  - One stock deploy in R98's batch of eight took 119 s against a usual
    23 s. The cron lease logged `fetch failed` 27 s after it ended, which
    hints at the network to the database. It was not diagnosed.
- A dropdown is not a gate (R97): the code generators left model
  governance to the model picker, and the picker starts unset, so the
  server's own fallback was the one choice the rules never saw. Wherever a
  server resolves a default on the caller's behalf — a model, a region, a
  warehouse, a destination — ask what checks the DEFAULT, not only what the
  UI lets someone pick. The rule belongs where the value becomes final.
- A gate asked at the front door only (R96): the runtime switches were
  checked by the interactive route and nowhere else, because the function
  that actually starts a kernel is shared with platform features that must
  not be gated by them. When a check cannot live in the shared function,
  ENUMERATE the shared function's callers and ask each one which side of
  the gate it is on. Siblings worth that treatment: model-access rules
  (every path that calls a model, including swarm nodes, workflows, ETL AI
  columns and scheduled analyses), and dataset permissions (every path
  that reads a table, including exports, embeds and Delta Sharing).
- Things that only happen while someone is looking (R95): the scheduler for
  every clocked job was started by the notification bell's mount effect, so
  a headless server ran nothing until a person signed in — and the page an
  operator would open to check it started it as a side effect. Look for
  server behaviour initiated from a client effect: anything a deployment
  with nobody logged in would never trigger. SWEPT for mount-time server
  kicks in layout components: the bell was the only one; every other
  client `fetch("/api/…")` sits behind a button.
- Investigated and NOT reproduced (R95): the cron lease stranded by a
  graceful stop. Three restarts and a force-recreate, one fired while
  another worker was mid-pass, and each time the first call after boot
  ran a pass. Earlier "ten-minute stalls" after rebuilds were R95's lazy
  start, not the lease. Re-open only with a measurement that shows a skip
  inside the first minute after boot.
- The words beside a control are part of the control (R91): the Deploy
  dialog's warning described the "Reject approvals" switch backwards,
  because it was written for an executor that predated checkpointing and
  nobody re-read it when the behaviour changed. A guard whose only
  documentation is stale UI copy is worse than an undocumented one, because
  the copy is believed. Sweep: every sentence that explains what a switch,
  a default or a status value DOES, checked against the code that does it
  — start with the ones next to a `<Switch>`, and with any text that
  survives from before a behaviour change (the shipped templates' notes
  name several such changes explicitly).
- Ask what a status word is FOR before trusting it (R90): the swarm resume
  gated on `status === "suspended"`, a word written by a stamp that could
  fail, when the thing a resume needs is the checkpoint. Where a guard and
  a dropped write meet, the guard turns a lost write into a lost decision.
  Look for `if (row.status !== …) return ok` above any resume, retry or
  cancel, and gate on the artefact the work needs instead.
- A status column written by every exit of one function is worth reading
  twice (R89): `setAppStatus` is the single place six outcomes are
  recorded, so one dropped error covers them all, and the two directions
  it fails in are opposite — Running over a dead server, Error over a live
  one. Where a deploy's answer names things a caller will use, the write
  that records them is part of the deploy, not an afterthought.
- The stale-list class is worst where the page also WRITES to the selection
  (R88): on Agent Chat the sidebar highlighted one conversation while the
  transcript showed another's, so a reply would have gone somewhere the
  reader could not see. Swept the pages that key a list on a selected row:
  Agent Chat had it on both lists and is fixed; the ETL runs tab is clear
  (its list starts null and the component is keyed per pipeline); the ML
  model, swarm and dashboard pages key on a route param, so a change is a
  navigation rather than a swap.
- A list kept across a selection change is the previous selection's list
  (R76): the Knowledge Bases page showed the last base's documents under
  the next base's name until the next read landed, and counted them on the
  tab after it had failed. Clear on selection, say loading, drop a read that
  comes back for a selection no longer current, and count only what was
  read. Any page that keys a list on a selected row is a candidate.
- A conditional write's empty result has two causes (R75): "someone else
  won" and "the write failed". Reading only the rows back conflates them,
  and the second is the one that leaves a state nothing will ever correct.
  Read the error first; treat a race as a race only when there was none.
- A write that follows an irreversible step must say what that step already
  did (R74): the schema is dropped whatever the catalog row answers, so the
  message names the row, not the schema. Seen in the browser on the way:
  the explorer stays stale after "Dropped" until a reload — a refresh that
  should follow the drop, for a later round.
- A multi-step write is ordered by what a failure part-way leaves (R73):
  promote wrote archive → pointer → stage, so a failure at the pointer left
  a model serving nothing with its old version already archived. Write the
  step whose failure is cheapest first, and say which step failed. The
  server-side survey (237 error-less writes in 64 files) continues: the
  lakehouse deletes (`lakehouse.functions`, 8), dataset deletion
  (`data/ingest.server`), the workflow runner's status writes, ML serving
  and training state, the catalog crawler.
- A delete that a second write depends on must stop the second write when
  it fails (R72): regenerate and edit-and-resend insert on top of what they
  could not remove, and a reload shows both. The write survey is closed;
  next is a survey of the same shape one level down — server functions
  whose `.update(`/`.delete(` drop their error and return `{ ok: true }`.
- The bell's badge is the same promise (R71): a count that goes to zero on
  screen before the delete lands must come back when it does not. The
  write survey's remaining files: evaluations' two deletes, the swarm chat
  dialog, the add-source dialog, and Agent Chat's conversation and message
  deletes and updates.
- An optimistic switch is a promise about the database (R70): a control
  that flips before the write lands must flip back when it does not, and
  say what the stored state will do — an alert still on will still fire.
  The write survey's remaining files: the notification bell, evaluations'
  two deletes, the swarm chat dialog, the add-source dialog, and Agent
  Chat's conversation and message deletes and updates.
- A survey that reads one line at a time misses a statement that spans four
  (R69): the bare `await supabase\n .from(…)\n .update(…)` OpenRouter's
  disconnect takes was not in the write survey's count, and the browser
  found it. Survey the AST, or at least the multi-line form.
- A write with a side effect that came first (R68): the Knowledge Bases
  page forgets a document's vectors, then deletes the row. When the row
  delete fails, the honest message is not "could not delete" alone but
  what the earlier step already did — the embeddings are gone, the row is
  not, and what to do about it.
- Two paths to one action, one honest and one not (R67): the swarm gallery
  said "Failed to delete"; the canvas said "Swarm deleted" over the same
  rejected request. When a page grows a second way to do a thing, the
  second way inherits none of the first's care unless it shares the code.
- A settings page that says "auto-saved" must derive that from the last
  write, not toast a constant (R66, Budgets). The write survey (40
  error-less client writes in 10 files) still has: swarms (3 inserts, a
  delete), the BI schedule dialog (4 bare writes), Knowledge Bases' three
  deletes, Integrations' credential delete and two updates, the
  notification bell, evaluations' two deletes, the swarm chat dialog, the
  add-source dialog — and Agent Chat's own conversation and message
  deletes and updates, left for a round of their own.
- A write that failed, shown as done (R65): Agent Chat's message inserts.
  The read-side rule has a write-side twin — `const { data } = await
  …insert()` is a save that passes on failure — and a page that shows the
  optimistic row must also show when the row did not land. Survey next:
  every error-less `.insert(`/`.update(`/`.upsert(` on the client.
- The two builder lists (R64): `No agents yet` with a "New Agent" button over
  nine agents the page could not read. A list surface has four states, not
  two; the pure `listState` in `lib/listState` names them, and an error is
  ahead of empty. The client-side survey that found it (55 error-less reads
  in 25 files) still has: the playground (12 reads), swarms (6), evaluations
  (5), the swarm node inspector (4) — next, in that order.
- The home dashboard's seven counts (R63): a failed read was zero, and the
  SQL-models chip asked for a value its column cannot hold, so it never
  fired. A predicate is a claim about what the column holds; check it
  against the constraint, not against the word you would have used.
- Sweep 2's named rows are closed with R62. The failed-read shape (item 1)
  turned up again in the one module the named list never reached — the
  ML page's two list handlers — which is the argument for the survey,
  not the list. Next: the badge family under item 2, starting with the
  materialized view the Lakehouse page can edit.
- A cap the fetch stops AT cannot be seen; fetch one past it. `rows.length
  >= cap` is a guess that flags a complete result of exactly cap rows and
  is the only thing a consumer can do when the runner said nothing. Say it
  once, at the runner, and every consumer inherits the verdict (R61).
- A stamp is about the row it was written on, not the row it sits on. A
  save that rewrites the definition and leaves `last_*` alone has moved the
  stamp onto a different thing. Either the save withdraws it, or something
  records that the thing changed — in the database, so no writer can forget.
- A report nobody reads is a warning with extra steps. R57 recorded the
  failures; until a page showed them, the recording changed nothing for the
  person who would act on it.
- `const { data } = await …` is a guard that passes on failure. Every
  destructuring that drops `error` before a decision is one of these.
- Verify a Radix picker's trigger text before submit: it keeps the previous
  selection across a dialog reopen, and a mis-click imported the wrong table.
- Running a prep flow persists its output name. A "read-only" run with a
  throwaway output table re-pointed the user's flow and had to be restored.
- Read `GATE EXIT` from the shell. The background-task notification reports the
  wrapper's status, not npm's; three times now it has said 0 over a red gate.
