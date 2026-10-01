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
   before. The ETL pipeline's `last_run_status` chip is R183: a save kept
   "Succeeded" over a target the pipeline had never written. Each run pins
   its code on `etl_runs.source_code`, so the card compares it with what a
   run would compile now and says "changed since this run", no migration.
   The same comparison flagged five older pipelines whose graphs the
   current compiler builds differently: an upgrade, not an edit, and just
   as true. Where a run already pins what it ran, compare with that before
   reaching for a trigger. The workflow saves are R184, the same way over
   `workflow_runs.graph`, with layout and labels left out of the
   comparison. Still open in this sweep, neither reachable from a page:
   the data-monitor config update and the app-source re-save (both
   server-function only, above). The materialized view's failed rebuild,
   shown only in the badge's hover title, is R185: the badge now reads
   "last rebuild failed" beside the reason and the rows' age. A failure
   carried only by a `title=` is the same shape anywhere: grep
   `title=\{.*(error|fail)` for a state the page shows to a hovering
   mouse and nobody else.
3. **A cause named that the evidence cannot support.** R31's freshness test, and
   Prompt Compare crowning the model that failed fastest. R63's dashboard
   chip is the degenerate case: a count of `last_status = 'error'` on a
   column whose constraint allows `built`, `failed`, `skipped` — a zero
   that could never be anything else. Surveyed the same day: every literal
   `.eq/.neq/.in` on a status-like column (72 predicates) against the
   column's CHECK (78 constrained columns in the migrations) — the
   dashboard's was the only mismatch; the survey re-run with the old
   predicate in place catches it, so the zero is a real zero.
   Phase D (2026-10-01) surveyed the app's own strings for an asserted
   cause ("may have", "because the", "is not configured", "no API key").
   R191's "The request may have failed before the trace row was written"
   was one. R193 is the playground's failure handling: every 402 was "AI
   credits exhausted" with five fallback models offered, including the
   platform's own budget cap, which refuses them all; and the administrator's
   model rule read "openrouter: …". A response that names who refused it
   (the route's `error` code) is evidence, and a status code alone is not.
   Left from the survey, to check each claim against its condition:
   the integrations test's "the request may have been blocked before
   reaching it" (`integrations.tsx`), the lakehouse's "it may have been
   cancelled elsewhere", the swarm URL's "It may have been deleted.", and
   the runtime tab's "this app is probably not …". The four "The lakehouse /
   Qdrant is not configured on this deployment" were checked against their
   conditions: three are the config flag (`listLakehouseTablesForUser`'s
   `enabled`, the store brief's `externalAvailable`). The fourth, BI Data
   Prep's *Save as* select, says it in its hover title while the lakehouse
   list is loading or after its read failed. The panel beside it does say
   "Could not list lakehouse tables.", though without the reason, which its
   `.catch(() => setLake("error"))` drops. Small; take it with the next BI
   round.
4. **Two surfaces, two answers.** The same figure computed twice by different
   code — the browser engine and the server refresh disagreeing on a row cap is
   the recorded instance. R194 (2026-10-01) is the second:
   - **What happened.** Prompt Compare showed "Est. cost —" and "~1" tokens while Traces showed
     the same calls' real figures.
   - **The cause.** The page kept its own copy of the chat stream reader, which stopped at
     `[DONE]`, and the platform's cost event comes after it. The playground had fixed the same
     bug in its reader; the copy never heard.
   - **The lesson.** A copy of a reader does not get its original's fixes, so replace the copy
     with the shared one. A test over `src` now forbids a `break` at `[DONE]`.
   - **Still open, small.** Prompt Compare rounds cost to four places, so $0.0000046 against
     $0.00011 reads "~$0.0000" against "~$0.0001", and Traces does the same.
   - **R195: the two DuckDB engines.** On one query in the Workbench the browser engine ran in the
     viewer's zone (`Etc/GMT-4`) and the server's in UTC, so `current_date` and a TIMESTAMPTZ cast
     to DATE named different days. Every engine now sets `ENGINE_TIME_ZONE`.
   - **R196: charts east of UTC.** `parseDateValue` read the server's naive `2026-01-01 00:00:00` as
     the viewer's local time, so a lakehouse month axis at UTC+4 read "2025-12, 2026-01, 2026-02"
     for January to March. Text without an offset is UTC wall-clock time now.
   - **R197: the date formats.** The browser engine now writes DATE and TIMESTAMP as the server
     does, and the auto axis reads the engines' timestamp text as raw.
   - **Still open.**
     - The two engines are different DuckDB versions: 1.4.3 in the browser (`@duckdb/duckdb-wasm`
       1.32.0) and 1.5.5 on the server. `date_trunc('month', <TIMESTAMP>)` is a DATE in one and a
       TIMESTAMP in the other, so over a long span only the server's axis relabels. Either align
       the versions, or pass column types to the charts instead of reading them from text.
     - The chart builder's *Add to dashboard* is disabled until the chart has a title, and nothing
       says why.
   - **R198: grid vs table sheet.** A probe ran 75 formulas through both engines over the same rows.
     The table read a blank number as "0" in text and counted a blank reference in
     MIN/MAX/AVERAGE. `sheetsGridTableParity.test.ts` now holds the agreeing list.
   - **R199: the grid's own differences from Excel.** TEXT and number formats round the 15 digits
     Excel keeps (2.675 is 2.68, as ROUND says), PROPER knows accented letters, and TEXT of a
     blank is TEXT of 0. `sheetsGridExcelText.test.ts`.
   - **R200: one rounding rule in both engines.** ROUND, ROUNDUP, ROUNDDOWN, TRUNC, TEXT and a
     number in text follow Excel's 15 digits in a grid and in a table sheet's SQL, and PROPER in a
     table starts a word after anything that is not a letter. A fast path keeps the SQL near
     `round()`'s cost. `sheetsExcelRounding.test.ts`.
   - **Next, R201: numbers past 15 digits.** These are the QUEUED rows in
     `sheetsGridTableParity.test.ts`.
     - CEILING and FLOOR in the grid snap a quotient within 1e-9 × itself of a whole number, so
       `CEILING(12345678901.005,1)` is …901, where Excel gives …902. The table gives
       12345678902.000002.
     - A grid number format past 1E+21 is toFixed's exponent text: `TEXT(1.5E+21,"0")` gives "1".
       The table writes every binary digit, where Excel writes 15 and then zeros.
     - Measured, not fixed: a number in text over random 17-digit doubles takes the exact path on
       every row (846 ms per million against a cast's 100).
   - **Still open, grid.**
     - `YEAR`/`MONTH`/`DAY` of a blank give 1899/12/30, where Excel gives 1900/1/0.
     - DATEDIF from 1900-03-01 is one day long.
     - `UPPER("ß")` is "SS" in the grid and "ẞ" in the table; check Excel first.
   - **Inherent.** IFERROR mixing numbers and text makes a table column text.

### Sheets (new, 2026-09-25)

Closed while building it: R112 (a `;` inside a string refused as a second
statement), R113 (`now()` served from the result cache), R114 (JSX text
showing `\u2014` as text). Open, from the first rounds:

- ~~Excel parity, small: a dynamic array over an empty cell spills a blank.~~ It spills 0 (checked
  in R170). `=A9+30` over a date cell carries the date format forward since R168.
- **Comparisons at 15 digits?** `=0.1+0.2=0.3` and `=1-0.9=0.1` are FALSE here. Excel is often said
  to compare at 15 significant digits and give TRUE, but `=0.1+0.2-0.3=0` is FALSE there too, and
  neither was checked in Excel. Settle it in Excel before changing every comparison. Found in
  R175's probe.
- ~~`=BASE(255,16)` is `ff`.~~ Closed by R176, with DEC2HEX, BIN2HEX and OCT2HEX.
- **formula.js functions not registered** (about 170; R177 added eight financial ones): MMULT,
  AVERAGEA, MAXA, MINA, TRIMMEAN, PERCENTRANK, QUARTILE.EXC, TYPE, ERROR.TYPE, the database
  functions (DSUM…), the distributions (BINOM.DIST, T.DIST…), hyperbolic trigonometry, bitwise and
  complex-number functions. VDB is in neither. Each needs checking against Excel's examples first.
- **Excel's 1900 calendar before March 1900**: serials 1 to 60 read a day early here
  (`=YEAR(1)` is 1899, `=DATE(1900,2,28)` 60 where Excel says 59), and 0 is 1899-12-30 where Excel
  shows 1900-01-00. Excel counts a 29 February 1900 that never was; from serial 61 on the two agree.
  Found in R173's probe.
- **Point mode does not write A1#**: clicking a spilled range while typing a formula inserts
  `A1:A3`, fixed to today's size, where Excel inserts `A1#` (R171 added the reference itself). A
  one-cell array answer counts as not spilling; Excel's handling of `=SEQUENCE(1)` then `A1#` was
  not checked.
- **TREND, GROWTH, XNPV and XIRR over a range with a blank** still count the blank as 0 (R170
  fixed the rest of the formula.js functions). A list with no numbers is an error, not always
  Excel's code: `=GEOMEAN(A2)` over a blank is #VALUE!, Excel's #NUM!.
- **Deleting the last two sheets at once:** `sheetsDeleteTab` counts, then
  deletes, so two concurrent deletes can leave a workbook with none.
- **A connection import was not driven:** the account has no database
  connection, and creating one needs a credential typed into the page.

Closed with formatting: R115 (the keyboard fell to the page after a
context-menu action), R116 (a stray Enter blanked a cell), R117 (every
prompt in the app opened on Cancel). Open from that round:

- ~~Inserted rows and columns take no formats.~~ Closed by R169: rows as the row above, columns
  as the one to the left, Insert cells as its neighbours. No Insert Options button yet.
- **An in-workbook link does not follow a sheet rename** (`#Sheet1!B6` after
  Sheet1 became Summary). Excel does not either, but a formula does; worth a
  look once links are common.
- **Frozen panes** are stored (`frozenRows`/`frozenCols`) but not drawn yet.
- **Text that runs on crosses a right border**: the border is drawn under the
  overflowing text rather than over it.

Closed with Excel files: R118 (a sheet name over Excel's 31 characters left
formulas naming a sheet the file does not have, and two such names made the
download fail). Open from Excel files:

- **A link to another workbook** (`[1]Budget!B2`) keeps its value, but the
  file written back carries no external-link part, so Excel may show `#REF!`
  when it recalculates the download.
- **Default font metrics**: an imported sheet's widths were set for Calibri
  11; the grid draws unstyled cells in the app font, a little wider, so a
  label that fits in Excel can clip here.
- **Defined names** are kept at Excel's value, not computed (no name manager yet).

Closed with rules (conditional formatting, validation, filter): R119 (`-$350.00`
typed stayed text), R120 (a session refresh reloaded the workbook and threw
away the edit not yet saved), R121 (keys typed in a popover over the grid went
to the active cell). Open from that round:

- ~~**The same token-as-dependency reload elsewhere**~~: swept as R125. 21
  places lost work and were fixed; the other 93 hooks keyed on the token
  were read and are ratcheted by `tests/unit/tokenReloadSweep.test.ts`.
  Open from that sweep:
  - **The opposite: a token captured once.** A Python notebook's kernel
    (and a sample notebook's) keeps the session it started with, so after an
    hour its status and stop calls send an expired token and a failed stop is
    swallowed: the kernel container may be left running until the idle
    reaper. The lakehouse's Spark query poll captures the token when the
    query starts, so a query running across a refresh can fail its polls.
  - **Switching workflows drops unsaved edits without asking.** Picking
    another workflow loads it over the open one; there is no "unsaved
    changes" question.
  - **Not driven in the UI** (the fix is the same line, the test pins it):
    changing an outcome source, a warm deployment's idle time and copies, an
    experiment's description, a connection import's table pick, the BI Git
    sync settings, a typed delete confirmation. Each needs data this account
    does not have.
  - **The AI analyst's scenario callback** lists unused dependencies and
    leaves out `catalog`, which it reads: a stale value is possible.
- **A filter's criteria stay in Sheets:** the file gets the AutoFilter range
  and the rows it hides, not each column's criteria (ExcelJS writes no
  `filterColumn`), so Excel shows the buttons without the funnels.
- **Rules count hidden rows:** a top-10 or average rule ranks over the whole
  range, filtered rows included, as Excel's does; worth a note in the docs
  if people expect otherwise.
- **No "Circle invalid data"**, and a pasted value is not checked (Excel does
  not check one either).

Open from charts:

- **A chart plots one block of its own sheet.** Excel lets a series come
  from anywhere (another sheet, non-adjacent columns); here a chart is one
  range, so an Excel chart built that way is left out on import (it says so).
- **Chart styling stays with the defaults**: series colors, fonts, gridlines
  and number formats on the axes are Sheets' own, in the app and in the file.
- **No chart sheets and no stock, 3-D, waterfall or map charts.**

Open from insert/delete cells and version history:

- **Insert cells opens on Shift cells down** whatever the selection; Excel
  picks right for a tall selection and down for a wide one.
- **A version is looked at by opening a copy.** There is no read-only view of
  a version in place, and no comparison of two versions cell by cell.
- **A restore replaces the sheets with new ids.** Anything that remembers a
  sheet by id (a link from outside, a pinned view) would lose it; nothing in
  the app does today.

Closed with the lakehouse guard (tables Sheets holds are changed only from Sheets): R126 (a
`lake.` catalog prefix walked past every schema check), R127 (a sheet's saved settings could
claim anyone's table), R128 (a view refresh, a model build and a batch prediction wrote whatever
held their name). Open from that round:

- **Tables made with Save to lakehouse stay editable.** Such a table is a copy the sheet does not
  read, so the Lakehouse may change it. Whether to lock those too is the user's call.
- **A table sheet's delete dialog says "Its cells go with it".** Only the sheet goes: the table
  stays and, if the sheet held it, becomes editable in the Lakehouse. The dialog should say so.
- **A held table that is also a materialized view still shows Rebuild**, which is now always
  refused. The button could say why before it is pressed.
- **Editing a sheet as a pivot releases what it held.** `sheetsPivot` with a `tab_id` replaces
  that sheet's source and drops its origin, whatever kind the sheet is. The pivot dialog offers
  only pivot sheets, but the server does not check.
- **Layout and partitioning still apply to a held table.** They rewrite its files with the same
  rows. Harmless to the data, but they are changes made outside Sheets.
- **A notebook kernel attached to the catalog is not asked**: the guard is on the server's write
  paths, and a kernel writes to the engine directly.

Closed with sharing (Phase G): R129 (opening a table could say it was an upload), R130 (grid
formulas over tables were wrong on every opening). Open from that round:

- **The recipient's side needs a real second account.** Their Sheets page, "Shared with me", an
  editor's edits and a viewer's session were checked only through "View as" and the tests.
- **A group share's warning is general.** It does not check each member's lakehouse access;
  members without access find out on the sheet.
- **Two people editing one grid sheet** get the existing version conflict ("saved elsewhere").
  There is no live merge.
- **A filtered viewer's grid row numbers show gaps** where rows were left out, as a filtered Excel
  sheet does. They say how many rows are hidden, not what is in them.
- **Downloads by a viewer** carry the restriction on the server but were not driven.

Closed with AI in Sheets (Phase H): R131 (it said it had changed what it had only proposed), R132
(a chart over two blocks failed at Apply), R133 (formulas over a table that could only show
#VALUE!), R134 (the cell's own formula offered as a change), R135 (Fill with AI wrote blanks when
the model left off the brackets), R136 (every internal model call reported no cost), R137 (Fill
with AI skipped the column where answers were started), R138 (the fill wrote something other than
its trial), R139 (View as carried the owner's conversation). Open from that round:

- **The model is not always right.** The model decides, and the page checks only what it can:
  - "Works as expected" was positive on one trial and neutral on the next, at temperature 0.
  - The check catches formulas that fail by themselves, not ones that compute the wrong thing.
- **The proposal check runs a proposed total over a table** so it can see whether it errs. That
  is one lakehouse query per such formula, before anything is applied. Its answer is kept for when
  it is applied.
- **`SHEETS_AI_FILL_MAX_ROWS` is checked by the page, per fill.** The server bounds each call (100
  values) and each person's calls a minute, not a fill's total. A script calling the server
  function directly is bounded only by the rate.
- **A cost under $0.00005 shows as $0.0000.** About thirty places round costs to four decimals,
  including the Lakehouse AI-functions badge and Traces. They could say "under $0.0001" instead.
- **Saving the Developer runtime settings takes about 20 s** when the egress proxy cannot be
  reloaded ("Restarting the proxy returned 500"). The save lands and says so. The wait comes from
  the proxy, not from Sheets.
- **The recipient's side of the assistant** was checked through View as, not a second account.

Closed with the sample workbooks (Phase I): R140 (whole columns were only as long as the data),
R141 (a chart's first column of dates drawn as a series), R142 (a formula whose answer was an empty
cell showed nothing, where Excel shows 0), R143 (the samples hid their own figures under their
charts). Open from that round:

- ~~Arithmetic over a whole column works on the used rows.~~ Closed by R146.
- **Opening a sample twice makes two workbooks with the same name.** The tile could say that one is
  already open.
- **The Project tracker's "late" rows depend on today** (`TODAY()`), so its red rows and late count
  change from day to day. That is intended for a tracker, but a screenshot from one day will not
  match another.

Closed with array formulas: R144 (a function of one value given a range looked at its first
cell), R145 (IF over a range took each branch's first value), R146 (arithmetic over a whole column
left out the blank rows). Open from that round:

- ~~Functions Excel has and Sheets does not.~~ Closed by R147, except two:
  - LAMBDA;
  - AGGREGATE (19 functions, with options to skip errors and hidden rows).

  A file that uses either shows Excel's saved value.
- **A whole column spilled into the grid shows only the used rows.** Excel spills all 1,048,576,
  or `#SPILL!` below row 1. The part shown is the useful part; the difference is on purpose.
- ~~Legacy files' implicit intersection.~~ Closed by R162: a file's plain formula takes Excel
  365's `@`.

Closed with the missing functions: R147 (seven listed long-tail functions never registered; 34
more missing). Open from that round:

- **LAMBDA and AGGREGATE** are not computed. A file that uses them shows Excel's saved value.
- **INDIRECT reads A1-style text only.** `INDIRECT("R2C3",FALSE)` says so, instead of reading it.
- **OFFSET and INDIRECT are not volatile, as they are in Excel.** They recompute when a cell they
  read changes, which covers ordinary use.
- **HYPERLINK shows its text but is not a link to click.** A link set with Ctrl+K is.

Closed with named ranges: R148 (a file's names dropped on import, and the formulas using them
frozen at Excel's values). Open from that round:

- **A name over several areas** (`Data!$B$2,Data!$B$4`) is left out on import, and the import says
  so. A formula over one shows Excel's value.
- **A name scoped to one sheet** comes in for the whole workbook, if no other name has it. A second
  sheet's name of the same name is left out, and the import says so.
- **Names are absolute.** In Excel, a name defined without `$` moves with the cell that uses it.
  Here a name's reference is always where it says.
- **Two editors changing names at once:** the last save wins, because the list is saved whole.
- ~~Rule formulas not rewritten on a sheet rename, a cell shift or an import's rename.~~
  Closed by R149.
- **A rule saved before R149 keeps its stale source.** A list whose sheet was renamed before the
  fix still names the old sheet. Setting the rule again repairs it.

Closed with Find and Replace: R150 (no Find or Replace; a browser's find cannot reach rows the
grid does not draw). Open from that round:

- **Table sheets are not searched by Find.** Their rows live in the lakehouse, and their own
  filters search them.
- **Find looks through every used cell of a sheet on each press.** That is fast at the grid's
  limit (200,000 cells). A far larger sheet would want an index.
- **Excel's Format search** (find cells by their format) and "Search: By Columns" are not there.

Closed with Freeze panes: R151 (frozen panes kept in files and never drawn; no Freeze Panes;
charts over the column headers). Open from that round:

- **Excel's Split** (a scrolling split without freezing) is not there.
- **A frozen part taller than the window** leaves little or nothing to scroll; Excel allows it too,
  and Unfreeze puts it right.
- **The keyboard's hidden text box stays in the body.** An input method's candidate window
  opened on a frozen cell, while scrolled, appears where the cell would be unfrozen.

Closed with Cell notes: R152 (a file with notes could not be imported; notes were dropped
everywhere; a sort dropped Excel's saved values; Clear all left the note). Open from that round:

- **Threaded comments go out as notes.** An Excel 365 conversation comes in as one note, its
  replies after the first. It goes back out as one legacy note, not as a thread.
- **A note has no size, position or formatting.** Excel keeps a note's box size and bold runs;
  here a note is plain text, shown in a card of fixed width.
- **Every downloaded note's author is "Author".** That is the file library's placeholder. The
  real author leads the text instead, so Excel shows who wrote it.
- **The fill handle copies values and formats, not notes or links.** Copy and Paste bring both.
  Whether a fill should carry notes, as Excel's may, is not settled.

Closed with Remove duplicates: R153 (no Remove Duplicates; a ribbon tab kept the keyboard, so
Ctrl+Z after a ribbon tool went nowhere). Open from that round:

- **Excel asks to expand a selection** that stops short of the data beside it; here the selection
  is used as it is.
- **Table sheets have no Remove duplicates.** Their rows live in the lakehouse; a query or the
  table's own filters are the way there.
- ~~Text to Columns~~ Closed by R157. **Flash Fill** (pieces guessed from an example) and Text
  to Columns' **fixed width** are not there.
- ~~Custom Sort~~ Closed by R156 (Data → Sort…), which also found and closed a sort leaving a
  merged cell behind.
- **Sorting by colour or a custom list** (Excel's other Sort options) is not there, nor sorting
  left to right.

Closed with one order for text: R167 (the ribbon's sort ordered numbers in text by value, so
approximate lookups over data it sorted took the wrong rows). Open from that round:

- **Accents and punctuation** sort by character code (É after Z), where Excel's collation puts
  them beside their plain letters.
- **The filter's list of values** still orders numbers in text by value.

Closed with typed times and month-name dates: R166 (they stayed text; a column of times summed to
0). Open from that round:

- ~~A formula does not take the format of the cells it reads.~~ Closed by R168 for `+`, `-`,
  a bare reference and SUM-like functions; `*` and `/` take none on purpose.
- **Month names in other languages** (15-mars-2023) are text.

Closed with the fill handle's series: R165 (dates past a month's end written as text, months and
weekdays repeated, quarters past Q4, dates a month apart repeated; a day past a month's end typed
was read as a date). Open from that round:

- **Filling up or left** is not there: the handle fills down or right.
- **Excel's own lists** (File → Options → Custom Lists) are not there, and nor is Flash Fill.
- **Ordinals** (1st, 2nd) repeat, and a trend over irregular numbers (Excel's Series dialog) is not
  there.
- ~~Dates typed in other forms~~ Closed by R166 for times and month-name dates; dates with slashes
  (3/15/2023) stay text on purpose (see R166).

Closed with a file's text staying text: R164 (£1,234.50, €99, 1e5 came in as numbers; a
leading `'` was lost). Open from that round:

- **A CSV** is read the other way on purpose: its cells have no types, so numbers and dates in it
  are recognised, as Excel does when it opens one.
- **Excel's "number stored as text" warning** (the green corner) is not shown.

Closed with number formats: R163 (durations, currency tags, fractions, conditions, and date codes
in capitals). Open from that round:

- **How Excel signs a number under conditions** is not documented plainly: here a section for
  negatives only (`[<0]`), or one of text alone, writes no minus, and others do.
- **Excel's `*` fill** (`_("$"* #,##0.00_)` puts the $ at the cell's left edge) is left out: the
  $ sits next to the number. `_x` is one space, whatever x's width.
- **Locale tags change nothing but the symbol.** `[$-407]` does not switch month names to German.
- ~~Text of a file that reads as a number or date~~ Closed by R164.

Closed with formulas from older Excel: R162 (such a file's formulas spilled where Excel takes one
value; no `@`). Open from that round:

- **A function that may return a range takes no `@`.** Excel 365 shows `=@INDEX(A:A,0)` or
  `=@OFFSET(A1,0,0,3)` for these in an older file; here they spill.
- **Rules from older files** (conditional formatting, validation) are read the dynamic way.
- **The list of array arguments comes from Excel's documented behaviour,** not from Excel itself:
  there is no Excel on this machine. A function missing from it is read as before R162.
- **A table's `[@col]` inside a grid** is not the same `@`; it is only for table sheets.

Closed with dynamic arrays in downloads: R161 (a formula working over a range went out plain,
so Excel took one value from it; a spill went out as a fixed Ctrl+Shift+Enter block). Open from
that round:

- ~~Reading older files the older way~~ and ~~`@` and `_xlfn.SINGLE`~~: closed by R162.
- **More is marked than Excel would mark.** `=SUMPRODUCT(A1:A3*B1:B3)` works over arrays in every
  Excel, and is marked dynamic here. Excel 365 computes it the same; Excel 2019 shows it in braces.
- **Only a download writes the mark.** Save to lakehouse writes values, so it is not affected.

Closed with Hidden sheets: R160 (a very hidden sheet was dropped on import and its formulas said
`#REF!`; a hidden one came in showing; no Hide, Unhide or Duplicate). Open from that round:

- **A very hidden sheet goes back out merely hidden,** so Excel's Unhide lists it in the
  downloaded file.
- **Table sheets** can be neither hidden nor duplicated.
- **A copy goes at the end of the tabs;** Excel's Move or Copy lets you choose where, and copies
  to another workbook. Tab colours are not there, nor a protected workbook structure (Excel's way
  to stop Unhide).

Closed with Paste special: R159 (no Paste Special; Ctrl+Z went nowhere after its dialog). Open from
that round:

- **Paste Special's other choices:** Validation, Column widths, All except borders, and Paste Link.
- **Pasting text copied from another program** is Paste only; Paste Special needs cells copied in
  the workbook.

Closed with Query sheets: R154 (a sheet could only open a table that already existed; no query
over the lakehouse). Open from that round, the rest of Row Zero's connected tables:

- **No scheduled refresh.** A table imported from a connection refreshes only when its owner
  presses Refresh from source. A query sheet is live, but nothing runs it on a schedule for the
  formulas and charts built on it.
- ~~No query variables.~~ Closed by R155: `{{Name}}` is a workbook name's value.
- **A variable is a workbook name only.** Row Zero also has typed variables with defaults and a
  picker; here the cell a name points at is the picker (a data-validation list makes it a
  dropdown).
- **A connection import stops at `WAREHOUSE_ABS_MAX_ROWS`** (5,000); larger ones are refused
  rather than paged.
- **A connection's query can't be changed** once imported, and a failed import is not audited.
- **SaaS and object-store sources** can't be opened straight into a sheet; they reach the
  lakehouse first (a sync, or a lake mount).

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
  already at the target. SWEPT so far:
  - **R102, DONE.** The "New table → Import dataset" dialog replaced an
    existing table, and wrote past the guard for mounts. The existence
    check is now `lakehouseTableExists` in `core.server`, shared with
    R101.
  - **SQL models, R103, DONE at save** (`sqlModels/run.server.ts`).
    A build runs `DROP <other shape> IF EXISTS <target>` and then `CREATE
    OR REPLACE`. A model with view materialization, named like an existing
    ordinary table in its schema, would DROP that table outright. A
    table-materialized one would replace it. The guard has to be "refuse
    a table this model did not build". A model rebuilding its own target
    is its job. Fixed at SAVE: a new or renamed model must find its name
    free. A table created at a model's target after the save is refused at
    build since R178: each build marks what it made with a comment DuckLake
    keeps, and replaces only its own mark.
  - **ML batch scoring, R104, DONE**: an existing output is allowed only if
    a succeeded prediction of the same user wrote it, and the input is
    never the output. The output-schema gap for Iceberg mounts is DONE in
    R111, which found the same gap in the statement guard itself.
  - **The feature training set, R105, DONE**: an existing output is allowed
    only if an earlier training set of the same user wrote it, and the
    only record of that is the audit trail's `feature_view.training_set`
    event. That record is best-effort, so the rule fails closed. The label
    table and the view's own table are never the output. A dedicated
    record of training-set outputs would be sturdier than the audit trail,
    if the feature is ever given a table of its own.
  - ETL sinks are CLEAR: they replace only in `write_mode: "replace"`,
    which the owner picks by that name.
  - CLEAR (read in R106): a Data Prep flow saved as a dataset, and the CSV
    upload. Both replace a same-named dataset deliberately and
    recoverably, snapshotting the old rows as a version first. The Iceberg
    publish and import are CLEAR too: `create` is a plain CREATE TABLE,
    and replace is chosen by name.
  - **Iceberg's replace, R107, DONE**: it was a DROP and then a CREATE, so
    a create that failed after the drop (an INTERVAL column) left the
    catalog with no table. It now stages the new data under a name made
    for that publish (`<table>__publishing_<8 hex>`) before dropping
    anything. The first fix used a fixed staging name and dropped a
    table the owner had given that name. A drive caught it, so any
    staging, temp or scratch name elsewhere is worth the same look: can a
    user own it? The swap that followed was not atomic: measured in R182
    from the catalog's log, no table for 0.9 s, then an empty one for
    1.7 s. **R182, DONE**: when the old table has the new data's columns,
    a replace is a DELETE and an INSERT in one transaction, which the
    catalog takes as one commit (a delete snapshot and an append, no
    gap). Otherwise the staged table is swapped in by two renames in one
    transaction. The REST catalog applies those one after the other
    (0.4 to 1.5 s apart on the development catalog), so a reader can
    still miss the table for that long, though never find it empty.
    Nothing in the REST spec renames two tables atomically; a schema
    change inside the one commit (the extension's ALTER support) would
    close that case too. Old rows stay in the table's history until the
    catalog expires its snapshots.
  - **Publish itself, R181, DONE**: on an image built 2026-09-30 every
    publish failed, `Failed to create directory "data": Permission
    denied`. The iceberg extension build baked into a fresh image writes a
    `CREATE TABLE AS`'s files to a relative `data/` whenever the ducklake
    extension is loaded, and this engine always loads it. DuckDB and
    node-api had not moved since July: `INSTALL` fetches the extension
    build that is current when the image is built, so an extension can
    change under a pinned DuckDB. Publish is now a `CREATE TABLE` with the
    source's columns and an `INSERT`. Every other engine feature that
    depends on extension behaviour is exposed the same way; a smoke drive
    of each after an image rebuild is what catches it.
  - The development Iceberg catalog (`aswarm-iceberg-rest`,
    `tabulario/iceberg-rest` on SQLite) can hold its store locked between
    requests, answering every DELETE with `[SQLITE_BUSY] The database file
    is locked` until it is restarted. That is the fixture, not this app,
    but an Iceberg round that sees HTTP 500 on a drop should check the
    catalog's log before blaming the code. A steady reader of a table (a
    loop loading it 4 to 30 times a second) is enough to starve its
    writer: in R181 every commit into a replace's staging table was
    refused this way while a poller ran, and none once it stopped. Time a
    catalog-side window from the catalog's own log ("Dropped table",
    "Successfully committed"), not from a poller.
  - Reading them found R106: the BROWSER's copies of the dataset delete and
    replace (`lib/sqlEngine.ts`) never read the database's answer. R87 had
    fixed only the server's. Sweep: every direct `supabase.from(…).delete()`
    or `.update()` in `src/lib` and `src/components` that is awaited
    without its `error`, especially where a success toast follows.
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
- A rule kept in N places is right in N-1 of them (R111): "a mount is
  read-only" was written out as `lake_source_id || iceberg_catalog_id` in
  eleven writers, and as `lake_source_id` alone in two: the statement
  guard and ML batch scoring. The Iceberg column (migration 20260867)
  came after the lake-mount one (20260842), and the change that added it
  to the other checks missed these two. When a column widens a rule, grep
  for the OLD column alone.
  Behind it, a CASCADE drop of a schema the product calls disposable took
  a table nobody listed. Any `DROP … CASCADE` of something described as
  "only views" or "only a mount" should look for the things it would take
  that are not that.
- A failed read that becomes an empty ACCOUNT becomes a write (R110): the
  swarm canvas read `rows = []` and created "My First Swarm" in place of
  the swarm asked for. Any "first run" branch (`if (rows.length === 0)
  create…`) must be fed from a read whose error was kept. The R109 sweep
  continues from here. In `swarms.tsx`, the switch only ever switched on
  data, and now says why it did not. `refreshPublished` still drops its
  error and sets the snapshot to null, which HIDES the "draft ahead of
  what is live" badge: no write, but a warning silenced by a failed read.
  `playground.tsx:2509` (an execution trace) and `mcpApps.functions.ts:69`
  are not yet read. The Recent runs "No runs yet" (R108's note), the
  same shape without the write, was closed in R179.
- A failed read that becomes an empty document becomes a data loss at the
  next save (R109): the swarm chat opened a conversation over
  `data?.messages ?? []`, kept its id, and saved the next turn over the
  stored transcript. R72 had left this dialog's writes as harmless
  because they reload the list; the list was all they reloaded. Look for
  a read of a whole document (`maybeSingle()`, `single()`) whose error is
  dropped AND whose id survives into a later update: the save that
  follows writes a blank over the original. R180 bound the aborted turn's
  save to the conversation it was sent in: it had followed the selection,
  inserting a copy of the conversation after New chat or a reopen, and
  writing one conversation over another after a switch. The general
  shape: work that outlives its screen must carry the ids it started
  with, and must not write the screen's state when it lands. Look for
  an async handler that reads a ref (`someRef.current`) after an
  `await`, where the ref can change while it waits.
- A reader's fallback is a status word too (R108): Recent runs showed any
  status it did not know as "Running", and `suspended`, written since the
  checkpoint work, was one. A parked run read Running for nineteen hours,
  with no action that could end it. And `suspended` alone did not say
  whether anyone was still being asked: R92's four leftovers are parked
  with their approvals long decided. The approval row says, so it
  decides. Look for `map[status] ?? map.<something>` and `default:`
  branches in any status display; an unknown word should read as itself.
  Swept for that shape: `workflows.tsx`'s `STATE_STYLE … ?? pending` is
  CLEAR, because node rows only ever take the five `NODE_STATES`, and
  "cancelled" belongs to the run, which has its own map. R179 closed the
  rest: Recent runs cancels a parked run on the server, removing its
  checkpoint and closing its pending approval; resume refuses
  `cancelled`; and a failed load of `swarm_runs` reads as one. Still
  open: a run cancelled after twelve hours parked shows `12h 19m` as its
  duration on Recent runs, while Observability shows `0ms`.
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
  write survey's remaining files: Agent Chat's conversation and message
  deletes and updates. The add-source dialog is R192: a two-write step
  (source, then document) whose second write failed left the first one
  standing as "ok · 0 docs", and the toast counted files dropped in rather
  than files that landed. A step of several writes owes the first ones back
  when a later one fails, or at least a mark on them. Open from R192: an
  uploaded .txt is recorded as kind `manual` and listed as "Manual paste";
  and the dialog does not look at the embed step's result, so a document
  added while embeddings are unavailable is announced like any other (the
  Documents list does show its index state).
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
  in 25 files) is done for reads. The playground's two with teeth are
  R191: the inspector's Trace tab said "Trace not recorded · The request may
  have failed before the trace row was written." for a trace the Traces
  page listed (a claim about the server, made from a failed read in the
  browser), and a failed agent read pointed a pulsing "Pick an agent to
  begin" at an empty selector. Left there: the tour's approvals poll (a
  failed read only delays a checkpoint), three title updates (a failed one
  leaves "New Chat"), and the first conversation's auto-insert, whose
  error is dropped (worth a round: does the page stay usable?). The last of swarms are
  R189: the canvas's published-snapshot re-read switched "Draft ahead" off
  after a Publish while the canvas went on changing (now "Live not
  checked"), and the components (palette and library) and the version
  history read as empty. R190 took the versions dialog's writes:
  *Save version* toasted "Version saved" whether or not the insert landed,
  and *Restore*, promised as undoable by its own confirm, replaced the
  canvas when its safety snapshot had failed. A helper that swallows an
  error "because it is best-effort" is best-effort only for the caller
  that said so. Still open in that dialog, both small: the trash icon
  deletes a version at once, with no confirm (the component library asks
  first), and Enter in the name field calls *Save version* past the
  button's `disabled={saving}`, so two quick Enters can capture it twice
  (read in the source, not yet driven). The
  deploy dialog's three are R188: a
  failed schedules read said "No schedules yet." with Add on, the one
  invitation in this survey that turns into a duplicate write (the swarm
  run twice per tick), and a live swarm read "Not deployed". The node
  inspector's are R187 (six reads in one effect, the survey counted four):
  the worst was not the invitation to upload a first CSV but the node's
  own restriction vanishing with the list, so a picker that cannot read
  its choices must still show what is chosen. Evaluations' five are R186, with its two deletes
  from the write survey: the driver's own read is the one with teeth, a
  run left "running · Executing cases…" with nothing executing, and the
  baseline read drew a comparison against nothing. The page had already
  guarded the comparable-runs list (module 28) and missed the rows of the
  run it compared with: a guard on a list does not cover the reads that
  hang off one of its items.
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
