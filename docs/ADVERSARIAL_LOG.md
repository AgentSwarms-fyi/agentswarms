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

### Mutation testing needs a green baseline

A mutation run reports a mutant as "caught" when the suite fails with it
applied. If the suite was ALREADY failing, every mutant is reported caught and
the whole run means nothing — it measures the standing failure, not the test.

This is not hypothetical: a run of fourteen mutants over the claim verifier
came back thirteen-for-thirteen with the control also caught, which is the only
visible symptom. The cause was a stale source assertion left red by a rename
two steps earlier. **The control failing is the tell** — a control that gets
caught means the baseline is red or the tests are anchored on a comment, and
either way the run is void.

Assert the baseline is green before mutating, and keep a control in every run.

### Source-anchored tests must pin the USE, not the definition

Three separate mutants have now survived a green suite by leaving a definition
in place and severing its use: an ontology token budget nothing sent, a schema
fetch an `if (false)` could disable, and a claim check whose result was
replaced with an empty list. A `toContain("someHelper(...)")` assertion passes
in all three cases. Assert the call site and the branch it feeds.

### Failing one read on purpose

Several findings depend on making exactly one read fail in the live page. The
recipe, after module 16 spent a whole pass on getting this wrong:

- Patch `window.fetch` with a wrapper that **records every URL it sees and
  every URL it failed**. The record is the evidence.
- Re-trigger the read with a **client-side remount** —
  `__TSR_ROUTER__.navigate` away and back — which re-runs mount effects while
  leaving `window` intact. **Never reload the page: a reload destroys the
  patch**, the read then succeeds, and the screen tells you nothing.
- Report every probe beside the same measurement with the injection disarmed,
  down the identical path. A probe whose control also fails has measured
  nothing.

**A failed-read finding requires positive proof the injection took effect** —
the wrapper naming the request it failed, or a probe of what the read returned.
Never infer it from what rendered.

## Severity

- **S1** — states something false, or lets a wrong number reach a decision.
- **S2** — hides something true (silent failure, swallowed error, misleading empty).
- **S3** — correct but confusing, or a control that does nothing.
- **S4** — cosmetic.

## Coverage map

| #   | Module              | Route                      | Pass | Date       | Findings                                                                          |
| --- | ------------------- | -------------------------- | ---- | ---------- | --------------------------------------------------------------------------------- |
| 1   | Dashboard           | `/dashboard`               | ✅ 1 | 2026-08-16 | 5 (2×S1, 1×S2, 2×S3)                                                              |
| 2   | Documentation       | `/docs`                    | ✅ 1 | 2026-08-16 | 4 (2×S1, 1×S2, 1×S1 self-inflicted)                                               |
| 3   | Agent Builder       | `/agents`                  | ✅ 1 | 2026-08-16 | 3 (2×S1, 1×S2)                                                                    |
| 4   | Knowledge Base      | `/knowledge`               | ✅ 1 | 2026-08-16 | 1 (1×S1)                                                                          |
| 5   | Agent Chat          | `/playground`              | ✅ 1 | 2026-08-16 | 2 (1×S1 self-inflicted, 1×S2); guardrails verified live                           |
| 6   | Agent Swarms        | `/swarms`                  | ✅ 1 | 2026-08-16 | 1 (1×S2)                                                                          |
| 7   | MCP Builder         | `/mcp-builder`             | ✅ 1 | 2026-08-16 | 1 (1×S2)                                                                          |
| 8   | AI Analyst          | `/ai-analyst`              | ✅ 1 | 2026-08-16 | 0 — held; no live turn (over budget cap)                                          |
| 9   | Data Catalog        | `/data-sql`                | ✅ 1 | 2026-08-16 | 2 (1×S1, 1×S3)                                                                    |
| 10  | Semantic Layer      | `/semantics`               | ✅ 1 | 2026-08-16 | 1 (1×S1) + one wrong hypothesis, recorded                                         |
| 11  | Metrics             | `/metrics`                 | ✅ 1 | 2026-08-16 | 2 (2×S2) + one hypothesis dropped                                                 |
| 12  | BI Workspace        | `/bi`                      | ✅ 1 | 2026-08-16 | 1 (1×S1) — widget count read the page-1 mirror                                    |
| 13  | Developer workspace | `/notebooks`               | ✅ 1 | 2026-08-17 | 4 (1×S1, 2×S2, 1×S3) — failed reads rendered as absence                           |
| 14  | Prompt Library      | `/prompts`                 | ✅ 1 | 2026-08-17 | 2 (1×S1, 1×S3) — empty claim on a failed read; `#tag`                             |
| 15  | Skill Library       | `/skills`                  | ✅ 1 | 2026-08-17 | 1 (1×S1) — same failed-read claim; guard added                                    |
| 16  | Integrations        | `/integrations`            | ✅ 2 | 2026-08-17 | 1 (1×S2) — re-audited with proof; the retracted S1 was real, at S2                |
| 17  | Web Embedding       | `/embeds`                  | ✅ 1 | 2026-08-17 | 0 — counts exact; disable, expiry and allow-list proven                           |
| 18  | Secrets             | `/secrets`                 | ✅ 1 | 2026-08-17 | 2 (1×S1, 1×S2) — empty claim on a failed read; skeleton for ever                  |
| 19  | MCP Servers         | `/mcp`                     | ✅ 1 | 2026-08-17 | 1 (1×S1) — derived counts read 0 on a failed read; pin was decorative             |
| 20  | Model Registry      | `/model-registry`          | ✅ 1 | 2026-08-18 | 1 (1×S1) — four false claims, and a sync button that acts on them                 |
| 21  | Analytics           | `/analytics`               | ✅ 1 | 2026-08-18 | 3 (1×S1, 2×S2) — a silent row cap made every KPI wrong                            |
| 22  | Swarm Traces        | `/analytics/observability` | ✅ 1 | 2026-08-18 | 2 (1×S1, 1×S2) — empty claim, and onboarding shown to an onboarded account        |
| 23  | Traces & Logs       | `/traces`                  | ✅ 1 | 2026-08-18 | 1 (1×S1) — the capped page presented as the population; error paths already sound |
| 24  | Audit Log           | `/audit`                   | ✅ 1 | 2026-08-18 | 2 (2×S1) — exculpatory empty claim; non-uniform silent truncation                 |
| 25  | Budgets             | `/budgets`                 | ✅ 1 | 2026-08-18 | 3 (1×S2, 2×S1) — skeleton-forever, false empty, caps shown unset                  |
| 26  | Monitoring          | `/monitoring`              | ✅ 1 | 2026-08-18 | 2 (1×S3, +R36) — health claimed over an empty probe set; then over a STALE one    |
| 27  | Prompt Compare      | `/prompt-compare`          | ✅ 1 | 2026-08-18 | 1 (1×S1) — the model that failed fastest was crowned fastest                      |
| 28  | Evaluations         | `/evaluations`             | ✅ 1 | 2026-08-18 | 2 (2×S1) — "0% pass" on an unscored run; false empty on a failed read             |
| 29  | Image Playground    | `/image-playground`        | ✅ 1 | 2026-08-18 | 1 (1×S1) — false "none connected", memoised for the whole session                 |
| 30  | IAM                 | `/admin/iam`               | ✅ 1 | 2026-08-18 | 1 (1×S3) — unrecoverable failed load; every read already checked                  |
| 31  | Developer runtime   | `/admin/runtime`           | ✅ 1 | 2026-08-18 | 1 (1×S2) — toast-only error, then a permanently blank page                        |

## Findings

<!-- newest first -->

### 2026-09-25 — Found testing Sheets rules: an hourly reload that ate edits, keys that went to the wrong place, and a dollar amount that stayed text

#### R124 · S2 · In the dark theme, a filled cell's text could not be read

A cell with a fill and no text color of its own took the theme's text
color. In the dark theme that is near white, on fills that are almost always
light: the pink of a "greater than" rule, a pale header from an Excel file.
The values were there and could not be read. Excel's automatic text color
is black, which is why these fills are chosen light.

**Driven, before**: "Sheets E2E Cells & Versions (Phase F)" in the dark
theme → C2 and D2 (20, 30, pink from a rule) showed near-white text on pink;
the gallery's thumbnails did the same. **After** (hot-deployed): C2 reads
`rgb(31, 31, 31)` on `rgb(255, 199, 206)`. A cell filled with no text color
of its own now takes dark text on a light fill and white on a dark one
(where black and white contrast equally, by WCAG luminance), in the grid and
in the thumbnails. Tests: `tests/unit/sheetsInk.test.ts`.

#### R123 · S3 · Ctrl+B in Sheets made the cells bold and opened the app's sidebar too

The app's sidebar toggles on Ctrl+B (and `Ctrl+\`) through a listener on the
window. The grid handles Ctrl+B as bold, as Excel does, and marks the key as
handled, but the sidebar's listener ignored that and toggled anyway. Every
Ctrl+B in a workbook opened or closed the sidebar, and the grid reflowed
under the pointer. Anyone formatting a sheet presses it constantly.

**Driven, before** (hot-deployed gallery build): a new workbook → A1:B1 →
Ctrl+B → the headers bold and the sidebar expanded; Ctrl+B again → bold off,
the sidebar collapsed. **After**: A1:B1 → Ctrl+B three times → bold on, off,
on, the sidebar collapsed throughout; in a cell being edited (F2), Ctrl+B
leaves the sidebar alone; with the page focused rather than the grid,
Ctrl+B still opens and closes the sidebar. The sidebar now leaves alone a
key that what has focus already handled. Tests:
`tests/unit/sidebarShortcut.test.ts` (mutants removing the check, or
restoring the old test in the listener, are caught).

#### R122 · S1 · The Sheets page said "edited 4h ago" of a workbook edited a minute earlier

A workbook's "edited" time on the Sheets page, and the order the page lists
workbooks in (most recently edited first), came from the workbook row's
`updated_at`. That moved only when the workbook row itself changed (a
rename, a restore). Every cell edit, sheet added or rule changed writes the
sheet row (`sheet_tabs`) and left the workbook row alone. So a workbook
worked on all afternoon said "edited 4h ago" and stayed below ones nobody
had touched. The claim was a true sentence about the wrong row. It was in
the page since Sheets first shipped; asking for a better gallery is what
led to reading where "edited" came from.

**Driven, before** (the image built for Phase E, with Phase F hot-deployed):
"Sheets E2E Rules (Phase D)" → K6 → 7, 7, Enter → "All changes saved" → ←
Sheets. The card still read "edited 4h ago", fourth in the list. The rows:
the sheet "Orders Q3" updated at 19:12:13, the workbook at 15:36:59.
**After** (rebuilt image, migration applied): Phase D → K6 → Delete → ← Sheets: the card read
"2s ago" and led the list; a thumbnail written a second after an edit left
the workbook's time on the edit (20:18:11.2 edited, 20:18:12.0 thumbnail),
and deleting a workbook through its card menu ran the new trigger under a
cascade without error. The migration's own clock was held off: Phase D read
19:12:13 (its last sheet change) after it ran, not the migration's time.

A change to a sheet (its cells, table definition, name, kind or place, a
sheet added or deleted) now touches its workbook through a trigger on
`sheet_tabs`. A migration moved every existing workbook's time forward to
its last sheet change, holding off the workbook's own `now()` trigger for
that one statement. The gallery's thumbnails are kept in a table of their
own, so drawing one is not counted as an edit.

#### R121 · S2 · Typing in a filter's search box typed into the active cell instead

A popover drawn over the grid (a filter column's menu, a validation list, a
link's buttons) is rendered in a portal elsewhere in the page, but React
bubbles its events up the component tree, not the DOM, so every key pressed
in it reached the grid's key handler. A letter typed in the filter's Search
box started editing the active cell, the menu closed, and the search box
stayed empty; the value box of a filter condition did the same; Enter on a
choice in a validation list moved the selection instead of picking it. The
first round missed it because the test tool inserted text without keydown
events; pressing real keys showed it.

**Driven, before** (the image built for Phase D): Orders Q3 → Region's
filter button → click Search → press N, o → the menu closed, cell H8 was
open for editing holding "No", the search box never had it. Alt+Down on H5
→ Down, Down → "Paid" focused → Enter → the list stayed open, H5 unchanged.
**After** (rebuilt image): the same keys → the search box reads "No" and
the menu lists only North; Down, Enter in the list picks Shipped and closes
it; a filter condition's box takes 4000 as typed. The grid's handler now ignores a key whose
target is not inside the grid's own DOM. Test:
`tests/unit/sheetsGridKeys.test.ts` (a mutation removing the check is caught).

#### R120 · S1 · A session refresh reloaded the workbook and threw away the edit not yet saved

The workbook page loaded the workbook in a callback that listed the session's
access token among its dependencies. The token changes every time the
session refreshes (about hourly, and when a tab regains focus near expiry),
so every refresh loaded the workbook again and rebuilt the editor from the
saved copy. An edit made in the second before its save (a conditional
format, a typed value) vanished; the selection jumped to A1; the badge said
"All changes saved"; and the save already queued wrote the older state back
over the change. This was in the page since Sheets first shipped.

**Driven, before** ("Sheets E2E Rules (Phase D)", Orders Q3): selected
I2:I21 → Conditional → Data bars → Blue → the bars drew and the toast said
"Rule added to I2:I21"; moments later the view was back at A1 with no bars,
the badge read "All changes saved", and the network showed a workbook load
(sheetsGet) returning the sheet's grid with `cells` only, then a save. The
stored session had been issued 105 s earlier, which matches the refresh.
Adding the same rule again, with no refresh in between, kept it.

**After** (the fixed build): the page loads the workbook once per workbook
and reads the token through a ref when it calls the server. Forced a refresh
(the stored session's expiry moved to 15 s ahead, then a visibility change):
the token changed after 5 s; no workbook load followed, the selection stayed
on J7, and every rule and value stayed. Test:
`tests/unit/sheetsReloadOnToken.test.ts`. The same `[token]` pattern is in 19
other files; which of them hold unsaved edits is a separate task (queue).

#### R119 · S3 · A negative dollar amount typed as -$350.00 stayed text

Typing `-$350.00` (or `$-350`) left a text cell, left-aligned, that SUM
skips; Excel reads it as the number -350 in a dollar format. The number
parser stripped a currency sign only at the very start, before a minus.

**Driven, before:** Long sheet names (R118), Sheet2!B1 typed `-$350.00` →
left-aligned text; its CSV wrote `'-$350.00` (defused as formula-looking
text). **After:** Orders Q3!K2 typed `-$350.00` → right-aligned `-$350.00`,
`=K2*2` → -700; Download this sheet as CSV → `-350` and `-700`. The parser
takes a sign on either side of the currency sign, and `-$350.00`, `$-350.00`
and `($350.00)` all pick up the dollar format. Test: `tests/unit/sheetsOps.test.ts`.

### 2026-09-25 — Found building Excel downloads: sheet names Excel cannot hold

#### R118 · S2 · A sheet name over 31 characters broke the downloaded workbook

Sheets allows a sheet name of up to 100 characters; Excel allows 31. ExcelJS
cut a longer name when writing the file without telling anyone, so every
formula on another sheet that named it still used the full name, which the
file does not have: in Excel those formulas point at a sheet that is not
there. Two long names that start with the same 31 characters were worse:
the second collided with the first once cut, and the download failed.

**Driven, before** (workbook "Long sheet names (R118)"): Sheet1 renamed to
"Quarterly revenue by region and product line" (44 characters), A1 = 5;
Sheet2!A1 = `='Quarterly revenue by region and product line'!A1*2` (shows 10).
File → Download as Excel → the file's sheets were
`Quarterly revenue by region and` and `Sheet2`, and Sheet2's formula was
still `'Quarterly revenue by region and product line'!A1*2`. A third sheet
named "Quarterly revenue by region and product line, prior year" →
Download → toast "Could not download: Worksheet name already exists:
Quarterly revenue by region and"; no file.

**After:** the same workbook on the rebuilt image → File → Download as Excel →
"Downloaded the workbook"; openpyxl reads the sheets `Quarterly revenue by region and`,
`Sheet2` and `Quarterly revenue by region (2)` (31, 6 and 31 characters), and Sheet2!A1 is
`='Quarterly revenue by region and'!A1*2`, whose saved value is 10.

The writer now names each sheet for the file (`excelSheetNames`: the
characters Excel refuses become spaces, the name is cut to 31, and a
collision gets " (2)" within the 31), and rewrites every formula that names
a shortened sheet (`renameSheetInFormula`) before writing it. Tests:
`tests/unit/sheetsXlsx.test.ts` ("cuts a sheet name to Excel's 31
characters, and the formulas that use it"); two mutants in the Excel/CSV
mutation run.

### 2026-09-25 — Found building Sheets formatting: where the keyboard goes after a menu or a dialog

#### R117 · S2 · Every text prompt in the app opened on its Cancel button

`promptAsk` (the shared replacement for `window.prompt`) renders a Radix
AlertDialog with an `autoFocus` text box. An AlertDialog focuses its Cancel
button when it opens, after React has run `autoFocus`, so the box never had
the keyboard: typing went nowhere and Enter pressed Cancel. Every prompt was
affected: Rename sheet, Row height, Custom number format, and the other
callers across the app. A mouse user who clicked into the box never noticed.

**Driven, before:** Sheets, ribbon → Number format → Custom… →
`document.activeElement` was the Cancel button; typing a format code then
Enter closed the dialog with nothing applied. **After:** the same path → the
text box has focus with its text selected; typing
`"$"#,##0.00;[Red]-"$"#,##0.00` and Enter applied it (B3 red). Rename sheet
from the tab menu → the box focused with "Sheet1" selected; typing "Summary",
Enter → the tab reads Summary.

The dialog's `onOpenAutoFocus` now puts focus in the text box when it asks
for text; a yes/no confirmation keeps Radix's Cancel default. Test:
`tests/unit/confirmDialogFocus.test.ts`.

#### R116 · S2 · A stray Enter blanked a cell

The grid keeps a hidden textarea on the active cell so that text arriving
without a keydown (an IME, dictation) starts an edit. When a dialog's button
was pressed with Enter, the button closed the dialog on keydown and focus
came back to the grid before the key's input landed, so the textarea
received a line break, an edit started holding only a line break, and the
next click committed it: B2's 1200 became an empty cell with Wrap on and the
total dropped to $2,130.00.

**Driven, before:** the Custom format prompt (on its Cancel button, R117),
Enter → the cell editor was open on B2 with value `"\n"`; clicking another
cell committed it. **After:** a bare line break reaching the textarea no
longer starts an edit (`startsEdit` in `src/lib/sheets/selection.ts`); the
same sequence leaves B2 as it was. Test: `tests/unit/sheetsFormatting.test.ts`.

#### R115 · S3 · After a context-menu action the keyboard fell to the page

Choosing any item in the grid's right-click menu unmounted the button that
held focus, so focus went to `<body>`: Ctrl+Z, arrows and typing did nothing
until the grid was clicked again.

**Driven, before** (the committed image): right-click B3 → Insert 1 row
above → Ctrl+Z → nothing; `document.activeElement` was BODY. **After:** the
menu hands the keyboard back to the grid before running the action (a
dialog the action opens takes it and returns it). The same steps → Ctrl+Z
restored the row. Ribbon menus and the color palettes do the same through
`onCloseAutoFocus`, unless the item opened a dialog.

### 2026-09-25 — Found building Sheets: a semicolon in a string, a cached clock, and escapes shown as text

#### R112 · S2 · A ";" inside a string literal was refused as a second statement

`classifyStatement` refused any statement whose text contained ";", after
stripping comments but not string literals. `SELECT 'north; south' AS
regions` was refused in the Query editor with "One statement per request —
split multi-statement SQL", and so was every other place a user's text
reaches a lakehouse statement as a literal: a Sheets calculated column
`TEXTJOIN("; ", …)`, a filter on a value with a semicolon in it.

**Driven, before:** Query editor, `SELECT 'north; south' AS regions` → the
refusal above. **After** (host build on the running app, then the image):
`SELECT 'north; south' AS regions, concat_ws('; ', 'a', 'b') AS joined` →
`1 row(s)`: `north; south · a; b`.

The check now reads `blankLiterals(sql)` (new in `sqlRefs.ts`): comments
blanked by the existing literal-aware scanner, then the insides of single-
and double-quoted literals and `$$…$$` blanked, indices kept. A real second
statement (`SELECT 'x'; DROP TABLE a.t`, `SELECT 'a'''; DROP …`) is still
refused. Tests: `tests/unit/lakehouseSqlShape.test.ts`.

#### R113 · S2 · `SELECT now()` answered with the first run's time for ten minutes

The lakehouse result cache keys on the user, the statement and the current
snapshot. None of those changes when the clock does, so a statement calling
`now()`, `current_date`, `random()` or `gen_random_uuid()` was served its
first answer until the entry expired (ten minutes) or a write moved the
snapshot. Nothing on the page said the answer was cached.

**Driven, before:** Query editor, `SELECT strftime(now(), '%H:%M:%S.%f') AS t`
run six times over fifteen seconds → `08:01:18.491288` all six times.
**After:** six runs → `08:28:01.29`, `08:28:03.80`, `08:28:06.80`,
`08:28:09.73`, `08:28:12.71`, `08:28:15.74`.

`callsVolatileFunction(sql)` (the same literal-blanked text, so
`SELECT 'now()'` still caches) now keeps such a statement out of the cache
lookup, which is also the only place a result is stored. Sheets pass
`useCache: false` for a table whose calculated columns call TODAY() or
NOW(). Tests: `tests/unit/lakehouseSqlShape.test.ts`, including a pin that
the guard sits in the block that sets the cache slot.

#### R114 · S3 · The catalog showed `\u2014` where it meant a dash

Three places in `CatalogView.tsx` wrote the escape in JSX text, where it is
not an escape: the asset panel's status select read "Certified \u2014
trusted for analysis" and "Deprecated \u2014 avoid using", the empty column
panel "No column metadata \u2014", and the profile's range "min\u2013max".
Seen on the asset `analytics.sheets_revenue_by_region_v2` registered from
Sheets. A scan of every `.tsx` for a `\u` escape outside a string found
these four and no others.

### 2026-09-25 — Read-only, until it was written to, and gone when the catalog was

#### R111 · S1 · An Iceberg mount took writes the dialog calls impossible, and removing its catalog dropped them unannounced

Queued in R104, where ML batch scoring's output check was found to refuse a
data-lake mount but not an Iceberg one. The question behind it was wider:
which writers know that an Iceberg mount is read-only? The mount dialog
promises "mount one of its namespaces as a read-only schema", and most of
the lakehouse's writers check `lake_source_id || iceberg_catalog_id`. The
one that matters most did not. The statement guard in
`runLakehouseStatement` is what every SQL write goes through: the Query
editor, feature training sets, agents' SQL, notebooks. It refused writes
through a data-lake mount only. So a "read-only" Iceberg mount took
`CREATE TABLE`.

That table then sat in a schema the product treats as disposable.
Removing an Iceberg catalog drops each of its mounts with `DROP SCHEMA …
CASCADE`, under a confirm that says only "Its N mounted schema(s) go with
it. Tables in the catalog itself are untouched." A lakehouse table
written into a mount went with the views, and nothing said it would.

ML batch scoring had its own copy of the rule, with the same gap. Its
"Output schema (yours)" picker listed every schema that had a table, so
it offered all eight `ice_*` mounts on this account. "Save as view" had
a picker that filtered only data-lake mounts. The server refused there,
but only after the owner picked the schema.

**Driven, before the fix** (image `abd4e27a1a31`). To keep `local_rest`
and its mounts out of it, a second catalog was registered for the round
on the same endpoint:

- Iceberg → Add catalog `r111_rest` (`http://192.168.1.85:8181`, `s3://iceberg/`,
  no authentication) → "Registered r111_rest: 2 namespaces". Mount `r107`
  as `ice_r111` → "Mounted 2 tables".
- Query: `CREATE TABLE ice_r111.r111_written AS SELECT 1 AS id, 'written
  into a read-only mount' AS note` succeeded. `SELECT id, note FROM
  ice_r111.r111_written` read back `1 · written into a read-only mount`.
- Remove `r111_rest` → the confirm "Remove "r111_rest"? Its 1 mounted
  schema(s) go with it. Tables in the catalog itself are untouched." →
  Remove. The same SELECT then answered "No access to schema "ice_r111"".
  The DuckLake catalog shows `r111_written` created at snapshot 559
  (04:50:21 UTC) and ended at snapshot 560 (04:51:07 UTC), the snapshot
  that also ended the schema `ice_r111`.
- ML Models → "revenue_facts plan classifier" → Predictions → Batch
  prediction. "Output schema (yours)" offered `analytics`,
  `ice_r107_after`, `ice_r107_final`, `ice_r107_fixed`, `ice_r107_four`,
  `ice_r107_regress`, `ice_r107_three`, `ice_r107_two` and `ice_sales`.

**Staged for the after-drive, on the old image.** Once fixed, the guard
would refuse to put a table into a mount, but a table written before the
fix still has to be protected. So a second throwaway catalog was set up
first: `r111b_rest`, mounting `r107` as `ice_r111b`, into which
`r111b_kept` was written (`1 · kept in a mount before the fix`).

**Driven, after the fix.** The guard and the pickers were driven on image
`5c76a79c3e5c`; the removal was driven on `321d1a9f4ad9`, which rewords its
refusal:

- Query: `CREATE TABLE ice_r111b.r111_after …` and `INSERT INTO
  ice_r111b.r111b_kept …` each answered "Schema "ice_r111b" is a
  read-only Iceberg mount — query it, or write to a regular schema.
  Publish to Iceberg puts a table into the catalog." Reading the mount
  still worked.
- Batch prediction on "revenue_facts plan classifier": "Output schema
  (yours)" offered `analytics` alone. The input picker still lists the
  mounts' tables, which are fine to read. "Save as view" offered
  `analytics` alone.
- Remove `r111b_rest` → the same confirm → Remove → "Not removed:
  ice_r111b.r111b_kept is a table of your own inside a mounted schema,
  and would be dropped with it. Copy it to a regular schema first (CREATE
  TABLE analytics.… AS SELECT * FROM ice_r111b.r111b_kept), then drop the
  mounted schema in the explorer, which says every table in it goes." The
  catalog stayed, and the table still read its row.
- That way out was followed. `CREATE TABLE analytics.r111b_kept_copy AS
  SELECT * FROM ice_r111b.r111b_kept` read back the row. The explorer
  listed `ice_r111b (3)` with `r111b_kept · 817 B` beside the two views.
  "Drop schema "ice_r111b"? Every table in it is dropped too." → "Dropped
  ice_r111b".
- A mount of views only does not block a removal. `r107` was mounted
  again as `ice_r111c`, then Remove `r111b_rest` → "Removed r111b_rest".

The changes:

- **The statement guard.** It refuses a write through an Iceberg mount as
  it does through a data-lake mount: "Schema "…" is a read-only Iceberg
  mount — query it, or write to a regular schema. Publish to Iceberg puts
  a table into the catalog."
- **ML batch scoring.** Its output check refuses Iceberg mounts too.
- **The pickers.** The ML sources call returns the schemas that can take a
  table (owned, and not a mount of either kind). The batch and schedule
  dialogs offer only those. "Save as view" drops Iceberg mounts from its
  picker.
- **Removing a catalog.** It now looks for real tables inside each mount
  first, since a mount holds only views. It refuses while there is one,
  naming it: "Not removed: … is a table of your own inside a mounted
  schema, and would be dropped with it." It also refuses when it cannot
  check, or cannot list the mounts. That protects tables written before
  this fix.

**Tests:** 10.

Behavioural, against the real guard with a mocked schema list:

- `CREATE TABLE`, `INSERT` and `DROP VIEW` in an Iceberg mount are
  refused.
- The refusal names Publish to Iceberg.
- A data-lake mount is still refused as before.

Anchored in the source:

- ML scoring refuses an Iceberg mount as output.
- The ML pickers take the writable list.
- "Save as view" filters Iceberg mounts.
- A catalog removal checks for tables before it drops anything, and
  refuses when it cannot check.

10 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-25 — My First Swarm, again

#### R110 · S2 · A failed read of the swarm list made a new swarm and opened it in place of the one asked for

Found by the sweep R109 queued: a read of a whole document whose error is
dropped. The swarm canvas starts by reading the owner's swarms, their
knowledge bases and their agents, in parallel, and it kept none of the
three errors. A refused list read came back as `rows = []`. For an owner
with no swarms, the canvas creates one, so it inserted "My First Swarm"
and opened it. That happened whatever swarm the URL asked for, and it
said nothing. The owner saw an empty canvas where their swarm should be,
under a name they never chose, and the gallery kept the new row. It never
overwrites the swarm that was asked for, because a Save goes to the new
row, but it looks exactly like the swarm has been lost.

Two smaller paths sat beside it:

- Switching swarms from the canvas dropped its read's error and simply
  did not switch.
- A URL naming a swarm that is not in the list opened the first swarm
  in the list, without a word.

**Driven, before the fix** (image `b1409a24ad3d`). The gallery listed 18
swarms. The canvas's list read (`GET swarms?select=*&order=created_at.asc`)
was refused from the browser with a 503, and Open was pressed on "R109
chat echo" (`d10c86c5`):

- postgrest-js tried four times, and then the canvas made a `POST
  swarms` (201).
- The URL still said `?swarm=d10c86c5-…`, but the canvas was "My First
  Swarm", 0 nodes, "Start wiring your swarm", with no toast.
- Back in the gallery: 19 swarms. "My First Swarm" was new at the top,
  and "R109 chat echo" was unchanged with its 2 nodes.

**Driven, after the fix** (image `abd4e27a1a31`), from the same gallery
of 19:

- The same refused list read and Open on "R109 chat echo": four refused
  reads and no `POST`. The canvas area said "Could not load your swarms"
  and "R110 injected: the GET did not reach the database. Nothing was
  opened or created, and your swarms are as you left them.", with "Try
  again" and "Back to gallery".
- With the fault lifted, "Try again" read the list (`GET` 200) and opened
  "R109 chat echo" with its 2 nodes.
- A URL naming a swarm that does not exist (`00000000-…-000000000110`)
  gave the toast "That swarm is not in your list · Opened "Swarm 1"
  instead."
- The gallery still listed 19, with the one "My First Swarm" the
  before-drive had made.

What the canvas opens first is now decided by `chooseInitialSwarm`
(`lib/swarmInitialLoad.ts`), from the list AND its error:

- **A list that could not be read.** Nothing is opened and nothing is
  created. The canvas says "Could not load your swarms", then the reason
  and "Nothing was opened or created, and your swarms are as you left
  them.", with "Try again" and "Back to gallery".
- **The swarm asked for.** It is opened.
- **A swarm asked for that is not in the list.** The toast says "That
  swarm is not in your list", and says which swarm was opened instead.
- **An owner who really has no swarms.** They still get "My First
  Swarm". Its insert now reads its answer.

A failed read of the knowledge bases or agents says their pickers stay
empty. A switch that could not read the other swarm says "Could not open
that swarm", and stays where it was.

**Tests:** 8. The decision itself is tested:

- A failed read opens and creates nothing, even with a swarm asked for.
- The swarm asked for is opened.
- A missing one opens the first swarm, marked as missing.
- A first swarm is made only for an empty list.
- With no swarm asked for, the first one in the list opens.

Anchored in the canvas source:

- The list's error decides before any `applySwarmRow` or `.insert(`.
- "Try again" loads again.
- A failed switch says so.

8 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-25 — One message, and the conversation before it was gone

#### R109 · S1 · A swarm chat opened through a failed read saved the next message over its whole transcript

The write survey closed in R72 left the swarm chat dialog's insert and
update as noted, on the grounds that they "reload from the table after
the write and so cannot show a phantom row". That is true of the chat
list, but the list is all they reload. The thread on screen is not
reloaded. The read that opens a conversation was never looked at either.

"Chat with this swarm" (the canvas's Chat button) keeps a swarm's
conversations in `swarm_chats`, and saves the whole transcript after
every turn. Three of its four database calls dropped the answer:

- **Opening a conversation** (`selectChat`) read its messages and state,
  ignored the error, and selected the conversation anyway, over
  `data?.messages ?? []`. A read that failed showed an empty thread with
  that conversation highlighted. The next message then saved
  `[question, reply]` over the stored row: the whole transcript and its
  carried flow-state, replaced by one turn.
- **A turn's save** into an existing conversation was an update that
  never read its answer. The turn stayed on screen, and it was gone when
  the conversation was reopened.
- **The first save of a new conversation** was an insert that never read
  its answer. The conversation stayed on screen, was missing from the
  list, and nothing said so.

The list read also turned a failure into "No conversations yet."

**Driven, before the fix** (image `57b70c28882f`), on a swarm made for the
purpose: "R109 chat echo", an Input and an Output, so every reply is the
message itself and no model is called. The failures were injected from
the browser, which reaches these calls because they are direct PostgREST
requests; each refused call answered 503 with `R109 injected`.

- "R109 turn one", then "R109 turn two": saved as chat `c7a47254`, with
  four messages.
- New chat, then the conversation opened with its read refused.
  postgrest-js tried four times. Then the conversation was highlighted
  over "Start the conversation below.", with no error.
- The fault was lifted, as a passing blip lifts, and "R109 after a failed
  read" was sent. It went out as a `PATCH` of `c7a47254`, and the list
  retitled it "R109 after a failed read".
- The dialog was closed, reopened, and the conversation opened with a
  clean read: two messages, "R109 after a failed read" and its reply.
  Turns one and two were gone from the database.
- With the update refused, "R109 unsaved turn" appeared with its reply
  and no error. Reopened, the conversation did not have it.
- In a new chat, with the insert refused, "R109 never saved" appeared
  with its reply and no error, and the list did not gain it.

**Driven, after the fix** (image `b7d8cdf59b82`), on the same swarm and
chat, which now held "R109 after a failed read" and "R109 after turn A":

- New chat, then the conversation opened with its read refused. Four
  attempts, then the toast "Could not open that conversation · R109
  injected: the GET did not reach the database. You are still in the
  conversation you had open.". The conversation was not selected.
- The fault was lifted, and "R109 after a refused read" was sent. It went
  out as a `POST`, a new conversation. Opened cleanly, `c7a47254` still
  held all four of its messages.
- With the update refused, "R109 turn B, refused save" showed "Not saved:
  R109 injected: the PATCH did not reach the database What you see here
  since the last save is gone when you leave this conversation.", with
  "Save again". Pressed with the fault lifted, it went out as a `PATCH`
  (200), and the notice went away. Reopened, the conversation held six
  messages, turn B among them.
- With the insert refused, "R109 insert refused" showed the same notice,
  and the list did not gain it. "Save again" went out as a `POST` (201),
  and the list gained it, selected.
- With the list read refused, reopening the dialog showed "Could not load
  conversations: R109 injected: the GET did not reach the database", over
  the last list it had read.

The notice ran the error into the next sentence ("…the database What you
see here…"). An error without a final stop now gets one. On a rebuild
(image `b1409a24ad3d`), a refused save of "R109 turn C, refused save"
read "Not saved: R109 injected: the PATCH did not reach the database.
What you see here since the last save is gone when you leave this
conversation.". "Save again" saved it (`PATCH` 200), and it read back
with all eight messages.

The reads and saves now live in `lib/swarmChatStore.ts`, and each one
returns what happened:

- **Opening a conversation.** `openChat` returns the transcript, or why
  it could not be read, and whether the conversation is gone. It never
  returns an empty stand-in. The dialog enters a conversation only once
  its read has succeeded. On a failure it says "Could not open that
  conversation · `<why>`. You are still in the conversation you had
  open.", or that the conversation no longer exists.
- **Saving a turn.** `saveChat` updates by id and asks for the row back.
  An update that reaches no row is not a save: the conversation was
  deleted elsewhere, and the next save keeps it as a new one. An insert
  that errs or returns no id is not a save either.
- **A failed save** puts "Not saved: `<why>`. What you see here since the
  last save is gone when you leave this conversation." under the thread,
  with a "Save again" button. The next turn's save, which writes the
  whole transcript, also clears it.
- **A list that could not be loaded** says "Could not load conversations:
  `<why>`".

**Not changed.** Leaving a conversation while a turn is running still
aborts that turn, as before, and the aborted turn's save still follows
whichever conversation is selected when it lands. Whether that can write
into the wrong conversation is queued.

**Tests:** 13, against a fake client that answers each call the way the
test names, and anchored in the dialog's source:

- A refused read is reported and never becomes an empty transcript.
- A missing row is gone, and a found row returns its transcript and
  state.
- An update goes by id and asks for its row back. A refused update is
  reported, and one that reached no row is not a save.
- An insert carries its owner and swarm. A refused insert, or one that
  returned no id, is not a save.
- The dialog enters a conversation only after the read's check, and
  returns on a failure.
- A failed save sets the notice and offers "Save again".
- A list that could not be loaded is not shown as empty.
- An error gets its final stop before the next sentence.

13 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-25 — Running, for nineteen hours, while it waited for a person

#### R108 · S2 · Recent runs showed a run parked at an approval as "Running", and offered nothing that could end it

Found while reading the browser writes that R106 queued. `cancelByDbRunId`
cancels a run only while it is `running`, which made me ask what else the
Recent runs panel (Agent Swarms → Recent runs) could be showing.

Since the checkpoint work, a run that reaches a human-approval step on the
server (from the API, a schedule or a webhook) parks with the status
`suspended`. The panel's badge knew five words: `running`, `waiting`,
`success`, `error` and `cancelled`. Any other word fell through to
`map.running`, so a parked run read "Running", with the running icon. It
was left out of the panel's own `ACTIVE` set, so it got no Cancel. Its
duration was the time since it started, so it grew by the minute. All of
this sat under a header that said "Cancel a running or paused run here."
What ends a parked run is a decision on its approval, and nothing on the
row said so.

R92 had seen four of these rows read "Running" and traced them to the
forked resume it fixed, which was real. The display rule was left as it
was, and it applies to every parked run, including the ones whose
approvals are still pending today.

**Driven, before the fix** (image `b413a02e6aad`), on runs earlier rounds
left parked on purpose:

- Swarm Observability listed five runs of "Approval durability check
  (schedule)" as `suspended`, started Sep 24 at 01:38:29, 01:59:23,
  02:27:57, 03:00:02 and 04:04:38. The header showed "Pending approvals
  (5)".
- Agent Swarms → Recent runs at 23:40:14 showed the same five runs as
  `Running`, with durations of `1321m 35s`, `1300m 42s`, `1272m 8s`,
  `1240m 3s` and `1175m 26s`. Each row offered only Open and Trace. The
  runs that finished around them read `Error` with `3 steps`, which was
  correct.

**The first fix went one step too far, and the drive showed where.** It
read every `suspended` run as "Awaiting approval", with a "Review approval"
button that opens the approvals inbox. On image `0bbcf3e09334`, the five
rows above read that way, and the button opened the inbox with "Pending
Approvals 5", paused 20h, 21h, 21h, 22h and 22h ago, one for each.
Further down the list, four more rows read the same. Their approvals were
nowhere in the inbox. They are R92's runs (`3bf09de5` and three others
from Sep 23): their approvals were decided before R92's fix, and their
work finished under a separate `(api)` run. No approval is waiting for
them, so "Awaiting approval" and a button to an inbox that does not hold
them were a new untruth for exactly those rows. `suspended` alone cannot
say whether anyone is still being asked. The approval row can, and the
executor writes it with the run owner's id, so the owner can always read
it. A second pass (image `a5d418394794`) read the requests. The five
pending runs kept "Awaiting approval", and the four read "Decided, not
resumed" with no button, but they still showed `45h 30m` to `46h 51m`.
Hiding the duration only for runs awaiting a decision had missed them.
A duration is time spent running, so it now shows only for a run that is
live or has finished.

**Driven, after the fix** (image `57b70c28882f`), on the same runs, at
00:41:53:

- The five read `Awaiting approval`, started 20h to 23h ago, each with
  "Review approval" and no duration.
- The four read `Decided, not resumed`, started 1d ago, with no duration
  and no button. The two in view sit directly under `(api) · Success · 5s
  · 3 steps` rows, the runs that hold their work.
- The panel's other 21 rows (7 Error, 14 Success) read as before.
- "Review approval" on a row opened the inbox, `Pending Approvals 5`,
  paused 20h, 21h, 22h, 22h and 23h ago.

Nothing was approved or rejected, and the parked runs stay as fixtures.

The panel now takes every status rule from one table
(`lib/swarmRunStatus.ts`). For the parked runs on screen, it also reads
their approval requests:

- **A pending request.** The run reads "Awaiting approval", with the
  hourglass. It is not polled, and it is not offered a Cancel that could
  not reach it. Its row carries "Review approval", which opens the
  approvals inbox, where the decision that ends it is made.
- **Requests that were all decided, with the run still parked.** It reads
  "Decided, not resumed", with nothing pointing to an inbox that no
  longer holds it.
- **No request at all.** This is R90's failed insert. The run reads
  "Parked, nobody asked".
- **Requests that could not be read.** The row says only "Parked", and
  keeps the button to the inbox.

The rest of the panel:

- No parked run shows a duration. A duration is shown only for a run
  that is live or has finished: the time since a parked run started says
  nothing about it.
- A run waiting at an approval inside this tab keeps its Cancel, because
  Cancel does reach a run held in this tab.
- A status the panel does not know reads as itself, never as "Running".
- Durations of an hour or more read in hours: `19h 35m`, not `1175m 26s`.
- The header says what is true: "Cancel a running run here; a run waiting
  for an approval goes on or stops when the approval is decided."

**Not changed, and queued.** Nothing cancels a parked run outright. If
anything ever does, it has to close the checkpoint and the approval with
it. `resumeApprovedSwarmRun` stops only for `success` and `error`, so a
run marked `cancelled` with its checkpoint still there would be resumed by
a later approval. The four "Decided, not resumed" rows also still hold
their checkpoints, as R92 recorded; nothing in the UI can resume them
again, because the inbox resumes only from a pending request.

**Tests:** 16, most on the status table itself and some anchored in the
panel and inbox source:

- A parked run with a pending request reads "Awaiting approval", is
  neither live nor cancellable, and awaits a decision.
- A decided request, no request, and an unreadable request each read as
  what they are.
- A second approval step that is pending wins over a first that was
  decided.
- No parked run is ever cancellable or live.
- The in-tab wait stays cancellable.
- Every status the executor writes has a view of its own.
- An unknown status reads as itself.
- A duration shows for a live or finished run, and never for a parked
  one.
- Hours read as hours.
- The panel reads the requests, marks a failed read, and lets the requests
  decide.
- A parked row opens the inbox and shows no duration.
- The inbox listens for a row's request.

19 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-24 — The replace that left nothing

#### R107 · S1 · Publishing to Iceberg with "Replace" dropped the table before it knew it could write the new one

Queued by R106. The Lakehouse's "Publish to Iceberg" writes a lakehouse
table into a registered Iceberg REST catalog. Its "If it exists" choice
offers "Refuse (keep the existing table)" or "Replace it (drop, then
create)". The DuckDB Iceberg extension has no `CREATE OR REPLACE`, so
replace was exactly what the label says: `DROP TABLE IF EXISTS <target>`,
then `CREATE TABLE <target> AS SELECT * FROM <source>`, two statements in
that order. When the create failed, the catalog was left with no table at
all. The owner had asked to replace the table, not to remove it, and
Spark, Trino and Snowflake reading the catalog lost it. A create fails
easily: a source column the Iceberg writer cannot store, a catalog or
storage error, a policy on the source.

**Driven, before the fix** (image `987d1ff3b46c`), on tables and a
namespace made for the purpose:

- `CREATE TABLE analytics.r107_src AS SELECT 1 AS id, 'published' AS
  note`, and `CREATE TABLE analytics.r107_bad AS SELECT 2 AS id, INTERVAL
  1 DAY AS span`.
- A probe, with no drop involved: `r107_bad` → Publish to Iceberg →
  catalog `local_rest`, namespace `r107`, table `r107_probe`, Refuse →
  `Invalid Input Error: Column type INTERVAL is not a valid Iceberg Type.`
- `r107_src` → Publish → `r107` / `r107_pub`, Refuse → `Published 1
  row(s) to r107.r107_pub`. Publishing it again with Refuse gave `Catalog
  Error: Table with name "r107_pub" already exists`, so the table was
  there.
- `r107_bad` → Publish → `r107` / `r107_pub`, Replace it (drop, then
  create) → `Invalid Input Error: Column type INTERVAL is not a valid
  Iceberg Type.`
- Iceberg → Mount a namespace → `local_rest` / `r107` as `ice_r107` →
  `Mounted 0 tables`. The published table was gone, and nothing had
  replaced it.

**The first fix had a flaw of its own, and a drive found it.** It staged
the new data under a fixed name, `<table>__publishing`, and began each
replace by dropping any table of that name "left behind by an interrupted
replace". A fixed name is a name somebody can own. On that build (image
`d071cd16aab0`) the failed replace above now kept the table (`Mounted 1
table`), and a good one worked (`Published 2 row(s)`). Then `r107_src`
published with Refuse as `r107/r107_pub__publishing` (`Published 1
row(s)`, and a mount read `Mounted 2 tables`). Replacing `r107_pub` from
`analytics.r107_src2` dropped that table first. The catalog logged
`Dropped table: r107.r107_pub__publishing`, then used the name for its
staging copy and dropped it again at the end. The next mount read
`Mounted 1 table`. The replace had destroyed a table the owner never
named, which is the defect this round set out to remove, moved to a
different table.

The same drive met a catalog-side fault. For two attempts the catalog
answered HTTP 500 to every `DELETE`: `[SQLITE_BUSY] The database file is
locked`, in the SQLite store of the development catalog
(`tabulario/iceberg-rest`). Creates still succeeded. The owner's table
survived those two attempts only because of the lock. A lock held between
HTTP requests is inside the catalog server, not in anything this app
holds. Restarting that one container cleared it, and its state lives on a
volume, so both tables were still listed afterwards. The fault also
showed a gap in the fix: when the catalog refuses the drop of the old
table, the old table stands, and the staging copy was left behind.

**Driven, after the fix** (image `b413a02e6aad`), with the owner's table
put back first:

- `r107_src` published with Refuse as `r107/r107_pub__publishing` gave
  `Published 1 row(s)`.
- `r107_bad` → Replace `r107_pub` → the INTERVAL error. The catalog's log
  shows the staging name `r107_pub__publishing_4482b342` looked up, never
  created, and nothing dropped. Mount `ice_r107_fixed` → `Mounted 2
  tables`.
- `r107_src` → Replace `r107_pub` → `Published 1 row(s) to
  r107.r107_pub`. The catalog's log, in order: committed
  `r107_pub__publishing_81ccfb38`, dropped `r107_pub`, committed
  `r107_pub`, dropped `r107_pub__publishing_81ccfb38`.
- Mount `ice_r107_final` → `Mounted 2 tables`. Through that mount,
  `r107_pub` reads `1 published`, and so does the owner's
  `r107_pub__publishing`, untouched.

The refused drop of the old table was not driven again. The catalog lock
that produced it cannot be brought on at will, so a test covers it.

A replace now stages the new data first, under a name made for that
publish alone: `<table>__publishing_<8 hex>`. Once that write has
succeeded, it drops the old table, fills the old name from the staged
copy (whose types the catalog has just accepted), and drops the staging
table. The only tables a replace ever drops are the one the owner named
and the one it has just created. A write that cannot happen fails before
anything is dropped. If the staged write or the drop of the old table
fails, the old table stands and the staging table is removed. That is
always safe, because the new data is still in the lakehouse. If the copy
into the old name fails in the narrow window after the drop, the error
says so and names the staging table that holds the new data. A failed
cleanup of the staging table is logged, and does not fail a publish that
has landed. `create` is unchanged. The cost is that a replace writes the
data twice.

**Tests:** 8 new, run against a fake engine that fails the statements each
test names:

- A staged write that fails leaves the old table undropped, and removes
  its own staging table.
- A refused drop of the old table removes the staging table.
- The new data is staged before the old table is dropped.
- A failed copy into the old name says where the new data is.
- A failed staging cleanup does not fail a publish that landed.
- The only tables dropped are the named one and one created earlier in
  the same publish.
- Two publishes stage under different names.
- `create` never drops.

The existing test of the publish SQL now pins the whole five-statement
replace, and pins that a replace without a staging name refuses. 11
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-24 — Deleted, said the page, of a dataset it still listed

#### R106 · S2 · The browser's dataset delete and replace did not read the database's answer

Found while finishing R101's sweep. The last unread writers were Data Prep's
"Run & save dataset" and the CSV upload. Both replace a dataset of the same
name, deliberately and recoverably: each snapshots the old rows as a
version first ("a re-upload of the wrong file is otherwise
unrecoverable"). They are CLEAR for that class. The Iceberg publish and
import are CLEAR too: "create" is a plain `CREATE TABLE`, and replacing
has to be picked by name. Reading the browser's copy of the dataset
writes, in `lib/sqlEngine.ts`, turned up the thing R87 fixed on the
server, still live here:

- **`deleteDataset`** ran `supabase.from("user_data_tables").delete()` and
  never looked at the answer. It dropped the table from the page's engine,
  and both callers then toasted `Deleted "<name>"`. That is the Data
  Catalog's workbench and BI's Data preparation. A delete that row-level
  security filters out is not an error either, just nothing removed, and
  it was treated the same way.
- **`saveDataset`**, replacing a dataset of the same name (the warehouse
  import's path), deleted the old rows and never checked. A failed delete
  left them, the new rows were appended below, and the dataset came out
  doubled under `Imported N rows`. That is R87 exactly, in the browser. The
  update of the dataset's details was unchecked too, and so was the lookup
  that decides between replacing and creating. A failed lookup read as "no
  such dataset" and created a second one of the same name.

**Driven, before the fix** (image `79cc1f0208c9`). BI → Data preparation
→ Local tables → `sftest_campaigns` onto the canvas → Flow name `r106
scratch`, Output table `r106_scratch` → Run & save dataset gave `Saved
"r106_scratch" with 4 rows`. The DELETE on `/rest/v1/user_data_tables`
was then made to answer 500 (`R106 injected: the delete did not reach the
database`). `r106_scratch` → Delete → the dialog (`1 thing depends on this
dataset…`) → type `r106_scratch` → Delete dataset. The one DELETE was
refused. The toast read `Deleted "r106_scratch"`, and the refreshed list
still showed `r106_scratch · 33 cols · 4 rows · prep` at its top.

**After the rebuild** (container `987d1ff3b46c`), the same page and the
same injected refusal:

- `r106_scratch` → Delete → confirm. The one DELETE (now asking for the
  row back, `select=id`) was refused. The toast read `"r106_scratch" was
  not deleted: R106 injected: the delete did not reach the database`. The
  dialog stayed open, and the list still showed the dataset, which was
  now the truth.
- With the refusal removed, the same dialog's Delete dataset gave
  `Deleted "r106_scratch"`, and the dataset left the list. After a
  reload, Local tables read 33, down from 34, and `r106_scratch` was not
  among them.

`deleteDataset` now asks for the deleted row back and counts it. An error
or an empty answer throws, and the page's engine table is dropped only
once the row is really gone. Both callers already hand a throw to the
dialog, which shows it and stays open. `saveDataset` checks the lookup,
the clear and the update, and stops before the insert when any of them
fails. So a replace can never append to rows it could not remove.

**Tests:** 8, run with the browser's database client and engine faked, so
they see every write and its order. A refused or empty delete throws and
leaves the page's table. A real one drops it after the row is gone. A
failed clear, a failed update or a failed lookup stops the save before
anything is appended, and a good replace clears before it writes. 6
behaviour-changing mutants each killed, control missed, baseline green
first.

`runAndSavePrep` in `lib/dataPrep.ts` is a third caller of `saveDataset`
with no callers of its own. It is dead code, left for a tidy-up.

### 2026-09-24 — The training set built over a table

#### R105 · S1 · A feature view's training set replaced a table it had not made

From R101's sweep, the last of its named writers. A feature view's
"Training set" joins a label table to the features that were true at each
label's moment, and writes the result with `CREATE OR REPLACE TABLE
<output>`. The build goes through the per-user statement guard, so the
caller must be allowed to write there. Nothing asked what was already at
the name. An existing table was replaced by the training set. So would the
label table be, or the view's own table: the two tables the next build has
to read.

**Driven, before the fix** (image `0be169f13e15`). ML Models → Feature
views → New view `r105_features`: table `analytics.revenue_facts`, key
`order_id`, latest row wins by `placed_at` → Create (`Created
r105_features`). A scratch `analytics.r105_keep` held `105 · not a training
set`, and a 20-row label table `analytics.r105_labels` held `order_id,
label_at`. Then Training set → Label table `r105_labels`, As of
`label_at`, key `order_id`, Write to `r105_keep` → Build. The toast read
`Built analytics.r105_keep — 20 row(s)`. `SELECT * FROM analytics.r105_keep`
then read back `order_id · label_at · net_usd · payment_rows · status ·
…`. The row and its columns were gone.

**After the rebuild** (container `79cc1f0208c9`):

- A fresh `analytics.r105_keep2` (`1052 · still not a training set`) as
  the output → Build → `analytics.r105_keep2 already exists, and no
  training set of yours wrote it. Building there would replace its rows
  with the training set. Pick a new output table, or drop that table first
  if replacing it is what you mean.`
- The label table as the output → `analytics.r105_labels is the label
  table. Building the training set there would replace the labels it is
  built from. Pick another output table.`
- Rebuilding a training set's own output is unchanged. Write to
  `r105_keep`, which the before-drive's build wrote → `Built
  analytics.r105_keep — 20 row(s)`.
- Read back: `r105_keep2` gave `still not a training set`, `r105_labels`
  gave 20 rows, and `r105_keep` gave 20.

`buildTrainingSet` now refuses the label table and the view's own table
outright, compared without case. It asks the lakehouse, through the shared
`lakehouseTableExists`, whether the output exists. If it does, the build
may replace it only if an earlier training set of the same user wrote that
exact table. The only record of that is the audit trail's
`feature_view.training_set` event, whose detail names the output. That
record is best-effort, so a rebuild whose earlier audit write failed is
refused, and says why. The refusal fails closed. An unreadable audit trail
or catalog refuses too.

**Tests:** 8, run with the catalog, the audit trail and the engine faked,
so they see whether the replacing statement would be sent. A foreign table
is refused. The audit trail is asked about this user's training-set
events for this exact output. An unreadable trail or catalog refuses. The
label table and the view's table are refused, whatever the case. A free
name builds, and a rebuild of the user's own training set builds. 9
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-24 — The predictions written over a table

#### R104 · S1 · A batch prediction replaced a table no prediction had made

From R101's sweep. A batch prediction runs in the sandbox, which writes the
scored rows with `CREATE OR REPLACE TABLE <output> AS SELECT * FROM _pred`.
Starting one (from a model's Predictions tab, the `/api/ml/predict/batch`
route, or a schedule) asked only whether the output schema was yours. The
dialog promises it "writes a new table you own". Given the name of an
existing table, it replaced that table with predictions. Nothing stopped
the output from being the input table itself either. With a row filter,
that replaced the scored table with only the rows the filter kept.

**Driven, before the fix** (image `cf409cf0925a`). Lakehouse → `CREATE
TABLE analytics.r104_keep AS SELECT 104 AS id, 'not a prediction' AS note`.
Then ML Models → `revenue_facts plan classifier` → Predictions → Batch
prediction → Input `analytics.revenue_facts`, Output schema `analytics`,
Output table `r104_keep`, version `v7 · logistic_regression · production`
→ Predict. The toast read `Batch prediction started`, and the job list
showed `succeeded · batch via ui · analytics.revenue_facts →
analytics.r104_keep · 836 · 10s`. A query for the table's own column
then failed: `Referenced column "note" not found … Candidate bindings:
"net_usd", "order_id", "proba_enterprise", "customer_id", "payment_rows"`.
`count(*)` was 836.

**After the rebuild** (container `0be169f13e15`):

- A fresh `analytics.r104_keep2` (`1042 · still not a prediction`) as the
  output → Predict. The dialog stayed open with `analytics.r104_keep2
  already exists, and no prediction of yours wrote it. Scoring into it
  would replace its rows with predictions. Pick a new output table, or drop
  that table first if replacing it is what you mean.`
- Output `revenue_facts`, the input itself, with the filter `region =
  'EMEA'` → `analytics.revenue_facts is the table being scored. Writing the
  predictions there would replace it with only the rows the filter keeps.
  Pick another output table.`
- Scoring again into its own output is unchanged. Output `r104_keep`,
  written by the before-drive's prediction, gave `Batch prediction
  started`, then `succeeded · 836 · 60s`.
- Read back: `r104_keep2` gave `still not a prediction`,
  `analytics.revenue_facts` kept 836 rows, and `r104_keep` held 836.

`startBatchPrediction`, which every door calls, now refuses an output that
is the input, compared without case. It asks the lakehouse, through the
shared `lakehouseTableExists`, whether the output exists. If it does, the
job may write there only when an earlier SUCCEEDED prediction of the same
user wrote that exact table, which is what a daily schedule does. A
failed or queued one never wrote it, and another user's cannot vouch for
yours. Either check failing refuses rather than guessing.

**Tests:** 8, run with the catalog, the prediction history and the sandbox
start faked, so they see whether a job would start. A foreign table is
refused. The history is asked about this user's succeeded writes to this
exact table. An unreadable history or catalog refuses. The input is never
the output, even when the case differs, and the refusal names the filter.
A free name and a re-score into a prediction's own table both start. 8
behaviour-changing mutants each killed, control missed, baseline green
first.

Seen while driving and queued rather than fixed: the output-schema picker
offers `ice_sales`, and the server's check refuses a data-lake mount but
not an Iceberg catalog schema. Every other writer refuses both.

### 2026-09-24 — The model that took a table's name

#### R103 · S1 · A SQL model named like an existing table dropped it

From R101's sweep, and the sharpest of it. A SQL model's name is its
target table, "as in dbt". A build first runs `DROP <the other shape> IF
EXISTS <target>`, so that a model switching between table and view is not
stuck, and then `CREATE OR REPLACE <shape> <target> AS <select>`. Saving a
model checked the name against materialized views ("is already a
materialized view"). It never checked it against the ordinary tables in
the schema. A model given the name of a table it had never built took
that table. Stored as a view, the model's build dropped the table
outright. Stored as a table, it replaced it.

**Driven, before the fix** (image `820d1915bef9`). Lakehouse → `CREATE
TABLE analytics.r103_keep AS SELECT 103 AS id, 'a table no model built' AS
note`, read back `103 · a table no model built`. Then SQL Models → New
model: Name `r103_keep`, Schema `analytics`, Stored as `View — the query
runs on every read`, SQL `SELECT 1 AS x` → Create gave the toast `Created
r103_keep`. Build this and what it reads gave `Built 1 model`, and the
run list showed `r103_keep · built · 1 rows`. `SELECT * FROM
analytics.r103_keep` then read back `x · 1`. The table and its row were
gone, dropped by the build, with a view in their place.

**After the rebuild** (container `cf409cf0925a`):

- `CREATE TABLE analytics.r103_keep2 AS SELECT 1032 AS id, 'still no model
  built this' AS note`. Then New model `r103_keep2`, `analytics`, View,
  `SELECT 1 AS x` → Create. The toast read `analytics.r103_keep2 already
  exists, and this model did not build it. Building the model would
  replace it (a view-stored model drops the table first). Give the model
  another name, or drop the table first if replacing it is what you mean.`
  No model was created.
- A model rebuilding its own target is unchanged. Opening `r103_keep` and
  changing its SQL to `SELECT 2 AS x` → Save gave `Saved r103_keep`. Build
  gave `Built 1 model`.
- Read back together, `analytics.r103_keep` gave `2` and
  `analytics.r103_keep2` gave `still no model built this`.

The save now asks the lakehouse, through R102's shared
`lakehouseTableExists`, whether the target is taken. It asks whenever the
target is new to this model: a new model, or one moved to another name or
schema. A model keeping the target it already has is rebuilding its own
output, and is not asked. Otherwise every existing model would be
refused on its next save. An unanswerable check refuses rather than
guessing the name is free. So does an unreadable answer from the
materialized-view clash check, whose error the code dropped.

Still open, and recorded in the queue: a table created at a model's target
AFTER the model was saved is still replaced by that model's next build.
Only the save is checked, because telling "the table this model built"
from "a table made there since" needs the build to leave a mark it can
recognise.

**Tests:** 7, source-anchored, because the save is a server function (the
check it calls is executed in `lakehouseImportNoReplace.test.ts`). The save
asks, refuses exactly when the answer is taken, and names the reason and
the way out. It asks only for a target new to the model, refuses when it
cannot tell, and decides before anything is written. The view-clash read
fails closed. 6 behaviour-changing mutants each killed, control missed,
baseline green first. The first run left one surviving: turning `if
(taken)` into `if (false)` passed, because the tests only proved the
message existed. The test now pins it to the branch.

### 2026-09-24 — The new table that was an old one

#### R102 · S1 · "New table → Import dataset" replaced an existing table

The first sibling from R101's sweep, and the plainest. Each schema in the
Lakehouse object explorer has a **New table** button. Its dialog, titled
"New table in <schema>", has two halves:

- **Define columns** runs `CREATE TABLE` through the per-user statement
  guard, and an existing name is refused.
- **Import dataset** pages a platform dataset out of the store and runs
  `CREATE OR REPLACE TABLE <schema>.<name> AS SELECT * FROM
  read_json_auto(...)` on a raw engine connection. An existing name was
  replaced, rows and columns, followed by "Table … ready".

The same write also skipped the rest of the guard it bypasses. The page
offers "New table" only on regular schemas, but the server function
never checked, so a direct call could write into a read-only data-lake
mount.

**Driven, before the fix** (image `91a6460a6a93`). `analytics.r101_keep2`
held `7 | still precious` after R101's after-drive. The schema's New table
(+) → Import dataset → Platform dataset `f1_constructor_standings` → Table
name `r101_keep2` → Import. The toasts read `Imported 10 row(s)` and `Table
analytics.r101_keep2 ready`. `SELECT * FROM analytics.r101_keep2` then
read back `wins · points · position · constructor · nationality`, starting
`14 · 833 · 1 · McLaren · British`. The previous row and columns were
gone.

**After the rebuild** (container `820d1915bef9`):

- A fresh table: `CREATE TABLE analytics.r102_keep AS SELECT 102 AS id,
  'untouched by the import' AS note`. Then New table → Import dataset →
  `f1_constructor_standings` → `r102_keep` → Import. The toast read
  `analytics.r102_keep already exists. Importing would replace its rows with
  this dataset. Pick a new name, or drop the table first if replacing it is
  what you mean.` The dialog stayed open, and `SELECT * FROM
  analytics.r102_keep` read back `102 · untouched by the import`.
- The same refusal for `r101_keep2`.
- A free name still imports. The same dataset → `r102_import` → `Imported
  10 row(s)` and `Table analytics.r102_import ready`, reading back 10 rows.
- R101's refusal, now through the shared check, still holds. Save as view
  onto `r102_keep` answered `analytics.r102_keep is an existing table, not
  a materialized view…`.

The import now refuses an existing name before it pages a single row out
of the store. The write itself is a plain `CREATE TABLE`, so a table
created between the check and the write makes the import fail rather than
be replaced. A mount or Iceberg schema is refused on the server, as the
page already implied. The existence check is one function,
`lakehouseTableExists` in `core.server`. The materialized-view save and the
import both call it. It compares without case and takes its connection as
a parameter, so it can be run against a fake engine.

**Tests:** 10 new, and R101's file adjusted to the shared check. Four run
the real check against a fake engine: it answers taken or free from the
catalog, it asks without case in the `lake` catalog and closes its
connection, and it quotes a hostile name rather than running it. Six are
source-anchored: the import asks, refuses with the reason, asks before
paging, writes with `CREATE TABLE`, refuses mounts, and uses the shared
check, which R101's save also uses. 6 behaviour-changing mutants each
killed, control missed, baseline green first.

The rest of R101's sweep list is in the queue with what each one already
does. The sharpest is the SQL model build, which runs `DROP <other shape>
IF EXISTS` on its target before replacing it.

### 2026-09-24 — The view that was saved over a table

#### R101 · S1 · "Save as view" replaced an existing table's data, and called it built

A materialized view is a query whose answer is kept as a real lakehouse
table. It is built, and rebuilt, with `CREATE OR REPLACE TABLE
<schema>.<name> AS <query>`. Saving one, from the Lakehouse page's "Save as
view" or Data Prep's "save to lakehouse", asked two things of the target:
is the schema yours, and is it a mount. It never asked what was already at
the name. Given the name of an ordinary table (an upload, an ETL output, a
table made in the workbench), the first build replaced that table's rows
and columns with the query's answer. It then reported success.

The queue sent this round to the materialized view for a different class,
a badge that outlives what it vouched for. That part checked out. A save
always rebuilds, and a failed rebuild sets `error`, while "Last rebuilt"
keeps the last good time, which is true. The overwrite sat on the same
path.

**Driven, before the fix** (image `5c5895ec55d0`), on a table made for the
purpose. Lakehouse → Query → `CREATE TABLE analytics.r101_keep AS SELECT 1
AS id, 'precious row' AS note` → Run (`Count 1`). `SELECT * FROM
analytics.r101_keep` read back `1 | precious row`. Then the editor got
`SELECT 42 AS answer` → Save as view → Schema `analytics`, Table name
`r101_keep`, Rebuild `manual` → Save and build. The toast read `Built
analytics.r101_keep — 1 row(s)`. `SELECT * FROM analytics.r101_keep` then
read back `answer | 42`. The row was gone, and so were both of its columns.
The dialog had said nothing about the name being taken.

**After the rebuild** (container `91a6460a6a93`):

- A second scratch table, `CREATE TABLE analytics.r101_keep2 AS SELECT 7 AS
  id, 'still precious' AS note`, read back `7 | still precious`. Then
  `SELECT 42 AS answer` → Save as view → `analytics` / `r101_keep2` /
  `manual` → Save and build. The toast read `analytics.r101_keep2 is an
  existing table, not a materialized view. Saving a view there would
  replace its rows with this query's answer. Pick a new name, or drop the
  table first if replacing it is what you mean.` The dialog stayed open,
  and the table read back `7 | still precious`.
- Redefining a view that IS one still works. `SELECT 43 AS answer` → Save
  as view → `analytics` / `r101_keep`, which the before-drive had
  registered as a view → `Built analytics.r101_keep — 1 row(s)`, and it
  read back `answer | 43`.

`saveMatviewForUser`, the one function both doors use, now looks before it
writes. A name that is already a registered view is a redefinition, which
is what the upsert is for. A name that exists as a table and is not a
view is refused, with the reason and the way out. The catalog is asked
without case, because DuckDB resolves identifiers that way, so a table
created as `Orders` is the one a view named `orders` would replace. When
the list of views cannot be read, the save is refused rather than guessed.
The scheduled rebuild of a registered view is unchanged: replacing its own
table is what it is for.

**Tests:** 6, run against a fake catalog and a fake engine that record
every statement sent. An existing table is refused by name, and nothing
that could replace it is sent and no view is recorded. The catalog is
asked without case. An unreadable view list refuses. A free name builds,
and an existing view is redefined even though its table exists. 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-24 — The first call after a quiet spell

#### R100 · S1 · Clients that gave up on a server while it was starting

MCP Builder servers scale to zero: after an idle timeout, 15 minutes by
default, the container stops, and the next call starts it again. This
instance's MCP endpoint gives that start up to 90 s before it answers 503.
Its own clients gave the first request far less. Agents and swarm Tool nodes
gave `initialize` 15 s, and Test connection gave it 12 s. The cold starts
measured while driving this took 17.7 s, 35.5 s, 23.4 s and 14.6 s. So the
first call after a quiet spell failed with "The operation was aborted due
to timeout". For an agent on a schedule that is most calls. The endpoint
went on to answer 200 to nobody and kept the session it had opened, which
no one would end. Test connection was worse: it wrote the result down, and
a server that was only asleep was marked **Error**.

The Deploy tab promised the opposite: "the server starts on the first call
(a few seconds)". The docs said the same.

This is the queue's "two timeouts that do not agree" class, which R98
showed was the wrong diagnosis for the deploy error. It is real here.

**Driven, before the fix** (image of R99, `52e61c76e4f1`):

- MCP Builder → `R99 hello` → Stop. Then Agent Swarms → `R99 MCP tool
  call` → the MCP Tool Call node → `{"name": "r100 before"}` → Test this
  node → Run node. After about 12.5 s it returned `{"error":"The operation
  was aborted due to timeout"}`. The endpoint's `initialize` was answered
  200 after 17.7 s, and the sandbox logged no DELETE.
- MCP Builder → Stop again. Then Integrations → MCP Servers → `R99 hello`
  (`● Active`) → Refresh. After about 11 s the toast read `Probe failed:
  The operation was aborted due to timeout`, and the card changed to
  `● Error`.

**After the rebuild** (container `5c5895ec55d0`), the same two paths with
the server stopped each time:

- **The swarm node**, `{"name": "r100 after"}`: `Hello, r100 after!` 28.4 s
  after the click. The endpoint logged `initialize` 200 after 23.4 s of cold
  start, then `initialized` (1.1 s) and the call (6.4 s, the fresh
  sandbox's first call). The sandbox logged `DELETE /mcp 200`, so the
  session was ended.
- **Refresh on MCP Servers**, with the card still reading `● Error` from
  the before-drive: after about 16 s the toast read `Discovered 2 tools`,
  and the card went back to `● Active · 2 tools`. The endpoint's
  `initialize` took 14.6 s, a cold start that the old 12 s would have
  cut off.

One number now, `MCP_CONNECT_BUDGET_MS` in an import-free
`mcpApps/budgets.ts`: the endpoint's own cold-start budget
(`MCP_COLD_START_MS`, 90 s, which the endpoint now takes from there too)
plus the ordinary 15 s for one request. Agents, swarm Tool nodes and Test
connection give `initialize` that long, and every other request keeps its
ordinary budget. The client's patience outlasts the server's, so whatever
the endpoint answers arrives: ready, or its 503 naming what went wrong. The
only cost is for an external server whose initialize HANGS, which is now
waited on for longer. Any answer still returns the moment it comes.

The longer wait exposed a second fault, fixed with it. R99's session
retried the request bare when initialize was refused, which is right for
a server without sessions (a 4xx). It did the same for a server that
FAILED (a 5xx). Behind this endpoint, that bare retry started a second
sandbox after the first start had just been given up on. A 5xx initialize
is now the answer, and nothing more is sent.

The Deploy tab and the docs now say the first call waits around half a
minute, and the docs name the 90 s ceiling.

**Tests:** 8 new. Two check the budget: it outlasts the endpoint's own
budget and every measured cold start. Two run the session: a 503
initialize is handed back with nothing more sent, and a 405 still goes on
bare. Four are source-anchored: agents and Test connection give initialize
the budget, the endpoint takes its figure from the same place, and the
owner is no longer promised a few seconds. `mcpStartHonesty.test.ts` now
reads the 90 s figure where it lives. 9 behaviour-changing mutants each
killed, control missed, baseline green first.

### 2026-09-24 — The agents that never said hello

#### R99 · S1 · Every agent call to a stateful MCP server refused

Agents reach MCP servers through one client, `mcpRequest`, behind the
`mcp_list_tools` and `mcp_call_tool` tools and the swarm Tool node's MCP
Tool Call. It sent its request cold: `tools/list` or `tools/call` with no
`initialize` before it and no session id on it. The Streamable HTTP
transport has a session. A stateful server issues an `Mcp-Session-Id` on
initialize and answers anything that arrives without one with
`400 Bad Request: Missing session ID`. Stateful is FastMCP's default, and
so it is how every server the MCP Builder deploys runs.

Measured first, outside the UI, against fastmcp 4.0.3 from the sandbox
image: `tools/list` and `tools/call` sent the agent's way both came back
`400 {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Bad
Request: Missing session ID"}}`.

The Builder makes the failure hard to see. Its Access tab registers a server
for this instance's agents with the toast `Registered — your agents can call
it now.` Its deploy, test console and Test connection all do the handshake,
so the same server reads as healthy everywhere a person looks. Only the
agents, the one caller the registration exists for, were refused.

**Driven, before the fix.** MCP Builder → New server `R99 hello` from the
stock Hello world template → Deploy (`Deployed — 2 tools.`) → Access → Your
agents on → `Registered — your agents can call it now.` Then Agent Swarms
→ New Swarm (`Swarm 17`) → Input → Tool (deterministic) → Output, wired.
The Tool node was set to MCP Tool Call, server `R99 hello`, tool `greet`,
arguments `{"name": "r99 before"}`, then Test this node → Run node. After
1.4 s the output was `{"error":"400: {\"jsonrpc\":\"2.0\",\"id\":null,
\"error\":{\"code\":-32600,\"message\":\"Bad Request: Missing session
ID\"}}"}`. The app's MCP endpoint logged `status 400`, and the sandbox
logged one bare `POST /mcp` → 400. The deploy two minutes earlier had
done `POST 200`, `202`, `POST 200` on the same server.

**After the rebuild** (container `52e61c76e4f1`), in the same swarm, saved
this time as `R99 MCP tool call`, with arguments `{"name": "r99 after"}`:

- **With the sandbox warm**, Run node answered
  `{"jsonrpc":"2.0",…,"result":{…,"content":[{"text":"Hello, r99
  after!","type":"text"}],"isError":false,…}}`. The sandbox logged the
  whole session: `POST 200` (initialize), `202` (initialized), `POST 200`
  (the call), then `DELETE /mcp 200`. The endpoint forwards a DELETE only
  after removing its own session row. That first call in a freshly started
  sandbox took about 10 s inside the sandbox. Run again with
  `{"name": "r99 again"}`, it answered `Hello, r99 again!`, and the
  endpoint logged 1.48 s, 1.11 s and 1.17 s for the three requests. A
  stock FastMCP called directly answered in 0.44 s the first time, so the
  10 s is the sandbox's first call, not the session.
- **With the sandbox cold**, the first run after the rebuild answered
  `{"error":"The operation was aborted due to timeout"}` after about 13 s.
  The endpoint's `initialize` was answered 200 after **35.5 s** of cold
  start, 20 s after the agent's 15 s timer had given up. That is a
  separate fault, a client timer shorter than the work it waits on, and
  it is queued rather than folded in here.

The call is now made in a session of its own, in `mcpApps/session.ts`. It
sends `initialize` and takes the `Mcp-Session-Id` and the protocol version
the server agreed to. It announces `notifications/initialized`, sends the
request carrying both headers, and reads to the answer (R98). Then it ends
the session with a DELETE, which the spec asks of a client. This
instance's own MCP endpoint keeps a row per session until one is ended, so
without the DELETE an agent calling a Builder server would leave a row
behind per tool call. A server that refuses `initialize` at the HTTP
level gets the request bare, as before, so an endpoint that only ever
answered bare requests keeps working. Every request of the session still
goes through the SSRF guard.

**Tests:** 12. Nine run the session against a fake that behaves the way
the measured server did. The fake refuses a cold request with Missing
session ID. In a session, the call is answered, in the order initialize →
initialized → request, carrying the issued session id and the agreed
version. The session is ended afterwards, and also when the request
fails. A server that refuses initialize is still called bare, and a
stateless one, which issues no id, gets no DELETE. Three are
source-anchored: the agents' client uses the session, keeps the SSRF
guard, and is what both agent tools call. R98's door test moved with the
reads. 8 behaviour-changing mutants each killed, control missed, baseline
green first.

### 2026-09-24 — The answers read to the end of a stream that need not end

#### R98 · S1 · Five MCP clients that waited for the server to hang up

Every place this app reads an MCP server's reply did `await res.text()`.
For a reply sent as `text/event-stream` that resolves only when the SERVER
closes the stream, and the Streamable HTTP spec leaves that to the server:
once the response is sent it "SHOULD close the SSE stream". Should, not
must. A stream kept open — keep-alive comments, a proxy in between, a
server slow to tidy up — held the reader until its abort timer fired. The
answer, which had come back in milliseconds, was then lost. The failure
was reported as "The operation was aborted due to timeout", which names
neither the request nor the wait. Five doors read this way:

- **Deploy's handshake** in the MCP Builder: 15 s for `initialize`, whose
  timeout was swallowed and simply spent, then 15 s for `tools/list`, whose
  timeout failed the deploy and marked the running server **Error**;
- the Builder's **test console**, 60 s for `tools/call`. It had no
  try/catch, so the timeout was thrown at the page, which did not catch it
  either and stayed on its spinner for good;
- the public **`/api/mcp/s/<slug>` relay**, 60 s, then 502 to the client;
- **Test connection** for a registered MCP server;
- an agent's **MCP tool calls**, 15 s, through a third hand-written SSE
  parser that took the LAST `data:` line rather than the response.

It surfaced as an intermittent deploy failure on a stock FastMCP server,
the `HTTP Test` app, while this round was being scoped. The deploy
returned the timeout at 43.2 s, although the sandbox's own log had
answered `initialize`, `notifications/initialized` and `tools/list` by
25 s. That gap fits one
15 s wait on a `tools/list` stream that had already delivered its answer.
A batch of eight deploys of the same app then passed 8/8 (23–42 s, one of
119 s left undiagnosed), so on that server it is rare. A server that uses
the latitude the spec gives it makes it certain, and that is what was
driven.

**Driven, before the fix, with a server that keeps its streams open.** MCP
Builder → New server `R98 held stream`. Its source is a small Streamable
HTTP server that answers each request at once and then holds that
request's stream open for 90 s with a keep-alive comment every 5 s.

- **Deploy**, with `initialize`, `tools/list` and `tools/call` all held
  open. The sandbox logged `answered initialize` at 22:18:42.44 UTC. The
  next request came exactly 15 s later, at 22:18:57.44: the handshake had
  spent its whole `initialize` timer waiting for a stream that already held
  the answer. `answered tools/list` followed 2 ms later. The deploy
  answered after **49.1 s** with the toast `The operation was aborted due
  to timeout`, and the app was marked **Error** while its sandbox ran on.
- **Test console**, with only `tools/call` held open, so Deploy succeeded
  (`Deployed — 1 tool.`). Tools → `echo` → `{ "text": "r98 before" }` →
  Call echo at 02:22:10. The sandbox logged `answered tools/call` at
  22:22:09.175 UTC, 5 ms after the click. The server function came back at
  **61.2 s**, a thrown `The operation was aborted due to timeout`. The page
  never showed it: no output, no toast, and the button disabled on its
  spinner still, 50 s later and for good.

**After the rebuild** (container `1d2c788bbb32`), the same app, every
stream held open, and one case added so a real timeout can be seen: `echo`
with the text `never` gets no reply at all.

- **Deploy**: `Deployed — 1 tool.` in **15.1 s**, status Running. The
  sandbox answered `initialize` at 22:47:24.250 UTC; the next request came
  70 ms later, not 15 s; `tools/list` was answered at 22:47:24.322.
- **Test console**, `echo` → `{ "text": "r98 after" }`: `echo: r98 after`
  in **1.26 s**, with the sandbox still holding the stream open.
- **Test console**, `{ "text": "never" }`: the sandbox logged `stayed silent
  on tools/call`, and after **61.0 s** the console showed `Error:
  tools/call → no answer within 60s` with the button enabled again.
- **A stock FastMCP server that closes its streams** (`HTTP Test`):
  `Deployed — 2 tools.` in about 18 s, so nothing was lost for the common
  case.

The public relay, Test connection and agents' tool calls share the reader
and are held by the tests.

One reader now, `readRpcBody(res, maxChars?)` in the import-free
`mcpApps/sse.ts`. A JSON body is read whole, as before. A stream is read as
it arrives and let go the moment a complete event carries a JSON-RPC
response. The reader stops and cancels the stream there, releasing the
connection. "Complete" means the blank line that ends an SSE event, not
just the end of a line: a `data:` line whose JSON parses is still half an
event until then. A stream that closes without a response is parsed the
old way, so odd servers keep their fallback. The relay's size cap is now
applied while reading, so an endless stream cannot pile up in memory. All
five doors use the reader. The agents' hand-written parser is gone, with a
fallback kept for a stream sent under the wrong content type. The
handshake and the console name the step that ran out: `tools/list → no answer within
15s`. That is now true, because a timeout here means no answer came. The
console's server function answers its failures rather than throwing them,
and its page leaves the spinner in a `finally`.

**Tests:** 22. Twelve execute the reader against streams that never close:
it returns the answer, returns while keep-alives arrive, cancels the
stream, passes over a notification, waits for the blank line and not the
line end, reassembles CRLF split across chunks, joins multi-line data,
reads JSON whole, falls back on a closed stream with no response, and caps
an endless one. Two cover the failure wording. Eight are source-anchored:
one per door, the handshake naming its step, the console's catch and the
page's `finally`. 18 behaviour-changing mutants each killed, control
missed, baseline green first.

This also corrects the queue's "two timeouts that do not agree" note from
R89, which blamed this same message on a caller's patience being shorter
than the 90 s cold start. The only timer that produces it on that path is
the handshake's own 15 s, and what it was waiting for was the end of a
stream that had already answered.

### 2026-09-24 — The model calls that went round the rules

#### R97 · S1 · Five features that called a provider themselves

IAM's model access rules restrict a user or a group to an allow-list of
provider/model pairs, and the admin page promises what that means: in deny
mode a user "can call no models at all until a rule allow-lists them". They
are enforced at one door, `/api/chat`, and the design goes to some trouble
to make that door the only one: agents, swarms, the AI gateway, the AI
functions in SQL, document OCR and every headless run go through it,
including `internalChatText`'s internal channel, which reads the rules with
the service role for the owner. R96's sibling sweep asked whether anything
went round it. Five features did, each calling a provider directly and
asking nothing:

- the **ETL**, **lakehouse** and **skill** code generators, which take the
  provider and model from the request — and when none is given, fall back to
  the owner's default or to `openai/gpt-4o-mini`;
- the **knowledge-graph builder**, which sends every chunk to a fixed
  `google/gemini-2.5-flash`;
- **embedded BI's analyst**, which answers an anonymous viewer with the
  dashboard owner's model through its own private copy of the JSON call.

The generators' header states the design plainly: "model governance applies
through the same picker". The picker is the dropdown in the page. It
filters what it offers, but it starts unset, and an unset choice sends no
model at all — so the server's fallback was never offered to the rules to
refuse. A user restricted to one cheap model, clicking Generate without
touching the dropdown, got a pipeline written by a model the administrator
had not approved, on credentials the administrator may have restricted for
exactly that reason.

**Driven, with a model rule on this account, before and after.** Model
rules apply to superadmins in the default allow mode (only deny mode exempts
them), so the rule was put on this account: Admin → IAM →
Access → Model access → User → this account → OpenRouter `openrouter/free`
→ Add rule → Save rules. The door that was already guarded proved the rule
live: a chat request for `openai/gpt-4o-mini` from the same session came
back `403 model_not_allowed: Your administrator has not allowed
openrouter/openai/gpt-4o-mini for your account.`

Before the fix: ETL Pipelines → `Test2` (Code) → AI assist, the model
picker left as it opens (`OpenRouter · Server default`), a one-line brief →
Generate. `POST /api/etl/generate` answered **200** with a drafted pipeline
and `"model":"openai/gpt-4o-mini"` — the model the rule had just refused on
the chat path, called for a plain click on the page's default.

After the rebuild (container `3c3996a4c9ad`), the same pipeline, the same
brief, the same untouched picker, Generate: **403**, and the page's toast
`Your administrator has not allowed openrouter/openai/gpt-4o-mini for your
account. Ask a superadmin to adjust your model access.`, with nothing put
in the editor. With `openrouter/free` chosen in the picker, Generate again:
**200**, `"model":"openrouter/free"`. The rule was then removed and read
back as `No rules — this user is unrestricted`, and `Test2` was left with
its original code, nothing generated saved. The lakehouse and skill
generators, the graph builder and embedded BI share the fix and are held by
the tests. Recorded in docs/UI_TEST_RESULTS.md.

One question now, `modelAccessRefusal(userId, provider, model)`, read the way
`/api/chat`'s internal channel reads it and answering with the same
sentence. Each generator asks once the model is FINAL — after the fallback,
which is the whole point — and before the call, answering 403, or 503 when
the policy cannot be read rather than calling on a guess. The graph builder
asks about the model it will use before it wipes the graph it has, so a
refused build leaves the old one intact. Embedded BI asks the OWNER's rules
and closes when they cannot be read.

**Tests:** 9 source-anchored — the question and its sentence, each
generator asking after the fallback and before the call and refusing on an
unreadable policy, the graph builder asking before the wipe, embedded BI
asking before its call and closing; 10 behaviour-changing mutants each
killed, control missed, baseline green first.

### 2026-09-24 — The notebooks the runtime switch did not reach

#### R96 · S1 · Who asks the admin's runtime switches

Admin → Developer runtime has two switches that decide who may run Python
on a server kernel, and says what each does:

- **Enable server runtime** — "Allow Developer-workspace notebooks to launch
  server kernels." The page adds: "until you enable it, notebooks show a
  short 'runtime required' prompt instead of running."
- **Require an access grant** — "When on, only superadmins and granted
  users/groups (below) may start a kernel."

Two paths asked (`canUseRuntime`): the interactive kernel route behind the
Developer workspace, and MCP deploys. Three did not, and each runs, or
licenses running, a user's own notebook code:

- **a published notebook's API**, `POST /api/notebook/run` with an `nbk_`
  key, which calls `startSession` straight after checking the key;
- **a workflow's Notebook step**, which calls `startSession` straight after
  checking the notebook is the owner's;
- **minting the key** that publishes a notebook, which hands out a standing
  permission to start kernels without asking whether its owner has one.

`startSession` itself asks nothing — it is shared with platform sandboxes
that are not notebooks — so whatever a caller forgot, nothing caught. The
consequence is a governance control that covers the front door only. An
administrator who switches the runtime off, or restricts it to one group,
is told notebooks will not run; every workflow with a Notebook step keeps
running them, and every key a user ever minted keeps working for anyone
who holds it, including after that user's grant is revoked.

**Driven, the master switch with a superadmin, before and after.** The
grant half cannot be shown from a superadmin account, which bypasses it by
design, and a published notebook's key cannot be exercised without handling
a secret; both are held by the tests. The master switch applies to
everyone, so it was driven. A new workflow, `R96 notebook step`, with one
Notebook step running `My Python notebook`.

Before the fix: Admin → Developer runtime → **Enable server runtime** off →
Save settings, read back `false` after a reload at 00:01:20. The notebook
itself then showed `Server runtime required … That runtime isn't available
yet, so cells can't execute.` with no Run button. Workflows → `R96 notebook
step` → Run now: the host had no sandbox at 00:01:47, then
`nb-f2968348-31f8-4d03-8680-971ec7a3fd7e · Up 8 seconds`, created 00:02:12,
and the run ended `Showing run · succeeded` at 00:02:34, its step naming
session `f2968348` — the same notebook the workspace had just refused to
run, executed on a server kernel with the runtime switched off.

After the rebuild (container `a949a9bae152`), the same switch off, read
back `false` at 00:19:26, and the same Run now: `Showing run · failed` at
00:20:11, the step reading `The notebook step cannot run: The server
runtime is not enabled on this instance. An administrator can enable it in
Admin settings.`, the host still holding no sandbox at 00:20:17, and the
earlier `succeeded · 18 minutes ago` listed under it. With the switch back
on, read back `true` at 00:21:05, Run now again: `Showing run ·
succeeded` at 00:21:55. Recorded in docs/UI_TEST_RESULTS.md.

Every path that runs a user's notebook now asks one question,
`notebookRuntimeRefusal(userId)`, whose reasons come from a single pure
function: the disabled runtime first, whatever the grant says, then the
missing grant. The published API asks about the key's OWNER on every call
and answers 403 with which switch stopped it, before it counts a use or
starts anything; a workflow's Notebook step fails with the reason; minting
a key is refused to anyone the runtime would refuse. Platform sandboxes —
ETL, ML training and serving, Spark queries — are deliberately left alone:
they are not notebooks, and the switch does not claim them.

**Tests:** 7 — four behavioural on the reasons and their order, three
source-anchored on each path asking before it starts or mints, and the
published API's 403 naming the right switch; 9 behaviour-changing mutants
each killed, control missed, baseline green first.

### 2026-09-23 — The scheduler that waited for someone to look

#### R95 · S1 · Starting the in-process scheduler

Everything this platform does on a clock runs from one pass: BI refreshes and
data alerts, scheduled reports, prep flows, swarm schedules, ETL pipeline
schedules, catalog crawls, data monitors, SQL model builds, workflow steps,
audit retention, notebook-kernel reaping and lakehouse maintenance. On a
single instance an in-process 60-second scheduler drives that pass, and the
deployment guide makes the promise in so many words: "The in-process
scheduler runs automatically on a single VM — **no cron setup needed.** To
update: `git pull && docker compose up -d --build`."

It did not start automatically. `ensureScheduler()` is reached through one
route, `/api/bi/cron`, and the only regular caller of that route is the
header's notification bell, which pings it once when a signed-in page
mounts. So after every restart — a deploy, the very update command the guide
gives, a crash recovery, a host reboot — nothing on a clock ran until somebody
opened the app. The module's own header said the scheduler started "on
first request that imports this module"; it never did. And looking was the
cure: the Monitoring page's Scheduler card sits under that same header, so
an operator who opened it to check would find a healthy scheduler they had
just started themselves.

**Driven, with timestamps, so that looking could not spoil it.** Opening
any page starts the old scheduler, so both halves were run with every page
closed and read afterwards from times the app itself wrote down. A new
schedule on the `Approval durability check` swarm, `R95 heartbeat`, every
15 minutes, gave the clock.

Before the fix: the heartbeat ran at 22:33:48; the app was restarted at
22:35:12 and no page was opened; the heartbeat came due at 22:48:48 and did
not run; the hour boundary at 23:00, when every pass runs lakehouse
maintenance and logs it, produced no maintenance line at all, and the app
log held no model call after the restart. A page was opened at 23:03:27 and
the heartbeat ran at 23:03:53 — fifteen minutes late, 26 seconds after
someone looked. Recent runs showed it plainly: `started 13s ago` directly
above `started 30m ago`, nothing between.

After the fix (container `b9e14441145c`), with every page closed again: the
image was swapped in at 23:05:02 and at 23:05:38 all eight workers logged
`scheduler started`, seven with `catch-up pass left to another worker` and
one with `catch-up pass ran`. The heartbeat came due at 23:18:53, its model
call is in the log at 23:19:45, and its row reads `last 9/23/2026, 11:19:46
PM` — 53 seconds after it was due, and 87 seconds before a page was opened
at 23:21:13. Recorded in docs/UI_TEST_RESULTS.md.

Every worker now makes the bell's call itself as it boots — in-process,
through `app.fetch`, exactly as `server.mjs` already asks the app whether its
keyring loaded before taking traffic. The call carries
`AGENTSWARMS_BOOT_TOKEN`, 32 random bytes minted per boot before any worker
forks and known to nothing outside the process group; it buys one ordinary
pass, which is what any signed-in user's token already buys, and never the
forced pass reserved for the operator's `BI_CRON_TOKEN`. It is skipped when
`DISABLE_INPROCESS_SCHEDULER` hands scheduling to an external cron, it is not
awaited so the SIGTERM handler is in place for the whole of the pass, and it
says in the log what happened either way — including, when it fails, that
scheduled work will wait for the first signed-in page load, which was the
old behaviour and is now a stated fallback rather than a silent default.

**Ruled out on the way, and worth recording.** Two other suspicions about the
same scheduler did not survive measurement. (1) A graceful stop stranding the
cron lease for its ten-minute TTL: three restarts and recreates were timed
against the first minute after boot, when no new worker can hold the lease,
one of them fired the instant a probe saw another worker mid-pass — and
every time the first call after boot ran a pass. The pass finishes inside
srvx's five-second drain. The two ten-minute stalls seen earlier today while
waiting for schedules after rebuilds were this round's defect, not a lease:
nobody had opened a page. (2) Eight passes a minute from eight workers:
real, but `docs/SYSTEM_REQUIREMENTS.md` already states it ("per worker
unless the in-process scheduler is off"), so it is a documented cost, not a
defect.

**Tests:** 8 — four behavioural on who may run a pass (the external cron,
the boot call, a near-miss one byte short, unset tokens) and that only the
external cron forces one, four source-anchored on the token minted before
any fork, the in-process call and its opt-out, the pass not holding up
SIGTERM, and both failure branches saying what they mean; 9
behaviour-changing mutants each killed, control missed, baseline green
first. The first mutation run MISSED one: the test proved only that one of
the two failure messages explained itself. It now counts both.

### 2026-09-23 — The two exits that freed nothing, and a correction to R93

#### R94 · S1 · The sandbox that never started

R93 counted what the host had kept: 122 sandboxes that exited 0, 16 that
exited 1, and one in `created` that had never run at all. R93 claimed the
refresher now covers all of them. It does not, and the count says which is
which. This round is the other two exits.

`create()` makes the container and then starts it. When the start fails it
takes the container away again and throws the start's error — and that
teardown is the ONLY thing that will ever remove this container, because no
session row carries a ref to a sandbox that did not start, so neither the
refresher nor the reaper will ever hear of it. Its answer was discarded, in
the shape this survey keeps finding: `await this.stop(created.Id).catch(()
=> {})`. A cleanup that failed too left the sandbox on the host and told
only the start's half of the story.

MEASURED twice. The old one: `nb-4698447a-…`, created 18 September,
`StartedAt` still `0001-01-01`, on the host five days later. And a fresh
one, forced through the admin UI by asking for a GPU on a host that has
none: the job ended `docker start failed (500): failed to create task for
container …` and a new sandbox `nb-d8376a51-…` sat on the host in
`dead`, named nowhere.

The teardown's answer is now read, and the thrown error carries both
halves: what the start said and, only when the removal failed as well, that
a container is still on this host and has to be taken away by hand. The
start's own explanation is read BEFORE the teardown runs, so the cause is
in hand whatever the cleanup then does; the `catch` around the teardown
exists for the same reason, to turn an unexpected throw into a result
rather than let it replace the error that matters.

#### R94 · S2 · The sandbox that reported its own result, and what R93 got wrong

R93 said: "A kernel that ends ON ITS OWN only ever comes through
[`refreshSession`]". That is true of a kernel that dies — and false of
every batch sandbox that finishes properly, which is most of them.

A batch sandbox — an ETL run, a training worker, a prediction, a Spark
query — ends by POSTing its result to `/api/notebook/runtime/result`.
That handler writes the terminal status onto the session row and returns.
From that moment `refreshSession` returns at its first line and the reaper
skips the row, so R93's new teardown never sees it: the row is terminal
BEFORE any refresher looks. 122 of the 139 leftovers were `Exited (0)`,
which is exactly this.

It was caught by driving R93 rather than by reading: after that round
shipped, a real training run finished cleanly and its sandbox was still on
the host a minute later, with nothing in the log. The callback now takes
the container away once its row is terminal — last, after the ETL, ML and
Spark finalisations that read the same row, and with the logs already
stored on it, so there is nothing left in the container worth keeping —
and says what is left, and that nothing else will come looking, when it
cannot.

**With S2, the sweep is closed.** Every sandbox this platform creates —
ETL, lakehouse Spark, ML prediction, ML training, ML serving, MCP apps,
notebooks — is released through the shared runtime layer, whose teardown
sites are now all read: `create()`'s cleanup, `startSession`'s unrecorded
container, `stopSession`, R93's `refreshSession`, and this callback. The
only direct uses of the orchestrator elsewhere are `status()` and `logs()`,
which take nothing away.

**Driven, both exits, before and after.** The failure is forced honestly,
through the admin UI: `Training GPUs` set to 1 on a host with no GPU, so
the container is created and the runtime refuses to start it. Before the
fix, on the R93 container: ML Models → `threshold_probe (payment_rows)` →
Train new version → Train ended `failed`, its Jobs row reading only
`docker start failed (500): {"message":"failed to create task for
container: failed to create shim task: OCI runtime create failed…`, while a
new sandbox `nb-d8376a51-…` sat on the host in `dead`, named nowhere. And
the second exit, found by driving R93 after it shipped: a training run that
SUCCEEDED, `24m ago · succeeded · 84s · lightgbm · F1 (macro) 58.8%`, left
`nb-620c9267-… · Exited (0)` on the host nine minutes later, with nothing
in the log, because its row went terminal through the result callback
before any refresher could look.

After the rebuild: the same forced failure left the host unchanged, 139
sandboxes and no new one; `Training GPUs` was set back to 0 and saved, read
back from the server, and training worked again. Then the same training
once more, on container `7ec7707c988b`: `nb-96758b65-8b4c-4740-8fb4-524d4
bfbc4f9 · Up 18 seconds` while it ran, and gone the moment it finished —
zero rows for it, the list back to 140 — with the Jobs tab showing `2m ago
· succeeded · 59s · lightgbm · F1 (macro) 58.8%` above the older
`24m ago · succeeded · 84s` whose sandbox is still there. Same training,
twice, minutes apart, both successful: one leaves a container, the other
does not. The sentence a FAILED removal adds is held by the tests; the
removal worked on both of this host's attempts, and a DELETE that fails is
not something a browser can arrange. Recorded in docs/UI_TEST_RESULTS.md.

**Tests:** 8 source-anchored — the order the start's body is read, the
teardown's answer, the sentence a failed removal adds and its absence when
the removal worked, the callback reading the container back, tearing down
after the finalisations, and what it says when it cannot; 9
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-23 — The sandbox nobody removed

#### R93 · S1 · The kernel that ended by itself

A notebook kernel, a batch job and an MCP service each run in a sandbox the
app creates and is supposed to take away again. A sandbox can end two ways,
and only one of them removed anything.

`stopSession` stops the container and removes it. It is reached from
`reapSessions`, which selects sessions whose status is still LIVE — idle
past their TTL, or past `expires_at`. That is the path for a sandbox
something decides to end.

The other way is the sandbox ending on its own: the kernel exits, the batch
job finishes, the service process dies. Nothing calls `stopSession` then.
`refreshSession` notices — `st.state` comes back `succeeded`, `gone` or
`error` — writes the terminal status onto the row and returns. The
container is left standing, and the moment that row stops being LIVE it is
invisible to the only cleanup there is, for ever.

MEASURED on the development host this was found on: `docker ps -a` listed
139 `nb-…` sandboxes, 122 of them `Exited (0)`, 16 `Exited (1)` and one
`Created`, the oldest thirteen days old — while the reaper ran on every
cron pass throughout. It surfaced sideways, from looking at the host during
an unrelated memory complaint; nothing in the app says a word about it,
which is the point. The cost is not memory — the leftovers are stopped
and hold none — it is an inventory that grows without bound on every
host that runs a kernel, and an operator's `docker ps -a` that stops being
readable.

The second half is the path that DOES remove. Its answer went in the bin:
`dockerFetch` RESOLVES with the Response, so the `.catch(() => {})` around
the DELETE only ever saw a transport failure, and a 409 or a 500 was
silently a job well done. The kubernetes backend had the same shape, where
a 403 from a namespace the service account may not delete in read as a
clean teardown.

So `stop` now answers `{ removed, error? }` instead of `void`; both real
backends read their DELETE and count 404 as gone, because somebody else
getting there first is the goal, not a failure; `refreshSession` removes
the sandbox when it writes a terminal status, taking the failing kernel's
logs first, since removing the container is otherwise the same act as
destroying the evidence of why it failed; and both callers say what is left
behind when a removal does not happen — a live session's stop says the
sandbox is "still on the host, still holding its CPU and memory", which is
the sentence the caps and the operator both need.

**Driven, from the notebook that owns the sandbox.** The before half is the
host itself, measured above: 139 sandboxes nothing points at, accumulated
over thirteen days while the reaper ran on every cron pass. After the
rebuild (container b454b7c4aaaa): Developer workspace → `My Python
notebook` → Run on the pure-Python cell, which answered `mean: 500 ms`,
`p50: 300.0 ms`, `max: 1450 ms`, `'2 slow calls out of 8'` from the server
kernel, and put `nb-0d2e5be3-7f30-45f0-84a6-bf4aa4d4dc3b · Up 16 seconds`
on the host, 140 in the list. Then a cell that ends the sandbox ON ITS OWN
— `import os, signal; os.kill(1, signal.SIGTERM)` — which answered
`gateway closed the connection (code 1005)` in 553 ms and left
`nb-0d2e5be3-… · Exited (0)` sitting there, because the app had not looked
yet. Reopening the Developer workspace is what makes it look, and that
removed the container: gone from `docker ps -a`, the list back to 139.
Under the old code the same reopen wrote `stopped` onto the row and left
the container, which is exactly how the other 139 got there. They stay —
their rows went terminal long ago, so the refresher returns before
reaching them — and have to be removed by hand. Recorded in
docs/UI_TEST_RESULTS.md.

**Tests:** 6 source-anchored on the contract, both backends' DELETE, the
terminal-status teardown, the logs taken before it, and the live stop's
report; 8 behaviour-changing mutants each killed, control missed, baseline
green first.

### 2026-09-23 — The run that was resumed somewhere else

#### R92 · S1 · The parked run's record

`executeSwarmServer`'s `resume` option says what it is for, in its own
words: "the caller supplies the existing run id (so the timeline continues
rather than forking)". The id arrives, is used to load the checkpoint, and
then stops. The tracer that writes `swarm_runs` was never told about it,
so every resume INSERTED a second run row and nothing ever closed the
first.

Four things follow, and all four are visible without looking at the
database.

The parked run is never closed. MEASURED: the swarm gallery's Recent runs
tab listed `Approval durability check (schedule) — Running — 34m 59s`,
with a live duration and a Cancel button, thirty-three minutes after its
approval had been granted and the work had finished. Four such rows sat in
that list from one session's driving.

Its headline numbers are zeros. A run that parks is stamped `suspended`
without calling the tracer's `finish` — deliberately, since it is not over
— so its totals are still the zeros it was inserted with. MEASURED: run
`3bf09de5` reads `suspended · STEPS 0 · ERRORS 0 · DURATION 0ms · COST
$0.0000` above its own timeline, which lists `Request 107ms`, `Summarise
for the approver 9927ms · 76/495 tok` and `Human approval 339ms`. Nothing
would ever have written those totals, because the run that could have
finished it was a different row.

That row is the second one, and it is named for the wrong thing. MEASURED:
run `7f9912e2`, `Approval durability check (schedule) (api) · success · 3
steps · 3919ms`, holds the half the approver released — under the source
of the RESUME rather than of the run, with the swarm's cost and step count
split across two records that nothing links.

And the parked row keeps its checkpoint. The end of a run clears the
checkpoint for the id it is running under, which was the new one; the old
one's row stayed. Combined with R90's gate — which refuses only a run
that is `success` or `error`, then asks for the checkpoint — the same
approval could be resumed a second time, and the whole remainder of the
swarm would run again.

The id now reaches the tracer. A resume reopens the run it was given,
carries its steps, its edges and its numbers, and leaves the step it
parked on exactly as it was recorded, so nothing is counted or drawn
twice; `finish` then closes the run everyone was already looking at. When
the row cannot be reopened the resume still records its work, under a new
id, and says that is what happened and what it leaves behind. The decision
row is not opened a second time either: it carries the run's id, so a
resume would be writing the same row.

**Driven, before and after, on the same page.** Before the fix, on the R91
container: the gallery's Recent runs tab held `Approval durability check
(schedule) · Running · started 34m ago · 34m 59s`, still offering Cancel,
directly under the `(api) · Success · 5s · 3 steps` row that held the work
its approver had released half an hour earlier. Opening the Running one
gave run `3bf09de5`, `suspended · STEPS 0 · ERRORS 0 · DURATION 0ms · COST
$0.0000`, three lines above its own timeline of `Request 107ms`,
`Summarise for the approver 9927ms · 76/495 tok` and `Human approval
339ms`; the other row was run `7f9912e2`, `success · 3 steps · 3919ms ·
75/1 tok`. After the rebuild (container 693a0ae3a632) a fresh schedule
parked the same way — bell `Pending approvals (1)`, run `c4a3f7bb`
`suspended · STEPS 0 · DURATION 0ms` — and Approve closed THAT run: the
same url reloads as `success · STEPS 5 · ERRORS 0 · DURATION 42818ms ·
TOKENS IN 155 · TOKENS OUT 948 · Data flow (4)`, its timeline listing five
steps once each and the final output, and the gallery showing one row,
`Success · 1m 56s · 5 steps`, with no `(api)` twin and nothing left
Running. The arithmetic checks: 115 + 37493 + 343 + 4656 + 211 ms is the
42818 ms reported, and 85 + 70 / 947 + 1 are the 155 and 948. Recorded in
docs/UI_TEST_RESULTS.md.

**Tests:** 7 source-anchored on the reopen, its failure message, the
carried steps, edges and totals, the still-open step, the three
do-not-record-twice guards and the executor's half of the promise; 8
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-23 — The switch that meant the opposite of its label

#### R91 · S1 · The Deploy dialog's warning about approval steps

A swarm with a human-approval step, deployed to an API key or a schedule,
runs with nobody watching. One switch decides what happens when such a run
reaches the gate, and the dialog's amber warning was the only place its two
positions were explained:

> Leave **Reject approvals** ON (the default) and those runs stop safely at the
> gate. Turning it OFF makes the swarm **auto-approve** every approval step —
> your human oversight is bypassed.

Both halves are wrong, and the second is the dangerous one. With the switch
ON the executor throws at the gate: the run stops at the step, ends as an
`error`, and nobody is ever asked. With it OFF the run parks — it writes a
checkpoint, is marked `suspended`, and the request goes into the approvals
bell for a person to decide. OFF is the setting that preserves human
oversight; ON is the setting under which no human ever sees the request.

The copy is a survivor of an older executor, and the repo still says so.
The shipped `Approval durability check` template's own notes read: "Before
checkpointing existed there was nothing to park: an unattended run could
only auto-approve or fail." Checkpointing landed; this warning did not
move.

The consequence is a governance control read backwards. An operator who
wants a person to sign off on scheduled runs is told that the position
which asks a person bypasses their oversight, so they leave it ON — and
the approval gate they installed becomes a wall that fails every run
reaching it, with nothing in the bell to show for it. The one who wanted
fail-closed gets it, but is told it is "safe" rather than "errored", which
is what the schedule's own row will say.

The executor says the true version in the error it throws, and this very
dialog displays it: a schedule with the switch ON reports `Stopped at
human-approval step "Human approval": ... turn off "Reject approvals" ... the
run will then park here and resume when someone approves it` in the list of
schedules, an inch below the warning claiming the opposite. The warning now
says what the executor does, in the executor's terms, and adds what a
caller needs: a parked run answers with `status: suspended` and no output,
so an integration that wants its answer in one call should keep the switch
ON deliberately. The evaluations note in the swarms docs carried the same
stale belief — "unless the swarm is safe to auto-approve in a batch" —
and was corrected with it; the eval runner itself has handled a parked case
by name since it was written.

**Driven, both positions, before and after.** On the R90 container: the
Deploy dialog for `Approval durability check` showed the old warning, and
two schedules were added to the same swarm, one per switch position. The
sweep answered for both: `R91 reject probe` (switch ON) `last 9/23/2026,
2:27:25 AM · error`, and printed under it, in the same list, the
executor's own contradiction of the warning above it — `Stopped at
human-approval step "Human approval": this run has nobody to approve it.
That is the safe default. To let this swarm wait for a real decision, turn
off "Reject approvals" on the API key or schedule — the run will then park
here and resume when someone approves it.`; `R91 park probe` (switch OFF)
`last 9/23/2026, 2:27:44 AM · suspended`, with `Pending approvals (1)` in
the bell, one request, which Approve carried to `All caught up`. Neither
position approved anything on its own: ON asked nobody, OFF asked a
person. After the rebuild (container b645e0532188) the dialog shows the
corrected warning, `/docs/swarms` the corrected evaluations note, and a
second pair of schedules answered the same way — `R91 reject probe
(after)` `2:59:13 AM · error`, `R91 park probe (after)` `2:59:25 AM ·
suspended` and its approval resumed. The behaviour did not change in this
round; only the words that describe it did. Recorded in
docs/UI_TEST_RESULTS.md.

**Tests:** 8 source-anchored, pinning each clause of the warning against
the executor's own gate and message, and the docs note against the runner;
5 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-23 — A decision that resumed nothing, and said it had

#### R90 · S1 · The parked swarm run

A headless swarm run that reaches a human-approval step parks: it writes
a checkpoint, marks its run `suspended`, and inserts an approval row so
somebody is asked. Two of those three writes dropped their answers, and
the consequences compound.

The approval insert sat in a `try/catch` a supabase answer never reaches
(R86's shape), so a failed insert was not even the warning its own
comment promised: the run parked, the inbox stayed empty, and nothing
anywhere said why nobody had been asked. The suspended stamp dropped its
error, leaving the row on `running` — which on its own is the familiar
badge that outlived its state. But the approval path then read that word:
`if (run.status !== "suspended") return { ok: true, … }`, with a comment
calling it "a second click, or a run that was already resumed". So a run
whose stamp had failed swallowed the approver's decision, resumed
nothing, and answered ok. The work stayed parked for ever, the person was
told it was fine, and the one path that could have resumed it had decided
it did not need to.

The insert now reads its answer and says that nobody was asked and the
run keeps its checkpoint. The stamp is retried once and, failing twice,
said with what it leaves. And the resume no longer gates on the word: it
refuses only a run that is `success` or `error`, then asks for the
CHECKPOINT, which is what a resume actually needs — a run with none
really was resumed already, and a run with one resumes whatever its
status column says.

**Driven, both halves, end to end.** Before the fix, on the R89
container: Swarms → Library → `Approval durability check` → Load
template → Save; its Deploy dialog → Schedules → a daily schedule with
the template's refund request and "Reject approvals" off; the server's
sweep parked the run — Observability `Approval durability check
(schedule) · suspended`, the bell `Pending approvals (1)`, the approval
reading `Human approval paused · MEDIUM · Approve this request · Refund
request #4821 … Biggest risk: refunding without damage verification may
enable a false claim.` — and Approve resumed it: `Human approval is
resuming.`, the run `success · 3 steps · 0 errors · 3534ms`. After the
rebuild (container `8668f6fb8012`) a second schedule, the same sweep, the
same park, and Approve resumed it in 3728ms. All three writes report
themselves as before. The failure halves — an approval nobody was asked
for, a stamp that did not land, and the decision that used to be
swallowed as a duplicate click — cannot be produced from the browser
against the server executor, and are held by the tests. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 5 source-anchored on the insert's answer, its message, the
stamp's retry, the checkpoint gate and the no-checkpoint case; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — "Running" over a server that died, and a deploy whose tools nobody wrote down

#### R89 · S1 · The MCP app's records

`mcpApps/service.server.ts`, five writes with their result dropped, and
each one is read by something that matters. `setAppStatus` is written by
every path that ends a start — the per-user limit, the instance cap, a
container that died, a start that timed out, a success, a stop — and its
column is what MCP Builder shows. Dropped, the two failures are opposite
and both bad: a server that DIED left the app on `ready`, so the page
said Running over nothing; a server that came up left it on its previous
status, so the page said Error over a server answering requests. The
deploy's own record is worse: the server is up and its tools are known,
and that update is the only place they are written down. Dropped, the
deploy answered ok with the new tools while the app kept the PREVIOUS
tool list, which is the one agents call — a deploy that changed what the
server exposes left every caller on the old contract, silently.
`snapshotVersion` adds the row a rollback reads; `persistLogs` saves the
container's last output, which is exactly what the start-timeout message
tells the owner to go and read; and `touch` feeds the idle reaper.

Each now reads its answer. A status that could not be written says what
the page will go on showing. A deploy whose tools could not be recorded
answers as a failure — "The server is running, but its tools could not be
recorded: …. Agents keep calling the previous tool list until they are —
deploy again." — instead of reporting the new tools. A version the
history could not take is said as one that cannot be rolled back to, the
logs as a Logs tab that will be empty for this attempt, and an unrecorded
use as what the reaper will see.

**Driven.** Before the fix, on the R88 container: MCP Builder → `HTTP
Test` → Open, the app `Stopped` → Deploy — after about 90 s `The
operation was aborted due to timeout` and the app `Error`, while its
sandbox `nb-dbc29e1c…` was up and finished starting moments later;
Deploy again — after 33 s `Deployed — 2 tools.` and the app `Running`
with `Stop` beside it. That second deploy drives the whole chain this
round guards, and every write landed. After the rebuild (container
`00a64721c026`) the same deploy: `Deployed — 2 tools.`, the app
`Running`. What a failure now says is held by the tests, a failed
database write not being producible from the browser against the MCP
service. The first attempt's `Error` over a server that came up is a
mismatch between the request's patience and the server's 90-second
cold-start budget, not a dropped write; it is queued as its own
candidate. Recorded in [UI test results](./UI_TEST_RESULTS.md).

**Tests:** 5 source-anchored on the status write, the deploy's record and
its early return, the version history, the touch and the logs; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — One conversation's transcript, under another conversation's name

#### R88 · S1 · Agent Chat across a selection change

The class R76 opened, swept to the page where it costs the most. Agent
Chat keys two lists on a selection: the conversations on the chosen
agent, the messages on the chosen conversation. Neither was cleared when
its key changed. Picking another conversation left the previous one's
messages on screen, under the new conversation's name and its highlight,
until the new read landed — and when that read FAILED, the early return
after the toast left them there for good. Driven before the fix: the
second conversation selected and highlighted, `Could not load this
conversation's messages: TypeError: Failed to fetch`, and the first
conversation's thirteen messages still on screen, ten seconds later,
reading as this conversation's transcript. A reply typed into that state
goes to the conversation the sidebar highlights, not the one the page is
showing. The same on the agent side: the previous agent's conversation
list stands under the new agent's name.

Picking an agent now clears its predecessor's conversations, picking a
conversation clears its predecessor's messages, and a read that comes
back for a selection no longer on screen is dropped — so a slow read
cannot overwrite a newer one. Both loaders mark their list read on the
failure path too, and the message area says "Loading this conversation…"
instead of the empty state that invites a first message over rows it has
not read.

**Driven.** Before the fix, on the R87 container: Agent Chat → `Sample ·
Graph RAG Explorer (Acme Corp)` → the conversation `Make a 2-slide
PowerPoint…`, 13 messages; then the second conversation `List my data
tables…` with every `GET /rest/v1/messages` rejected — 2.5 s in, the same
13 messages under the second conversation's highlight; 11 s in, the toast
`Could not load this conversation's messages · TypeError: Failed to
fetch` and still those 13 messages. After the rebuild (container
`bc6e32cc54f1`), the same rejection: 2.5 s in, nothing listed and a
`role="status"` line `Loading this conversation…`; 11 s in, the same
toast over an empty transcript and the page's own invitation. The
selection and the transcript agree. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 7 source-anchored on the two clears, the two late-read guards,
the failure path's mark and the loading state; 5 behaviour-changing
mutants each killed, control missed, baseline green first.

### 2026-09-22 — A prep flow that doubled its dataset, and called it a success

#### R87 · S1 · The prep flow's rebuild

`bi/prep.server.ts` materialises a flow's output into a dataset:
snapshot the previous rows for the version history, delete them, write
the new schema, insert the new rows. Three of those four read their
answer. The delete did not. A delete that failed left the old rows in
place and the insert below appended the new ones beside them, so the
dataset came out DOUBLED — every sum, count and average over it wrong, on
every chart and every agent question that reads it — under a flow that
reported success and a version snapshot that said the rebuild had
happened. Nothing downstream recomputes a row count, so nothing would
ever have caught it. This is the same rule R82 wrote for lineage — the
insert must wait for the delete's answer — with rows instead of edges,
and the consequence is not a wrong graph but wrong numbers.

The same file's incremental refresh replaced rows inside a guarded delete
and insert and then set the dataset's column list in a write whose error
went unread, so a renamed column would be described by its old name for
every reader; and its semantics writes sat in a catch a supabase answer
never reaches (R86's shape).

The rebuild's delete now stops the write: "The dataset's previous rows
could not be cleared: …. Nothing was written, so <name> still holds the
rows it had." — the dataset is left exactly as it was rather than
doubled. The incremental refresh fails with what is where. The semantics
write reads its answer and says the data is there and the descriptions
are not.

**Driven.** Before the fix, on the R86 container: BI Workspace → Data
preparation → `Summary data`, output set to `r87_prep_probe` → Run & save
dataset — `Saved "r87_prep_probe" with 9,992 rows`; run again, the
rebuild branch — the same toast; Data Catalog → `r87_prep_probe · 3
columns · 9,992 rows · 81.6 KB`, replaced rather than appended. After the
rebuild (container `04cfed91a5fc`) the same two runs and the same 9,992
rows. That second run is the path this round guards: snapshot, delete,
schema, insert. Its delete landed both times, so the count held; had it
failed, the same success toast would have stood over 19,984 rows and
every figure read from the dataset would have doubled — which is what the
tests now hold, a failed database write not being producible from the
browser against the prep service. The probe dataset was deleted
afterwards through the impact dialog. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 3 source-anchored on the delete's throw standing between the
delete and the insert loop, the schema failure, and the semantics answer;
4 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — A swarm run that finished and stayed "running", under four catches that never caught anything

#### R86 · S1 · The swarm run's trace

`observability/serverTracer.server.ts` writes the whole of what the
Observability page shows: a run row, a step row per node, an edge row per
hop, and the run's close with its totals. All four sat in
`try { … } catch { /* best-effort */ }` — and a supabase call answers with
its error rather than throwing, so those catches never caught anything.
Every one of the four was unconditionally silent. The step insert was the
compounding one: read back only for its id, a failed insert left no id in
the map, and the `if (!stepId) return` below then dropped that step's
outcome, while its edges were written with a null endpoint. And the close
is the R75 shape again: a swarm that had finished stayed `running` on the
Observability page for ever, with no final output, no step count, no
tokens and no cost.

Each write now reads its answer and says what the trace will be missing:
a step that could not be recorded, an outcome that leaves a step showing
as running, an edge the graph will not draw. The run's close is retried
once — the run is over, so there is nothing to race — and, failing twice,
said with the run, the outcome and "It will show as running until it is
closed." The catches stay, for what can still throw.

**Driven.** Before the fix, on the R85 container: Swarms → `Embed E2E
Mini Swarm` → Open → Run with "Write one sentence about why a run record
must say what happened." — the trace filling live, then `235 tok ↑115
↓120 ~$0.0001`; Observability `8 swarm runs` with the new row `success ·
4 steps · 0 errors · 9219ms · 115/120 · $0.0001`, and its trace `STEPS 4
· ERRORS 0 · DURATION 9219ms`, four steps and `Data flow (3)`. After the
rebuild (container `9571f511504a`) the same run: `9 swarm runs`, `success
· 4 · 0 · 10937ms · 119/126 · $0.0001`, four steps and three edges again.
All four write kinds are on that page and all four land. What a failure
now says — a step that could not be recorded, an outcome that leaves a
step showing as running, an edge the graph will not draw, a close retried
once and then said — is held by the tests, a failed database write not
being producible from the browser against the tracer. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 source-anchored on the step insert, the step's outcome, the
edge and the close's retry; 5 behaviour-changing mutants each killed,
control missed, baseline green first.

### 2026-09-22 — A schedule whose next run never moved, and an alert that fires again on every check

#### R85 · S1 · The BI schedule's clock and the alert's edge

`bi/refresh.server.ts`, four writes with their result dropped, and the two
that matter carry state nothing else recomputes. An alert's `last_state`
is not a display column: it is the edge that decides whether a person is
told. Checked and triggered, the alert notifies and then writes
`triggered` — and that write's error was dropped, so a failure left the
state on its previous value and the same alert was sent again on the next
check, and the one after that, for as long as the write kept failing. The
"could not be evaluated" branch did the same with `partial`. Worse, the
schedule's stamp carries the CLOCK: `last_run_at`, `last_status` and
`next_run_at` in one write. Dropped, a refresh that ran left `next_run_at`
in the past, so the next sweep — a minute later — refreshed the whole
dashboard again, and the one after that: a refresh loop, paid for in
warehouse queries, with nothing on the page to say why. And in
`bi/versions.server.ts`, restoring a version replaced the rows under a
guarded delete and insert and then set the dataset's column list in a
write whose error went unread, leaving exactly the state its own comment
forbids — this version's rows under the previous version's columns —
reported as a restore that worked.

The alert's state writes now say what a failure means for the next check,
naming the alert and the dashboard. The schedule's stamp is retried once
and, failing twice, logged and told to the owner: "The dashboard
refreshed, but the schedule still says it is due: …. It will keep
refreshing every sweep until the schedule can be written." The prep
flow's stamp says what the page will go on showing. And the restore fails
with what is where: "The table now holds this version's rows under the
previous column list — restore it again."

**Driven.** The three writes this round guards are made by the cron
sweep and by a restore: the alert's state and the schedule's clock are
written only by `processDueSchedules`, and no dataset in this account has
a version to restore. What the browser reaches is the surface they drive,
and it is unchanged by the fix. Before, on the R84 container: BI →
dashboard `db14d61a…` → "Scheduled refresh & data alerts" — `Scheduled
refresh` off, the rule's wording `notifies once when it trips and re-arms
when the condition clears`; Data Catalog → Local tables → `snow_prepared`
— `VERSION HISTORY — No previous versions.` After the rebuild (container
`1edfd98ba6c9`), both the same. Every failure path — an alert that would
fire again, a schedule that would refresh again, a restore under the
previous column list — is held by the tests. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 5 source-anchored on the two alert states, the schedule's retry
and its notice, the prep flow's stamp and the restore's failure; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — "Recovered", over an incident still open, and an alert with no incident at all

#### R84 · S1 · The data monitor's records

The survey's next single-site file, `dataMonitors/run.server.ts`. A check
runs, writes its run row — that one insert reads its error — and then
stamps the verdict on the monitor itself, which did not: the run said
`alert`, the monitor's own row went on saying what the previous run had
said, and the page, and anything gating on `last_status`, read the table
as fine. Below it `reconcileIncident` made three writes and read none of
their answers. An alert with no open incident inserted one and read the
row back only for its id, so a failed insert meant an alert with no
incident anywhere and an owner told of one. An alert with an incident
already open extended it — occurrences, last seen, last message —
silently. And a passing check resolved the open incident and told the
owner "Recovered: <name>" whether or not the resolve landed: the
incident stayed open on the page, repeating, while the person had been
told it was over.

The verdict's stamp now reads its answer, says what the monitor will go
on showing, and hands the failure back to the caller as `recordError`. An
incident that could not be opened is said in the audit detail and in the
notification itself — the alert is real either way, so the message goes
out, carrying "the incident could not be recorded: …". An extend that
failed is said. And a resolve that failed no longer says "Recovered": the
notification's title becomes "Recovered, incident still open: <name>"
with the reason, and the audit entry carries it.

**Driven.** Before the fix, on the R83 container: Data monitors → the
alerting monitor `revenue_facts · negative net rows`, its open incident
`seen 16 times · last 6m ago` → Run now — toast `Value 2 is above the
maximum of 0.` and, two seconds later, `seen 17 times · last 1s ago`.
After the rebuild (container `fe257b08f644`) the same: `seen 17 times ·
last 23m ago` → Run now → `seen 18 times · last 1s ago`. The two writes a
still-failing check makes — the monitor's verdict and the incident's
extension — report themselves as before. The resolve path needs the table
to pass, which means changing the data under it, so the "Recovered,
incident still open" title and the failed-open notification are held by
the tests, along with every write that fails: a failed database write
cannot be produced from the browser against the monitor runner. Recorded
in [UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 source-anchored on the verdict's stamp and its return, the
extend, the open and its notification, and the resolve's title; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — A build that finished and stayed "running", and an "edited" badge that outlived the build of that edit

#### R83 · S1 · The SQL model build's records

The survey's single-site files begin with the one R60 lives in,
`sqlModels/run.server.ts`, 4 writes with their result dropped. The run's
close dropped its error: a build that had finished — models built, tests
run — stayed `running` on the SQL Models page for ever, with no outcome
and no per-model results to read. `stampModel` dropped two: the model's
`last_status` stamp, so its badge stayed on the PREVIOUS build's outcome,
and the clear of `definition_changed_at` — the "edited … not built since"
mark R60 added — so a model could show as edited and unbuilt over a build
that had just been made of that very definition, the mark lying the other
way from the one R60 fixed. And `writeLineage` deleted the models' edges
and inserted the new ones inside a try/catch that a supabase answer never
reaches: a failed clear drew the new graph beside the old, a failed insert
left it partial, and neither was said.

The run is closed with one retry and, failing twice, said with the run,
the outcome and what the page will go on showing — the R75 shape. The
model's stamps return what they could not write, and the build's own
result carries it: "Built, but the model's record could not be stamped:
…; the page shows the previous build until it is." and "The edited mark
could not be cleared: …; the model shows as edited, not built since, until
the next build." Lineage follows the R82 rule: a failed clear stops the
rewrite and says the old edges stand; a failed insert says the graph is
partial.

**Driven.** Before the fix, on the R82 container: SQL Models →
`stg_revenue` → Build this and what it reads — `Built 1 model`, and the
run on top of Builds as `success · manual · 1m ago · 60.6s · stg_revenue
built 836 rows`. After the rebuild (container `56d9a5952a68`) the same
build, then the round's own pair: the SQL edited by one newline and saved
— `edited 1s ago · not built since`, `last build, of the previous
definition: built · 836 rows · 1m ago` — and built again, after which the
edited mark is gone and the header reads `built · 18s ago · 836 rows`.
Both stamps R83 guards are driven there: the model's outcome, and the
clear of R60's mark by the build of that very edit. The defect half — a
run left "running", a badge left on the previous build or on "edited", a
graph drawn beside what could not be cleared — is held by the tests, a
failed database write not being producible from the browser against the
model runner. Recorded in [UI test results](./UI_TEST_RESULTS.md).

**Tests:** 3 source-anchored on the close and its retry, the stamps and
the build's result, and the lineage rule; 5 behaviour-changing mutants
each killed, control missed, baseline green first.

### 2026-09-22 — A crawl that succeeded and left its source "crawling", and a graph drawn over what could not be cleared

#### R82 · S1 · The catalog crawl's records

The server-side write survey's last multi-site file, `catalog/crawler.server.ts`,
6 writes with their result dropped, and the ETL run's lineage delete that
R78 left for it. `runCrawl` marked the source `crawling`, crawled, wrote
the assets, and then dropped the error of marking it `ready`: the assets
were in the catalog, the crawl answered its stats, the page said
"Crawled … 21 assets", and the row stayed `crawling` — refusing every
later crawl as "already running". `persistAssets` reported the stale rows
removed before deleting them and dropped the delete's error, so the
catalog went on listing tables the source no longer had under a crawl
that said it had taken them out. `persistLineage` deleted the previous
edges and inserted the new ones, reading neither answer: a failed delete
drew the new graph beside the old one, a failed insert left it partial,
and the crawl's catch swallowed both as "optional". The ETL run cleared
its pipeline's lineage the same way before re-inserting it; the schema
records that drift is judged against went unread too.

The source is now marked ready with one retry and, failing twice, the
crawl fails with the reason — "Crawled N asset(s), but the source could
not be marked ready: …. It will show as crawling until it is — crawl
again." — so the row says what happened rather than what is not
happening. Stale assets are claimed removed only once they are, and a
delete that failed fails the crawl. Lineage is never written beside what
could not be cleared: a failed clear stops the rewrite and says the old
edges stand, a failed insert says the graph is partial, and the crawl's
catch says why instead of nothing. The ETL run's lineage follows the same
rule, and its schema records read their answers.

**Driven.** Before the fix, on the R81 container: Data Catalog → `Lakehouse
catalog` → Re-crawl — a spinner on the source, the asset list growing as
the crawl wrote, and 85 s later `Crawled "Lakehouse catalog" — 21 assets,
184 columns · 11 added`, the spinner gone. After the rebuild (container
`d218d394edca`) the same re-crawl: 23 s later `Crawled "Lakehouse catalog"
— 21 assets, 184 columns`, the source `ready`. A crawl whose writes land
reports itself as before; the defect half — a source left "crawling" over
a crawl that succeeded, stale assets claimed removed, a graph drawn beside
what could not be cleared — is held by the tests, a failed database write
not being producible from the browser against the crawler. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 source-anchored on the stale claim, the lineage rule on both
paths, the ready mark and its retry, and the crawling and error marks; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — "Promoted", by the API and the schedule, whatever the three writes did

#### R81 · S1 · The promotion the API and the schedule make

R73 fixed the page's promotion: five writes, each read, in the order a
failure part-way leaves least — stage, pointer, archive. The survey's next
file, `ml/api.server.ts`, holds a second promotion, `promoteVersion`, used
when a version is registered from outside through the ML API and when a
scheduled retrain judges its candidate better: the same three writes in
the old order — archive, stage, pointer — and every error dropped. A
promotion that failed at the pointer left the model serving nothing with
its old version already archived; one that failed at the stage left the
model pointing at a version not marked production; and either way the API
answered `201` with the version, and the schedule wrote `promoted` and
told the owner "v N is now in production".

The API-path promotion is now the guarded one: it reads the version and
hands it to `applyPromotion`, answering as that went. A registration whose
promotion failed still registers the version and says so — `promoted:
false` and `promotion_error` in the API's answer. The schedule reads the
answer: `last_status` says `kept`, `last_error` carries the reason, and
the owner is told "v N trained, but could not be promoted" with it; the
schedule's own verdict write reads its answer too.

**Driven.** Before the fix, on the R80 container: `revenue_facts · groups`
→ Automation → `Nightly retrain · promote when better` → Run now —
`Training started`; the schedule `kept 4m ago`; the bell `"revenue_facts ·
groups" v25 trained; production kept · silhouette: 0.2490 vs production
0.2490 (not better)`. After the rebuild (container `09f1a7bb3de1`) the
same: `Training started`, Versions (26), the schedule `kept 2m ago`, the
bell `v26 trained; production kept … (not better) · just now`. A verdict
whose promotion is not attempted, or whose writes land, reports itself as
before; the defect half — a promotion that failed part-way said as made,
on the API and the schedule — is held by the tests, a failed database
write not being producible from the browser against a server function,
and the API path needing a key and an artifact these rounds never mint.
Versions v25 and v26 are kept as candidates. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 3 source-anchored on the delegation and its answer, the
registration and the route, and the schedule's verdict and notification;
4 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — A container the session never learned of, and a stopped one whose row stayed live

#### R80 · S1 · The sandbox session's own record

The server-side write survey reaches the file under every ML endpoint,
training worker, ETL run and notebook kernel: `notebookRuntime/service.server.ts`,
7 writes with their result dropped. `startSession` created the container
and then wrote its ref onto the session row without reading the answer. A
write that failed left a container running that its row did not know:
`stopSession` stops by the ref, `refreshSession` returns early without
one, the reaper's stop is a no-op — a sandbox nothing could reach, under a
row that stayed live and counted against the caps. R77, R78 and R79 each
guarded their own record of a session; this is the record they all rest
on. `stopSession` stopped the container and dropped the error of marking
the row stopped: a dead container listed as running, counted, reaped
again. `refreshSession` handed its caller the reconciled state and dropped
the write that would have put it in the table. `touchSession` dropped the
write the idle reaper reads, so a kernel in use could be taken for idle.
And the error marks on a start that failed, and the app's stopped mark
after a reaped service, went the same way.

A container the row could not take is now stopped again while the ref is
in hand, and the start fails as a start: "The sandbox started but its
session could not record it: …; it was stopped again." A stopped
container's row that could not be marked is said, with what the next
refresh will do; a reconciliation that could not be written is said with
what the table still says; an unrecorded touch is said for the reaper's
sake; the error and app marks read their answers.

**Driven.** Before the fix, on the R79 container: Developer workspace →
`My Python notebook` → Run cell — `Starting kernel…`, the runtime API
answering a session `starting` then `ready`; Running kernels `1 live ·
ready`; Stop — `Kernel stopped`, the panel gone. After the rebuild
(container `c28597f45d18`) the same: a new session `ready` after eleven
polls, `1 live · ready`, `Kernel stopped` 8 s after Stop. A session whose
ref and stopped mark land reports itself as before; the defect half — a
container the row could not take left running, a stopped container's row
left live — is held by the tests, a failed database write not being
producible from the browser against the runtime service. Seen both
times: the page then reports `Kernel connect timed out` over the ready
kernel, `NOTEBOOK_GATEWAY_URL` being unset in this deployment. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 6 source-anchored on the container stopped again, the two error
marks, the reconciliation, the stop, the touch and the app mark; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — A job "succeeded" over a version left training, and workers the job never learned of

#### R79 · S1 · The training job's records

The server-side write survey's next file, `ml/train.server.ts`, 9 writes
with their result dropped. The one that matters most sits at the end of
`writeTrainOutcome`: the job row was claimed `succeeded` — a conditional
update, read back — and then the version's `ready` write, with the
artifact, the metrics and the stage, dropped its error. A write that
failed left a finished job over a version `training` for ever, with no
artifact on its row: the Jobs tab said succeeded, the Versions tab said
training, nothing would ever serve it, and "promote when better" could not
choose it. The model's production pointer after an automatic promotion
dropped its error the same way — the state R73 named, a version marked
production that nothing serves. `startTrainingJob` wrote the started
workers onto the job without reading the answer: workers running that the
row did not count, so cancel could not reach them and the merge waited for
callbacks the row did not know to expect. And the version's `failed` and
`cancelled` marks, the training snapshot, the partial logs and the
assembling worker's record all went the same way.

The version is now recorded with one retry and, failing twice, the job is
failed with the reason — "The model trained, but its version could not be
recorded: …. Train again." — written onto the job, said to the owner, and
the success audit and promotion withheld, so the outcome and the record
agree. Workers the job row could not take are stopped again while their
ids are in hand, and the job fails as a job. A production pointer that
could not be set is said with what to do. The failed and cancelled marks,
the snapshot, the logs and the assembling worker each read their answer.

**Driven.** Before the fix, on the R78 container: `revenue_facts · groups`
→ Train new version, budget 5 → `Training started`; Jobs `running 19s` then
`succeeded 38s kmeans_k2 · Silhouette 0.249`; Versions `v22 candidate`;
again, `succeeded 12s`, `v23 candidate` — too fast for a cancel to be
driven. After the rebuild (container `9112063e9cde`) the same: `Training
started`, `succeeded 52s`, `v24 candidate kmeans_k2 0.249 836`, `v1
production` unchanged. A job whose version write lands reports itself as
before; the defect half — a job "succeeded" over a version left
"training", workers the row never learned of — is held by the tests, a
failed database write not being producible from the browser against the
training service. Versions v22–v24 are kept as candidates. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 source-anchored on the workers stopped again, the version's
retry and the job failed in its stead, the pointer said, and the failed and
cancelled marks; 5 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-22 — A run cancelled on screen, a sandbox the run never learned of, a watermark not kept

#### R78 · S1 · The ETL run's records

The server-side write survey's next file, `etl/service.server.ts`, 13
writes with their result dropped, and the page above them. Three change
what a person and the next run believe. `startRunSandbox` started the
sandbox and then wrote the run's `running` state and `session_id` without
reading the answer: a write that failed left a sandbox running that the
run row did not know — nothing could cancel it, since cancelling stops by
session id, and the reconciler saw a queued run with nothing behind it.
`cancelEtlRun` dropped the cancel's error, returned `true`, and stopped
the sandbox anyway: a row still `running` over nothing, for ever. And
`persistEtlWatermarks` dropped each upsert's error after a run that
succeeded: a cursor the next run does not have, so it reads from the
previous one and loads the same rows again — silently, under a green
badge. Above all three, the page: both cancel handlers said "Stopping",
or nothing, whatever the server answered; pressed on a run that had just
finished, Cancel did nothing and said nothing.

A sandbox whose session the run row could not take is stopped again while
the id is in hand, and the attempt fails as an attempt. A cancel writes
the record first and, if it cannot, says so and stops nothing: "The run
could not be marked cancelled: …. It is still running — try again." — and
a run that is not running is answered as such. The watermarks a successful
run could not keep are returned node by node and written onto the run:
"Succeeded, but the watermark could not be saved for …. The next run reads
from the previous cursor." The pipeline's status stamps, the attempt
counter, the partial logs, the progress record, the released cluster's ref
and the consumed ingest events each read their answer and say what a
failure leaves. The page reads the cancel's answer — "Could not stop the
run" and "Could not cancel the run", with the server's reason — or, when
the call itself never reached the server, with that. Left for the catalog
round: the lineage delete before the re-insert.

**Driven.** Before the fix, on the R77 container: `bi_seed` → Run → `Run
started`; Cancel pressed on the run as its sandbox finished — no toast of
any kind, the row `Succeeded` a moment later; Cancel pressed 14 s into the
next run — no toast, the row `Cancelled`. After the rebuild (container
`906b223c7b32`): a cancel that lands shows the row `Cancelled … 11s`; one
whose call is rejected says `Could not cancel the run · Failed to fetch.
It is still running.` over a row still `Running`; one the server refuses,
the sandbox having finished a second earlier, says `Could not cancel the
run · That run is not running.` over the row `Succeeded … 17s`. The
server side — the cancel's write, the sandbox's session, the watermarks —
is held by the tests, a failed database write not being producible from
the browser against a server function. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 6 source-anchored on the sandbox stopped again, the cancel's
order and answer, the server function and the page on both of its failure
paths, the watermarks returned and said, and the two stamps; 7
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — "Serving", over a row that said starting; "stopped", over one that said ready

#### R77 · S1 · The ML endpoint's state writes

The server-side write survey's largest cluster: `serve.server.ts`, 23
writes with their result dropped. Three of them change what the page and
the scorer believe about a running sandbox. The ready stamp at the end of
`ensureDeployment` — the copy up and answering, the row still `starting`
— dropped its error and the call answered ok; the next call, not seeing
`ready`, retired the healthy copy and started another, and did so on every
call for as long as the row stayed so. `undeploy` returned nothing either
way over three writes, so "Endpoint stopped" was said with every copy gone
and the row still `ready` — the address of a stopped sandbox, handed to
the next caller. And a copy whose `session_id` write failed was a copy
nothing could ever stop, since retiring stops by session id. The same in
`setCandidate`: a candidate copy up, the row not naming it, the mirror
never using it, nothing stopping it. `touch` wrapped its writes in a
try/catch that a failed write never reaches, so a served request could go
unrecorded and the idle reaper, which reads what was recorded, take a busy
endpoint for an idle one.

A state the record could not take is now said, and a copy the record
cannot describe is stopped rather than left running. The ready stamp is
retried once and, failing twice, answered as a failure that names the
state left: "It will show as starting, and the next Deploy will replace
the copy, until it is." `undeploy` answers with every write that failed —
"Every copy is stopped, but the endpoint's record could not be updated
(…). It will show as it was until it is — press Stop again." — and the
server function passes that on. A copy whose session or ready state could
not be written is stopped again with the id still in hand. A candidate
the record could not name is retired. `touch` reads its writes' answers
and says what the reaper will see. The autoscaler's per-minute readings
and the mirror's bookkeeping keep their fire-and-forget: a reading is
remeasured a minute later, and nothing decides on it in between.

**Driven.** Before the fix, on the R76 container: ML Models →
`revenue_facts · groups` → Automation → Deploy — `Starting the endpoint and
loading the model…`, a scorer sandbox up, the server function answering
`{ ok: true, version: 1 }`, `Serving v1`, the panel `Warm endpoint serving
v1`; Stop — `{ ok: true }` after 24 s, `Endpoint stopped`, `Warm endpoint
off`. After the rebuild (container `46df8dfdd4a3`) the same deploy and
stop, the same answers, toasts and panel states. A deploy whose stamp lands
and a stop whose writes land report themselves as before; the defect half —
ok over a stamp that failed, "stopped" over a row still ready, a copy
nothing could stop — is held by the tests, a failed database write not
being producible from the browser against a server function. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 9 source-anchored on the stamp and its retry, the copy stopped
again on either failed write, the retire's answer, `touch`, `undeploy` and
its server function, and the candidate paths; 6 behaviour-changing mutants
each killed, control missed, baseline green first.

### 2026-09-22 — The previous base's documents, under the next base's name

#### R76 · S2 · The Knowledge Bases page across a base change

Seen while driving the sibling paths of R64. Pick `RAG eval · Halvard
Systems` (12 documents), then `Test` (none): for the seven seconds the
second read spent failing under the client's retries, the page showed
`Test` as the heading and the twelve Halvard documents beneath it, with the
tab reading `Documents (12)`; and when the read had failed and the alert
took the panel, the tab still read `Documents (12)`. Nothing cleared the
previous base's rows: `docs` was replaced only when the next read landed,
and the tab counted whatever `docs` held. A slow read did the same as a
failed one, for as long as it took — and a read that came back late, for a
base no longer selected, would have replaced the current base's list with
the old one's.

Picking a base now clears its predecessor's documents, sources and chunk
counts before the read, marks both lists loading, and drops a read that
comes back for a base no longer selected. The panels say `Loading
documents…` and `Loading sources…` ahead of their empty states, and the
tab counts follow the read: `…` while it is pending, `?` when it failed,
the number once it has been made. The count helper, `listCountLabel`, sits
beside `listState` in `src/lib/listState.ts`.

**Driven.** Before the fix, on the R75 container: `RAG eval · Halvard
Systems` (12 documents), then `Test` with every read of
`knowledge_documents` rejected — 2.5 s in, the heading `Test` over the
twelve Halvard documents and `Documents (12)`; 10 s in, the alert and
`Documents (12)` still on the tab. After the rebuild (container
`ae7506f1384c`), both reads rejected: 2.5 s in, nothing listed, `Loading
documents…`, `Documents (…)` and `Sources (…)`; 10 s in, the alert,
`Documents (?)` and `Sources (?)`; with fetch restored, `No documents in
this knowledge base.` and `Documents (0)`. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 unit on the count label; 4 source-anchored on the clearing,
the late-read guard, the tab counts and the loading branches; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — A run that finished and stayed "running" for ever

#### R75 · S1 · The workflow runner's closing writes

The server-side write survey's next file, and the one where a dropped
error is not a wrong word but a wrong state that never corrects itself.
`closeRun` wrote the run's outcome with a conditional update — only the
replica that still saw the run as running wins — and read back `won` alone:
`if (!won?.length) return; // another replica closed it first`. A close
whose write FAILED produced the same empty `won`, and so returned without
a word. The run stayed "running" for ever on the Workflows page, the
workflow's last status stayed "running", no audit entry said what the run
did, and the owner who had asked to be told on failure was not told. The
workflow's status stamp and every node's final write dropped their errors
the same way.

A failed close is now told apart from a close another replica made: it is
retried once a second later, and a second failure is logged with the run,
the outcome and what a person needs — "It will show as running until it is
closed." The workflow's stamp keeps its error and says so, and the audit
entry and the notification still go out for a run that did close. A node's
final write says when the step is over but its record is not.

**Driven.** Before the fix, on the R72 container: Workflows → `Test`, a
Wait step of 2 seconds added and saved, Run now — `Run started`, and ten
seconds later `Test manual · less than a minute ago succeeded`, the Runs
tab `succeeded less than a minute ago · manual`. After the rebuild
(container `0dd063722838`) the same run: the same toast, the list and the
Runs tab closing it the same way, two runs now listed. A run whose close
lands reports itself as before; the defect half — a failed close read as
another replica's — is held by the tests, a failed database write not
being producible from the browser against the server-side runner.
Recorded in [UI test results](./UI_TEST_RESULTS.md).

**Tests:** 5 source-anchored on the close, its retry, its message, the
stamp and the node write; 4 behaviour-changing mutants each killed, control
missed, baseline green first.

### 2026-09-22 — "Dropped", with the catalog row that lists it still there

#### R74 · S1 · The lakehouse schema drop and materialized-view removal

The server-side write survey's next file. Dropping a schema runs `DROP
SCHEMA … CASCADE` on the lakehouse, then deletes the schema's catalog row
and its grants — and both deletes dropped their error before the audit
entry said dropped. A schema whose row survived stayed on the Lakehouse
page pointing at a schema that no longer existed, and its grants named it
still. Removing a materialized view did the same with one delete, and a
view whose row survived kept refreshing on its schedule.

Each delete keeps its error now, and the answer says what is already true:
"The schema was dropped, but its catalog entry could not be removed: <why>.
It will still be listed until it is; drop it again to retry." — the grants
likewise — and "Could not remove the materialized view: <why>. It is still
defined and will still refresh on its schedule." The audit entry is written
only after every row is gone.

**Driven.** Before the fix, on the R72 container: Lakehouse → New schema
`r74_probe` → Create, then its drop — `Dropped r74_probe`, the explorer
stale until a reload. After the rebuild (container `0dd063722838`) the
same create and drop: `3 schemas · 21 tables` with `r74_probe (0)`, then
`Dropped r74_probe` and `2 schemas · 21 tables` with the schema gone, on
the page and after a reload. A drop whose catalog-row deletes land
reports itself as before; the defect half — done reported over a row
that stayed — is held by the tests, a failed database write not being
producible from the browser against a server function. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 source-anchored on the three deletes, their messages and the
audit's place; 3 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-22 — "vN is now in production", over writes that could have failed, in an order that could leave none

#### R73 · S1 · The ML promotion's four writes

The server-side write survey — 237 error-less writes in 64 files — taken
to the one that changes what agents and dashboards compute with. Promoting
a version ran four writes in `applyPromotion` and returned `{ ok: true }`
whatever they answered: the page then said "v21 is now in production" from
that answer. And the order was the worst one for a failure part-way:
archive the old production version first, then point the model at the new
one, then mark the new one — so a failure at the second step left a model
serving nothing, with its former production version already archived.

Each write keeps its error now and the answer names the step and what is
true after it: "Could not mark v21 as production: <why>. Nothing changed.";
"Could not switch the model to v21: <why>. The model still serves its
previous version; v21 is marked production but not served — promote it
again."; "v21 is now served, but the previous production version could not
be archived: <why>. Two versions are marked production until it is." The
order is now the one that never leaves a model with no production version:
the version's own stage first, the model's pointer second, the archive of
the old one last. The audit entry is written only after every write landed.

**Driven.** Before the fix, on the R72 container: `revenue_facts · groups`,
v21 promoted and v1 promoted back — `v21 is now in production`, `v1 is now
in production`, the states following each. After the rebuild (container
`0dd063722838`) the same two promotions, the same toasts and states, the
fixture left as found (v1 production, v21 archived): a promotion whose
five writes land reports itself as before. The defect half — `ok: true`
over a write that failed — is held by the tests; a failed database write
cannot be produced from the browser against a server function. Recorded
in [UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 source-anchored on the writes, their errors, the order and
the audit's place; 3 behaviour-changing mutants each killed, control
missed, baseline green first.

### 2026-09-22 — A message deleted on screen that came back on reload

#### R72 · S1 · Agent Chat's four deletes

The write-side survey's last file, back on the Agent Chat page. Press
Delete on a bubble with every `DELETE` to `messages` rejected: nine bubbles
where there were ten, nothing said; reload: ten. Four deletes on the page
dropped their error — a message, a chat, the reply a regenerate replaces,
the tail an edit-and-resend replaces — and the last two were worse than
silent: a regenerate whose old-reply delete failed streamed a fresh reply
on top of the old one, and a resend whose tail delete failed inserted the
edited message above the tail it was meant to replace, so a reload showed
both threads.

Each keeps its error now. A message or chat that could not be deleted comes
back on screen — "Could not delete the message: <why>. It is still in the
conversation." — and a regenerate or resend that could not remove what it
replaces restores the conversation and stops: "The previous reply could not
be removed, so it stands." The write survey (40 error-less client writes in
10 files) is closed with this round; what remains of it — the swarm chat
dialog's insert and update, the add-source dialog's insert, evaluations'
two deletes — each reload from the table after the write and so cannot show
a phantom row, and are left as noted.

Driven, before: nine bubbles over a rejected delete, nothing said, ten after
a reload. After the rebuild, the same rejection: ten bubbles at once and the
toast `Could not delete the message · TypeError: Failed to fetch. It is
still in the conversation.` No real delete was made.

**Tests:** 5 source-anchored on the four deletes, their undo and their
stopping; 5 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-22 — Thirty notifications cleared on screen, none in the database

#### R71 · S1 · The notification bell's three writes

The write-side survey's next file. Open the bell — thirty unread — and
press Clear with every `DELETE` to `notifications` rejected: "No
notifications — dashboard alerts and scheduled-refresh results land here.",
the badge loses its count, and nothing is said. Reload: thirty unread. The
bell's three writes — clear all, mark all read, mark one read — were all
optimistic and dropped their error, so the badge a person had just silenced
came back on the next page, and the alert they had dismissed had never been
dismissed.

Each keeps its error now and undoes itself on screen: the list and the
badge return to what is stored, and a toast says "Could not clear the
notifications: <why>. They are still there." — or "still unread" for the
read marks.

Driven, before: the popover empty and the badge without its count over a
rejected delete, nothing said, thirty unread after a reload. After the
rebuild, the same rejection: the list back at once, the badge at thirty
unread, and the toast `Could not clear the notifications · TypeError:
Failed to fetch. They are still there.` No notification was cleared.

**Tests:** 4 source-anchored on the three writes, their undo and their
messages; 4 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-22 — An alert switched off that was still on, and would still fire

#### R70 · S1 · The BI schedule dialog's writes

The write-side survey's next file. Add a data alert to a dashboard —
`Total Sales · row count > 1`, switch on — and press its switch with every
`PATCH` to `bi_alerts` rejected: the switch goes off on screen, and nothing
is said. Reload: the switch is on. The alert was never switched off, and
would have fired on the next scheduled refresh while its owner believed it
silenced. Every write in the dialog was like this: removing the schedule
(the refresh kept running, the dialog showed none), deleting an alert (it
left the list and kept firing), the alert's email setting.

Each keeps its error now. A switch that could not be switched is undone on
screen and says "Could not switch the alert off: <why>. It is still on and
will still fire."; a delete that failed says "It is still set and will
still fire."; a schedule that could not be removed says "It is still
scheduled."; the email setting says "It is unchanged." The dialog shows
what is stored, never only what was pressed.

Driven, before: the switch off on screen over a rejected update, nothing
said, on again after a reload. After the rebuild, the same rejection: the
switch back on at once and the toast `Could not switch the alert off ·
TypeError: Failed to fetch. It is still on and will still fire.`; with
`fetch` restored, the fixture alert deleted for real.

**Tests:** 5 source-anchored on the four writes, their undo and their
messages; 5 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-22 — "Provider disconnected", with the key still stored and the card still Connected

#### R69 · S1 · The Integration Hub's three disconnects

The write-side survey's next page. Disconnect OpenRouter — the dialog says
"The stored key is deleted, not disabled" — with every write rejected:
`Provider disconnected`, and the card reloads still `Connected`, Disconnect
button and all. Three writes on the page dropped their error: the encrypted
provider's credential delete, the integrations-row provider update (the
path OpenRouter takes, which the single-line survey had not listed — the
statement spans four lines), and the notification channel's update.

Each keeps its error now and says what is still true: "Could not
disconnect the provider: <why>. The key is still stored and the provider is
still connected." — or "The provider is still connected." on the row path,
and "The channel is still connected." for a channel — and none says
"disconnected" or reloads until the write landed.

Driven, before: `Provider disconnected` over a rejected update, the card
still Connected after a reload. After the rebuild, the same rejection:
`Could not disconnect the provider · TypeError: Failed to fetch. The
provider is still connected.`, the card still Connected with its Disconnect,
and no "Provider disconnected". No real disconnect was made.

**Tests:** 4 source-anchored on the three writes, their messages and the
order of failure before success; 4 behaviour-changing mutants each killed,
control missed, baseline green first.

### 2026-09-22 — "Document deleted", and the document listed in the same breath

#### R68 · S1 · The Knowledge Bases page's three deletes

The write-side survey's next page. Add a document to a knowledge base,
press Delete, confirm "Its chunks and embeddings go with it…" with every
`DELETE` to `knowledge_documents` rejected: `Document deleted` — and
`Documents (1)`, the document still listed, because the list reloads from
the table where the row still is. Reload: still there. The base delete and
the documents-of-a-source delete did the same; only the source row's own
delete checked its error.

The order on this page is deliberate and kept: the vectors are forgotten
first, while the rows that prove ownership still exist. That order gives a
failed row delete a consequence worth saying — the embeddings are gone, the
row is not — and the message now says it: "Could not delete the document:
<why>. Its embeddings were already removed — re-index the knowledge base to
restore retrieval." Each of the three deletes keeps its error, returns
before "Deleted" or a reload, and the base and source variants say the same
in their own words.

Driven, before: `Document deleted` over a rejected delete, the document
listed in the same breath and after a reload. After the rebuild, the same
rejection: `Could not delete the document · TypeError: Failed to fetch. Its
embeddings were already removed — re-index the knowledge base to restore
retrieval.`, the document still listed and no "Document deleted"; with
`fetch` restored, `Document deleted` and `Documents (0)` — the fixture gone
for real.

**Tests:** 4 source-anchored on the three deletes, their messages, their
returns and the vectors-first order; 5 behaviour-changing mutants each
killed, control missed, baseline green first.

### 2026-09-22 — "Swarm deleted", and the swarm was still there

#### R67 · S1 · The swarm canvas's own create and delete

The write-side survey's next page. The swarm gallery already says "Failed
to create swarm" and "Failed to delete" — with every `POST` to `swarms`
rejected, its New Swarm says exactly that. The canvas has its own create
and delete, and neither said anything. Open a swarm, press Delete swarm,
confirm "Swarm 16 will be permanently removed…" with every `DELETE`
rejected: `Swarm deleted`, and the canvas moves on to Swarm 1. Reload the
gallery: `My Swarms 16`, Swarm 16 still there. The canvas said the swarm
was gone and moved on; the swarm was not gone. Its create did the opposite:
a failed insert did nothing at all — no swarm, no word.

The delete keeps its error, and a delete that fails changes nothing on
screen and says "Could not delete the swarm" with the reason; the list and
the canvas stay as they are. The create keeps its error and says "Could not
create a swarm"; the fresh swarm the canvas opens after the last delete
says when it could not be created instead of leaving an empty canvas with
no swarm behind it.

Driven, before: `Swarm deleted` over a rejected delete, the canvas moving
on, the swarm back in the gallery on reload. After the rebuild, the same
rejection: `Could not delete the swarm · TypeError: Failed to fetch` and the
canvas staying on the swarm; with `fetch` restored, `Swarm deleted` and the
gallery back to fifteen — the fixture gone for real.

**Tests:** 3 source-anchored on the canvas's create, delete and the fresh
swarm after the last delete; 4 behaviour-changing mutants each killed,
control missed, baseline green first.

### 2026-09-22 — A cap that was never saved, under a button that said "auto-saved"

#### R66 · S1 · The Budgets page's writes

The write-side survey's next page. Reject every `PATCH` to
`budget_settings` and type a monthly cap of 25 over the saved 20: the cap
reads 25, the strip reads `Month-to-date spend: $1.79 / $25.00`, and there
is no toast. Press the page's own button: `All settings auto-saved`. Reload:
20. A cap that was never saved was the cap on screen, and the page said so
in so many words — on a page whose one job is to state what the platform
will refuse to spend past.

Every write on the page was optimistic and dropped its error: the budget
update, the per-agent limit update, the per-agent limit insert. The button
toasted a constant. A write that fails is now undone on screen, said in a
toast with the reason ("The value shown is what is saved."), and recorded;
the page's status line is derived by a pure `saveStatusText` from what the
last write did — "Settings auto-save on change" before any write, "Saved
HH:MM" after one that landed, "Not saved — budget: …" after one that did
not — and pressing it toasts the same truth.

Driven, before: cap 25 on screen over a rejected save, `All settings
auto-saved` on the button, 20 after a reload. After the rebuild, the same
rejection: the cap back to 20 at once, the toast `Could not save the budget
· TypeError: Failed to fetch. The value shown is what is saved.`, the status
`Not saved — budget: TypeError: Failed to fetch`; with `fetch` restored, a
real change to 21 reads `Saved 12:56 AM`, and back to 20 for the fixture.

**Tests:** 3 behavioural on `saveStatusText`, 3 source-anchored on the
page's three writes, the undo and the status; 6 behaviour-changing mutants
each killed, control missed, baseline green first.

### 2026-09-21 — A turn that was never saved looked exactly like one that was

#### R65 · S1 · Agent Chat's message inserts

The failed-read survey's largest file, the Agent Chat page, and the
write-side twin of the class. Reject every insert to `messages` and send a
probe: "You: R65 probe: reply with the single word OK" · "Assistant: OK" —
twelve bubbles where there were ten, two POSTs rejected, no toast, no mark.
Reload: ten bubbles; the probe turn is gone. Nothing distinguished the two
unsaved messages from the ten saved ones until they were not there.

Five of the page's six message inserts — the user's message, its edited
resend, the assistant's reply on both paths, the BI answer, the document
prompt — read `const { data } = await …insert()` and dropped the error; only
the document save warned ("built, but not saved to this conversation").
Every insert now goes through one `persistMessage`: on failure the on-screen
message is marked `unsaved` with the reason, the bubble says "not saved — it
will not be here after a reload" under the sender's name, and a toast says
why. The two conversation reads keep their error too: a failed
`conversations` read used to be an empty list, and an empty list creates a
fresh "New Chat" — so a network blip could bury the real conversations
under a new one; it now says so and creates nothing.

Driven, before: twelve bubbles, no mark, no toast, ten after a reload.
After the rebuild, the same rejection: under both new bubbles `not saved —
it will not be here after a reload` with the fetch error on hover, and the
toast `This message was not saved to the conversation · TypeError: Failed
to fetch. It will not be here after a reload.` read seconds after the send;
ten bubbles after a reload, as the marks said.

**Tests:** 6 source-anchored on the helper, the six call sites, the bubble
and the two reads; 6 behaviour-changing mutants each killed, control
missed, baseline green first.

### 2026-09-21 — "No agents yet", over nine agents it could not read

#### R64 · S1 · The Agent Builder and Knowledge Base lists

The failed-read survey (55 error-less client reads in 25 files), taken to
the two builder pages every other page starts from. Reject every request for
`agents` and reload the Agent Builder in-app: `No agents yet` — "Create your
first agent to get started — pick a model, write a system prompt, and add
tools as you go." — and a `New Agent` button, over nine agents. Reject
`knowledge_bases` and reload the Knowledge Bases page: `No knowledge bases
yet.` over six. Nothing on either page says a read failed; the obvious
response to either screen is to make another one.

Both pages dropped their read's `error`. The Agent Builder had already
learned that "not fetched yet" is not "none" (its `loaded` flag, for the
first paint), and still had no third state for "could not fetch". A pure
`listState` now says which of loading, error, empty and list a surface may
show — an error ahead of empty and ahead of loading, because a read that
failed is not still loading and is not nothing — and the Agent Builder
renders "Could not load your agents" with the reason and a "Try again"
ahead of its empty state. The Knowledge Bases page keeps the error of each
of its three list reads (bases, documents, sources) and renders each ahead
of the empty state it used to hide behind, as an alert with the reason.

Driven, before: `No agents yet` with its call to action over nine agents,
`No knowledge bases yet.` over six, each with every request for the table
rejected. After the rebuild, the same rejections: `Could not load your
agents · TypeError: Failed to fetch · Try again`, and the nine agents back
when `fetch` is restored and Try again pressed; `Could not load your
knowledge bases: TypeError: Failed to fetch` as an alert, and no empty state
on either page.

**Tests:** 3 behavioural on `listState`, 3 source-anchored on both pages'
reads and the order of their states; 6 behaviour-changing mutants each
killed, control missed, baseline green first.

### 2026-09-21 — "Everything is running", from counts that could not be read and one that could never fire

#### R63 · S1 · The home dashboard's status band

The landing page opens with one sentence — "Everything is running", or "N
things need attention" with a chip for each — built from seven counts. Two
things were wrong with how they were built, and both were found by driving
the page.

**A chip that could never fire.** Give `stg_revenue` a row-count test of
100 (it has 5 rows), build: `failed · row_count_min on the table failed`.
Open the dashboard: `1 thing needs attention · 1 open data incidents` and no
"SQL models failing" chip; the SQL models card says `2 models` with no
warning. The count asked `sql_models` for `last_status = 'error'`, and the
column cannot hold that value — its check constraint allows `built`, `failed`
and `skipped`. Every failing model has been "Everything is running" since the
chip shipped. Sweep item 3's shape — a claim the evidence cannot support —
in its simplest form: a predicate on a value that does not exist.

**A failed read as zero.** Reject every `/rest/v1/etl_runs` request and
reload the page in-app: `1 thing needs attention · 1 open data incidents`,
checked a minute later, and nothing about pipeline runs — the check is
absent, not unknown. Every count landed as `count ?? 0`, with a comment
explaining that a table a deployment has not migrated should not fail the
page. Right for that case; wrong for a read that failed for any other reason,
because zero is the most reassuring possible way to display "we have no
idea". Sweep item 1's shape, on the one page built to say whether the
platform is healthy.

The predicate now asks for `failed`. Each count is a number when its read
answered and `null` when it did not; the band is derived by a pure
`bandSummary`: "Everything is running" only when every check answered and
none found anything; "Nothing failing among what could be checked — N checks
could not be read" when the unread are the only news; "N things need
attention · M checks could not be read" when both. An unread check is a chip
of its own — "? pipeline runs failed today — could not be read", the reason
on hover — never a zero, and each card's warning line says "could not be
checked" for its own. The docs say so.

Driven, before: `1 thing needs attention · 1 open data incidents` over a
model that had just failed its build, and the same sentence with every
`etl_runs` request rejected. After the rebuild: `2 things need attention ·
1 open data incidents · 1 SQL models failing`, the card `2 models · 1
failing`; with the request rejected, `2 things need attention · 1 check
could not be read` and a chip `? pipeline runs failed today — could not be
read` whose hover text is `TypeError: Failed to fetch`, the ETL card `20
pipelines · could not be checked`.

**Tests:** 5 behavioural on `bandSummary`, 4 source-anchored on the page's
reads, the predicate, the cards and the band; 6 behaviour-changing mutants
each killed, control missed, baseline green first.

### 2026-09-21 — "Jobs (20)" on a model with twenty-one versions

#### R62 · S2 · The ML model page and its runs: a capped list's length as the count, and failed reads as "nothing yet"

Sweep 2's last named row, ML predictions. Open `revenue_facts · groups` —
"21 versions" on its card — and the tabs read `Versions (21)` and `Jobs (20)`;
the Jobs tab lists twenty rows, oldest "17d ago", and nothing says there
are more. `mlGetModel` read the newest twenty training jobs and the page
printed the length of what came back. The Predictions tab did the same with
the newest fifty runs (`mlListPredictions`), and the Accuracy and Fairness
panels searched those fifty for the newest successful batch run and called
an older one "No successful batch run to measure yet".

The same two handlers dropped the error of every read they made: a failed
versions read was `Versions (0)` and no production version, a failed jobs
read "No jobs yet.", a failed runs read "No predictions yet." — sweep item 1's
shape, in the one module the named list never reached.

Each read now throws with what could not be read, and the page shows the
failure. Each list fetches one row past what it shows (`capList`, the twin of
R61's `semanticTrim` for lists that are not queries) and says when it goes
on: `Jobs (20+)` with "The newest 20 jobs. Older jobs exist and are not listed
here." under the table; the same note under the Predictions tab; and the two
panels say "No successful batch run among the newest 50 runs — older runs
are not searched" instead of "none". The docs say which lists are the newest
N and that a failed read is shown as one.

Driven, before: `Versions (21)` · `Jobs (20)`, twenty rows, no note. After
the rebuild, the same model: `Jobs (20+)`, and under the twenty rows "The
newest 20 jobs. Older jobs exist and are not listed here."; the Predictions
tab lists its eleven runs with no note, being under its cap. The failed-read
half is server-side and held by the tests.

**Tests:** 2 behavioural on `capList`, 7 source-anchored on both handlers
and every surface; 9 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-21 — The governed query that stopped at its cap and never said so

#### R61 · S2 · "100 row(s)" over 9,994 groups, and three more places the prefix was the whole

Sweep 2's next row, the semantic layer. `total_sales` by `order_id` on the
SaaS Sales model — 9,994 orders — run from the Semantics page: `100 row(s)`,
`LIMIT 100` in the compiled statement, a hundred rows in the table. The page
asks for a hundred and nothing says the query has more. The cause is one
level down: `runSemanticQuery` fetched AT its cap and so could not tell a
result of exactly cap rows from one of more, and returned no verdict either
way. Every consumer then decided for itself, and most decided "whole":

- the Semantics page counted the prefix;
- a dashboard widget's **parameter re-run** asked for `limit: 100` — a tenth
  of the widget's own cap — and stored the rows over whatever `truncated` the
  widget already had, so a widget of a thousand rows quietly became a hundred
  with no Partial badge;
- the AI Analyst's governed step wrote `capped: false` over a result the
  runner had cut at a thousand, so a total or a ranking over "revenue by
  customer" was summarised from a thousand of many more, and the write-up was
  never told;
- the scheduled BI refresh guessed from `rows.length >= cap`, which also
  flags a result of exactly a thousand rows that was complete.

Only the agent's `metric_query` tool and the metrics gateway fetched one past
their caps and said so — each on its own, above the runner.

The runner is now the one place that knows. `semanticFetchPlan` takes the
smaller of the query's limit and the caller's budget as the cap and fetches
one row past it; `semanticTrim` cuts at the cap and says whether it did; the
result carries `truncated` and `cap`. The preview says "first 100 rows of a
larger result — the preview stops at 100; add a filter or a coarser grain to
see everything". The parameter re-run asks for the widget's cap and stores
the runner's verdict. The analyst's step is `capped` when it was, with a
note the self-check keeps and the write-up reads: "Partial: the governed
model returned the first N groups of a larger result…". The refresh trusts
the verdict when it has one and keeps its guess for the SQL paths. The tool
and the gateway are untouched — their own cap+1 still lands above the
runner's, and the arithmetic stays right.

Driven, before: `100 row(s)`, `LIMIT 100`, a hundred rows. After the
rebuild, the same query: `first 100 rows of a larger result — the preview
stops at 100; add a filter or a coarser grain to see everything`, `LIMIT
101` in the statement that ran, a hundred rows in the table.

**Tests:** 7 behavioural on `semanticFetchPlan` and `semanticTrim`, 7
source-anchored on the runner and every consumer; 9 behaviour-changing
mutants each killed, control missed, baseline green first.

### 2026-09-21 — A build's stamps outlived the definition they were about

#### R60 · S2 · "built · 836 rows" beside SQL that had just been replaced

Sweep item 2, taken up at last: a badge that outlives what it vouched for.
Open `stg_revenue` on the SQL Models page: `built · 11d ago · 836 rows`, a
green dot. Append `limit 5` to its SQL and press Save: "Saved stg_revenue" —
and `built · 11d ago · 836 rows`, the green dot. The save writes every column
of the definition and none of the stamps; the page reads `last_status` as if
it were about the row it sits on. So the status, the row count and the time
all describe the previous definition, and nothing on the page can tell.

The database now marks a definition change: a `BEFORE UPDATE` trigger on
`sql_models` (migration `20260921000000`) sets `definition_changed_at` when
the SQL, target schema or name, materialization or tests change — and not
when the description, tags, schedule or pause state do, because a model
paused or rescheduled still holds the table its last build wrote. A trigger
for the same reason the semantic layer decertifies in one: every writer goes
through the row, and none can forget.

The runner clears the mark, not the trigger, and only when the mark on the
row is still the one it loaded at plan time. A trigger cannot tell a build
that read the new definition from one that started before the edit and
stamped after it; the runner holds the mark it read, so its clear is the
claim-by-clock pattern the sweeps already use. A mark that survives a build
is one that build did not read.

The page derives what it may claim from both (`modelBuildState`): an edited
model's dot is amber, its header reads `edited <when> · not built since`, and
the previous build's figures are still shown — named as the previous
definition's — because the table in the lakehouse is still that build's.

**On the live database since 2026-09-22.** The migration's push was refused
by the session's permission gate on the day, so the trigger went in when the
owner ran `npx supabase db push`; until then the runner tolerated a row
without the column. Driven afterwards, both directions: a SQL change marks
the model `edited · not built since` with the previous build named as the
previous definition's; a description-only change on a built model leaves it
`built`; the build that reads the definition clears the mark. Recorded under
R60 in the UI test results.

Driven, before: `stg_revenue` at `built · 11d ago · 836 rows`, `limit 5`
appended and saved — `Saved stg_revenue`, and `built · 11d ago · 836 rows`,
green dot. After the rebuild, against the un-migrated database: the same
header (no mark to read), then Build — `Built 1 model`, `built · 22s ago ·
5 rows`. The trigger was proven in both directions against the empty local
Postgres twin in a throwaway schema, dropped afterwards; the edited state
in the browser waits on the push.

**The family.** Every other definition edit in the product keeps its last
result the same way, and none was in the named list: the lakehouse
materialized-view upsert (`last_status`, `last_refreshed_at`, "Last rebuilt
…"), the ETL pipeline save (`last_run_status` chip), the workflow saves, the
data-monitor config update (a rule changed while its `ok` and `last_value`
stand — reachable only through the server function today), and the app-source
re-save (`last_test_status` "Healthy" over credentials that were replaced —
the warehouse and provider saves clear it; this one does not, and the Apps
tab cannot reach it). Listed under sweep item 2; each is a round of its own.

**Tests:** 5 behavioural on `modelBuildState` and 9 source-anchored on the
trigger, the runner and the page; 7 behaviour-changing mutants each killed,
control missed, baseline green first.

### 2026-09-21 — The scheduler's last pass has a surface

#### R59 · S2 · A page that lists every service except the one that runs every schedule

R57 made the scheduler's pass record every folded failure in `errors`, and
the only place that answer went was the JSON of `/api/bi/cron`, which the
page polls and discards. The Monitoring page — "N needing attention" — listed
every service the deployment runs and never the scheduler, so a pass that
could not read its own schedule, or a scheduler that had stopped, changed
nothing on the one page built to say so.

The pass now keeps its last result in process memory (`getLastCronPass`), and
the health handler reports it as a service beside the others through a pure
`schedulerProbe`: **up** with the last pass's age and counts; **degraded**
naming the failures when the last pass had any, or when no pass has run for
five minutes (the tick is one a minute), or when a process has been up that
long without ever passing; and an honest **up** with a note when the
in-process scheduler is disabled by configuration and an external cron drives
the passes. The page's "needing attention" count includes it like any other
service, and the row shows the failures in its message.

Process memory on purpose, and said in the code: the probe answers for the
instance that served the request; a multi-instance deployment reads the one
that answered.

Driven: the Monitoring page after the rebuild shows the Scheduler row — up,
last pass seconds ago, the pass's counts — beside the other services.

**Tests:** 6 behavioural on `schedulerProbe` and 2 source-anchored on the
wiring; 6 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-21 — Retrieval that could not be checked or completed says so

#### R58 · S1 · A failed ACL read showed restricted documents; every failed search said "no match"

`retrieveCitationsServer` answered a bare `Citation[]`, and four things
inside it fell short without a word reaching the model:

- The ACL filter's catch was written for one state — a database that predates
  the connector migration, where the ACL columns do not exist — and its
  comment says so. The catch itself caught EVERY failure and kept the
  unfiltered candidates. A timeout on the ACL read showed restricted documents
  to whoever asked.
- A failed vector search was folded into keyword mode with a warn.
- A failed keyword scan was a bare warn; and the document scan under it
  dropped the error of every page (a failed page was "no more documents") and
  stopped at the first page shorter than it asked for — R41's assumption, with
  `KEYWORD_PAGE` equal to `db-max-rows` by luck.
- The chat route's own catch, "don't block the chat — just continue without
  grounding", let the model answer from memory over a failed retrieval with
  no word that anything had been searched.

And the grounding prompt, told `[]` by any of these, instructed the model:
"It returned no matching passages. … say plainly that you could not find it
in the available documents." The `kb_search` tool said "No matching documents
in any connected knowledge base." Absence asserted over a search that failed.

Now the function reports `{ citations, degraded }` and the old name delegates.
The ACL catch keeps the legacy path only for the pre-migration error
(`does not exist` / `42703`) and otherwise fails CLOSED — the candidates are
withheld and the reason recorded. The vector and keyword failures are
recorded. The document scan pages through `selectAllPages`, which reads every
page's error and does not stop on a short one. The grounding prompt, given
nothing back and a reason, tells the model the search could not be completed
and not to say the documents lack the information; given citations and a
reason, that retrieval was partial. The tool's empty answer carries the reason
instead of "no matching documents", and the chat route's catch tells the
model retrieval failed instead of saying nothing.

Two more reads on the same path answered absence over a failure and go with
this round: the agent's own configuration (`const { data: agent }` — a
failed read left the search covering no knowledge base) and an ML model's
production version (`Production version not found`, over a failed read).
Both read their error now; the first throws with the reason, the second
tells the model the version could not be read.

Server-side throughout, so the browser half is the regression half: a
grounded agent still answers with citations under the live deployment. The
defect half is behavioural on the pure prompt builder and source-anchored on
the rest.

**Tests:** 4 behavioural on `buildGroundingPrompt`, 9 source-anchored on the
report, the ACL catch, the scan, the tool, the route and the two reads; 9
behaviour-changing mutants each killed, control missed, baseline green first.

### 2026-09-21 — A scheduler that reported success over its own failures

#### R57 · S1 · `/api/bi/cron` answered `ok: true` with zeros over a failed schedule read

The scheduler's pass, `runCronPass`, runs some twenty sweeps — BI schedules,
prep flows, analyses, quality checks, catalog crawls, ETL, materialized views,
SQL models, workflows, swarm schedules, retention purges, health checks. All
but the first two were folded to `console.warn` and `return 0`; the three
reads that decide what is due were folded to "nothing due" (`due ?? []`,
`flows` → `return 0`, `alerts ?? []`); and the pass result had no field for
any of it. So the cron endpoint the page polls every few minutes answered
`{ ok: true, processed: 0, prep_flows: 0, … }` over a pass that could not
read its own schedule, and a refresh that crossed an alert threshold, under
a failed alerts read, notified nobody. Per-row failures were already recorded
on the schedule and flow rows; the failures BEFORE a row was reached were the
silent ones.

Every folded step now records itself — `fold(step, e)` warns as before and
pushes `step: reason` into `errors` on the result, and the first two steps
are folded the same way so a failed read does not abort the sweeps after it.
The three reads throw with their reason, which is what `errors` then carries.
The route's `ok` is `result.errors.length === 0`; the counts and the errors
travel either way, still as a 200, so an external cron keeps calling.

Nothing in the UI shows the pass result — the page polls the endpoint and
discards the body — which is the next thing to give a surface. This round's
browser half is the regression half: the endpoint the page polls answers
`ok: true, errors: []` under the live deployment.

**Tests:** 4 behavioural on the real `processDueSchedules` and
`processDuePrepFlows`, forced past their interval guards, against an admin
client whose read fails; 5 source-anchored on the pass, the alerts read and
the route; 7 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-21 — Two server reads whose failure became an answer

#### R56 · S2 · "No credentials configured" over a failed read, and a person shown as an id

Found by reading, in the two files the failed-read sweep had left: both are
the server's own reads, so neither is injectable from the browser and both
rounds' browser halves are regression only.

`loadCredentialRowShared` fetched the user's OWN credential through
`loadCredentialRow(...).catch(() => null)`. `loadCredentialRow` answers `null`
for "no row" and throws only for a failed read, so the catch turned a failed
read into "no own credential", the lookup fell through to the IAM grants, and
the call then failed downstream with **"No credentials configured. Add them in
Provider Integrations."** — the wrong reason, at the wrong place, for a
credential that exists. `getProviderDefaultModel` folded the same read into
"no default model", which silently changes which model a call uses.

`emailMap` in `audit.functions` paged the Auth admin API and `break`-ed on
error, so a failed page handed back a SHORT map and the audit list attributed
every trace and swarm row after it to an 8-character id where it should show
a person — under an `ok: true` answer (event rows have an `actor_email`
fallback; trace and swarm rows do not). `adminSpendBreakdown` consumed the same
map and dropped the errors of its groups and members reads too: a failed read
answered `ok: true` with an empty group breakdown.

The two catches are gone — a failed read propagates with its reason and the
"not configured" message is said only over a genuine null. `emailMap` reports
a failed page, and both handlers answer `{ ok: false, error }` — which the
Audit Log page already toasts — instead of attributing spend or actions to
ids.

**Tests:** 3 behavioural on the real `loadCredentialRowShared` and
`getProviderDefaultModel` against an admin client whose credential read fails,
3 source-anchored on the two audit handlers; 7 behaviour-changing
mutants each killed, control missed, baseline green first.

### 2026-09-21 — "Upload data first", over a read that failed

#### R55 · S2 · The generate dialogs advised uploading data when the data could not be read

Driven: a saved report opened with every `user_data_tables` request rejected
— two rejected reads on mount and no toast, because the report route's
hydration catch was bare ("the designer still works without them; only
generation needs them"). Then Generate with AI: the source picker's placeholder
and its notice both read **"No local datasets — upload data on the Data & SQL
page first."**, and Plan the report was disabled. Four rejected reads by then.
The account has thirty-three local datasets.

Both generate dialogs take their table list and their "not ready" reason from
`generationSource()`, which turned an empty list into advice to upload. The
dashboard route toasted the failure and moved on; the report route said
nothing at all; either way the dialog received `[]` and had no way to tell a
failed read from an empty account.

The BI data context now carries `datasetsError`. Both routes set it in their
catch (the report route gains the toast it never had), both dialogs pass it
through, and `generationSource` answers an empty list WITH a reason with the
reason — "Local datasets could not be read — …" — while an empty list without
one still says where to get data, and a kept list after a failed re-read is
not blocked.

**Tests:** 3 behavioural on the real `generationSource` and 4 source-anchored
across the context, both dialogs and both routes; 6 behaviour-changing mutants
each killed, control missed, baseline green first.

### 2026-09-21 — A deck whose data could not be read, delivered without a word

#### R54 · S2 · "Here's your PowerPoint" over four rejected reads

Driven in the playground: PowerPoint mode, every `user_data_tables` request
rejected, a request for a two-slide deck with a bar chart of sales by region
and a KPI of row count. At 21 s: **Here's your PowerPoint —
Make-a-2-slide-PowerPoint-about-the-saas.pptx**. Four rejected reads behind
it, no toast, no error, a deck delivered with its chart slides fallen back to
bullets.

`materializePptxWithBI` caught the failed hydration as `datasets = []` and
returned `{ visuals: 0, filled: 0 }` — the same report a plan with no charts
gets. Its caller's "N of M visuals could be filled" warning needs `visuals > 0`
to fire, so a failed read was the one outcome that produced no message at all:
an unanswerable question warns, an empty account is silent by design, and an
unreachable table list was silent by accident.

The report now counts the charts the plan asked for BEFORE reading, so the
count stands whatever happens next, and carries `error` when the datasets could
not be read. The playground toasts that as an error — "Charts could not be
filled — could not read your datasets: …" — with the deck still built and
the reason on screen, and the existing partial-fill warning is unchanged
for the case it was written for.

**Tests:** 3 behavioural on the real filler (a hydration that rejects, one
that answers no datasets, a plan with no visuals — against the unpatched
source the first two reported `visuals: 0` alike) and 1 source-anchored on the
caller; 4 behaviour-changing mutants each killed, control missed, baseline
green first.

### 2026-09-21 — A policy read that fails must fail closed

#### R53 · S1 · A failed IAM read evaluated as "no policy"

Found by reading, not by driving: R51's false lead pointed at the grants
resolver, and the resolver's neighbours turned out to be the finding.
`getEffectiveModelRules` read four tables and dropped the error of each:

```ts
const [{ data: memberships }, { data: rules }, { data: roles }, { data: settings }] = …
const mode = settings?.model_access_default === "deny" ? "deny" : "allow";
```

Under allow mode `collapseModelPolicy` turns "no applicable rules" into
`null` — unrestricted. So a failed `iam_settings` read evaluated a
deny-by-default org as allow, and a failed `iam_group_members` read dropped
every group rule; in both cases a model the policy forbade was called. Four
callers gate model calls on this — the chat API, the embed chat, the notebook
model proxy and the BI planner — and each would have proceeded.

The same shape three more times in the same file and its callers:
`resolveGrantedResourceIds` dropped both of its reads (a failed grants read →
"nothing is shared with you", at sixteen call sites); `requireSuperadmin`
dropped its role read and fell through to the bootstrap claim, which writes;
and two callers of the resolver — `grantedDatasetIds` and `grantedIdsFor` —
caught its throw and answered "no grants", so a prep flow or BI refresh ran
over a short source list and a granted credential became "no credential
configured".

Every one of these reads its error now and throws with the reason. A policy
that cannot be read fails CLOSED: each caller answers the model call with an
error instead of making it, the listings fail with the reason instead of
answering short, and the superadmin guard refuses instead of claiming.

This round's UI half is the regression half only, as R41's was: the failure
cannot be injected from the browser (the reads are the server's own), so it is
proved by behavioural tests on the real functions against a client whose reads
fail one table at a time — the settings case resolved `null` before the fix and the memberships case `[]`
— and the browser confirms that under the live policy (deny-by-default off, no
rules) a model call still succeeds and the IAM page reads the same.

**Tests:** 10 behavioural on `getEffectiveModelRules`, `resolveGrantedResourceIds`
and `requireSuperadmin`, 2 source-anchored on the two callers; 8
behaviour-changing mutants each killed, control missed, baseline green first.

### 2026-09-21 — Loading is not zero, and a pass without a session is not an answer

#### R52 · S2 · "Local tables 0" for ten seconds, then "33" for two, on every full load

The timeline that corrected R51's cause. A fresh load of `/data-sql`, sampled
every two seconds, untouched:

| t    | Sources panel                         | server-function calls |
| ---- | ------------------------------------- | --------------------- |
| 8 s  | `Local tables 0`                      | 0                     |
| 18 s | `Local tables 33`, no `sftest` row    | **0**                 |
| 20 s | `Local tables 26` · `sftest 7`        | 1 (made at 17.97 s)   |

Two wrong answers before the right one. The first is the loading state rendered
as a count: R50 taught the panel to say `—` when the read FAILED, and nothing
covered "not read yet", so the ten seconds of hydration read as an account
with no local tables. The second is a pass that ran before the session had
resolved: `token` was `""`, `reloadLocal` skipped the connections call by
design, filed every synced dataset as an upload, and painted it; the
token-driven re-run corrected it two seconds later. Both were painted as
facts, and the 33 had already sent two rounds of notes after the wrong cause.

Now the local half has a `localLoaded` flag set by the first read's success
OR failure — a failed read is a read — and while it is neither, the panel
shows `Local tables …`, the totals carry `+` with the title "still loading —
crawled assets only". And `reloadLocal` returns before doing anything when
there is no token: the callback is rebuilt on the token, the mount effect runs
again with it, and the first paint is the right one.

**Tests:** 5 source-anchored, R50's moved with the expressions they pin; 6
behaviour-changing mutants each killed, control missed, baseline green first.

### 2026-09-21 — A failed read of where a table came from, answered as "here"

#### R51 · S2 · "Local tables 33" where 26, and a connector's row gone

First seen by accident, and first explained wrongly. After R50's rebuild the
Sources panel read **Local tables 33** with the `sftest` connector row missing,
and R50's notes blamed the connections server call failing while the container
was still `health: starting`. Sampled every two seconds during this round's
validation: the first `reloadLocal` runs before the session has resolved, with
no token, so it never asks for the connections at all — zero server-function
calls — and paints 33 at 18 s; the token-driven re-run makes the one call at
18 s and paints 26 at 20 s. Two seconds of a wrong attribution, by design, not
a failure. Then measured on purpose: with only the attribution read
(`select=id,saas_connection_id`) rejected, the same 33, the same missing row,
and the seven synced `sftest_*` datasets listed with SOURCE "Local tables". No
toast, no banner; 8 rejected requests.

Two reads decide where a table came from, and both dropped their failure: the
attribution query was destructured as `const { data: attribution }`, and the
connections call was `listConnectionsFn(...).catch(() => [])`. Either one
failing made every connector-synced dataset an upload — which is the wrong
source, the wrong sync status, and the wrong "re-crawl" affordance, presented
as fact.

Both failures are read now. The last attribution and connection list that were
actually READ are kept in refs and used across a failed re-read; until a read
has landed, the tables sit under Local tables and a banner says so —
`Where synced datasets came from could not be read — they are listed under
Local tables until it can be: …` — with a Retry. After a failed RE-read the
banner says the attribution shown is the last known one. Each wording is
gated on whether an answer exists, so a first-load failure cannot claim one.

**Tests:** 5 source-anchored; 6 behaviour-changing mutants each killed, control
missed, baseline green first.

### 2026-09-21 — The catalog counted a failed read as zero

#### R50 · S1 · "All assets 21 · Local tables 0" over a rejected read

Seen while validating R49: with every `user_data_tables` request rejected, the
Data Catalog's Sources panel read **All assets 21 · Local tables 0** and the
list footer **21 of 21 assets**. Normally it reads 54 · 26 · 54 of 54. No toast,
no banner — one `console.warn` — and 33 assets gone: the 26 local tables and
the 7 connector-synced datasets that are stored the same way. A search for any
of them answered "no results".

`reloadLocal`'s catch had a comment saying a hydration failure "is not an empty
account", and then did `setLocalAssets([])`. The warn was the whole
disclosure.

The catch records the failure now and leaves the last good list alone. While
the local half is UNKNOWN — a failure with nothing loaded yet — the Sources
panel shows `Local tables —` rather than `0`, the totals read `21+` and `21 of
21+ assets` with the title "crawled assets only", and a banner above the list
says `Local tables could not be loaded: …` with a Retry. After a failed RELOAD
over a populated list the counts stand and the banner says the list may be
stale. The prep tab's collapsed section header, which read `Local tables 0`
beside its own R49 error state, shows `—` there too.

**Tests:** 8 source-anchored; 7 behaviour-changing mutants each killed, control
missed, baseline green first.

### 2026-09-21 — A failed list is not an empty account

Both of these were found by driving the page, and neither could have been found
another way: the first is a handler with no try, the second is a `[]` that
twelve callers each read as "nothing here".

#### R48 · S2 · The first caller to meet R46's throw had nowhere to put it

R46 made the checked reader THROW on a failed window instead of registering a
partial table. Driving `/data-sql` with every `user_data_rows` request rejected
and pressing Refresh: the console showed `Uncaught (in promise) could not count
rows of …`, the icon spun indefinitely, and nothing on screen said the refresh
had failed. The dataset list stayed as it was — right, a failed refresh is not
an empty account — but a control that silently does nothing under failure is a
control the user keeps pressing.

The mount path had a try and toasted; `refreshTables` was four lines with no
try at all. It has one now, the toast says `Could not refresh datasets: …`,
the spinner clears in a `finally`, and the datasets are deliberately left
untouched.

One of the round's own tests matched the word "catch**es**" in the comment above
the try — a bare `/catch[^}]*setDatasets/` ran forward from the prose into the
try's own `setDatasets(tables)`. Pinned as `catch (e) {` now, reading only the
body that opens.

**Tests:** 5, four behaviour-changing mutants each killed, control missed.

#### R49 · S1 · A failed table list answered as an empty account

`hydrateFromSupabase` read the dataset list as

```ts
if (error || !tables) return [];
```

Driving the workbench with every `user_data_tables` request rejected and
pressing Refresh: the thirty real tables in the sidebar were replaced by
**"No tables yet. Upload a file to get started."** — no toast, spinner cleared
after about 3.5 s, 38 rejected requests by then. Restoring `fetch` and pressing
Refresh brought the same list back; nothing was lost, the page had only said so.

The same `[]` reaches the mount path, which reads an empty list as an empty
account and calls `ensureSampleDataset`. The injection log filled with the
seeder's own existence checks — `select=id&name=eq.saas_sales&is_sample=eq.true`
— every one rejected, and `ensureOneSample` reads that result as
`const { data: existing }`: a failed check IS an absent sample, and it seeds.
The registration RPC returns the existing id without writing (its body was
checked), which is the only reason that round changed nothing. The row insert
below it is guarded by a count read whose error is dropped the same way; a
failed count reads as 0, and 0 means "insert every sample row" — on top of the
rows already in the table.

The Data Prep tab's reload wiped its list to `[]` on failure, a false empty
with the copy "upload a CSV on the Workbench tab"; leaving it `null` instead
would have shown the loading skeleton forever, which is R48's shape again. So
both surfaces now have an explicit failed state — "Datasets could not be
loaded: …" with a Retry — tested BEFORE the empty branch, and a list that a
failed refresh could not replace carries "Last refresh failed … showing the
previous list" for longer than a toast lasts.

The list read throws with the server's reason; the existence check and the
count read throw; twelve callers meet that throw, and all twelve already met
the rows-path throw from R46, so no new failure shape reaches any of them.
Three of them render absence on catch and are queued rather than fixed here:
`docGen/biData` drops every chart of a document when the list cannot be read,
`bi_.report` swallows the failure entirely, and `chatBi` answers "no datasets"
— now only on a true empty.

**Tests:** 5 behavioural on the real `ensureSampleDataset` against a client
whose reads fail one at a time — both failure cases resolved `true` before the
fix — and 8 source-anchored on the three call sites; 8 behaviour-changing
mutants each killed, control missed, baseline green first.

### 2026-09-21 — A flag that named the wrong defect, and the last of the pagers

#### R47 · S2 · Two sites I had recorded as mitigated were not

R44 fixed the three offset-advance sites where nothing downstream could tell,
and left `bi/quality` and `etl/service` in the queue with "skips, but `capped`
catches it" and "skips, but `truncated` catches it". That was wrong, and it was
wrong in an interesting way.

Both flags report the same thing: **fewer rows were read than the count**. A
reader takes that to mean the work below ran over a PREFIX of the table — the
first N rows, missing a tail. Under a server cap smaller than `PAGE` that is not
what happened. Their offsets advanced by the request size, so every clamped page
left a hole, and the rows on hand were a SCATTER.

A null rate, a distinct count or a min/max over a scatter is not a partial
answer, it is a wrong one. An ETL step over a scatter produces output that is
wrong rather than short. And the flag sitting beside the result tells the reader
the wrong thing about it, which is worse than no flag: it converts a defect into
a caveat, and caveats get accepted.

The general shape, worth keeping: **a disclosure is only a mitigation if it
describes the defect that actually occurred.** "We read fewer rows" and "the rows
we read have gaps" produce identical flags and completely different answers.

Both read through `selectAllPages` now, ordered by `id`, and `capped` /
`truncated` come from the scan rather than from a count comparison that could
not tell the two apart.

#### R47 · S3 · The sweep's own module had the milder half

`pageTraces` in `lib/traceWindow` — written by this campaign, for exactly this
class — stopped at the first page shorter than the one it asked for.

It never skipped: it stopped rather than advancing past a short page, so the
window headline it feeds stayed honest. On a deployment whose `db-max-rows` sits
below the page size it simply said "showing the most recent 400 of 2,731 traces"
where it could have said 2,731 — truthful, and needlessly degraded. It advances
by what it received now, and ends on a page shorter than one the server has
already produced.

**Tests:** 5 behavioural for `pageTraces` (including every row read at a cap of
400 against 2,731 rows) and 7 for the two server sites, 10 behaviour-changing
mutants applied one at a time and each killed, control missed, baseline verified
green first.

#### R47 · The sweep is closed

Nine hand-rolled pagers were found by grepping for one assumption. All nine are
done: three that persisted (R43), three that skipped unnoticed (R44), the audit
export (R45), the parallel reader (R46), and these three. `audit.functions`
remains and is deliberately out of scope — it pages the Auth admin API, which
honours its own page size and has its own pagination contract; its only issue is
a folded error, which belongs to the failed-read sweep rather than this one.

### 2026-09-21 — Five windows at once, and any one of them could end the read

#### R46 · S1 · Four defects in one loop, feeding the SQL engine

`lib/sqlEngine` loads a whole dataset into the in-page SQL engine five windows at
a time. What a user's query answers — and what the AI SQL path reads — is
whatever this put into the engine.

```ts
let stop = false;
for (const { data: chunk, error: rowErr } of results) {
  if (rowErr || !chunk || chunk.length === 0) { stop = true; break; }
  allRows.push(...chunk.map(...));
  if (chunk.length < PAGE) { stop = true; break; }
}
if (stop) break;
pageIndex += PARALLEL_PAGES;
```

1. **A window's ERROR became `stop`.** One failed request out of five ended the
   read, and the table registered with whatever the other four returned. No
   error surfaced anywhere; the query simply answered from less data.
2. **No `ORDER BY`, while issuing five concurrent windows.** Postgres promises
   no order without one, so the five were not guaranteed consistent with each
   other, let alone a partition of the table.
3. **The first short window ended everything** — including the windows already
   fetched and paid for in the same batch, which were discarded.
4. **Offsets were `pageIndex * PAGE`**, the request size, so a server handing
   back less than a full page left a hole at every window boundary. R44's defect,
   with five chances per batch.

The replacement is `selectAllWindows` in `lib/pagedSelect`, beside the sequential
pager: count, one probe window whose LENGTH is the page size this server
actually honours, then batches of `concurrency` windows of that size, then a
check that the rows add up. Any error aborts the whole load. More rows than the
count is fine — that is a concurrent insert, not a gap.

The count check is what makes parallel offsets safe to use at all: windows
derived from a count either cover the filter or they do not, and a clamped
window, a skipped row or a short page surfaces there rather than in someone's
query result.

#### R46 · S1 · A failed shared read registered an empty table

In the same file, four lines up:

```ts
if (rpcErr || !Array.isArray(data)) return [];
```

A failed `shared_dataset_rows` RPC registered the table with no rows, so a query
against it answered "no results" — which is also exactly what an empty dataset
answers. Nothing on screen separated the two. It throws now.

#### R46 · note · Extracted so the tests could be real

The first version of this fix was written inline in `sqlEngine`, and the tests
for it would have been what the last two rounds settled for: a replica of the
algorithm in the test file, plus source anchors on the production code. That is
weak, and this algorithm — probe, derive the window size, batch, verify — is
intricate enough that a replica proves very little.

So it moved into `lib/pagedSelect` and the tests drive the real thing: every row
read exactly once at a cap BELOW the page size, one failing window aborting the
load, a count mismatch refusing, a stale count accepted, a single-window table
costing one request, and — because a correct-but-sequential version would have
passed everything else — an assertion that the windows really do overlap in
flight.

**Tests:** 14 in `parallelWindows`, 9 behaviour-changing mutants applied one at a
time and each killed. Six of the nine attack the algorithm itself rather than a
source anchor, which is the return on extracting it.

### 2026-09-21 — The one path that ended the evidence stream without saying so

#### R45 · S1 · A complete-looking export of a third of the audit trail

`/api/audit/export` streams the compliance trail as NDJSON so an enterprise can
ship it to its own SIEM. It is careful nearly everywhere: superadmin only,
invalid dates rejected rather than silently widening the range, one page per
`pull` so backpressure is honest, and — the part that matters — a mid-stream
failure emits a final error line, with a comment saying exactly why:

> Mid-stream failure: emit a final error line so the consumer can tell a
> truncated export from a complete one.

Then it closed on a short page:

```ts
if (data.length < PAGE) controller.close();
```

That is the ONE exit that ends the stream without emitting that line, and it
fires whenever the server hands back fewer rows than asked for — `db-max-rows`,
which belongs to whoever runs the database, not to this code. On a project tuned
below `PAGE` the export closes after a single page and writes a file that is
byte-for-byte a valid, complete-looking export of a fraction of the trail. For
evidence that is the worst available property: not missing, not erroring, just
quietly less. Measured here: `audit_events` holds **2,010 rows**, so a full
export is three pages and a cap below 1,000 is all it takes.

A short page proves nothing; an empty one proves the end, and the branch above
already handled it. The close is gone. The cost is one extra request, and only
where a page was actually short — two full pages already needed an empty third
to know they were done, which is why removing it is free in the common case.

**The ORDER BY gained `id`.** `spec.ts` is `created_at` or `started_at`, and two
events can share a timestamp to the microsecond. Offset paging over a non-unique
order is not a sequence: the planner may return one of them at the end of page
one and again at the start of page two, and the other never — a row that did not
happen beside a row that happened twice, in the file someone opens precisely
because they need to know which.

**Tests:** 9 in `auditExportStream`, 8 behaviour-changing mutants applied one at
a time and each killed — including one that drops the superadmin guard — control
missed, baseline verified green first.

The behavioural half runs the route's loop shape against a table that clamps
like PostgREST does, at caps of 1, 7, 500, 999, 1,000 and 4,096, because the fix
is a DELETION and "the line is gone" is the weakest possible assertion about
one. Its honest limit: `drain` replicates the loop rather than importing it, so
it documents the defect while the source anchors pin the code. Driving the real
handler would mean restructuring the route for testability, which is a larger
change than this round should carry.

#### R45 · S3 · The comment answered for the code, again

`expect(SRC).toContain("_export_error")` passed under a mutant that emitted a
bare newline instead of the error object — because the token appears in the
comment above the branch, explaining the feature. Fourth of this family in one
session, third caused by prose in the file under test.

The remedy differed this time. Twice before, the comment was reworded. Here the
key name in prose is genuinely useful to a reader ("look for `_export_error`"),
so the ASSERTION moved instead, onto the encode expression:

```ts
expect(SRC).toMatch(/JSON\.stringify\(\{ _export_error: error\.message \}\)/);
```

Which suggests the general rule is not "never mention the code in a comment" but
**pin something only code can be**: a chained call, an expression, an argument
position. A bare identifier is prose as easily as it is code.

### 2026-09-21 — The offset that advanced by what it asked for

#### R44 · S1 · Not a short tail. Holes.

`start += PAGE` after a page that came back short does not truncate a read — it
puts **holes** in it. Ask rows 0-999, receive 500 because `db-max-rows` says so,
then ask 1000-1999: rows 500-999 are never requested at all.

That distinction is the finding. A missing TAIL can be caught by comparing what
was read against an exact count, and several call sites in this repo do exactly
that — `bi/quality` sets `capped`, `etl/service` sets `truncated`. A missing
MIDDLE reports the same way: fewer rows than the count, a caveat about
truncation, and rows that are not a prefix of anything. Every figure computed
from them is wrong in a direction nothing can predict, and the caveat that fires
describes the wrong problem.

Five internal sites advanced by the request. Three had no way for anything
downstream to tell:

| Site                    | Error     | Order    | Discloses |
| ----------------------- | --------- | -------- | --------- |
| `tools/sql.server.ts`   | folded in | **none** | **no**    |
| `bi/prep.server.ts`     | folded in | **none** | cap only  |
| `bi/versions.server.ts` | correct   | **none** | **no**    |

**The SQL tool is the one that matters most.** It is what an agent calls to
answer a question about a dataset, and it was reading a table with its middle
missing, with the page's error folded into the exhaustion test and no `ORDER BY`
at all. The agent then answers, confidently, from a sample nobody chose.

**The version copy is the one with the sharpest irony.** Its error branch was
already right, and says so:

> A partial copy is worse than an honest metadata-only version: it would present
> itself as restorable and then silently lose rows.

The paging directly beneath that comment did precisely what the comment refuses
— a clamped page left a hole in a snapshot that still called itself restorable.
The fix is to make the paging agree with the doctrine the file already had.

All three read through `selectAllPages` now, which advances by the rows it
RECEIVED, orders by `id`, and reports whether its ceiling stopped it. The SQL
tool refuses rather than answering from a prefix (`SQL_TOOL_MAX_ROWS`, default
200,000); prep keeps naming the datasets it could not read whole; a version
stores metadata only rather than a copy with gaps.

**Tests:** 15 in `offsetAdvance`, 8 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

The test file keeps the OLD loop as `legacyPager` so the defect stays
demonstrable rather than described. Against 2,500 rows behind a server that
hands back 400 it asserts not "too few rows" but **which** rows were never
asked for:

```ts
expect(seen.has(399)).toBe(true);
expect(seen.has(400)).toBe(false);
```

#### R44 · S3 · The test double was shaped to the bug

`embedBiAllowList` drives the SQL tool against a fake Supabase client, and the
fix broke it twice over.

The shallow break: the stub had no `.order()`, because the query never had one.
Adding the method is trivial. The interesting break is underneath it — the stub
**ignored the range window entirely** and returned every row of the table for
any page, faking an ending with a flag that made the un-ranged call return `[]`:

```ts
// Second page must come back empty or loadUserTables loops forever.
data: ranged ? (rowsByTable[id] ?? []).map((row) => ({ row })) : [],
```

That only works against a pager that stops at the first short page. The comment
even says so: the stub had to manufacture an ending because the loop it was
written for could not find one honestly. A pager that advances by the rows it
received asks for page after identical page until its ceiling — which is what
happened.

So the double had been built to the shape of the defect, and it would have kept
any correct implementation looking broken. It honours `range` now, which is both
the fix and a truer stand-in, since the real builder does.

A test double that models the call shape a buggy caller happens to make is not
neutral: it votes for the bug. When a fix makes a stub fail, the question is
which of the two was describing the real system.

#### R44 · process · Having the list is not running the list

Before the gate, `tests/` was grepped for everything touching the three files —
eighteen of them, `embedBiAllowList` included — and then eleven were run. The
gate found the other one. The habit added in R40 was "grep for the files the
round touched and run those first"; the habit that was missing is running all of
what the grep returns. Nineteen files, 305 tests, is thirty seconds.

#### R44 · process · The gate was flaky, and the flakiness was measured, not assumed

Two consecutive full gates failed with 10 and 4 failures, every one a 20-second
TIMEOUT, in files this round never touched — `duckdb.test.ts`,
`connectedIntegrations`, `nl2sqlEval`, `aiAnalyst`. Each run reported ~640s of
test time against a suite that normally takes a fraction of that, with a Docker
stack of fifteen containers on the same machine.

Rather than re-rolling the gate until it came up green — which would have meant
trusting a green run after discarding two red ones — every step of `npm run check`
was run separately with its own exit code, and vitest pinned to four threads:

```
typecheck 0 · lint 0 · check:docs 0 · check:md-docs 0
check:doc-commands 0 · check:infra 0 · vitest 0 (396 files) · build 0
```

The suite is green; the aggregate gate is unreliable on this machine under load.
That is a property of running 7,497 tests beside a container stack, not a defect
in the product, and the repo's test timeout was deliberately left alone —
raising it to suit one laptop would hide exactly the kind of slowness a timeout
exists to surface.

### 2026-09-21 — The pagers that write, not the ones that print

#### R43 · S1 · A failed page replaced a lakehouse table with a prefix of itself

R41 fixed the shared helper. Grepping for the assumption it removed found
**seventeen** hand-rolled copies, twelve of them against PostgREST. Three of
those do not render a sentence — they produce a lakehouse table, a materialised
Parquet mirror, and the rows a dashboard widget computes its stored answer from.

Each carried some combination of the same three faults:

- the page's error folded into the exhaustion test, so a statement timeout was
  indistinguishable from the end of the data;
- `chunk.length < PAGE` as proof of the end, which holds only when the server
  returns everything it is asked for;
- offset paging with **no `ORDER BY` at all**, which Postgres makes no promise
  about. That one does not undercount — two pages can repeat one row and drop
  another, moving the answer in either direction.

| Site                     | Error            | Ordering | Short page |
| ------------------------ | ---------------- | -------- | ---------- |
| `lakehouse.functions.ts` | **discarded**    | by `id`  | breaks     |
| `bi/refresh.server.ts`   | **folded in**    | **none** | breaks     |
| `data/parquet.server.ts` | thrown (correct) | **none** | breaks     |

The lakehouse import is the sharpest. It bound no `error` at all — a failed page
simply ended the loop — and the rows gathered so far went into
`CREATE OR REPLACE TABLE ... AS SELECT * FROM read_json_auto(...)`. So a
statement timeout did not fail the import; it **replaced an existing lakehouse
table with a prefix of itself**, which SQL models, BI widgets and training runs
then read as the dataset. Nothing anywhere says a table is short rather than
small.

All three now read through `selectAllPages`, order by `id`, and **refuse at
their ceiling rather than persisting a prefix**. Refusing is the point: a
truncated display can carry a caveat, but a truncated table cannot.

**This round changes behaviour under load, and that is worth saying plainly.** A
workspace with a dataset over `BI_LOCAL_ROWS_PER_TABLE_CAP` (20,000, and now an
env knob precisely because reaching it is a refusal) and no Parquet mirror will
get a failed widget refresh naming the knob, where before it silently got a
number computed from the first 20,000 rows. Datasets that size normally have a
mirror — `PARQUET_MIN_ROWS` defaults to 5,000 — so this is reachable only with
mirroring off or not yet synced. It is the correct trade, and it is a real change
in what an operator sees.

**Tests:** 16 in `rowPagers`, 9 behaviour-changing mutants applied one at a time
and each killed, control missed, baseline verified green first.

#### R43 · S3 · The same two anchor traps, in one round

The negative assertion "the folded-in error is gone" failed on its first run —
against the comment above the new code, which quoted the old expression to
explain why it went. Same shape as R39, and the remedy was the same: change the
PROSE, not the pattern.

And a mutant that passed a bare `20_000` to the scan while leaving
`localRowsPerTableCap()` in the error message survived a plain `toContain`. The
sibling occurrence answered for the one under test — third time this session a
symmetric copy has stood in for the site being checked. The assertion pins the
argument position now.

### 2026-09-21 — Group budgets asked the database for a user with no id

Both findings below came out of driving the pages in a browser, after seven
rounds of unit tests and mutants had found neither. That is the entry's point
as much as the defects are.

#### R42 · S1 · Every group spend query the product has ever made was a 400

The admin Budgets tab had nothing to show, because this deployment has no IAM
groups. So a throwaway group was created — one member, a $5 cap — and the spend
cell rendered:

> unknown

with the reason in its tooltip: **`invalid input syntax for type uuid: ""`**.

`budget_spend_since(_user_id uuid, ...)` is called by both group callers with
`userId: ""` and a member array, so Postgres was being asked to cast an empty
string to `uuid`. Proven directly against the database:

```
_user_id ""    -> 400  invalid input syntax for type uuid: ""
_user_id null  -> 200  1.677463
single user    -> 200  1.677463   (control)
```

That error does not match the "function is missing" test in `spendSince`, so it
returns `ok:false` without trying the row-scan fallback, and `groupSpend` turns
that into `null`. What `null` costs depends on a setting:

- **`BUDGET_FAIL_CLOSED` off** — the default — the guard `continue`s past the
  group cap. A team ceiling is configured, rendered in the admin UI, and
  **enforces nothing**.
- **`BUDGET_FAIL_CLOSED` on** — `decision = { over: true, scope: "group", spend: 0 }`.
  **Every member of every capped group is refused on every call**, with the
  spend that justified it reported as $0.

Neither is visible outside one `console.warn`. The function's own authorisation
branch is written for the right shape — `_user_ids IS NULL AND auth.uid() = _user_id`
— so a group query was always meant to arrive with `_user_id` null.

**Why the suite missed it.** All 100 budget tests passed before the fix and
after. Every one of them is source-anchored: they read `budgetSpend.server.ts`
and assert on its text. Not one had ever put an argument on the wire. The new
`groupSpendRpc` test mocks the admin client and asserts what is actually sent —
null, never `""`, and never anything that is not a uuid — and it was checked
against the code as shipped, where it fails.

R39's display is the reason this surfaced at all: it printed "unknown" rather
than the confident `$0.00` the old browser-side sum would have produced from an
empty array. The fix it received was to say when it does not know, and the first
thing it did was say so.

#### R42 · S2 · The fallback sum had R41's defect, on the path that gates spend

`fallbackSum` — the pre-migration path that still enforces on an un-migrated
instance — ended each page with `if ((data?.length ?? 0) < PAGE) return { ok: true, ... }`.
Same assumption as `lib/pagedSelect` before R41: a page shorter than the
REQUEST proves nothing, because `db-max-rows` is the operator's setting. It now
advances by what came back and only ends on a page shorter than one the server
has already produced. It sums as it goes rather than collecting, so it cannot
call the shared helper — a budget path must not hold fifty thousand rows to add
up one column.

#### R42 · S2 · A truncation caveat over a failed read (in R40's own fix)

Driving the run detail page with the step read failing showed the banner
working — "The detail of this run could not be read — ... The totals above come
from the run itself and still stand" — and directly beneath it:

> Showing the first 0 of 4 steps. The canvas, the timeline and the per-step
> figures cover these only …

That is what a SUCCESSFUL read of a prefix looks like. Two sentences, one
failure, different stories — and the tab beside them said `Data flow (0)`,
claiming zero edges from a read that never returned any. The unit tests could
not see it: `runStepsCaveat({ fetched: 0, total: 4 })` is correct in isolation,
and the defect was entirely at the call site. Both now defer to `loadError`, and
the harness kills a mutant for each.

**The rule this round adds.** A disclosure helper is written for one situation;
the call site has to decide whether that is the situation it is in. "Partial"
and "failed" produce the same empty array, and only the caller knows which
happened.

### 2026-09-21 — The paging helper assumed the server's cap was its own

#### R41 · S2 · The module written to stop the undercount could produce it

Chasing the `db-max-rows` class upstream found where it was already known.
`src/lib/pagedSelect.ts` was written by an earlier round for exactly this
defect — its header records the dashboard reporting **$1.84 for a window whose
real cost was $5.77**, a 68% undercount — and every page it reads ends on this
test:

```ts
// A short page means the filter is exhausted. Only a page that came back
// completely full can have more behind it.
if (page.length < to - from + 1) return { rows, truncated: false };
```

That is sound only if the server returns everything it is asked for. It does not
have to: `db-max-rows` is the OPERATOR's setting, and the module hard-codes
`PAGE = 1000` while calling it "the largest page PostgREST will return" — an
assumption about somebody else's configuration, in a file whose own header
insists the ceiling "is a CEILING, not a default". On a project tuned below
1,000, or a self-hosted Supabase with its own `postgrest.conf`, every page comes
back short and **the first one ends the read with `truncated: false` holding a
fraction of the rows**.

`truncated` is what `dashboard.functions.ts` renders as `partial`. So the failure
mode is this module's own reassurance printed over the undercount it exists to
prevent — and the smaller the operator's cap, the worse the undercount and the
more confident the label.

The fix keeps the offset API and costs the ordinary case nothing. Track the
largest page the server has ACTUALLY handed back, and treat a page shorter than
that as the end: shorter than what was _requested_ proves nothing, shorter than
one the server already produced proves exhaustion at any cap. The offset
advances by what came back rather than by what was asked for, so a smaller cap
simply takes more rounds. All seven pre-existing tests pass unchanged, request
counts included — `seen` is still `[0, 1000, 2000]`.

Two smaller things in the same spirit. A filter matching exactly `maxRows` rows
was reported truncated; a caveat on a complete answer teaches readers to ignore
caveats, so one extra row settles it. And the probe's own error is propagated
rather than swallowed, because it decides the one flag this module exists to
set.

**The finding was available in the test file all along.** `fakeTable(total, cap)`
has always taken a cap, and nothing ever passed one below `PAGE`. The parameter
that would have shown this was sitting in the fixture, unused.

**Tests:** 15 in `pagedSelect`, 8 behaviour-changing mutants applied one at a
time and each killed — the first of them being **the original loop restored in
full**, which is the only way to know the new tests would have caught the old
code — control missed, baseline verified green first.

One mutant survived the first run: dropping the `want === PAGE` guard. When
`maxRows` is not a whole number of pages the last window is narrow by design,
and a page that fills it is not evidence of an end — it is the ceiling arriving.
Reading it as exhaustion returns `truncated: false` on a read that stopped
short: the original silent undercount, moved from the cap to the boundary. The
existing truncation test used `maxRows` of 3,000, a clean multiple, so the
narrow window never occurred. Now one uses 2,500.

#### R41 · note · Why this jumped the queue

The cursor said Semantic layer. This is the shared mechanism under the
dashboard's spend figure and the metrics page, the defect is in the same class
the sweep is working through, and it could be demonstrated deterministically
from a fixture already in the repo rather than argued from configuration. The
two paging modules now cross-reference each other, so the next person choosing
between them is told which question each answers.

### 2026-09-21 — A swarm run's canvas could be a prefix of the run it draws

#### R40 · S2 · A DAG from a prefix is not a smaller graph, it is a wrong one

`/analytics/observability/$runId` read the steps and the edges of one run with
no bound:

```ts
supabase.from("swarm_run_steps").select("*").eq("run_id", runId).order("started_at"),
supabase.from("swarm_run_edges").select("*").eq("run_id", runId).order("created_at"),
```

Past `db-max-rows` the timeline, the data-flow list and the canvas are a prefix.
The canvas is the one that matters: a truncated node set with a truncated edge
set does not draw a smaller swarm, it draws a broken one — edges arriving from
nodes that are not on the page, branches that appear never to have run.

What makes this page tractable is an asymmetry it already had. `step_count`,
`total_cost_usd`, `total_tokens_in/out` and `total_latency_ms` are **columns on
the run row**, written by the executor, so the header describes the whole run
however little detail came back. Verified against this deployment: `step_count`
matched the actual row count on all seven runs checked. So the page can state
exactly when its list is a prefix without asking the database anything extra —
and it must, because otherwise a header reading "Steps 1,400" sits above a
timeline holding a thousand and the page simply looks like it cannot add up.
`runStepsCaveat` goes directly under the metrics row, where that discrepancy is.

Paging is by cursor on `id`, then sorted by `started_at` for display. Ordering
by `started_at` and paging by offset would not have worked: two steps of one run
can share a start instant, and a page boundary inside that tie drops rows.

#### R40 · S1 · A failed read drew a run that did nothing

The same two reads were `?? []`, and the run read's error was discarded outright.
So a failed query rendered an empty timeline, an empty data flow, an empty
canvas — or "Run not found.", which is a claim about the database that a failed
read has not established. All three now say the read failed, and the run's own
totals are kept on screen with a note that they still stand, because they do.

Rather than a new test beside it, the page is enrolled in
`tests/unit/failedReadClaims.test.ts` — the registry of pages that must not
report a failed read as an empty account, which already enforces the contract
(the claim routes through a real branch, the error is kept, a rejection is
handled, the list is never emptied without recording why). A page that satisfies
that contract belongs in the list, or the next person to touch it gets no
warning from the guard built for exactly this defect.

**Tests:** 45 in `traceWindow`, 15 behaviour-changing mutants applied one at a
time and each killed — including one that drops the page back out of the
registry — control missed, baseline verified green first.

#### R40 · S3 · An anchor satisfied by the sibling

Four mutants survived the first run, all for one reason. The page has two
pagers, one per table, and the assertions were `toContain`:

```ts
expect(page).toContain('q = q.gt("id", after)');
expect(page).toContain("{ maxRows: RUN_ROW_SCAN_MAX }");
expect(page).toContain('.order("id", { ascending: true })');
```

Remove the cursor from the STEP pager and the EDGE pager's identical line is
still in the file, and every one of those passes. The mutants that reverted one
pager to a single capped request, that ordered one by a non-unique column, and
that quietly capped one scan at 1,000 all went green.

This is the presence-is-not-use family again, one symmetry along: not a token
that no longer does anything, and not a comment quoting the code — a **sibling**
standing in for the site under test. The remedy is to count rather than to look:
`occurrences(page, needle) === 2`, which says what was actually meant — _both_
pagers are cursor-paged, ordered by a unique key, and bounded. Where a rule must
hold at several symmetric sites, an anchor that does not count checks nothing.

### 2026-09-21 — Group budgets were summed in a browser from a page of the traces

#### R39 · S1 · Three findings of this sweep in a single read

The IAM → Budgets tab read every trace of the current month into the browser and
bucketed the costs by group:

```ts
supabase.from("execution_traces").select("user_id, cost_usd").gte("created_at", iso);
```

**It is capped.** PostgREST answers with at most `db-max-rows`, 1,000 on a
default Supabase project. Measured on this deployment while writing this:
**1,104 traces in the current month**. So the sum was already over a prefix — a
group's spend rendered low, its percentage of cap rendered low, and the red
over-cap colouring withheld from a team that may well be over it. The comment
above the read called this "only for display", but a spend figure shown beside a
cap, in the admin tool for setting caps, is the thing someone acts on.

**A failed read is $0.** `traces ?? []` sums to zero and renders as "nothing
spent" — and `$0.00` is also exactly what an untouched group legitimately shows,
so the two are indistinguishable.

**Unpriced calls are free.** `cost_usd ?? 0` counts a call on a model with no
known price as costing nothing. R34 fixed precisely that in the path that
ENFORCES the cap; the display beside it kept doing it, so the two surfaces
disagreed about the same figure while sitting on the same screen.

The fix asks the enforcing path rather than writing a fourth version of the sum.
`groupSpendTotals` is superadmin-only, reads group membership by cursor — an
unbounded membership select has the same cap and would quietly make a group's
total too small — and calls `spendSince`, which prefers the database aggregate
and reports how many calls went unpriced. A membership list that could not be
read in full yields no total at all rather than a floor of a floor.

`floorTotal` moves the rule that decides whether a figure is the answer or a
lower bound out of JSX and into `spendCompleteness`, beside `formatSpend` and
`spendCaveat`. An unknown unpriced count is a floor, not a complete figure — the
same reading `budgetGuard` already uses — and having it in one place is what
stops the display and the gate from drifting apart again. The percentage carries
`≥` when the total is a floor, and the red stays: over a floor, "over cap" is
sound and "under cap" is not.

An unavailable figure says "unknown".

**Tests:** 11 in `groupSpend`, 11 behaviour-changing mutants applied one at a
time and each killed — including one that drops the superadmin guard and one
that declares the membership ceiling without passing it — control missed,
baseline verified green first.

#### R39 · S3 · The comment satisfied the assertion about the code

`expect(tab).not.toMatch(/\.from\("execution_traces"\)/)` failed on its first
run — against the comment above the new read, which quoted the old query to
explain why it went. The test's own comment claimed it was "anchored on the
chained call, not the table name"; it was not.

The remedy this time was to change the PROSE rather than the pattern: the
comment now describes the old read in words, and says why. A negative assertion
— "this call is gone" — cannot be satisfied by a comment if no comment spells
the call. Sixth of this family, and the first where the fix belonged on the
other side of the anchor.

#### R39 · process · A guard test that had to follow its property

`ownerFkCascades` asserts that a trace whose owner was deleted — `user_id` NULL
under `ON DELETE SET NULL` — is never bucketed under one phantom person and shown
as a team's spend. It pinned that with:

```ts
expect(GROUP_BUDGETS).toMatch(/if \(!t\.user_id\) continue;/);
```

Deleting the browser sum deleted that line, and the test went red. The property
itself did not go anywhere: the panel now asks the server for a per-group total,
and the server scopes the sum to the group's explicit member ids, so a detached
row matches no id and is excluded by the database rather than by a guard someone
has to remember to write — stronger than before.

So the assertion followed the property to where it lives now: the panel must not
bucket traces at all, the server function must pass `userIds`, and `spendSince`
must filter on them. That is the useful shape for a guard test whose subject
moves — re-anchor it at the new home and say in the comment why it moved, rather
than deleting it as stale or leaving it pinned to a line that no longer exists.

### 2026-09-20 — The knowledge base asked a membership question of a prefix

#### R38 · S1 · Documents that were already indexed got embedded a second time

Before embedding, the backfill asks which of the documents in its batch already
have chunks, and skips those:

```ts
const { data: existing } = await writer
  .from("kb_chunks")
  .select("document_id")
  .in("document_id", ids);
const have = new Set(existing.map((r) => r.document_id));
pending = docs.filter((d) => !have.has(d.id));
```

No limit, so it reads everything — except PostgREST answers with at most
`db-max-rows`, **1,000** on a default Supabase project, and supabase-js returns
the short page with no error and no flag. The batch is up to 50 documents; at
the default 500-character chunk size a 10 KB document is about 21 chunks, so
**fifty ordinary documents pass a thousand chunk rows**. Past that point some
indexed documents are simply not in the response, and `!have.has(d.id)` cannot
tell "no chunks" from "not in the page I was given".

What that costs: the documents are embedded again — paid API calls — and a
second copy of their chunks is inserted. Duplicate chunks are not just waste;
they change retrieval, because the same passage now occupies several of the
`KB_CHUNKS_PER_DOCUMENT` slots an answer is allowed to cite.

This is the partiality class at its sharpest. Every earlier finding in the sweep
was a number or a sentence that came out wrong. This one is a **set membership
test over a prefix**, where absence from the page read as absence from the
table, and the wrong answer spends money and mutates data.

The same read, with the same cap, builds the per-document chunk counts on the
Knowledge page — so the same documents carry an amber "Pending embedding" badge
while being fully indexed, "Indexed N/M" counts them as missing, "Embed X
pending" offers to fix what is not broken, and the Re-index button's force
decision (`indexed >= total`) is made from the same prefix.

**Cursor paging, not offset paging.** `lib/cursorScan.ts` asks for rows strictly
after the last one it saw, so it never uses a short page as proof of the end —
which matters, because "stop at the first short page" is wrong exactly when the
server's cap is below the page size asked for, and that assumption is what
produced this bug. Two shapes:

- `scanKeysPresent` answers membership and jumps past the whole of a key as soon
  as one of its rows proves it: a document with 40,000 chunks costs one page,
  not forty. At most one round per key, so it terminates even against a page
  source that ignores the cursor.
- `scanRows` keeps every row up to a ceiling and reports whether the ceiling
  bit. It probes one row past the ceiling before saying so, because a table
  holding exactly `maxRows` rows is not a prefix of itself and a caveat on a
  complete answer teaches readers to ignore caveats.

The failed-probe path changed too. The old read dropped its error, and an errored
probe produces an empty `have` — which is the most expensive possible reading of
a failure: re-embed everything. It now fails the backfill.

**Verified live** against the running deployment: for the 50 documents on hand,
the cursor scan returns the same membership set as the unbounded read (11 of 50
have chunks) in 2 requests, and stays correct past 1,000 rows where the
unbounded read does not.

**Tests:** 13 in `cursorScan`, 15 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

#### R38 · S3 · Presence is not use — the fifth, and the first caught by a mutant

`expect(page).toContain("const CHUNK_SCAN_MAX = 50_000;")` passed happily under
a mutant that declared the constant and then passed `Number.MAX_SAFE_INTEGER` to
the scan, which is the difference between a bounded client read and one that
pulls every chunk row in the workspace into a browser tab. The other four this
session were found by reading; this one was found by the harness, which is what
the harness is for. The assertion now pins `{ maxRows: CHUNK_SCAN_MAX }`.

A second anchor broke in the older way: `{chunkCountsWhole && indexCoverage.total > 0`
matched nothing once prettier wrapped the guard across three lines. Those are
regexes now. Source anchors must be bounded by structure, never by the
whitespace prettier chose that day.

#### R38 · process · The gate said 1 and the notification said 0

Third time this session. The background task reported "exit code 0" while the
shell's own `GATE EXIT` line said **1**; the notification reports the wrapper's
status, not npm's. The failure was real:

```
missing path (1)
  SCALE_AND_LIMITS.md: src/lib/cursorScan.ts
1 problem(s).
```

`scripts/check-md-docs.mjs` resolves a backticked repo path against **git's**
index, not the filesystem — so documentation may only name a file the repo
actually has. `src/lib/cursorScan.ts` existed on disk and was untracked, and the
paragraph describing it was, by that rule, a claim about nothing. The repo's own
tooling caught a drift this campaign exists to prevent, which is the outcome the
checker was written for. A new module has to be `git add`ed before the gate runs,
not at commit time.

### 2026-09-20 — The model registry's ceiling was half what the code thought

#### R37 · S2 · A cap of 2,000 that the database enforces at 1,000

`getModelRegistry` read the catalogue with a single `.limit(2000)` and the page
printed `models.length` as the population: "Browse 770 live models across all
major providers", with the provider dropdown, the modality badges, the
capability list and the search box all derived from the same array.

Two things are wrong with that, and the second is the one that makes it urgent.

**The truncation is not even.** The order is `developer, display_name`, so a
prefix is not a thinned-out sample of the catalogue — it is every developer up
to a letter. Measured against the live table just now: first row `AI21 / Jamba
Large 1.7`, last row `Zhipu AI / GLM-OCR`. Cut at any point and the providers
past the cut do not get fewer models on the page, they vanish from it entirely,
including from the provider filter that is supposed to find them. And because
the search box filters the array in hand, they cannot be searched for either.

**The 2,000 does not exist.** PostgREST caps every response at `db-max-rows`,
1,000 on a default Supabase project, and supabase-js returns the short page
without an error — the same mechanism recorded in `lib/traceWindow`'s header
when `/analytics` asked for 2,000 traces and got 1,000. Re-measured on this
deployment while writing this:

```
execution_traces | total 1,109 | returned for limit=2000: 1000
model_registry   | total   770 | returned for limit=2000:  770
```

So the registry's real ceiling is **1,000**, not 2,000, and the table holds
**770** — 77% of the way there, against a third-party catalogue that only grows
and is pruned to match upstream on every sync. This is the sweep's first finding
that is not yet wrong on the screen; it is wrong in the code, and the distance
to it being wrong on the screen is a few hundred models AIMLAPI has not shipped
yet. Recorded as S2 rather than S1 for exactly that reason.

The fix is the one the repo already has: read the exact count first, then page
with `pageTraces`, and let the header say which of the two situations it is in.
Three details worth keeping:

- The ceiling is `MODEL_REGISTRY_MAX_ROWS` (default 5,000) rather than a
  constant, because the thing it bounds is somebody else's catalogue.
- The ORDER BY gained `id` last. `developer, display_name` is not unique across
  modalities, and a page boundary inside a tie is how `.range()` paging starts
  repeating or dropping rows — a bug that would have arrived with the paging
  rather than being fixed by it.
- A count that fails does not fail the page. Rows on screen beat a perfect
  label; the label then claims only what it holds.

`catalogueCount` is a second sentence rather than another noun passed to
`countHeadline` because "the most recent 1,000" is a lie about an alphabetical
list. `catalogueCaveat` is its own sentence because the cost here is not an
undercount but an unreachable filter.

**Verified live** against the running deployment: exact count 770, paged read
770 rows, 770 distinct ids, `windowComplete` true — the new read returns the
whole catalogue today and knows that it does.

**Tests:** 37 in `traceWindow`, 13 behaviour-changing mutants applied one at a
time and each killed — including one that declares the env ceiling and then
passes the page size instead, and one that drops the unique tiebreaker — control
missed, baseline verified green first.

#### R37 · S3 · An anchor satisfied by the comment that explained the fix

`expect(fn).not.toContain(".limit(2000)")` failed the moment it was written,
because the comment above the new read names `` `.limit(2000)` `` to say why it
went. Had the wording been slightly different it would have passed forever while
the call sat there. It now matches a chained call at the start of a line, which
is a thing only code can be. Fourth of its kind this session, and the first
where the decoy was prose rather than a dead identifier: **pin the branch that
runs, not the token that appears** — and the token can appear in a comment.

### 2026-09-20 — The monitoring board went green when the probes stopped coming

#### R36 · S1 · A health verdict that outlived the probes it was made from

`/monitoring` polls every 15 seconds. When a poll throws, the catch does one
thing:

```ts
} catch (e) {
  setError((e as Error).message);
}
```

`setServices` is never called, so the previous probes stay on screen — and so
does the sentence made from them:

> No problems detected · checked 14:02:11

An hour later, that line still says **No problems detected**. The timestamp is
technically honest (it is also only set on success) but nobody reads a clock and
does subtraction, least of all on a page that advertises itself as auto-
refreshing. The reader sees a red banner — which says the _refresh_ failed — and
a green verdict beside it, and concludes the estate is fine and the UI is being
fussy. This is the canonical monitoring failure: the board that freezes green
when the collector dies, on the one page whose entire job is to say whether
anything is wrong.

**The first pass blessed this in a test**, which is the part worth recording.
Module 26 fixed the empty-probe case and then wrote:

> `it("keeps reporting the last-good status when a refresh fails but data remains")`
> — the error banner carries the failure separately.

Two surfaces, one claim. The banner carries _that the refresh failed_; it does
not carry _that the sentence beside it is therefore old_, and a reader who takes
the header at its word takes a reassurance the page can no longer support. A
test that encodes the defect is worse than no test, because the next pass reads
it as a decision already made.

The fix is the asymmetry this sweep keeps meeting. Over a stale snapshot the two
verdicts are not equally salvageable: **`N needing attention` is a floor** —
those services were broken and nothing has since confirmed a fix, so it is still
worth acting on — while **`No problems` is sound in no direction at all**, since
anything could have broken in the interval. The reassuring half is the unsound
half, exactly as with freshness (R31) and budget spend (R34). So both verdicts
move into the past tense and name the check they came from, which is what the
timestamp beside them has meant all along:

> No problems at the last successful check · checked 14:02:11

#### R36 · S2 · The gauges froze too, under a subtitle promising "right now"

`metrics` is set in the same `try`, so a failed poll freezes CPU, memory, disk
and process RSS at their last values as well — beneath a subtitle that reads
"what the machine running it is doing **right now**". Qualifying eight figures
individually would bury the page; `stalenessNotice` says it once, directly under
the banner, covering everything below it. It stays quiet when there is nothing
stale to warn about — a first load that failed with an empty page already has a
banner and an unknown-health header, and a third line there would be noise.

#### R36 · S3 · "No probe results yet" for a read that came back an error

The services table's empty state says "No probe results yet." The word _yet_
belongs to a load still in flight, not to one that returned an error: an empty
list that failed to read is the absence of an answer, not an answer of none.
That is the next queued sweep's class, found on a page already open, so it was
fixed here rather than filed.

**Tests:** 13 in `servicesSummary.test.ts` (the overturned one rewritten, with
the reason in the comment), 8 behaviour-changing mutants applied one at a time
and each killed — including one that restores the old `&& services.length === 0`
gate and one that computes the notice but never renders it — control missed,
baseline verified green first.

### 2026-09-20 — Swarm Observability presented its first page as the account

#### R35 · S1 · The sibling page's fix had never been applied here

`/analytics/observability` reads `swarm_runs` for the last 30 days with
`.limit(200)` and then says:

> 200 swarm runs · click a row to inspect agent-level traces · auto-deleted
> after 30 days

That is a statement about the ACCOUNT made by a read that saw only the first
page, and "auto-deleted after 30 days" sitting beside it makes the number read
as the whole retained history rather than as a page of it.

The first pass had already fixed this page's OTHER half: `listClaim` makes a
count and an empty state claims only a completed read may make, so a query error
prints "unknown" rather than zero. The capped half was never touched — and the
identical defect had been found and fixed on the sibling page, `/traces`, where
`lib/traceWindow` was written for it. That module's header says it exists "so
they are testable and cannot drift into implying completeness the read does not
have", and one page of the Observability pair was doing exactly that.

So the fix reuses the module rather than adding a second one: the noun is a
parameter, the exact count for the same window is read before the rows, and the
page either states the total or says "showing the most recent 200 of 1,312 swarm
runs from the last 30 days". When the window is cut, the list says so again above
the table — a reader who scrolls past the header is still entitled to know the
rows below are a page.

**Tests:** 24 in `traceWindow`, 8 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

#### R35 · S3 · Presence is not use — a third time

The source anchor checked that the file contains `countHeadline(`. A mutant that
put `${runs.length} swarm runs` in front of the call left that string in place
and printed the bare row count anyway, and the assertion stayed green.

This is the third source anchor this session satisfied by an identifier that no
longer did anything: `olderThanShown` still present while always set to zero, a
phrase matched in a doc comment instead of the log line it described, and now a
function still called but no longer rendered. The rule that keeps surviving
contact: **pin the branch that runs, not the token that appears.**

### 2026-09-20 — The budget gate counted unpriced calls as free

Three rows of the partiality sweep. Two clear, one the most consequential
finding of it so far.

**Traces & Logs — clear.** Its first-pass finding was "the capped page presented
as the population", and that fix reached every figure: the header goes through
`traceCountHeadline`, an incomplete window says "filters and counts below cover
these, not all N", a filtered view says "of the loaded traces", and per-row and
per-chain costs carry the unpriced label and the `+?` mark.

**Audit log — clear.** `auditWindowHeadline` already states shown-of-total and
the retention boundary.

#### R34 · S1 · The cap was enforced against a total that omitted part of the spend

`spendCompleteness` exists because a call on a model with no known price is
recorded at `cost_usd` 0 — honest on the row, labelled "unpriced" on the Traces
page. The comment beside that label reads:

> "$0.0000 for a call nothing knew how to price reads as 'free', and budgets
> summed exactly that."

Budgets did. **No file under the budget gate mentioned `pricing_missing`** — not
the spend query, not the guard, not the client mirror. So the cap meant to stop
spending was enforced against a total that silently omitted part of it, and the
omission grows with exactly the models nobody has priced yet.

The same asymmetry as R31, on money:

- **over** — sound. If the floor already exceeds the cap, the true spend does
  too, whatever the unpriced calls cost.
- **under** — not sound. Those calls could carry any amount, and the one that
  would tip it over is exactly the one counted as free.

`spendSince` now reports how many calls contributed nothing, and the guard
treats a floor under the cap the way it already treats a lookup that failed:
allowed by default, refused for an operator who set `BUDGET_FAIL_CLOSED` because
they need the cap to hold. **Nothing changes for a default install.** The floor
is logged and carried on the status either way, so an operator sees the cap is
being enforced against an incomplete figure rather than learning it from a bill.

A count that itself fails reports null rather than zero — "no unpriced calls"
and "we could not tell" lead to different decisions under a cap that must hold,
and collapsing them is the same mistake as reading a failed sum as $0.

**Tests:** 27 in `budgetSpend`, 8 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

Two assertions were weak, and mutants found both rather than reading did. One
pinned the whole one-line `SpendResult` type, which prettier reflows the moment
a field is added. The other asserted the phrase "is a floor" — which also
appears in a doc comment, so a mutant that rewrote the message an operator
actually reads stayed green. Both pin something load-bearing now.

#### R34 · S3 · A queue row anchored on its own formatting

The queue update failed on its first attempt: it matched whole table rows
including their padding, and prettier reflows every column width whenever any
cell changes. It matches on the row LABEL now. The same lesson as the source
anchors — pin the thing, not the layout around it.

### 2026-09-20 — A baseline that fell off the end of a list

#### R33 · S2 · The compare control did not shrink, it disappeared

The run detail page offers "Compare against": pick an earlier run on the same
dataset, see which cases improved or regressed. It built that list by filtering
`runs` — the **fifty most recent runs across every dataset**.

On an account that evaluates regularly, a perfectly good baseline stops being
offered once fifty newer runs exist elsewhere. And the control is rendered
behind `comparable.length > 0`, so the user does not get a shorter list: the
feature is absent. No picker, no message, nothing to separate "there is nothing
to compare" from "your baseline is run fifty-one".

The list now comes from a query scoped to the dataset, excluding this run,
newest first — so the fifty is a bound on the PICKER rather than a filter that
removes valid answers, and when the dataset holds more than fifty it says so
beside the control. An empty result states why instead of vanishing.

The rule moved to `evalScoring.isComparableRun`, because one of its three
conditions is subtle: two runs whose `dataset_id` are both null are not on the
same dataset, they are each on no dataset, and pairing them invents a
comparison.

**Tests:** 24 in `evalScoring`, 7 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

One survivor was a gap in an assertion rather than in the code: the source check
said the page contains `olderThanShown`, which stayed true under a mutant that
always set it to zero — silencing the disclosure while leaving the identifier
in place. It pins the computation now.

#### R33 · S1 · The fix reintroduced module 28's own defect, and a guard caught it

`tests/unit/failedReadClaims.test.ts` failed on the first gate run. The new
query destructured `data` and `count` and ignored `error`, so a failed read
would have set an empty list and the page would have stated "there is nothing to
compare against" — the exact false-empty this module was converted to prevent,
arriving through the repair for a different defect.

That guard exists because a previous mutation showed the same thing: dropping a
`setLoadError` beside a `setSecrets([])` restored an S1 while the suite stayed
green. It earned its keep here.

The read now separates a failure from an absence. Worth noting what the shared
guard does NOT cover: it checks that an error setter sits _near_ the emptying
line, and two mutants — deleting the error branch, and hiding what it records —
both preserved that proximity and survived. Those two lines are pinned
explicitly now.

### 2026-09-20 — A spend trend built from two floors

#### R32 · S1 · The uncaveated number sat on the caveated card

`spendCompleteness` exists because a call to a model with no known price is
recorded at $0 — honest on the row, silently under-counted once summed. Its
header says the row-level honesty "never reached the numbers people actually
look at", and the fix at the time routed the analytics month-to-date card
through `sumSpend`: it prints `$41.20+?` with a sentence explaining the mark.

Directly beneath that, on the SAME card, `trend={spendTrend}` — "vs last week" —
was computed from two bare reduces over `cost_usd`. One card saying both "this
total is at least this much" and "spend is down 40%", where the 40% could be
entirely an artifact of which of the two weeks held the unpriced calls.

**A trend is worse than a total, and that decides the fix.** A total has a
half-state: marked `+?` it is still a floor and still useful. A percentage has
none — the arrow points down or it does not — and the difference between two
floors is not a floor, it can be wrong in either direction. So when either week
is partial there is no honest percentage, and the reason is printed in its
place. The card shows no arrow rather than a 0% one, because 0% is a claim that
nothing changed. A zero baseline is treated the same way, by the same reasoning
that produced "0% pass" on an unscored evaluation run in R28 of the first pass.

**Tests:** 23 in `spendCompleteness`, 8 behaviour-changing mutants applied one at
a time and each killed, control missed, baseline verified green first. One puts
the bare reduce back on the page, because the defect was never in the arithmetic
— it was that the page did the arithmetic itself instead of asking the module
that knows what the rows are worth.

#### R32 · S3 · The hunt now has a queue

`docs/ADVERSARIAL_QUEUE.md`. The coverage map above finished a first pass over
all 31 modules in August; running it again module-by-module would mostly re-read
pages already read. What has been finding things for thirteen rounds is the
opposite shape — one defect class swept across every module — so the queue names
the current sweep, states the single question to ask, and tracks a row per
module with a cursor.

Nine rows are settled, three of them **clear** rather than fixed. That is the
point: "checked, on this date, against this question" is a result, and three of
the last five candidates turned out to be already correct. Marking them stops
the next session re-deriving that.

### 2026-09-20 — A freshness test that blamed the data for the reader's cap

#### R31 · S1 · "Stale: 412 days old" about a dataset written five minutes ago

The quality evaluator reads at most `DATA_QUALITY_ROW_CAP` rows — 200,000 by
default — and threads a `capped` flag to every check. The row-scoped tests use
it: `not_null`, `unique`, `accepted_values` and `range` all append "(checked the
first N rows)". **Freshness did not.**

A column-based freshness test takes the newest value it can SEE. On a table
larger than the cap that prefix need not hold the newest row, and if the source
is ordered oldest-first it certainly does not. The test then declares the
dataset stale and names the watermark column as the reason — which is the log's
opening line, _a message that names a cause it cannot support_, occurring in the
one part of the product whose entire job is to say whether data can be trusted.

**The two verdicts are not symmetric under capping**, and the fix turns on that
rather than on suppressing both:

- **pass** — the whole table's maximum is at least the maximum of any prefix, so
  a prefix inside the limit proves the dataset is inside it. Sound. Left as a
  pass, and given the cap note the other tests already carried.
- **fail** — the row that would refute "stale" is exactly the row the cap did
  not read. Now reported as unrunnable, which is what this module does with any
  assertion it cannot evaluate, naming the way out: raise the cap, or order the
  source so the newest rows are read first.

The same reasoning covers "no parseable dates in this column", which a prefix
cannot establish either. The load-time fallback is untouched: with no watermark
column the stamp comes from the dataset's recorded load time rather than from
rows, so no cap can affect it.

**Tests:** 28 in `dataQualityCore`, 7 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first. One mutant
exists to pin the asymmetry itself — downgrading the PASSING capped case is
caught, because that verdict IS supported and must not be discarded along with
the unsupported one.

#### R31 · S3 · en-IN again

Two new assertions compared against `"1,000,000"` and met `"10,00,000"`. Node on
this machine resolves en-IN and the code formats with `toLocaleString()`. They
assert the contract — the same formatter — rather than a literal, which is the
only form that holds wherever CI runs. Third time this has been recorded; the
rule is that a test must never hard-code the output of a locale-aware call.

### 2026-09-20 — The Partial badge did not survive the export

#### R30 · S2 · A caveat that exists on screen and not in the artifact

A dashboard card whose snapshot hit the row cap wears an amber **Partial**
badge. The dashboard PDF keeps it, and by luck rather than design: that exporter
rasterises each card with html2canvas, so the badge travels as pixels.

A **report** does not. `biReportPdf` is a vector builder — it draws the title
and places the chart bitmap itself — and neither it, nor the designer's preview,
nor the report generator contained the word `truncated`. Three surfaces, zero
mentions. So a section whose query returned more rows than the cap exported a
chart of the first N with nothing anywhere saying so, in the one artifact that
leaves the product and gets read as final.

One string, `partialRowsCaveat`, and both surfaces render it: the preview under
the chart and under the table, so the designer sees what will export; the PDF as
vector text in the same two places, beside the title it already draws that way.

Scoped to `truncated` on purpose. A table block's `maxRows` also shows fewer
rows than exist, but that is the author choosing how many to print and it is
visible to them in the editor. The cap is the one nothing on the page reveals.

A flowing table repeats its header on every page and must NOT repeat this —
under each slice it reads as a fresh problem each time — so it appears once,
under the last.

**Tests:** 34 in `biReports`, 9 behaviour-changing mutants applied one at a time
and each killed, control missed, baseline verified green first. Two of them exist
because a caveat is easy to compute and forget to draw: one removes the PDF's
call under the chart, one under the table, and no test of the string itself
would have noticed either.

### 2026-09-20 — The insight card called a prefix "the total"

#### R29 · S1 · The second way a result is partial, which the SQL never says

The card already discloses one: a query that caps ITSELF with a trailing LIMIT,
which `queryRowLimit` finds by reading the SQL. There is a second, and reading
the SQL can never find it — the SNAPSHOT hitting the row cap while the query had
more to give. The query asked for everything; the cap took the tail.

So `generateWidgetInsight` was handed a prefix and told, in its own comment,
that its totals were "computed over EVERY row". Below the cap that is true.
Above it the card states a prefix's total as the total, and its shares as shares
of it, summing to 100% of a fragment.

**What makes this worse than a wrong number: the checker grounds it.** The
figures really are derivable from the rows the card was given. Every mechanism
built in R19 and R21 to stop the model inventing a figure passes this one
through, because nothing was invented — it is an honest summary of the wrong
rows. A verifier can only compare prose against the data it is handed; it cannot
know the data is a fragment unless something tells it.

The widget knows. `truncated` is set by both refresh paths and is what the
Partial badge already reads. It now reaches the insight: the digest gains a
second PARTIAL reason with its own sentence, the shares are withheld for either
reason rather than only for a LIMIT, and the caveat forbids the superlatives a
prefix cannot support — "the largest region", "no other category" — because the
rows that would contradict them were never fetched.

**Tests:** 22 in `biInsightFacts`, 8 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

One mutant survived the first run and was a real gap: computing the reason and
handing it over are different things. Dropping the third argument to
`formatInsightFacts` still removed the shares, so every other assertion stayed
green while the caveat simply stopped being written.

#### R29 · S3 · Two source anchors, and what each was really pinning

Both broke, and both deserved to.

`biInsightFacts` sliced `src.slice(at, at + 2600)` to get the function's body.
A few lines of comment pushed its last assertion past the window — one edit from
silently asserting about a DIFFERENT function's text. The slice is now bounded
by the next top-level export, which is what "the body" always meant.

`biNumericClaims` pinned `rowLimit != null ? { ...measured0, shares: [] }`. That
condition was widened to `partial`, which covers both reasons — so the anchor
was pinning one arm of a union that had grown. It now asserts the union itself.
Mutation-checked by narrowing it back: caught.

### 2026-09-20 — An alert that watched the first 500 rows

#### R28 · S1 · The threshold was compared against a prefix, and emailed as fact

`evaluateAlerts` computes an alert's value with
`alertValue(widget.rows ?? [], ...)`, and `widget.rows` is a PREFIX:
`applyResult` slices to WIDGET_ROW_CAP and the engines cap at the same number.
On a table smaller than the cap the prefix IS the result and nothing is wrong.
On a warehouse table it is not — and the alert then compares a threshold
against the sum of the first N rows and sends a notification and an email
stating that figure as fact.

`count` is the worst of them. It returns `rows.length`, which on a capped
snapshot is exactly the cap, so **"row count above 1000" can never fire** and
"row count below 600" always does.

This is invisible at demo scale, which is why it survived: every table in the
seeded data is smaller than the cap. It is systematic on anything real.

When the snapshot is partial the aggregate is now asked of the database, built
through the same validated path pushdown uses — `renderAggregateClauses` for
identifier resolution and per-dialect quoting, `buildDirectQuerySql` for the
wrapping. Where that cannot be done the alert does NOT fall back to the prefix:
it declines to fire and tells the owner once, because a rule that has silently
stopped watching is the same bug one layer down.

A forecast basis is included in the refusal. A curve fitted to a prefix of a
series is not a forecast of the series.

**Verified against a real engine.** The SQL this produces for the live "Revenue
by Region" widget was run on the lakehouse through the Workbench and returned
**51,749.84** — the seeded truth total, and the figure the alert needs instead
of a prefix sum.

**Tests:** 26 in `biRefreshScheduling`, 7 behaviour-changing mutants applied one
at a time and each killed, control missed, baseline verified green first.

#### R28 · S1 · Two defects in the fix, both found by its own tests

The first version built the scalar aggregate with `dims: []` and trusted
`buildDirectQuerySql`. That emits `GROUP BY` **followed by nothing** — a syntax
error in every dialect — because the builder assumed every plan has dimensions.
`aggregationPlan` refuses an empty `dims`, so no chart had ever reached it; an
alert asking for one measure does. The builder now omits an empty GROUP BY.

The tests did not catch that, because they asserted `toMatch(/SUM\(/)` and
"contains the base query" — both true of the malformed string. They assert the
whole SHAPE now.

The second was worse and a mutant found it. The function decided the plan had
been refused by comparing the result against the base SQL — but the builder does
not return the base SQL when it refuses a plan, it returns `SELECT * FROM (…)`.
So a column the validator would not quote produced a RAW-ROW query, which
`scalarFrom` would have read a number out of: a wrong alert value dressed as an
exact one. It now asks `renderAggregateClauses` whether it will render the plan,
rather than inferring from what comes back.

#### R28 · S2 · The harness emptied a source file

Recorded because it nearly cost uncommitted work. A mutation harness restored
files with `io.open(path, "w").write(original)`. That truncates on open and
evaluates the argument afterwards, so when a rename left `original` undefined
the file was emptied and never rewritten — and the `finally: restore()` raised
the same error. 1491 lines gone; `git checkout` recovered them only because the
file was committed.

Harnesses in this repo now compute the bytes first, assert they are non-empty,
and only then open for writing — and assert every target file is non-empty
before starting, so a second run cannot mutate what the first run emptied.

### 2026-09-20 — A live result under sentences written about a snapshot

#### R27 · S1 · The one widget the restatements could not reach

`query_mode: "direct"` re-runs the SQL at view time and draws that instead of
the stored snapshot. The render substitution carried the live columns, rows and
truncation onto the widget — and left the two SENTENCES alone:

```
{ ...w, columns: live.columns, rows: live.rows, truncated: live.truncated }
```

`w.title` still held the reconciliation note and `w.narrative` the prose, both
computed against the snapshot. So a direct widget could read "The data has 3
rows, not 5." above a live result with five bars in it, and its hover text could
quote a total from whenever the snapshot was last written.

The refresh-time restatements built in R24 and R26 cannot reach this. They
rewrite the widget's STORED rows, and a direct widget's stored rows are not what
it is drawing. Nothing in the dashboard ever compared the sentences to the live
answer.

`widgetForLiveResult` derives both from the live result at render. Nothing is
persisted, which is the point twice over: a live result belongs to one view —
two people looking through different filters are looking at different rows, and
the only honest answer is for the card to say different things to them — and a
sentence that is never stored is a sentence that can never go stale.

**Tests:** 8 in `biDirectWidgetDisplay`, 8 behaviour-changing mutants applied one
at a time and each killed, control missed, baseline verified green first.

One mutant survived the first run and was a real gap: the fixture gave the
stored widget and the live result the SAME column names, so "took the live
columns" and "kept its own" were indistinguishable. A test whose fixture cannot
tell the two branches apart asserts the right answer for the wrong reason, which
is the second time this session mutation testing has caught exactly that.

### 2026-09-20 — Prose about a result the widget no longer has

#### R26 · S2 · The narrative outlived its rows, with the figures still in it

The same defect as R24, one field over, and this one carries numbers. A widget
stores the sentence the AI wrote about it and shows it on hover. Neither refresh
path has ever touched it, so the prose describes rows that were replaced
underneath it.

Found live rather than reasoned about. The widget left on the dashboard from
R24's failed first attempt queries five MONTHS, and was still carrying:

> The top region, AMER, generated $25.9k in revenue. The three regions together
> generated $51.7k in total revenue.

Its five rows are monthly figures totalling about 9k. There are no regions in
them at all.

`restateWidgetNarrative` re-checks the figures against the rows the widget now
holds, with the verifier built in R19 and R21 and no model call, and withdraws
prose whose numbers no longer ground. Withdrawn rather than corrected: nothing
here can rewrite an English sentence truthfully, and an absent tooltip beats a
confidently wrong one. The narrative is derived content about one result — when
the result is gone the prose is not about anything the widget has.

Two limits, deliberate. A capped snapshot is not checked: the figure may be true
of the table and simply not derivable from the part of it kept here, and
deleting correct prose on that evidence is the worse error. And a numeric
verifier has nothing to say about "AMER leads the regions", which survives AMER
falling to third — sentences with no figures are left alone rather than deleted
on suspicion.

**Tests:** 33 in `biNumericClaims`, 8 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first. A ninth
candidate was dropped as EQUIVALENT rather than counted: removing the no-figures
guard changes no outcome, because prose with zero claims yields zero unsupported
figures and the same null a line later. It earns its place by skipping a scan of
the rows, not by changing a result.

#### R26 · S3 · One withdrawal this round could not be checked

The first run of the check over widgets built in earlier rounds withdrew two
narratives. One is the R24 artifact above, and arithmetic settles it. The other
was **Units Sold by Region**, whose rows are APAC 2121, EMEA 2118, AMER 2115 —
total 6354, average 2118 — against prose beginning "A total of 6.4k units were
sold across all regions, with an average of 2.1k units per region. APAC led with
the highest sales at 2…". Every figure in that fragment grounds: 6.4k is within
tolerance of 6354, 2.1k of 2118, and APAC did lead.

Whatever failed is in the part after the 130 characters that were captured, and
by the time that mattered the prose was gone. Version history offers restore,
not read, and restoring would have destroyed the demonstration. So it is
recorded as unverified rather than assumed correct.

What IS established is that the check does not churn: a second refresh over the
same 23 narratives, with none of their data changed, withdrew **zero**. The risk
worth worrying about with a destructive check is that it fires on prose that is
still true, and on this dashboard it does not fire twice on anything.

### 2026-09-20 — A headline number that was one row of three

#### R25 · S1 · `rows[0]` in the type size reserved for a total

`BiChartRender` draws a KPI as `rows[0]?.[chart.valueField]` and stops. When the
query returned one row that is the whole truth. When it returned three, the card
puts one slice of a breakdown in the largest type on the dashboard and says
nothing about the other two.

Three live instances, read out of React state on a generated dashboard:

| Card                  | Shows          | Of                                                |
| --------------------- | -------------- | ------------------------------------------------- |
| Revenue by Region     | AMER 25,874.92 | 3 rows — EMEA 15,524.94 and APAC 10,349.98 unseen |
| Units Sold by Plan    | free 2,139     | 3 rows — pro 2,118, enterprise 2,097 unseen       |
| Best Month by Revenue | "2025-05"      | 36 rows — and CORRECT                             |

The first is the shape of the problem: 25,874.92 is half of the 51,749.84 total,
displayed under a title promising the breakdown. A reader takes the big number
as the answer, because that is what big numbers on dashboards are.

**The third is why the rule is not "a KPI with more than one row".** "Best Month
by Revenue" is a KPI over thirty-six ORDERED rows whose `valueField` is `month`.
Row zero is the answer there. A caveat on it would be noise, and noise is what
teaches people to ignore the caveats that matter. The check therefore fires only
when the displayed value is a **measure** — a finite number — which is exactly
the case where row zero is one slice presented as a total, and excludes the case
where it is the extreme the title asked for.

`unshownRows` is computed where the number is drawn, not stored on the widget.
That is a deliberate consequence of R24: a count of rows is precisely the kind of
sentence that goes stale when a refresh replaces the rows, and this one cannot,
because nothing keeps it. Single-value charts carry `1 of N rows` under the
figure; the gauge takes the same caveat, since a gauge is a single-value chart
with a dial around it.

**Tests:** 21 in `biChartFields`, 8 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

A ninth candidate mutant was investigated and dropped rather than counted:
removing the `!valueField` guard is a **tsc** error (TS2538, "Type 'undefined'
cannot be used as an index type"), so it is caught by the typecheck rather than
by this suite, and the numeric test below it would swallow it at runtime anyway.
Established by applying it and running tsc, not by reasoning about it — a
surviving mutant is either a test gap or an equivalent one, and which of the two
is not a judgement call to make from the armchair.

### 2026-09-20 — The badge that outlived what it vouched for

The opening paragraph of this log names the failure it exists to hunt: _a badge
that outlives what it vouched for_. The reconciliation notes built over R20-R23
were exactly that, and had been since the first one shipped.

#### R24 · S1 · "The data has 3 rows, not 5." beside a chart drawing five bars

A note is a statement about ONE query result. `refreshAll` in the dashboard
route and `applyResult` in the scheduled refresh both replace that result —
they rewrite `rows`, `columns`, `truncated` and `refreshed_at` — and neither
has ever touched `title`. The note is fused into the title string, so it stands
unchanged while the thing it describes is swapped out underneath it.

The result is worse than the silence it replaced. A reader who takes the
trouble to check the caveat against the chart finds the product contradicting
itself, and learns that its caveats are decoration.

`restateWidgetNote` re-derives the count on every write that replaces the rows
and rewrites the sentence, or withdraws it. It is stored on the widget as
`reconcile_note` rather than parsed back out of the title, because a separator
is not a marker: an owner may put an em dash in a title for their own reasons.

Three things deliberately stop it. A snapshot that hit the row cap has no count
to speak of — `rows.length` is the cap, not the result — so the note stands and
the **Partial** badge explains the widget instead. A title whose suffix is no
longer the note has been rewritten by its owner, and those are their words now.
And a note that is still exactly right is left byte-identical, so a refresh that
changes nothing writes nothing and cannot lose a concurrent edit.

Only the COUNT note is re-derivable, which is why it is stored and why the
generator now emits it last. A field note ("returns no revenue column, so the
rows are shown instead") describes a repair already applied to that widget — its
chart is a table now — so re-running that check would find nothing wrong and
delete a sentence that is still true.

#### R24 · S1 · A new field is not a field every writer knows about

Found by the UI test failing, and it was my own change that caused it.

The first attempt to verify this drove the obvious route: generate a widget with
a note, edit its SQL so the row count changes, refresh, watch the note go. The
note did not go. The widget had no `reconcile_note` at all — `BiBuilderPane`
constructs its widget from an explicit list of fields, and anything not named
there is dropped. Editing any widget therefore ORPHANED its note: the sentence
stayed in the title with nothing able to restate it, permanently.

Adding a field to a type does not add it to the code that rebuilds objects field
by field. The same lesson as the stored-identifier one further down this log —
enumerate every writer — in a new disguise. The pane now carries the note and
restates it on save, for the same reason a refresh does: the owner may have just
changed the SQL underneath it.

The test for it is source-anchored, because no unit test of a pure function can
watch an object literal fail to mention a key.

**Tests:** 39 in `biTitleClaims`, 11 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

### 2026-09-20 — A chart names its columns, and the query need not return them

R22 recorded this open and did not fix it. Fixed here, with the part that is
still only unit-tested said plainly.

#### R23 · S2 · The widget that looked like it was still loading

A generated widget drew five x-axis labels, no y-axis, no bars, and no
explanation. Its query and its chart, both from the same generation:

```
sql:   SELECT month FROM analytics.bi_demo_sales
       WHERE revenue IS NOT NULL ORDER BY revenue DESC NULLS LAST LIMIT 5
chart: { type: "bar", xField: "month", yField: "revenue" }
```

The query orders BY revenue and never selects it. So the chart's measure names
a column that does not exist, and a bar chart with no measure draws an empty
frame that is indistinguishable from one still fetching.

The title check next door cannot see this. It compares a title against a ROW
COUNT, and five rows under a title promising five agree perfectly. Only reading
the chart's FIELDS against the query's COLUMNS finds it.

`reconcileChartFields` now does that, deterministically and with no model call,
in three outcomes ordered by confidence. A missing **series split** is dropped
without comment — a chart that cannot find the column it meant to split by is
not broken, it is a chart with one series. A missing **measure or category** is
re-pointed when exactly one unused column of the right kind could have been
meant; two candidates is a guess, and a guess drawn as a chart is worse than no
chart. Otherwise the widget **shows its rows as a table** and the title names
the missing column, because five months a reader can see beats an empty frame.

Which field must be a number depends on the chart and not on the field's name:
a bar chart's `yField` is its measure, a sankey's is a node label, a heatmap's
axes are both categorical with the measure in `valueField`. A single set of
field names would move a repair onto the wrong column, which is worse than the
blank chart it set out to fix.

The correction is applied to the TURN rather than to the finished widget, so
`widgetFromBiTurn` derives `agg_pushdown` from the spec that will actually be
drawn. A mutant that moves it after the build is caught for that reason.

**Tests:** 15 in `biChartFields`, 14 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

One mutant survived the first run — "columns already drawn are offered to
repairs" — and it was EQUIVALENT rather than a gap. Fixing an earlier defect
(two missing fields both claiming the same spare column) had added a
`!taken.has(c)` guard inside the loop, which made the outer filter redundant.
The redundancy was removed rather than the mutant kept: two guards doing one
job is how a later reader concludes the real one is unnecessary.

#### R23 · S2 · What the UI could not be made to show

Four generations on the rebuilt image, and the repair path did not fire in any
of them: every query the SQL step wrote selected its own measure, including one
run handed the literal one-column SQL and asked to use it unchanged. The bug is
real — it was observed twice in R22, before this check existed — but it could
not be summoned on demand, so `unplottable` and the re-point repair rest on
unit tests and mutants alone.

What the four runs do show is the half most likely to go wrong. A guard that
fires when it should not would have turned four correct charts into tables
carrying an apology. None of the four grew a note.

#### R23 · S3 · An anchor that went stale the moment the line moved

R22's source-anchored test pinned the note application with
`dash.indexOf("fixed.note ? \`${base}")`. This change rewrote that line to join
two notes, so the anchor matched nothing, `indexOf`returned`-1`, and the
assertion failed with _expected -1 to be greater than 16636_.

It failed loudly, which is the good case. The point worth keeping is what did
NOT catch it: the mutation run for the new check passed a green baseline,
because it runs one test FILE and the broken anchor lived in the neighbouring
one. Only the whole gate saw it. A per-file mutation run proves the tests in
that file kill those mutants; it says nothing about the file next door that
pins the same line.

The anchor now names the current expression and also asserts the title note is
still IN the joined list — because every other test in that file stops at
`reconcileTitle`'s return value, so a list that quietly dropped it would leave
the R20 bug fixed in the unit tests and back on the dashboard. Mutation-checked:
removing `fixed.note` from the list fails that test.

### 2026-09-19 — The guard that told the truth about the wrong thing

`widen` was built in R20 to repair a query that capped itself, and R20 recorded
honestly that it had never fired on a live generation. Driving one more
generation to find out why produced the answer, and a worse bug with it: the
repair could not be reached from the case that needed it most, and the branch
that took that case instead printed a false statement about the reader's data.

#### R22 · S1 · "The data has 1 row, not 5" — of a table holding thirty-six

Asked, through the generate dialog, for one bar chart over the seeded 36-month
lakehouse table. The model returned:

```
title: "Top 5 Months by Revenue"
sql:   SELECT month FROM analytics.bi_demo_sales
       GROUP BY month ORDER BY SUM(revenue) DESC LIMIT 1
```

and the widget rendered

```
Top 5 Months by Revenue — The data has 1 row, not 5.
```

The table has thirty-six months. The note is false, and it was written by the
guard whose entire purpose is to stop a widget saying something false.

`reconcileTitle` returns from every path inside `if (claim)`, so the `widen`
branch below it was reachable only by a title naming NO number. A title that
names one — the only kind that can be compared against a row count at all —
fell to `rowCount < claim.n` and was told the data was short. The single input
that makes the check possible was the input that disabled its repair.

The distinction the fix turns on is that **a query which stopped at its own
`LIMIT` has not told you how big the table is**. So `short` is now reserved for
the case where the count is a fact about the DATA — no limit, or a limit the
query never reached — and a query that capped itself below its title's number
is re-run for that number. The re-run carries the same `ORDER BY` requirement
`truncate` already had, because re-running an unordered query returns more
arbitrary rows rather than the top five. When the re-run cannot be made at all,
the note says the QUERY stopped, which is the part that is known to be true.

**Tests:** 8 added, 28 in the file, 11 behaviour-changing mutants applied one at
a time and each killed, control missed, baseline verified green first.

One of the eight did not test what it was aimed at when first written. The
"stopped below its own limit" case used `LIMIT 10` under a claim of 10, so
`limit < claim.n` was already false and the clause under test — `rowCount >=
limit` — was never reached; the mutant flipping it to `<=` survived. A limit
BELOW the claim reaches it. Recorded because the test read correctly and
asserted the right answer for the wrong reason, which is the failure mode that
mutation testing exists to expose and that reading the test cannot.

#### R22 · S2 · OPEN — a chart whose measure is not in its own result set

Found in the same frame and deliberately not fixed here. The repaired widget
draws five month labels and no bars: the model's SQL selects only `month`, so
the chart spec's `yField: "revenue"` has no column to plot, and the widget
renders an empty plot area saying nothing about why. The R20 widget beside it,
whose query selected the measure, draws five bars and a 0-2.0k axis.

The title check cannot see this — it compares the title against the ROW COUNT,
and those agree. Comparing a chart's declared fields against the columns its
query actually returned is a different check. Recorded open rather than folded
into this round's change.

### 2026-09-19 — The analyst's answer, checked the same way a card is

The numeric check shipped on the insight card. The busier surface is the
analyst's written answer: every natural-language question produces one. It
already computed its own facts — added after it once reported "approximately
$1.4M" against a true total of $704,186 — but nothing verified what came back.
It does now, with the same write, check, retry-once, disclose loop.

#### R21 · S3 · A check that would have punished obedience

The design problem was not the checking, it was what counts as checkable.

An analyst answer is handed a prepared FACTS block and told to use it, and some
of those figures are not row values and not totals: how many distinct
identifiers a column holds, how many rows of how many the engine returned
before truncating. Grounding only against rows and computed aggregates would
have flagged the model for quoting exactly what it was instructed to quote —
the fastest way to make a warning worth ignoring.

So anything the writer was GIVEN counts as grounds. `valuesStatedIn` reads the
numbers back out of the same text the model was handed, which keeps the two in
step without the caller having to describe its facts twice in two shapes. A
truncated result still withholds its shares from the checker, for the reason a
`LIMIT`-capped query does: they would be shares of a prefix.

#### Driven, and what it did not show

Two questions through the AI analyst on the rebuilt image, with `window.fetch`
patched to record every `/api/bi` call and clone its reply.

- _"What is total revenue by region?"_ — one narrative call, no retry.
  `$2.3M` against a true 2,297,201.86; `$1.0M` against EMEA's 1,042,800;
  `$415k` against APJ's 415,500, which passes at exactly the ±500 the written
  precision allows.
- _"What share of total sales does each region hold?"_ — chosen because a
  question about shares invites an invented percentage. No retry.
  45.4% and 18.1% are the real shares, and "about 33.3%" is the mean of the
  share column, which the facts state.

**The catch path did not fire in either run, and this entry does not pretend it
did.** Both answers were correct, which is what handing the model computed
facts is for; the check is the backstop behind that, and it is proven by unit
tests and by the mutant that severs it. Two attempts at inducing an invented
figure is not evidence that one cannot occur.

One probe artefact worth recording, because it nearly became a false claim: a
first version detected corrections by looking for the phrase "must not appear"
in the request body, and reported a correction on the **SQL** step, whose
prompt contains that phrase for its own reasons. The marker is now the
narrative correction's own opening sentence. A probe that matches something
other than what it claims to match will happily confirm whatever you hoped.

**Tests:** 27 in `biNumericClaims`, 25 behaviour-changing mutants applied one at
a time and each killed, control missed, baseline verified green first. Two of
those mutants exist because the first run silently SKIPPED them — one anchor
matched twice once the insight card and the narrative shared a retry shape, and
one matched nothing after Prettier reflowed a line.

### 2026-09-19 — A widget's title is a claim, and claims get checked

The numeric verifier (R19) checks the prose a visual is described with. It
cannot check the visual itself, and the two drift apart: the planner names a
chart before it knows what the query will return.

#### R20 · S1 · "Top 5 Products by Sales" over fourteen bars

Verified on the running instance rather than inferred: the widget is a real
recharts bar chart and its category axis carries **fourteen** labels —
ContactMatcher, FinanceHub, Site Analytics, … Storage. Its SQL is

```sql
SELECT "Product", SUM("Sales") AS total_sales FROM saas_sales
GROUP BY "Product" ORDER BY total_sales DESC
```

with no `LIMIT`. The SQL prompt does tell the model to "use LIMIT only when the
question itself asks for a top-N"; the question did, and the model did not.

A title promising N over a query that returned more now takes the N it
promised — **but only when the query sorted its rows**. The first five of an
unordered result are an arbitrary five, which is a different lie from the one
being repaired. No re-query is needed: the rows arrive in the query's own
order, so slicing them is precisely what `LIMIT 5` would have returned, and the
stored SQL is rewritten so a later refresh agrees with what is on screen.

#### R20 · S3 · "Top 10 Customers by Sales" over twelve rows

Nothing to do with SQL. `BarRace` takes `topN = 12` and the requested N never
reached it. The spec now carries `topN`, the generator sets it from the title,
and the renderer passes it through — three places, because a value that stops
at any of them is a title the chart does not keep.

#### R20 · S2 · A promise the data cannot meet

The complement of the first finding, and the one driven end to end here:
"Top 5 Regions by Revenue" over a table with three regions. Rows cannot be
invented, so there is no repair — only disclosure. The widget now reads

> Top 5 Regions by Revenue — The data has 3 rows, not 5.

#### R20 · S2 · And the repair was written where it could not survive

Found by driving it, and it is the reason this round was driven at all. The
note was applied to `widget.title` immediately after the widget was built —
and two lines later the generator does

```ts
widget.title = picks[i].title || widget.title;
```

which overwrote it. The unit suite was green throughout: it asserted the note
was **produced**, never that it **survived**. Twenty tests and seventeen
mutants did not see it; one forced generation did.

The note is now applied with the final assignment, and the test asserts the
ORDER of the two rather than the presence of either — with a mutant that
reinstates the overwrite, which is now caught.

#### On the `widen` repair, honestly

A category chart whose query ends `LIMIT 1` over a `GROUP BY` is re-run without
the limit, because a one-bar bar chart is not a chart. **This guard has no
observed instance.** It was motivated by R19's "Revenue by Region", which that
entry described as a bar chart and which is in fact a KPI — see the correction
there. A KPI reaching for one row with `LIMIT 1` is coherent, and the rule
correctly declines to touch it.

It is kept because the SQL it guards against is real — the generator does emit
`GROUP BY … LIMIT 1` — and the only accident was which widget it landed on. If
the same query had been attached to the bar chart the title implied, the chart
would have drawn a single bar. Recorded as a guard rather than a repair so that
nobody later reads it as evidence of a defect that was never seen.

Mutation testing pushed back on the scope twice while this was written: one
mutant showed the KPI test never exercised the category-chart condition at all
(its SQL had no `GROUP BY`, so the rule was never reached), and another that
there was no test for a widening re-query returning **empty** — where replacing
a rendering widget with nothing is worse than leaving it narrow.

**Tests:** 20 in `biTitleClaims`, 18 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

### 2026-09-19 — The insight card, checked rather than trusted

The card that reported shares summing to 106% was fixed in R18 by computing the
facts and handing them to the model. That made an invented figure less likely
and nothing made it impossible, so this round built the check — every numeral
in generated prose matched back to a row value, a computed total, range or
mean, or a share — and then drove it from the UI, which is where both of the
findings below came from.

#### R19 · S2 · The verifier flagged a correct sentence, because of one letter

Pressing **AI insight** on "Monthly Units Sold Trend" produced two `/api/bi`
calls instead of one — the signature of a rejected first draft. Capturing both
drafts showed the sentence it objected to:

> some months like January 2023 and March **2024 b**oth recording the minimum
> of 159 units

The extractor had read the **"b" of "both"** as a BILLION suffix, turning 2024
into 2.024e9. That also stopped it looking like a four-digit year, so the guard
that exists precisely to skip years never fired, and a correct sentence was
sent back to be rewritten. The same trap was waiting in "300 basis points",
"12 bottles" and "7 key accounts".

A single-letter magnitude must now sit directly against its digits — `$1.2M`,
`3.4k` — while a spelled-out one may take a space, since `$2.3 million` cannot
be misread. Verified on the rebuilt image: the same widget now answers in one
call, and its card still contains the phrase "January 2023".

This is an argument for driving the thing rather than reading it. The unit
tests were green, the mutants were all killed, and the bug was in a regex
branch no test had thought to write, in prose no test had thought to invent.

#### R19 · S1 · A card whose every figure verifies, and whose sentences are false

"Revenue by Region" produced a card headed "What the data shows":

> AMER accounts for **100%** of the total revenue in this dataset.
> There are **no other regions** contributing to revenue.

The seeded table has three regions. The verifier passed the card with zero
corrections — correctly, because the widget's SQL is

```sql
SELECT region, SUM(revenue) AS total_revenue FROM analytics.bi_demo_sales
GROUP BY region ORDER BY total_revenue DESC NULLS LAST LIMIT 1
```

`LIMIT 1`. Relative to the one row the widget holds, 100% is exactly right and
no other region is present.

> **Correction, 2026-09-19.** This entry first described that widget as _"a bar
> chart whose generated rationale was 'easy comparison of revenue across
> different regions'"_. That is wrong on both counts and the error was mine.
> Checked against the running instance, the widget is a **KPI** — no recharts
> node, no axis labels, a single value with a label — and the rationale quoted
> belonged to a _different_ dashboard, the one generated over `saas_sales`. A
> KPI that takes the top region with `LIMIT 1` is coherent SQL, not a defect.
>
> What stands: the insight card's claims were false and the fix is right. A
> card asserting "100% of the total revenue" and "no other regions
> contributing" is wrong about the business whatever chart it sits beside, and
> the PARTIAL caveat is what stops it. What does not stand: the picture of a
> bar chart drawing one bar. The `widen` repair built in R20 was motivated by
> that mistaken picture, correctly does NOT fire here — it is scoped to
> category charts, and a KPI is not one — and is documented there as a guard
> against an adjacent case rather than a repair of an observed one.

**This is the most dangerous shape a generated claim can take**, and it is
worth being precise about why: every figure in it verifies. A check on the
prose cannot catch it, because the prose is not wrong about its data — the
data is wrong about the world. Nothing downstream of the query can fix a
sentence like that; what has to change is what the model is told the data IS.

So a query that caps itself now says so. A trailing `LIMIT n` produces a
PARTIAL line in the facts _instead of_ the shares — "these are the top n rows
only and NOT the whole breakdown; do not state shares of a total, do not call
anything 100%, and do not say other categories are absent" — and the shares are
withheld from the checker too, so a "100%" written against a capped result is
caught rather than grounded.

Verified on the rebuilt image, same widget, same button. The card now reads:

> The AMER region generated a total revenue of $25,875. This revenue figure
> represents the highest revenue among the regions analyzed.
> **Watch out for** — The data only includes the top region, so insights on
> other regions are not available.

It disclosed the truncation itself, which is better than merely not lying about
it, and it needed no correction: told the truth about its data, the model wrote
something true.

#### The same defect as R18's "Top 5", in the mirror

R18 recorded "Top 5 Products by Sales" rendering 14 bars because the generated
SQL carried no `LIMIT`. This is the same defect inverted — a title promising a
breakdown over SQL that returns one row. Two instances now, in opposite
directions, from one generator. Reconciling a widget's title against what its
query actually does is no longer an optional refinement.

#### Method, twice over

Both of this round's process guards were earned rather than designed.

A mutation run over the verifier came back thirteen-for-thirteen **with the
control also caught** — the only visible symptom of a run that measured
nothing, because a rename two steps earlier had left a source assertion red and
every mutant was "caught" by that standing failure. The harness now asserts a
green baseline before it mutates, and that guard fired for real within the
hour: a source assertion with a hard-coded 4,200-character window had stopped
covering the end of a function that grew. It now slices to the next top-level
function.

**Tests:** 37 across `biNumericClaims` (22) and `biInsightFacts` (15), with 19
behaviour-changing mutants applied one at a time and each killed, control
missed, baseline verified green first.

### 2026-09-18 — BI dashboarding and reporting, end to end

Twenty-five of the twenty-six visual types on one dashboard over a series whose
every value was known in advance, then the AI half: generate a dashboard,
generate a paginated report, an insight card, the insight sweep, and an
ontology over the lakehouse. The arithmetic held up almost everywhere — the
forecast to a 1.4% MAPE, the matrix cell by cell, two AI-generated widgets
agreeing on a total to the cent. What did not hold up is what happens to a
number between being computed and being read.

Four of the six defects below are one sentence: **a value the query returned
is not a value a person can read, and nobody converted it** — a country code,
a timestamp on an axis, a timestamp in a table, a float in a report cell. The
other two are the AI inventing arithmetic it was never given, and the largest
generation in the product running on the smallest deadline.

#### R18 · S1 · A column of ISO country codes drew one country

A filled map and a bubble map over `SELECT country, sum(amount) … GROUP BY 1`,
where `country` holds alpha-2 codes — the ordinary way country data is stored.
Both rendered, shaded a single country, and said so in grey 9px text in the
corner: **"10 rows not matched to a country"**.

The matcher worked on the country NAME through a hand-kept alias table whose
only code-shaped entries were `usa`/`us` and `uk`. Of the 280 assigned alpha-2
codes exactly TWO resolved, and `UK` is not one of them in ISO: the real code
for the United Kingdom is `GB`, which drew nothing at all.

Alpha-2 now resolves through `Intl.DisplayNames`, which already knows every
assigned region, and the numeric form through the atlas's own feature ids,
which ARE ISO 3166-1 numeric — rather than a 249-row table in the component
that would be wrong the first time a code is reassigned. Measured against the
bundled Natural Earth 110m atlas: **171 of its 177 countries** now resolve from
a code, up from 2.

Writing the test turned up two aliases that had always pointed at nothing:
`macedonia → "north macedonia"` (the atlas shape is called "Macedonia", so the
plain name vanished) and `cape verde → "cabo verde"` (the 110m atlas carries no
Cape Verde under either spelling). Both removed; a test now asserts every alias
names a shape the atlas can actually draw.

#### R18 · S1 · A date axis on AUTO printed epoch milliseconds

Found on the first report the AI generated. The planner asked for a monthly
revenue trend, the SQL writer produced `date_trunc('month', order_date)`, and
the chart drew a correct line under an axis reading `1667260800000`,
`1696118400000`, `1725148800000` — on the page a finance team reads.

The data was never wrong: pressing the chart's **M** grain button relabelled
the same line `2022-05 … 2025-12`. But the toggle defaults to "auto", and auto
did no bucketing at all, so the unreadable axis is the one every reader gets.
The toggle is offered on line and area charts only, so a column chart over the
same column had no escape hatch whatsoever.

The dashboard's hand-built tiles had escaped this only because their SQL emits
strings; every chart whose query returns a real timestamp was affected, which
is every chart the AI writes.

Auto now picks the finest grain whose labels still fit and **relabels in
place** — an explicit grain is a request to regroup the data (it sorts, sums,
and drops what will not parse), where auto is only a request to make the axis
readable, so no row moves, disappears or changes value. A bar chart still
combines equal categories afterwards, as it always has; a line chart, which
does not aggregate, keeps every point.

#### R18 · S2 · The report preview showed a number the PDF never prints

The "Top Products by Revenue" table read `410379.26499999943` in the preview
while the exported PDF rendered the same cell `410,379.26`. The PDF had a
`cell()` formatter; the preview called `String(v)`.

That contradicts the preview's own stated purpose, which its file header spells
out: it paginates with the same function the PDF uses, because "a preview that
flowed differently would be a picture of a document nobody receives". Cell text
is part of what a reader receives. One formatter now, used by both.

#### R18 · S1 · And a date column in that table printed the epoch too

The AI's "Monthly Revenue Summary" section had an `Order Date` column whose
every row read `1640995200000`. Formatting it as a number — the fix above —
would only have made it `1,640,995,200,000`.

So a table column is now typed from its values before anything is printed:
dates print as dates, and **each row keeps its own**, which is where a table
parts company with a chart axis. An axis may relabel a whole column to one
grain because an axis is a scale; a table is a list somebody checks a row of.

This nearly introduced a worse defect than it fixed. `parseDateValue` maps any
number below 10^10 to seconds-since-epoch, so the money column
`13946.229, 4810.558, 55691.009` parsed as three moments in 1970 and the first
version of this change relabelled the finance team's revenue as dates. Caught
by a test written before the code was trusted. The detector is now deliberately
narrower than `parseDateValue`: integers only, inside a plausible epoch range,
and anything short of unmistakable is left exactly as the query returned it.

#### R18 · S1 · The AI insight's percentages summed to 106%

Pressing **AI insight** on a "Sales by Region" bar produced a card headed
"What the data shows":

> EMEA leads with total sales of $1.0M, accounting for **48%** of overall sales.
> AMER follows with $837k, representing **39%** of total sales.
> APJ has the lowest sales at $415k, making up **19%** of the total.

48 + 39 + 19 = 106. No denominator makes three shares of one total sum to 106%,
so this needs no reference data to be wrong. The prompt had asked the model to
"quote real numbers from the data", which it did for the dollars — the
percentages were not in the data at all, and the model did the division.

The division is no longer the model's job. Totals, ranges and each category's
share are computed over **every** row and handed to the prompt as authoritative
facts, and the model is told not to derive a percentage, share, ratio or total
of its own. That also closes a quieter gap: the prompt sends only the first 30
rows, so on a longer result the model was generalising from a sample while the
card spoke about the whole.

The computed facts refuse to state what would be meaningless rather than
guessing: no shares for a column that can go negative (a "share" of profit
where one row is a loss), none when a category repeats (the rows are not a
breakdown), and no total for a column of timestamps or years — `2023 + 2024 =
4047` is not a fact about anything.

#### R18 · S2 · The ontology's AI step had the deadline of a one-line SQL call

Building an Ontology widget over the built-in lakehouse — 21 tables, default
model — returned:

> AI enrichment unavailable (openai/gpt-4o-mini did not finish within 60s. Try
> again, or pick a different model.) — showing the detected structure with
> heuristic labels.

…and a map of the data estate showing 21 entities and **0 relationships**,
which is not a map. The product disclosed the failure clearly and degraded
honestly, which is why this is S2 and not S1.

The cause is in `llmDeadline.ts`, and that file's own comment names the trap:
the deadline is `floor + maxTokens × msPerToken`, so a call naming no
completion cap lands on the 60-second floor meant for a one-line SQL step.
`enrichOntology` named none — and it is the largest generation in the product,
a record for every entity plus a typed triple for every relation.

The cap is now sized from the shape of the reply the prompt asks for, which
fixes both halves at once: the reply can no longer be truncated, and the
deadline grows with the estate (21 tables: 60s → 87s; a 73-entity estate:
150s). Mutation testing caught that the first version of this test would have
passed with the budget deleted from the call — it exercised the function and
never the one line that puts it on the request.

#### R18 · S3 · The AI writes a title it does not make the data keep

Two instances on one generated dashboard:

- **"Top 5 Products by Sales"** renders 14 bars. Its SQL is
  `SELECT "Product", SUM("Sales") AS total_sales FROM saas_sales GROUP BY
"Product" ORDER BY total_sales DESC` — no `LIMIT`. The SQL prompt does say
  "use LIMIT only when the question itself asks for a top-N"; the question did,
  and the model omitted it.
- **"Top 10 Customers by Sales"** renders 12, because the bar-race component
  takes `topN = 12` and nothing plumbs the requested N through to it.

Left as found. Both are a title and a dataset disagreeing, and reconciling them
is a product decision — rewrite the model's SQL, retitle the widget, or badge
the mismatch — not a defect with one obvious repair.

#### R18 · S3 · Neither AI generator could be pointed at the lakehouse

"Generate Entire Dashboard" offered a local table or a governed semantic model;
the report planner offered `ctx.datasets` alone. Neither listed a warehouse or
lakehouse table, though the manual chart builder reaches both and the
dashboards under test query `analytics.bi_demo_sales` directly. The two dialogs
were the only place in BI that could not see the lakehouse.

It was a gap in the dialogs, not the platform, and nothing new had to be built
to close it: the builder has always offered warehouses, `runBiTurn` already
accepts an `execute` override and a `dialect`, and `widgetFromBiTurn` already
stores whichever source it is handed. Only the dialogs never asked.

Both now resolve their source through one shared, pure function rather than
each remembering the rules. The rules are where the risk is, and they are not
about SQL:

- **Semantic entries and saved metrics are keyed to LOCAL dataset ids.**
  Carrying them onto a warehouse table would offer the planner one table's
  metric definitions for another table's columns — `revenue = SUM(amount)`
  defined on a local `saas_sales` silently applied to a lakehouse table that
  also happens to have an `amount`. That is an ungoverned guess wearing a
  governed number's clothes, so a warehouse source carries neither.
- **A missing schema is not an empty warehouse.** "Still loading", "the
  connection is broken", and "this warehouse has no tables" all end in a table
  list with nothing in it, and only one of them is fixed by waiting — so each
  says something different, and the generator refuses rather than asking a
  model to write SQL against columns it was never shown.
- **A connection that disappears must not fall back to local data.** Generating
  a dashboard over the wrong tables and looking like it worked is the worst
  outcome available here, so that path returns no tables and says why.

The generated widget records the connection it queried, so refresh and
drill-through go back to the warehouse rather than hunting for a local table of
the same name.

**And wiring the dialog turned out to be only half of it.** With the dashboard
generator working against the lakehouse, the report planner still showed no
source picker at all — because the report EDITOR is its own route, and it
handed the dialog `warehouses: []`, `whTables: {}`, a no-op `ensureSchema` and
a `runSql` that threw "A report generates from local datasets". The feature was
impossible there regardless of what the dialog did, and every dialog-level test
passed the whole time. Found by opening the report generator and seeing one
dropdown where the dashboard's had two — which is the same lesson as the
catalog `fqn` in R17: a change is not finished at the component that displays
it. That route now loads connections, fetches schemas lazily, and runs a
report block's SQL at `widgetRowCap()` rather than the workbench's 50-row
preview cap, because a table somebody checks a row of must not quietly stop at
fifty.

#### Verified on the rebuilt image, not just in the tests

Every fix was checked back on the same widgets that produced the finding.

**The maps.** The two widgets that read "10 rows not matched to a country" now
read **"3 rows not matched"**. The lakehouse says why, exactly: `SELECT
country, count(*) FROM analytics.recon_union GROUP BY 1` returns twelve groups
— `BR 35, DE 35, ES 35, FR 38, GB 32, IN 41, JP 33, US 46`, plus `?? 1`,
`U S 2`, `XX 2` and 9 nulls. All **eight real countries now draw, `GB` among
them**, and the three that remain unmatched are the sample's deliberate dirt.
They should stay unmatched: guessing that `U S` means the United States is how
a map ends up quietly wrong instead of visibly incomplete.

**The axes.** The saved report and both time charts on the AI-generated
dashboard render `2022-05 … 2025-12` on AUTO, with no user action and no epoch
anywhere on either page.

**The report table.** `410,379.26`, `340,935.42`, `330,007.05` — the same text
`buildReportPdfBytes` puts on the page. `410379.26499999943` appears nowhere.

**The insight card.** Pressed again on the same widget, so both cards now sit
on the dashboard for comparison. Before: 48% / 39% / 19%, summing to 106%.
After: **45.4% / 36.5% / 18.1%, summing to 100.0%** — and it now states the
total it divided by ($2.3M) and the exact figures ($837.9k, $415.5k) instead of
rounded ones, because it is quoting computed facts rather than doing the
arithmetic. The shares reconcile against the true total of $2,297,201.86.

**The ontology.** Rebuilt from the same button that had failed: **76 entities,
55 relationships, 5 sources, badged "AI-built"** rather than the heuristic
fallback — and that is a job three times the size of the 21-table one that
died at 60 seconds. The relations carry real predicates (`derived_from`,
`defined_in`, `owned_by`, `depends_on`, `on_call_for`, `is_a`,
`interacts_with`), so the map has edges to read.

#### Verified correct, left alone

**The forecast is not a decorative line.** Six projected months against a
series built from `1000 + 25t + 200·sin(2πt/12) + 10·sin(7t)`: 1874.2 / 1997.0
/ 2095.4 / 2148.6 / 2147.7 / 2099.5 against a truth of 1906.24 / 2034.84 /
2131.80 / 2178.14 / 2169.33 / 2116.02 — **MAPE ≈ 1.4%**, the peak at step 4 in
both, and the interval widening 208.5 → 510.6, which is √6 exactly.

**Scan for insights** says on the tin that it is "computed from the snapshots
already on this dashboard — no model call, no cost, same answer every time",
and it is: it found the 2025-11 outlier at 3.1 MAD from the median, and it
listed the four widgets it could NOT sweep with a reason for each ("the
snapshot hit its row cap, so any total or share would be computed from part of
the data"). A feature that discloses its own blind spots.

**The AI's numbers are right even where its prose is not.** Total Sales 2.30M
and Total Profit 286.4k on the generated dashboard match the analyst's
independent `SELECT SUM(Sales), SUM(Profit)`, and the 14-row product breakdown
sums to 2,297,201.86 — the same total by a third route.

The Matrix pivot was checked cell by cell against the seeded series; the
paginated report's running header, footer, `{{page}} of {{pages}}` tokens and
cross-page table header all behave; and a section that fails to build is
disclosed (one of four failed once in three runs, with the reason named).

**Tests:** 51 across `biGeoMapCodes` (11), `biAutoDateGrain` (14),
`biReportCell` (11), `biInsightFacts` (10) and `biOntologyBudget` (8) — all
mutation-verified, 18 behaviour-changing mutants applied one at a time and each
killed, with two misses recorded and justified (a control, and the renderer's
one-line call site, which the live check covers instead).

### 2026-09-18 — A bundled sample, run end to end

One run of the shipped **Orders ↔ payments reconciliation** pipeline. The ETL
half was right to the row — 309 joined, 257 matched, 52 exceptions, every
number equal to a reference computed independently beforehand. Everything
below is about what happened to those 52 rows _after_ they landed, and it is
one assumption wearing five faces: **dlt gzips text output.**

#### R17 · S1 · The catalog globbed a filename nothing has

The crawler stored each folder-dataset as `${dir}/*.${logical format}`. The
logical format of `1789716749.8566182.2f2a328a13.jsonl.gz` is "ndjson", so the
asset was recorded as `finance/recon_exceptions/*.ndjson` — a pattern that
matches nothing in its own folder.

That string is not a label. It is the catalog's join key: the Workbench reads
the bucket through it, an ETL catalog-asset source resolves to it, the lakehouse
mount parses it, and `catalog_lineage.downstream_fqn` is matched against it.
Pressing the catalog's own **Query data** button on the catalog's own asset
returned

```
IO Error: No files found that match the pattern
"s3://etl/finance/recon_exceptions/*.ndjson"
```

Every jsonl or csv target this product has ever written was in this state. The
one bundled sample that reads a bucket back would have hit it too.

#### R17 · S2 · A row count measured in compressed bytes

`estimateRows` counted newlines in the sampled Buffer and scaled by
bytes-per-line. For a `.gz` object those bytes are gzip, so it counted whatever
0x0A fell out of the compressed stream: the 52-row exception report was
cataloged as **10 rows**, and 10 is exactly the sort of number nobody
questions. `inferColumns` a few lines above decompresses; only the counter did
not. It now decompresses first, and when the sample covered the whole object it
returns a count rather than an estimate.

#### R17 · S1 · The object-storage source could not read the target's output

`fs.open(k, 'rb')` hands pandas raw gzip:
`UnicodeDecodeError: 'utf-8' codec can't decode byte 0x8b`. Since this
product's own target is what writes the `.gz`, "pipeline B reads what pipeline
A wrote" — the medallion pattern — was impossible for csv and jsonl.
Reproduced both ways in the runtime image before and after the one-argument
fix, and that reproduction is the test.

#### R17 · S2 · Fixing the crawler alone would have broken lineage instead

A run REPORTS its target's fqn and lineage joins on that string, so the
compiler had to move with the crawler. What dlt actually names its files was
then **measured** — jsonl `.jsonl.gz`, csv `.csv.gz`, parquet `.parquet`,
against dlt 1.30.0 — rather than assumed, since assuming is what produced R17
in the first place. Spark names its own output differently again
(`part-*.json`, `part-*.snappy.parquet`), so the two engines deliberately
report different globs for one graph.

#### R17 · S2 · And four parsers downstream of the join key

Changing a stored identifier is never a local edit. `lineageKey` keys on the
last two **dot** segments, which for `finance/x/*.jsonl.gz` are "jsonl" and
"gz" — a key every compressed dataset in the bucket would share, so one
table's lineage would render as another's. The lakehouse mount's regex
(`/^(.*)\/\*\.([a-z0-9]+)$/`) simply failed to match and counted the asset as
`skipped`, with no message anywhere. `objectSqlName` — whose own header says
both sides must agree or the seeded query names a table the server cannot
resolve — trimmed one extension and left `*.jsonl`. The fourth came out of
pressing the button rather than reading: the Catalog decides whether to offer
**Query data** with an anchored extension test over the fqn, and `*.jsonl.gz`
ends in `.gz`, so the corrected asset had no button at all — a fix that removes
the feature it was repairing, on exactly the assets this product writes most
often. Each is pinned.

#### R17 · S1 · And none of it reached the pipeline that found it

The fixes were deployed, the image rebuilt, the catalog re-crawled — and
re-running `recon_live2` still wrote the OLD target fqn, leaving its lineage
edge pointing at a filename that does not exist while the asset beside it was
right. Pressing **Save** to recompile did nothing: the button is disabled when
the graph has not changed.

The generated program is a CACHE of the graph, and the run executed the cache.
Every visual pipeline on an upgraded deployment keeps running the previous
release's program until somebody edits it for some unrelated reason — with the
runs still succeeding, so nothing points at it. The same sitting had already
paid for this once without noticing: the SQL step's move off ibis did not reach
a pipeline created before that rebuild either, and its stored REQUIREMENTS went
on asking pip for `ibis-framework`, so even a correct program would have run in
the wrong environment.

A visual pipeline's graph is now recompiled at run start, for the engine the
run uses, and its packages derived from the same graph. A graph the current
compiler refuses stops the run with the compiler's own sentence. A code
pipeline — where the source is what somebody typed — is untouched.

#### R17 · S2 · A node nobody finished configuring failed in a library's words

Building the platform-dataset case, the "Choose a dataset" select was never
opened. The graph **saved**. The run **started**. It died inside the sandbox
with

```
requests.exceptions.HTTPError: 404 Client Error: for url:
http://agentswarms:8080/api/notebook/runtime/source
```

— the app's own internal API, named as though it were the problem, with nothing
tying it back to the node or the field. The reader's next move is to go and
look at the runtime.

Targets have said the right thing for as long as they have gone through the
identifier check ("Lakehouse table must be a valid identifier … got ''") and
the bucket check ("Node “Reconciled” has no bucket selected"). Sources and
transforms got it only where a field happened to pass through one of those; the
rest reached pandas, requests or DuckDB first and failed in whichever library
got there. `df.query('')` is "expr cannot be an empty string"; `groupby([])` is
"No group keys passed!"; a join with no right keys is "len(right_on) must equal
len(left_on)". None of them names one of ten nodes on a canvas.

Every required field is now refused at compile with a sentence naming the node.
Fields whose emptiness MEANS something are deliberately left alone — a rename
with no pairs is a no-op, a dedupe or a fill with no columns means every column
— and that line is pinned in both directions: the mutation run includes an
OVER-strict mutant (refusing a rename with no pairs) and the suite catches that
too.

#### R17 · S2 · The proxy refuses ports, and it looks like the endpoint refusing

A reverse-ETL target pointed at `http://echo-target.local:8099/hook`. The host
was on the allow-list, `allowed_domains` carried `.echo-target.local`, the
pre-flight passed — and the run failed with `403 Client Error: Forbidden for
url: http://echo-target.local:8099/hook`. It was squid: `http_access deny
!Safe_ports`, where Safe_ports is 80, 443, 9000 and 19000. The same pipeline
succeeded first try once the receiver moved to port 80.

The allow-list covers HOSTS. Nothing in the product covered ports, so the one
rule that could refuse a fully-configured node was invisible until it fired, in
a library's words, from inside a container — and the SaaS target's 403 hint
("this looks like the egress proxy…") would have pointed at the allow-list,
which was already right. The pre-flight now names the node, the port and the
allowed set, and gives HTTPS-on-a-non-443-port its own sentence since
`http_access deny CONNECT !SSL_ports` is a separate denial with the same
symptom. The app's port list is parsed out of the tracked squid.conf by a test,
mutation-checked in BOTH directions, so a change to either side fails.

**Tests:** 21 in `tests/unit/catalogGzipDataset.test.ts`, 30 in
`tests/unit/etlUnfinishedNode.test.ts`, 7 in
`tests/unit/etlRunRecompiles.test.ts`, 6 in `tests/unit/etlEgressPort.test.ts`.
Twenty-five guards mutation-checked one at a time, every reversion caught, with
a control mutant correctly missed in each set. The mount's regex and the Catalog's "Query data" test are pulled out of
the source and executed, so they are checked by behaviour rather than
spelling.

### 2026-09-17 — Lakehouse, ETL and ML, driven after the fixes

Not a module pass: the round that verifies four fixes in the browser, and what
verifying them turned up. Three of the five below are findings the UI produced
and no amount of reading would have; the last two came from reading the emitter
and the scheduler in the same sitting, and are logged here because they are the
same kind of defect — a control that offers something the code then quietly
turns into something else.

#### R16 · S1 · A comment stripper was written, tested, and never wired in

The fix for lakehouse write authorization needed a stripper that knows what a
string literal is, so one was written (`sqlRefs.ts`, `stripComments`) and used
by the new code. `stripSqlComments` — the one every statement actually goes
through before it executes — kept its two regexes, which do not. The commit
message asserted the opposite.

Typing `SELECT 'A--B'` into the editor returned **"unterminated quoted string"**:
the stripper had cut the statement at the `--` inside the quotes. Worse and
quieter, `SELECT '/*' AS a, '*/' AS b` returned **one column and no error** —
everything between the two literals had been blanked as a comment.

Fixed by delegating (`64e34dd`), with a test that asserts the WIRING rather
than the behaviour of the good function, because the behaviour was already
tested and already passing while the product did the wrong thing. Verified on
the rebuilt image: three columns, `A--B`, `/*`, `*/`.

#### R16 · S1 · The warm scorer is in a different image, and says nothing when it is stale

The decision-threshold fix (`837180d`) has two halves: the app sends the
version's threshold with each warm request, and the scorer applies it. The
scorer is `docker/notebook-runtime/score_server.py`, baked into
`agentswarms/notebook-runtime` — not the app image. A rebuild that named one
service (`docker compose up -d --build agentswarms`) left the old
`def score(rows)` in place, and the warm endpoint went on answering by argmax
while the app dutifully sent a field nobody read. No error, no warning, no
version skew check: the extra JSON key is simply ignored.

The documented upgrade (`docker compose up -d --build`, no service name)
rebuilds both, so this bites a partial rebuild rather than a real install.
docs/DEPLOYMENT.md now says so in the Upgrades section, because the symptom is
invisible in exactly this way.

#### R16 · S2 · "Pipeline has no code to run", on a pipeline the canvas had just explained

A visual pipeline saves even when its graph does not compile — a draft may be
half-wired — and the save toast carries the compiler's real sentence. Four
seconds later the toast is gone. Pressing Run then answered "Pipeline has no
code to run": true, because the graph never compiled and `source_code` is
empty, and useless, because it reads like the pipeline is empty and points at a
code tab a visual pipeline does not have. Found with the refusal still on
screen above the button that gave the wrong reason for it.

`startEtlRun` now recompiles the stored graph and returns what the editor said.

#### R16 · S3 · A quality gate that aborted the run recorded that it had dropped rows

The severity dropdown offered "Drop bad rows" for every check. For
`row_count_min` there is nothing to drop, and both emitters raised — correct —
while appending `severity: 'drop'` to the run's `_quality` metric. The record
of the gate that stopped the run said it had filtered it. The editor no longer
offers the option for that check, and both emitters record what they did.

#### R16 · S2 · Promote-when-better chose the noisier anomaly detector

`ML_PRIMARY_METRIC.anomaly = 'anomaly_rate'`, and `anomaly_rate` is not in
`ML_LOWER_IS_BETTER`, so `beatsProduction` read "better" as "flags MORE rows".
A nightly retrain with promote-if-better on installed whichever version was
noisiest, and told the owner it was better. The trainer disagreed in its own
output — the leaderboard row it writes carries `higher_is_better: False` — so
the two halves of the product had contradicted each other since the metric was
chosen.

Flipping the direction is not the fix: a detector that flags nothing would then
always win. The rate describes the fit rather than scoring it, so it now
decides nothing — production is kept and the notification says why.

#### R16 · S2 · "Explain this answer" on a recommender returned no answer and no explanation

Ticked on `revenue_facts · recommendations`, one row, through the UI. The
prediction succeeded and the stored row says exactly what happened:

```
input:   {"kind": "rows", "count": 1, "explain": true}
result:  {"columns": [...], "explanations": null,
          "warnings": ["1 user(s) had no history; they received the most popular items."]}
```

`explanations: null`, and the only warning is about cold start. The
recommendation branch of `_predict` returns before BOTH explain blocks, so the
flag was carried all the way from the checkbox into the stored request and then
dropped without a word.

The ablation those blocks perform replaces one feature value with a typical one
and asks the model again. A recommender's answer comes from which items other
users chose together, not from this row's columns, so there is nothing to
replace — the honest answer is "not for this kind of model", which is now what
both halves say: the two controls are not rendered for that task, and the
program appends a warning for every other caller (the API, the agent tool, a
scheduled batch) that asks anyway.

#### R16 · S1 · The trainer program was never compiled as Python by the suite

Found by making the mistake. The warning above was first written with an
apostrophe inside a single-quoted Python literal, in a 2,000-line module
carried as a TypeScript `String.raw` template. TypeScript was happy. Python
would have died at import, inside a sandbox, on a line number that maps to
nothing anybody edited.

Twenty-odd test files assert things about that module by searching the string
for substrings, which cannot catch it — the substring is present either way.
`tests/unit/mlTrainProgramParses.test.ts` now compiles the whole module with
the real interpreter, and scans it for control characters (a `\b` written in a
shell heredoc arrives as a literal BACKSPACE and compiles). Mutation check: the
unbalanced quote fails it with `SyntaxError: unterminated string literal`.

The same round also put a backtick inside that `String.raw` template while
writing a comment, which ends the template and breaks the TypeScript — caught
immediately, by the new test file failing to transform.

#### R16 · S3 · And the fix above turned a checkbox into a no-op

Refusing to judge an anomaly promotion leaves the schedule dialog offering
"Promote the new version when its primary metric beats production" for a model
where nothing can beat anything. Ticking it would have written
`promote_if_better: true` and then never fired — one silent wrong answer traded
for a silent nothing. The box is disabled for that task, the reason replaces
the label, and the save writes `false`.

Worth naming as a pattern: a refusal added in the engine is only half a fix
while the control that asks for it still looks available.

**Tests:** `tests/unit/lakehouseSqlRefs.test.ts` and
`tests/unit/lakehouseWriteAuthz.test.ts` (the stripper wiring),
`tests/unit/etlRunRefusalReason.test.ts`, the two gate cases in
`tests/unit/etlPipelines.test.ts`, the anomaly cases in
`tests/unit/mlOps.test.ts`, the recommender case in
`tests/unit/mlExplanations.test.ts`, and the whole of
`tests/unit/mlTrainProgramParses.test.ts`. Every one mutation-verified: removing the fix fails
it, rewording the comment beside it does not.

**Fixtures kept**, all listed in [UI test results](./UI_TEST_RESULTS.md).

---

### 2026-09-14 — Module 3 revisited, Agent Builder (`/agents`): the ML Predictions picker

Found by the UI round of a feature being shipped — a model picker for the ML
Predictions tool — not by a suite. The pass is the usual one: press the button,
then read the row.

#### R1 · S1 · Clearing an allow-list saved the old list back

The save-time `toolConfigs` was assembled as
`{ ...toolConfigs, ...sqlSpread, ...metricSpread, ...mlSpread }`. The SQL and
semantic spreads each dropped their own key by returning `rest` — the whole
config minus that key — so a later spread re-added what an earlier one had
removed, and the base spread of the unpruned state put back whatever the last
spread merely left out.

Measured on "Demo · Friendly Assistant" (`sql_query` limited to `saas_sales`):
untick `saas_sales`, watch the panel read "No selection — the agent can query
every table you can read", save, see "Agent updated". The row:
`sql_query: {"table_names":["saas_sales"]}`. The form said every table; the
agent still had one. Then the same on the new picker: "Allow every model again"
rendered the allow-all state and the save wrote
`ml_predict: {"model_names":["revenue_facts plan classifier"]}` back.

Not a wrong number — a setting that reports one state and persists another.
The persisted state is the narrower one, so it fails closed, which is how it
survived: nothing got wider, and reopening the form showed the restriction
still there, which reads as "I must not have saved".

Fixed in `AgentForm.tsx`: every allow-list key is stripped from the state
first and written back only when it should exist. Verified on the rebuilt image
against the rows: SQL cleared → key absent; ML reset → key absent; restricted →
exactly the one name; untouched → byte-for-byte the before snapshot.

**Tests:** `tests/unit/mlAgentPicker.test.ts` — three guards on the save path,
mutation-verified 6/6 (base spread re-added, key left in the remainder, length
gate on the ML write, a second write, an always-true SQL condition, a re-add
inside the metric branch).

#### R2 · S2 · The model said "verbatim" and had not called the tool

Not a code defect, and logged because it nearly passed as verification. Asked
to call `ml_predict` with a model outside its list and paste the raw response,
the Playground agent answered "The call failed as expected. Here is the tool's
raw response, verbatim:" followed by an error text that exists nowhere in the
codebase. The message row's metadata had no tool source for that turn; the
turn before it — a real `ml_list_models` call — did. A prompt that insisted on
the actual invocation came back with the server's own string,
`"revenue_facts model" is not enabled for this agent. Call ml_list_models for
the models it may use.` — which the model could not have produced otherwise.

The rule this adds to the method: a transcript is not evidence that a tool
ran. The row's `sources`, the audit trail, or a string only the server could
have produced is.

It recurred twice the same day, on the predict-by-key round: a "verbatim"
scoring result with version 1 (the model is at 7), one probability repeated
three times and a nonexistent key reported as found, answered in four seconds
with no `ml_predictions` row; then two error objects in a `{code, message}`
shape the code has never produced. The evidence path that works for error
returns — which `sources` drops by design — is a canvas run: the client
tracer records every `tool_call` and `tool_result` on the step, so the
refusal strings can be read from `swarm_run_steps.tool_calls` verbatim.

#### R15 · S2 · One collection can choose its own index — and the four instance-wide questions that stopped being the right question

The vector store was one switch for the whole deployment: `VECTOR_STORE`
decided where every collection was searched. Asked why there were two stores at
all, the honest answer was that the choice belongs to a collection, not to a
deployment — one collection outgrows Postgres, the rest never will. So the
choice moved into **RAG Settings → Retrieval → Vector index**.

What made this worth doing carefully is the failure mode. Vectors written to
one index and searched in another produce **no error and no empty state**. The
agent simply stops citing that collection, and every page still says it is
indexed. Nothing in the product would have reported it.

Four places had already answered the question instance-wide, and each was wrong
for a collection that differs from its instance:

- **Ingest** exited on `usesExternalStore()` before doing anything. A
  collection on Qdrant, on a deployment defaulting to Postgres, would have been
  indexed nowhere — the write skipped, the search finding an empty index.
- **Deleting** a document or a collection cleared the external store only when
  the INSTANCE used one, so vectors could outlive the rows that authorised
  them.
- **Re-index** skipped whole instances for the same reason, leaving the one
  repair operation unable to reach the collections most likely to need it.
- **The mode pin** in `resolveRetrievalSettings` rebuilt the settings object for
  `semantic` and `keyword`, and would have dropped the store with it: switching
  a Qdrant collection to keyword search would have silently moved it back to
  Postgres. Caught by a mutant, not by reading.

The resolution now runs through two functions that ingest, retrieval, cleanup
and rebuild all call, because the property that matters is not which store is
right — it is that all four agree.

**Changing the choice moves the data.** Saving copies the collection's existing
vectors into the new index, then saves the setting, then clears the old one.
Nothing is re-embedded: the embeddings are a column on `kb_chunks`, so a move
costs no model calls. The order is the guarantee — saving first and failing the
copy leaves a collection pointed at an empty index, while failing this way
leaves a copy in two stores, which costs disk and answers correctly.

**Proved live**, against this machine's real Supabase and the running Qdrant,
with `VECTOR_STORE` unset so the instance default was Postgres — the exact case
the old guards got wrong. A collection that chose Qdrant resolved to Qdrant
while its neighbour resolved to Postgres; its vectors, once copied, came back
from Qdrant at similarity 1.0 in the planted order; the same collection still
answered from Postgres, which is what makes the move reversible; a search
naming a different collection returned nothing; and clearing Qdrant left the
Postgres copy intact. Every row and vector was removed afterwards.

The first run of that file reported **five green ticks and proved nothing** —
the fixture had not been built, and each test began with an early return that
passes. The reason was mundane: the shipped sample collections have a null
owner, so borrowing "the first knowledge base" borrowed nobody. The file now
fails when `QDRANT_URL` is set and the fixture did not build, which is the only
reason it was ever noticed.

**Then driven through the browser**, once the owner signed in to a build of the
commit served beside the running instance. The 100-chunk RAG eval collection was
moved to Qdrant and back through the control itself, and the two directions
prove different halves of the design:

- Saving Qdrant reported "100 vector(s) moved into qdrant"; Qdrant went from 4
  points to 104, exactly 100 of them this collection's, and a search with a
  stored chunk's own vector returned that chunk at 1.0000. The dialog reopened
  on Qdrant rather than the default.
- The agent then answered a multi-hop question from that collection — the
  firmware a controller needs to roll a node back (5.2) and the condition that
  declares a partition (45 seconds on 3 or more links) — with citations, and a
  version-conflict question (768 nodes, noting the older document says 512 and
  why it is superseded).
- **Qdrant's own request counter is what proves the routing.** It rose by one
  per question while the collection was on Qdrant, and did not move at all for
  a question asked after the switch back, which still answered correctly and
  cited the right document. Postgres kept every vector, which is what makes the
  return trip free.
- Switching back reported a plain save with no move, cleared this collection's
  100 points from Qdrant while leaving the other collection's 4 alone, and wrote
  both directions to the audit trail.

The collection was then restored to the settings it had before any of this.

#### R14 · S1 · Every service, every install — and the four things only running it found

Compose put seven services behind profiles, so `docker compose up -d --build`
started the app alone; `--all` was documented and not the default; the
Kubernetes installer left the notebook runtime and the Spark namespace to a
later `kubectl apply`; and several services that did start were never wired —
Qdrant idle until .env said `VECTOR_STORE`, Valkey until `FEATURE_STORE_URL`,
Spark until `SPARK_CONNECT_URL`, the lakehouse catalog until it was named and
given an object store that nothing shipped. The change is in the commits; what
belongs here is what running it found, none of which a test that reads files
could have said.

- **F1 (S1)** MinIO's Docker Hub repository is not publicly pullable.
  `docker pull minio/minio` is "pull access denied … or may require 'docker
  login'" on a daemon that pulls `alpine` in the same second, so every install
  would have failed on the image. Both images come from quay.io now, where
  MinIO publishes.
- **F2 (S2)** The bucket step ran `mc alias set` through a folded YAML scalar.
  YAML turned the line continuations into spaces, mc read the access key as a
  command — "agentswarms: command not found" — and created nothing, while the
  line above it said "Added `lake` successfully". It uses `MC_HOST_lake`, mc's
  own credential form, and a command array: no shell, nothing to fold.
- **F3 (S2)** The object store's health check allowed 20 seconds plus five
  retries. A fresh install starts eleven containers while several images are
  still building, and MinIO formats its pool on first start: under that load it
  missed the window, the bucket step refused to run ("dependency failed to
  start: container minio is unhealthy") and the install ended with no bucket
  and no error anyone would connect to the cause. Idle it is ready in about 30
  seconds — which is why every measurement on a quiet machine passed. 60
  seconds plus twenty retries now.
- **F4 (S3)** `docker-compose.yml` named the egress proxy's container as a
  literal while the app resolves it from `NOTEBOOK_EGRESS_CONTAINER`: the same
  name by coincidence, and two instances on one host collided on it. Compose
  reads the same variable now, so one setting moves both.

Then CI, on the first push: `docker compose config` failed with "yaml: control
characters are not allowed". Two comment lines carried U+0080 U+0094 — an
em-dash that went through a bad decode in an editing script. Windows' compose
accepts those characters and Linux's does not, so every local run passed and
the first Linux run did not. Repaired, and `check-infra` now scans every
tracked text file for U+007F–U+009F, which needs no Docker and so catches it
where it is written.

**Proved on a clone of the commit**, installed from scratch beside the running
stack with its published ports remapped: `bash scripts/setup.sh` brought up 11
services in 444 s, `/api/health` answered 200 five seconds later, the bucket
was created, the catalog password was generated into both halves that must
carry it, and .env arrived wired (VECTOR_STORE, QDRANT_URL, FEATURE_STORE_URL,
SPARK_CONNECT_URL and the four lakehouse values). From inside the app
container: qdrant, minio, docgen, the notebook gateway and the JS sandbox all
answered 200, and valkey's port was open. Two refused at that moment and both
were first-run timing, verified afterwards rather than assumed: the catalog was
still running Postgres' first-boot init and accepts connections once it
finishes, and Spark Connect was still downloading its connector jars — on a
stack whose ivy volume already has them, the port is open.

Recorded, not changed: the app image takes about 55 minutes to unpack on this
machine, nearly all of it in the exporter, so a first install is a long wait
rather than a hang; and the daemon holds a container it cannot kill ("PID is
zombie and can not be killed"), a host condition that cost one attempt at this
proof — it stopped the running stack, hit that container, and left the app down
until it was brought back up.

#### R13 · S2 · The installers, the compose file and the manifests, checked for the first time

Every installation and deployment asset, verified rather than read: the
three shell installers and the PowerShell one, the backup and restore
scripts, the five Dockerfiles, the compose file with and without every
profile, the four Kubernetes manifests, the runtime verifier and the
hardening suite, and the commands the handbook tells an operator to type.
Static where a cluster is not needed, live against the running stack where
it is. `docs/UI_TEST_RESULTS.md` has the table.

- **F1 (S2)** Not one of the six tracked shell scripts was executable:
  100644 in git for `setup.sh`, `setup-selfhosted.sh`, `setup-k8s.sh`, the
  two runtime test scripts and the notebook image's entrypoint. The in-app
  install page said `./scripts/setup.sh --all`, which on a fresh Linux or
  macOS clone is "Permission denied" (every Markdown doc said `bash
scripts/setup.sh`, which works either way; the Dockerfile chmods the
  entrypoint, so images were never affected). Modes fixed, the page reads
  like the rest, and the check pins the mode.
- **F2 (S3)** `setup.sh --help` printed a usage block that had lost the
  seventh profile — `--featurestore` worked, the help did not know it — and
  both installers' comments said "the same six profiles" of seven. The
  check now derives the count from the compose file and demands each
  profile in both installers' flags, in `--all`, and in the help.
- **F3 (S2)** `verify-runtime.sh` tier 4 ("the kernel reaches the platform")
  pointed its test kernel at `host.docker.internal` whenever the app URL
  was localhost — including when the app runs in compose, where the kernel
  sits on an `internal` network with no route to the host. A healthy
  install reported "All connection attempts failed"; 15 of 16 checks
  passed and the one that failed was the verifier. It now mirrors
  `internalAppUrl()`: the service name inside compose, the host gateway for
  a host-run app, `NOTEBOOK_APP_INTERNAL_URL` when set.
- **F4 (S3)** `docker build --check` warned about the publishable Supabase
  key in ENV in the app image. It is the anon key, shipped in every browser
  bundle by design; the directive skips the rule with that reasoning, and
  the other four Dockerfiles were clean already.
- **The gap behind all four:** nothing ran any of this. CI built the app and
  ran the unit tests; `check:doc-commands` existed and ran nowhere. Both
  checks are in `npm run check` and in CI now.

Verified working, no change needed: the compose file renders with and
without every profile; 47 Kubernetes documents with consistent selectors,
images and secret references (the notebooks namespace's LimitRange fills
the requests two Deployments omit); 73 documents' commands resolve; 83
routes load without a server error; a real backup (the catalog dump, 79
lake objects, all 25 catalog-referenced files present) and the documented
restore drill (scratch database restored to snapshot 460 and dropped, 25
objects re-uploaded and verified, prefix removed); the self-hosted
installer's ordering (wait for auth, then for the storage schema, then the
five extensions, then the push, then the admin user, then the app).

#### R12 · S1 · A knowledge-base answer read one chunk, cut in half: the RAG evaluation

A session on Agent Chat with a knowledge base built to be hard: twelve
documents about a fictional vendor — a current and an archived SLA that
disagree on every number, a pricing guide whose discount and support rules
sit in different tables, a runbook, a regional matrix whose Mumbai date is
contradicted by a newer report with the correction buried in the middle of
3,800 words of filler, release notes that raise a limit the product overview
still states, a glossary, a partner FAQ — and twenty questions with an answer
key: current-version, version-diff, multi-step arithmetic, an exception,
multi-hop, a recency conflict, a buried fact, an absent product, an
aggregation, an acronym across documents, a capped credit, an exclusion,
another domain, a follow-up that depends on the previous turn. One agent on
`openai/gpt-5.2`, the knowledge base alone. Every answer read from the
stream, two of them typed into the real chat and read back from the DOM and
from `messages.metadata.sources`. `docs/UI_TEST_RESULTS.md` has the tables.

- **F1 (S1)** Eleven of twenty right, and the model was honest every time it
  was wrong: "the retrieved excerpt does not include the response-time
  table". It did not. Citations were one chunk per document — the
  best-scoring one — cut to 560 characters. On the SLA the paragraph that
  merely talks about response times outranked the table that holds them
  (both are in the same document), the collapse kept the paragraph, and
  even the document whose first chunk won was shown with its second half
  missing: the runbook's RTO sits past character 560 of chunk 0. A citation
  now carries a document's best three chunks in reading order, each whole
  (1,600 characters), under a 12,000-character budget per turn; all three
  are settings (`KB_CHUNKS_PER_DOCUMENT`, `KB_CITATION_CHARS_PER_CHUNK`,
  `KB_GROUNDING_MAX_CHARS`). Same questions, same model: twenty of twenty,
  the grounding 2,400 prompt tokens a turn instead of 700, and the answers
  faster (6.5 s against 9.8 s) because the model no longer reasons about
  what it was not given. The recency conflict (512 or 768 nodes) is
  answered with both figures and the condition; the credit is capped; the
  buried Mumbai date wins over the matrix.
- **F2 (S2)** A collection that never saved retrieval settings searched by
  vectors only, on the argument that an upgrade should change no answers.
  Measured on the same twenty questions: semantic-only lost the exact-term
  ones — "Severity 1", "RTO", "HIPAA" — to look-alike paragraphs, and the
  keyword pass rescued each one it was allowed to run on ("What is the
  Severity 1 response time for Gold support" ranks the two SLA tables first
  and second by keyword and neither by vector). Hybrid, weighted 0.7 toward
  meaning, is the default for the undecided; a saved `semantic` is kept.
- **F3 (S3)** Adjacent chunks are cut with an overlap so no sentence is lost
  at a boundary; joined back to back the overlap read twice ("## Do not
  affic forwarding across the whole fabric … ## Do not Never restart"). The
  second chunk now starts where the first ended (`overlapLength`).

Measured and recorded rather than changed:

- **Tool bloat.** The same agent with thirteen built-in tools enabled (web
  search and browse, graph search, SQL, metrics, data health, ML, calculator,
  date, weather, n8n, MCP, notifications): still twenty of twenty, never the
  wrong tool — the routing guidance holds — but 10,400 prompt tokens a turn
  against 2,400, because every tool's schema rides on every request. The
  credit question went round the calculator three times for arithmetic the
  model had already done in prose: 37,000 tokens and 18 s for an answer the
  bare agent gave in 8.8 s. The four tool-shaped questions (weather, date,
  local tables, a product) each called the right tool once. Prompt caching
  reported zero cached tokens on every request. The handbook's "three tools
  is a good number; eight is not" now carries these figures. Measured per
  tool afterwards (each enabled alone, same question, prompt tokens over the
  bare request): `sql_query` 5,240, `ml_predict` 701, `kb_graph_search` 508,
  `data_health` 264, `weather` 185, `web_browse` 185, `calculator` 162,
  `datetime` 154; n8n, MCP and notifications cost nothing until something
  is connected. The SQL tool's description carried fifteen tables with
  every column — 17,000 characters — so it now has a budget
  (`SQL_TOOL_SCHEMA_MAX_CHARS`, 4,000): columns until it is spent, names
  after, `list_data_tables` for the rest. Two things the per-tool round also
  showed: with web search as the only tool the model searched the web twice
  for a question the grounding answered (adding kb_search beside it, it did
  not), and an explicit `enabledTools` list without `kb_search` switches
  auto-RAG off by design — documented at the gate in chat.ts, easy to trip
  over from the API.
- **Context bloat.** A 24-turn conversation, the page's whole history sent
  each turn: prompt tokens plateaued at 3,200–4,200 (the 20-message window),
  latency stayed 5–13 s, every answer stayed right. The rolling summary is
  folded from persisted rows, so a caller that does not persist its turns
  gets a windowed history with no summary and the model names the wrong
  "first question" with confidence; with the rows persisted the fifth turn
  carried `memory_used {summaryUsed: true}` and the model listed the folded
  questions while saying it could only paraphrase them. A 36,000-character
  question was answered correctly at 10,108 prompt tokens — the query
  embedding did not fail — and the 4,000-character input guardrail is off by
  default. Retrieval ran on every turn, "what is the weather in Frankfurt"
  included: five citations fetched and discarded. Measured afterwards on
  the same collection (text-embedding-3-small): the best chunk of every
  document question scored 0.38–0.75, of every off-topic question 0.10–0.32
  ("how many local data tables" the closest at 0.32), and no off-topic
  question had a keyword hit. A floor (`KB_MIN_SIMILARITY`, 0.3; a keyword
  hit always passes; the tool is never floored) now leaves such a turn
  ungrounded, with the model told the search found nothing.

#### R11 · S2 · The analyst page at a narrow window, and a new analyst with no controls

From the user's screenshot at a small window, reproduced at 1000px: the
analyst rail kept its 256px, the header's six actions never wrapped, so the
page container — which hides overflow so the transcript can scroll inside a
pinned height — held 1173px of content in 744px of room, and focusing the
question box scrolled the rail clean out of view: the analyst list looked
cut off at the left and the actions at the right. The header now wraps, its
labels go icon-only below lg (titles kept), the title input shrinks, the
model badge and the source label are dropped first, the rail narrows below
lg, and on a phone it hides behind a button and comes back full-width,
closing again when an analyst is picked. Verified at 1000, 768 and 375px:
the container's content fits its width at each.

Two smaller ones from the predictive-model round. The analyst just created
showed no owner controls (share, edit, delete) until the page was reloaded:
the insert returned the row without `user_id`, and the card decides
ownership by it. It returns it now. And the "analyst updated" toast sits at
the bottom right, over the Ask button; a pointer resting there keeps it alive
and every click lands on the toast, so three asks went nowhere until the
pointer moved. Left as is — it is the app-wide toast position and a resting
pointer, not a code path — but recorded so the next round does not lose
twenty minutes to it.

#### R10 · S1 · Seven questions to the AI Analyst about seven models: twelve findings

A session rather than a feature: one analyst on `openai/gpt-4o-mini` over the
lakehouse, one question per model kind, every answer read from the DOM and
from `ml_predictions` and the persisted step rather than from the screen.
The full transcript is in `docs/UI_TEST_RESULTS.md`. The findings, by
severity:

- **F1 (S1)** Fifteen scored orders, quoted to the write-up as a summary
  because fifteen is past the twelve-row quote cap: the writer saw
  `order_id total=22104` and three per-class maxima and built its findings
  table out of them — three rows, each with order id 22104. A scored step's
  rows ARE the answer; they are now quoted in full up to the scoring cap.
- **F2 (S2)** The same total made the self-check "correct" a correct query
  ("22104 seems too high for 15 orders"). Identifier columns (`_id`, `_key`,
  `_code`, …) are no longer totalled in the facts; they are named as
  identifiers with a distinct count.
- **F3 (S1)** "Estimate their net_usd with the revenue_facts model" produced
  a step whose goal named the model and whose plan had no score block; it
  was written as SQL over the actual values, the reviewer passed it as
  "accurately estimates … using the model", and the write-up presented a
  table of actual vs "estimated" with identical numbers. A goal that names a
  model in scope is now scored by it; the reviewer is told a step not marked
  as scored did not run the model; the writer is told a step not marked
  SCORED BY holds observed values only.
- **F4 (S3)** The scoring goal's "at most 50 rows" overrode the question's
  own ten, costing a correction round. The goal now says fewer when the goal
  names a number, and one row per DISTINCT entity (F12 — one customer was
  scored thirteen times, once per order).
- **F5 (S2)** Asked what distinguishes each group, the write-up said the
  distinctions "are not provided in the results" — the cluster profiles, the
  class meanings and the trainer's warnings the tool already writes as notes
  were discarded by the analyst's scorer. They now travel with the scored
  step (a collapsible under the disclosure) and into the write-up.
- **F6 (S1)** "Which ten orders look most anomalous": the SQL sampled fifty
  at random (it cannot rank by a score that does not exist yet), the
  reviewer proposed `ORDER BY anomaly_score` and died on a binder error, and
  nothing could rank the scored rows. A plan may now ask for
  `"rank": { "by", "desc", "limit" }` inside `score`; the platform orders
  the scored rows and the disclosure says so. The planner is told each
  model's output columns to rank by.
- **F7 (S2)** The R9 prompt rule ("a correction must not select, filter or
  sort by the model's columns") did not hold with this model. A correction
  that reads a model column is now refused in code, with a note saying what
  it read and that the original result stands.
- **F8 (S2)** Twice, a correction that failed to run was reported by the
  write-up as the STEP having failed ("the SQL query failed to execute
  correctly") over a step that had succeeded and scored fifty rows. The note
  now says the original result stands, and the writer is told a failed or
  refused correction means the step did not fail.
- **F9 (S1)** The two forecast models were invisible to the analyst (they
  take no rows, so they were filtered out of the scorable list); asked what
  monthly net_usd will do over the next three months "using a trained
  forecast model if one fits", the planner scored fifty orders with the
  regression model and the write-up invented "month 1: 480.89, month 2:
  480.89, month 3: 480.89" from their mean. Forecast models are now offered
  as a forecast step — no SQL, the model's projected periods with their
  interval, through the same runner the agent tool uses — the planner is
  told a regression model is not a forecast, and the writer is told never
  to turn per-row estimates into a projection.
- **F10 (S1)** "Score the customers with the churn model" — there is no
  churn model — was answered with the clustering model, silently, as "top
  five at risk". A question naming a model nobody has now stops and asks,
  naming the models that exist.
- **F11 (S2)** That same step scored rows carrying one of the model's seven
  feature columns; the scorer imputed the other six and four of five rows
  came out identical. Rows missing at least half of a model's features are
  refused with the missing columns named; fewer missing are scored and named
  in the notes.
- **F13 (S2)** Found by the re-run: asked the anomaly and the forecast
  questions again on the fixed image, the planner returned `{ "score": {
"model": …, "rank": … } }` and `{ "forecast": { "model": …, "horizon":
3 } }` — the whole plan collapsed into its one interesting block, both
  blocks exactly right — and the analyst said "no analysis steps". A bare
  step-shaped root (or `steps` as one object) is now read as a one-step plan
  whose goal is the question.

- **F14 (S3)** Rows-mode scoring returned the feature columns and nothing
  that named the order, so "the ten most anomalous orders" came back as ten
  unnamed rows. The scoring goal now asks for the entity's identifier beside
  the features.
- **F15 (S3)** The forecaster's period is a week; the question said months;
  the reviewer passed "the next 3 months". It is now told the step's period,
  horizon and last observed period, and to name a mismatch.
- **F16 (S2)** "Go with the assumption" re-asks with the assumption appended,
  and the planner asked the same question again. The planner is now told the
  user has answered, and if it still asks it is asked once more in plainer
  words before a second clarify is honoured. Measured after that: the
  smaller model asked a third time ("Which churn model should I use?") with
  its own assumption, "the churn model is the one defined in the schema" —
  there is none — so a plan that reaches for another model under an
  accepted assumption is now stripped of its scoring and answers from the
  data alone, with the approach saying so. A model that insists on asking is
  shown asking; it can no longer substitute.

- **F17 (S3)** With a rank of ten planned, the SQL writer took "ten" as its
  LIMIT and the ranking ran over ten rows instead of the fifty-row sample.
  The scoring goal now says the platform keeps the top N after scoring, so
  the query must not limit to that number (verified live in the R11 round:
  fifty sampled, the top ten ranked).

Twenty-two mutants, twenty-two caught. The session's analyst and its threads are
kept on the instance for review, and the same seven questions were asked
again on the rebuilt image; the before-and-after is in the UI test results.

#### R9 · S2 · The reviewer "corrected" a column that exists in no table, and a caveat built on arithmetic over an id

Two more, from the health rounds, both in what the self-check is told about
a scored step. A scored step's facts carry the model's columns beside the
SQL's — `order_id | prediction | probability | proba_*` — and nothing said
which was which. The reviewer "corrected" the step with `SELECT order_id,
prediction, probability, proba__unknown_, …` and the rewrite died on
`Binder Error: Referenced column "prediction" not found in FROM clause` —
the model had written that column onto the rows after the query ran. The
original result survived and the step was flagged, so nothing wrong was
shown; but "correction failed" now stood over a correct step.

The second is worse. The contribution detector recognises a two-period
breakdown by shape — a label column and two numeric ones — and read that
same table as a breakdown by `prediction` with `order_id` as the previous
period and `probability` as the current, and computed it. The reviewer
repeated the result as a concern ("a total change of -11,054.852, which is
not consistent with the expected scale of changes based on the order_id
range"), and the write-up listed it under Caveats, beside the real one
about drift. A fabricated caveat is one nobody can act on, and it makes
the true one next to it read as noise.

Now the disclosure records which columns the model added (`columns`, named
as they land on the table, prefixed when they collide); the check's step
block says "SCORED AFTER THE QUERY by <model>: the column(s) prediction,
probability are the model's estimates … they exist in no table"; the
reviewer's rules say a correction returns the same key column(s) and is
scored again on its own; and the facts every prompt reads come through one
helper that keeps the model's columns out of the contribution and series
arithmetic and marks them "(model estimate)" on the columns line. Nine
mutants, nine caught — including the one where the loop simply stops
telling the check which step was scored.

#### R8 · S2 · "Produced no write-up" over a finished analysis, and a rule that never reached the writer

Two more from the same two live rounds. The findings panel said "The
analysis completed but produced no write-up — the step results above stand
on their own", twice, while the ASK NEXT list had three follow-ups from the
same reply. `execution_traces` held the reply: `{ "answer": { "orders": [
{ "order_id": 1000, "predicted_plan": "pro", "probability": 0.9479 }, … ] },
"caveats": [...], "follow_ups": [...] }` — the write-up, as data. The parser
accepted a string under `answer` and nothing else; a perfectly good answer
became "no write-up" because it arrived as a table. It is rendered now — an
array of flat objects as a Markdown table, an object as a list, caveats
appended — and a string answer is untouched.

The second: the planner was told, at length, what a scored step's SQL must
return. The SQL is written in a separate call that sees only the step's
goal, so the rule never reached the writer, and both rounds it reached for
`analytics.revenue_facts_plan_classifier_predictions`, a stored table whose
columns looked like the answer. The goal a scored step hands the writer now
carries the requirement — the model's key column(s), from the source table,
no stored predictions, no prediction of its own — and the test reads the
writer's prompt for it. Prompts are not a chain: what one call is told, the
next is not, unless the text is carried across by hand.

#### R7 · S2 · The model's answer vanished behind the badge that said the model had answered

The first live question to a scored analyst step. The plan asked to score
orders 1000–1010 with the plan classifier; the SQL generator, reading the
lakehouse schema, reached for `analytics.revenue_facts_plan_classifier_predictions`
— a batch-prediction table from an earlier run — so the step's rows already
carried `prediction` and `probability` before the model ran. Scoring ran (an
`ml_predictions` row via `ai_analyst`, four rows, succeeded), and the join
kept the SQL's columns and left the model's out, because it only appended
columns the input did not have. The table showed the stored table's numbers
under a badge saying the model had scored these rows.

Then the self-check narrowed the SQL, and under the first rule a refined step
dropped its predictions and told the reader to "ask again to score them" —
the honest sentence for a governed compile, which cannot be re-run on
hand-written SQL, and the wrong one for scoring, which can simply run again
on whatever the correction returned. Both changed: a colliding prediction
column is kept under a `predicted_` prefix (`joinPredictions`, pure, with the
key-identity join and a null for a key that matched nothing), and a refined
scored step is scored again and says so. Neither was reachable by the unit
test until the live round produced the collision.

#### R6 · S2 · The self-check overwrote what the step had already said about itself

Found by a unit test, not a screen, while giving the AI Analyst a scored
step: a scoring that failed wrote `check = { suspect, "Could not score with
… — the rows below are unscored" }`, and the assertion found `pass` with
"ok". The self-check stage, which runs after every step, assigned its verdict
over whatever `check` held. That was not new to scoring: a governed step
whose compile fails falls back to written SQL and writes "The governed model
could not answer this step … so the SQL below was written by the analyst
instead of compiled" into the same field, before the same check — and had
been losing it to a green **pass** since governed steps shipped. The reader
saw a passed step and no badge, and nothing said a compile had been tried.

Two facts, two authors: how the step was produced (written before the check)
and whether its SQL holds (the check). Both are kept now — a pre-check note
survives as a suspect verdict with the check's own verdict appended, and a
refinement's note is prefixed with it. Pinned by the scoring test; the
governed fallback rides the same line.

#### R5 · S2 · A refused call badged "ok"

Found while giving the Tool Calls panel a prediction table (the panel had
shown every result as its first 400 characters, which for a prediction ends
mid-probability). The ML tools answer an error as JSON rather than throwing —
`{"error": "Send rows or keys, not both."}` — so the loop's `ok` was true, the
panel's badge said **ok** in green, and beneath it the result said the call
had been refused. Two facts on one card, contradicting each other, with the
green one on top. The badge now reads the result: ok only when the call
succeeded and an ML result is not an error. Same round, smaller: a forecast
returns periods, not rows, and the count badge over a table of three weeks
read "0 rows". Both were visible only with the real panel open over a real
call; the parser's tests were green throughout.

R2 recurred a third time here — "8 periods returned (2025-01-01 through
2025-08-01)" with no call behind it; the real call, forced, returned three
weeks starting 2026-04-05.

#### R4 · S3 · An all-miss answer that could never be given

The predict-by-key work gave `ml_predict` its own answer for "no key matched
a row": a structured result with `predictions: []` and every key named in
`keys_not_found`, so an agent would see misses rather than nothing. A guard
pinned it, the docs described it, and the canvas round for the scoring node
ran it — a key of 999999 — and the node failed with the LOOKUP's message:
"No features found for order_id=999999 in order_features". `resolutionError`
already refuses a resolution with no rows, the tool returns that refusal on
the line above the new branch, and the branch was unreachable. Dead code with
a passing test and a paragraph of documentation. Removed; the rule is pinned
where it lives (`resolutionError`: all-miss is an error, a partial miss is
named beside the rows that scored), and the docs say that instead.

What it took to find: not a mutant, not a review — a value that matched no
row, pressed through the real path. The guard was green because it read the
code it was written beside.

#### R3 · S2 · A headless run's steps record no tool calls

Applying R2's rule to the canvas round exposed a gap in the server executor.
The same swarm, the same node, the same input, run twice: from the canvas, the
`research` step in `swarm_run_steps` carries
`tool_calls: [{name: "ml_list_models", type: "tool_call"}, {type: "tool_result",
ok: true, preview: …}]`. From a schedule — the server executor — the step
carries `tool_calls: []`, with the same one-model output. The server tracer
(`observability/serverTracer.server.ts`) has no tool-call field at all; the
client tracer writes `args.toolCalls`. So the Swarm Traces page shows a
deployed run as if its agents never used a tool, which is the case where
someone most wants to know. Left open here — this pass is about the picker —
and queued for the ML/agent integration work, where the deterministic scoring
node will need its calls visible on exactly this path. For this round the
headless evidence is the run's `swarm_snapshot` (the node's
`ml_model_names: ["revenue_facts plan classifier"]`) and an output naming that
one model with "Count: 1", a name the input never mentioned.

**Closed 2026-09-14.** The server read /api/chat's stream for text and the
`cost` event and dropped every `tool` event; the stream reader is now one
pure function (`src/lib/chatStream.ts`, `readChatStream`) that hands the
executor the same events the canvas keeps, the executor collects them per
node, and the server tracer writes `tool_calls` where the canvas tracer
does. A tool node and a retrieve node record their own call and result in
the agent loop's shape (`toolNodeEvents`), an ML result carrying the same
person-readable table the Playground panel gets, so the Score node's calls
are visible on exactly this path. The Traces page reads both shapes — the
loop's `args` string and result preview, and older rows' `arguments`
object. Ten mutants, ten caught.

### 2026-08-18 — Modules 30 & 31, IAM (`/admin/iam`) and Developer runtime (`/admin/runtime`)

The last two modules, and the same finding on both: a failed load that could
not be recovered from. Neither page ever told a lie — which on the two pages
that govern access and code execution is the part that matters most, and both
had it right before the campaign arrived.

#### Module 30 · IAM — S3 · A dead end with the exit in the unreachable room

This is the best-behaved read path in the whole campaign. All **seven**
server-fn reads are checked (`if (!u.ok) return setError(u.error)` and six
siblings); the error is held in state and rendered in two places; and every
list stays `null` on failure because each check returns _before_ any setter
runs. So no "no users", no "no groups", no "no grants" can ever appear from a
failed read. On an access-control page, where an empty grant list read as fact
is the difference between "nobody has access" and "we could not check", that
property is the whole ballgame — and it was already there.

What it lacked was a way out. Measured with `iamListUsers` 403'd (one
interception): three skeletons, one line of red error text, and **no control of
any kind**. The Refresh button exists — in the main view, below the gate that
the null lists keep active. A browser reload was the only recovery.

#### Module 31 · Developer runtime — S2 · The same, one step worse

`RuntimeTab`'s load did `if (!res.ok) return toast.error(res.error)` — the
error going to a **toast only**, `state` left null, gate rendering two
skeletons. Measured with `nbRuntimeGetState` 403'd (two interceptions), then
sampled again nine seconds later:

|               | at 5s          | after the toast expired |
| ------------- | -------------- | ----------------------- |
| skeletons     | 2              | **2**                   |
| toast         | (already gone) | gone                    |
| error text    | **none**       | **none**                |
| retry control | **none**       | **none**                |

A permanently blank page, with nothing on it saying why — governing whether the
Python runtime is enabled, its egress allow-list, and who is granted access to
it. S2 rather than S3 because unlike IAM there is no persistent error at all:
after a few seconds the screen is indistinguishable from a page that is simply
still loading, for ever.

#### Fixed the same way on both

A settled failure now renders the reason, a reassurance that the configuration
itself is untouched — "every user, group, rule and grant is unchanged and still
enforced" / "the runtime's current configuration is unchanged and still in
force" — and a **Try again** wired to the loader. The reassurance is
load-bearing on these two pages specifically: a superadmin who believes IAM is
broken may start re-granting access that never lapsed, and one who believes the
runtime page is broken may re-enable a runtime that was never off.

IAM's branch is gated on `error && !loading` on purpose, so an error latched
from a previous attempt does not replace the skeleton of the retry currently
running — a detail with its own test.

Verified live on both: the failure state shows the error and no skeletons, and
clicking Try again with the injection healed brings the real page back (IAM's
tabs and Refresh; the runtime's switches).

#### Mutations: 6/6 (IAM) and 5/5 (runtime)

Both sets are source tripwires, and the reason is stated in the test file: IAM
is a 2,400-line superadmin route driven by seven server functions and
RuntimeTab is driven by five, so rendering either here would test mocks. Two
of the IAM mutations pin the properties that were _already_ good rather than
what I changed — dropping a read check, and moving `setUsers` above the checks
so a false empty becomes possible. Those exist because this page's existing
correctness is worth protecting from a future refactor, not just my addition to
it.

**Tests:** 9 in `tests/unit/iamRecoverable.test.ts` covering both pages. No
fixtures; nothing was granted, revoked or enabled.

---

## Coverage complete — all 31 modules audited

Every module in the map now has a pass. What the campaign found, in one place:

- **The dominant defect, 16 times over:** a read whose failure was reported as
  a fact about the account — "you have none", "0 connected", "no audit events",
  "no providers connected" — usually with an invitation to fix the emptiness by
  redoing work that already existed. Four modules also _instructed_ the user
  (create a dataset, execute a swarm, connect a provider, add an Evaluate node).
- **Silent truncation, 4 times:** `.limit()` capped below the real row count,
  or PostgREST's max-rows capping below the `.limit()`, with the loaded window
  presented as the population. Once (module 24) the caps were non-uniform in
  time, so a merged feed mixed a 3-day view of one action type with a 13-day
  view of another.
- **Verdicts over work that never happened, twice:** the model that failed
  fastest crowned fastest; a run with nothing scored graded 0%.
- **Unrecoverable states, 4 times:** skeletons with no retry, and once a
  _memoised_ failure that claimed "no providers connected" for a whole session
  from one transient 403.

Reusable primitives left behind: `listClaim`, `countClaim`, `traceWindow`,
`auditWindow`, `budgetLoad`, `compareWinner`, `evalPassRate`, `serviceHealth`'s
`servicesSummary`, and `adhocTools`. `failedReadClaims.test.ts` pins nine
converted pages against eight rules — still deliberately a list, not a rule
over every page.

Two habits earned their place and should outlive the campaign: **positive
injection proof** (a failed-read finding requires the interception counted, not
inferred from what rendered — the rule module 16 cost a whole pass to learn),
and **mutation-verifying every test**, which caught eleven decorative tests
across the run, including one that let the exact defect it was written for pass
straight through.

---

### 2026-08-18 — Module 29, Image Playground (`/image-playground`)

One finding, and it is the first in this campaign that **outlives the request
that caused it**. The fix is in a shared module, so it lands on two pages.

**What the page already does right.** The models read — the second, per-provider
fetch — keeps its error in `modelsError` and renders it; "lists no
image-generation models" is shown only when that error is absent. The defect is
one layer down, in the provider list both this page and `BiModelSelect` share.

#### S1 · "No model providers connected", for an account with two — and it sticks

`fetchConnectedIntegrations` merges two tables and did `?? []` on both, so a
403 produced an empty list and **resolved successfully**. The page's own
`.catch` was therefore never reached: there was nothing to catch. What
rendered was the onboarding empty state —

> No model providers connected. Connect one under **Integrations** to generate
> images.

— to an account with `gemini` and `openrouter` both active. The same shape as
modules 22 and 28: an empty state that doubles as an instruction to redo work
already done.

The second half is what makes it worse than its predecessors. The fetcher
memoises:

```ts
integrationsPromise ??= Promise.all([...])
```

so the empty result was cached for the session. Measured directly: after the
injected failure, a second call returned the same empty list with **zero new
requests** — the network was never touched again. One transient 403 during
page load claimed "you have connected nothing" until the tab was reloaded, on
every surface that uses this fetcher.

Both halves were proven against a cache-busted fresh module instance with the
403 armed, two interceptions recorded: the call resolved `[]` rather than
rejecting, and the follow-up call made no requests at all.

#### Fixed at the source, so both consumers benefit

The fetcher now throws on either read's error, and its `.catch` clears
`integrationsPromise` before rethrowing — so a failure is never memoised and
the next caller genuinely retries. A **success** is still cached; the memo was
never the problem, caching a failure was. The page keeps the rejection reason
in `providersError` and renders it — "Anything you have connected is still
connected" — above the empty claim, which is now unreachable while an error is
held.

Verified live in three states with interceptions counted: failing (rejects,
error panel, no false claim), healed (the retry recovers both providers with
real requests), and healthy.

#### Mutations: six run, all killed after two tripwires

Three fell to the unit tests directly — the two swallowed read errors and the
re-memoised failure. The fourth, "successes stop being cached", is worth
noting: it is a mutation that makes the code _less_ efficient without making
it wrong, and the test that catches it exists to say the cache is deliberate.
The two page-level survivors were the usual UI wiring, pinned by tripwires
including the now-standard ordering assertion.

**Tests:** 6 in `connectedIntegrations.test.ts`, exercising the real exported
function against a stubbed client — including "a genuinely empty account still
resolves empty, not an error", which is the claim the fix must not break —
plus 2 tripwires. No fixtures; the database was read and never written.

---

### 2026-08-18 — Module 28, Evaluations (`/evaluations`)

Two findings, both about a verdict. This page's whole output is a judgement on
whether a swarm's answers were good, so a number that is wrong rather than
missing is the worst thing it can produce.

#### S1 · "0% pass" on a run that had scored nothing

`pct(n, d) => d > 0 ? round(n/d*100) : 0` — a zero denominator returned **0**,
so a run with 0 of 12 cases scored rendered "**0% pass**": a failing grade for
work that had not been marked. Measured live against a fixture run in exactly
that state (`status: running`, `done_count: 0`, `case_count: 12`).

The contradiction was on screen at the same time. `fmtScore` renders "—" for a
null `avg_score`, and did so for this very run — so the page showed "Avg score
—" beside "0% pass", the same absence reported honestly by one card and as a
failing grade by the other. The half that looked like data was the wrong one.

The distinction the fix has to keep: **zero is a real pass rate.** A run where
every scored case failed genuinely is 0%, and hiding that behind the same "—"
the unscored run gets would trade one lie for another. `passRate` returns null
only when nothing has been scored.

#### S1 · "No datasets yet — create one and add test cases." for an account with one

All three list reads — datasets, runs, swarms — discarded their error and fell
to `?? []`, then `setLoaded(true)` regardless. With a 403 injected on the
datasets read (one interception recorded) the page rendered its onboarding
empty state to an account holding a dataset. The now-familiar shape, on the
page where the empty state doubles as a setup instruction.

#### Fixed

`lib/evalPassRate` owns the rate: null when nothing is scored, a real 0% when
everything scored failed, "—" as the display form. The load keeps the first
error of the three reads and renders it — "Any datasets and runs you have are
still saved" — above the empty state, so the onboarding copy is unreachable
while an error is held.

Verified live in all three states with interceptions counted: healthy shows
the fixture dataset and "— pass" for the unscored run; the failed read shows
the error and no "No datasets yet"; restored returns to healthy.

#### Mutations: seven run, four killed by tests, three forced tripwires

The survivors were all UI wiring the pin rules could not see — a local
redefinition of `formatPassRate` keeping every call site intact, the read
errors swallowed while `setLoadError` still appeared in dead code, and the
error branch deleted while `loadError` was still mentioned elsewhere. All
three are pinned by tripwires that state their limits, including the ordering
assertion the audit log needed for the same reason. Second pass: 7/7.

A pin-rule note worth recording: the first attempt aliased the helper as
`const fmtPassRate = formatPassRate`, and the claim rule REJECTED it — an
alias satisfies neither "called" nor "branched on". That is the rule working
as intended, and the fix was to call the shared function directly at both
sites rather than to weaken the rule.

**Tests:** 8 in `evalPassRate.test.ts` plus 3 tripwires; failedReadClaims
gains the evaluations row. **Fixtures:** one `eval_datasets` row and one
`eval_runs` row created directly (the run had to be in a state the UI cannot
produce on demand — started, nothing scored), both deleted afterwards and
both tables re-read at `*/0`.

---

### 2026-08-18 — Suite note: a flake, measured rather than assumed

The module 27 full-suite run came back red with one failure:
`semanticMeasure.test.ts > refuses a relative-date filter and says why`,
"Test timed out in 20000ms" on a dynamic `await import()`.

Checked rather than waved through: the file passes 22/22 in isolation in 4.2
seconds, and `git diff` confirms module 27 touched neither it nor anything it
imports. A clean re-run of the whole suite came back green. Same shape as the
`nl2sqlEval` timeout recorded during module 16 — a dynamic import starved
under full-suite parallel load, not a regression.

Recorded because "the suite went red and I decided it was fine" is exactly the
reasoning this log exists to make people show their work for.

---

### 2026-08-18 — Module 27, Prompt Compare (`/prompt-compare`)

One finding, and the first in this campaign that is not about a database read
at all. This page has none — it streams the same prompt to two or three models
and compares them. The defect is in the comparison itself.

**What this page already does right.** Costs and token counts use real usage
when the server returns it and fall back to a character estimate only when it
does not; estimates carry a `~`, unknowns render `—` rather than `0`, and the
cost winner already skipped nulls. The `~` discipline is exactly the honesty
this campaign asks for, applied before anyone asked.

#### S1 · The model that failed fastest was crowned the fastest model

`minIdx` ranked panels on raw `durationMs`. A request that ERRORS still
records a duration — the catch sets `durationMs: Date.now() - startedAt` — so
a model that fails immediately posts the lowest time and wins.

Measured with three panels, the first two answering and the third failing
fast:

| panel | model                     | time     | answered?                      | crowned            |
| ----- | ------------------------- | -------- | ------------------------------ | ------------------ |
| A     | Gemini 2.5 Flash          | 2.0s     | yes                            |                    |
| B     | GPT-5 Mini                | 2.7s     | yes                            |                    |
| C     | Gemini 2.5 Flash **Lite** | **0.1s** | **no — errored, zero content** | **green "winner"** |

The failing model was highlighted green as the best response time, against two
models that actually answered the question. On a page whose entire purpose is
to help someone pick a model, "fastest" was being awarded for failing quickest.

Two details made it reachable and easy to miss. The stats block is gated on
`panelA.content && panelB.content`, so an errored A or B suppresses the table
entirely — but panel C, the optional third, is in the comparison and NOT in
the gate. And a fast failure is the common kind: a 500 from the gateway, an
unavailable model, a bad key. The slow, thoughtful answer loses to it every
time.

#### Fixed: a competitor is a panel that answered

`lib/compareWinner` encodes two rules. A panel that produced no answer is not
a competitor — its speed measures how fast it failed, which is not the
quantity on display. And a winner over a field where the rivals' values are
unknown is not a winner: with fewer than two comparable panels the helper
returns -1 and nothing is crowned, because highlighting the only measurable
value presents it as the best value.

The header now also carries what the ranking left out — "(ranking excludes 1
did not answer)" — so a comparison covering fewer models than the table shows
says so.

Verified live by re-running the identical three-panel scenario: the crown
moved to Flash at 2.0s, a model that answered, and the caveat appeared. The
streams were fabricated rather than billed — two SSE responses and one 500 —
so the measurement cost nothing and was exactly repeatable.

#### Mutations: six run, five killed by tests, one forced a tripwire

The survivor was the page's own predicate, `answered = () => true`, which
restores the finding precisely and which no test of the pure helper can reach.
It is pinned by a source tripwire that states its limit — `ComparisonStats` is
a route-local component fed by three live streaming panels, so exercising it
here would test mocks. Second pass: 6/6.

**Tests:** 10 in `compareWinner.test.ts` plus the tripwire. No
failedReadClaims row — there is no read here to fail. No fixtures, no API
spend.

---

### 2026-08-18 — Module 26, Monitoring (`/monitoring`)

One finding, an S3, and a page that is otherwise the best-defended in this
range — worth saying plainly, because most of the campaign has been failures.

**What this page already does right, verified by reading and by the live
healthy state:** it holds a `error` in state and renders it in a banner; a
failed refresh KEEPS the last-good probes and metrics rather than blanking
them (stale-but-labelled, the correct choice); null hardware metrics render
"—" not "0"; an empty probe list renders "No probe results yet." in the table
body; and it refreshes both on an interval and on demand. Nothing here reports
a failed read as an empty or healthy account in the body. This is the standard
the campaign has spent twenty-five modules enforcing, already met.

#### S3 · The summary line claims health over an empty probe set

The one seam. The header read:

```
{unhealthy.length === 0 ? "No problems detected" : `${unhealthy.length} needing attention`}
```

`unhealthy.length === 0` is true whenever `services` is empty — a
misconfiguration that returns no probes, an all-filtered set, or the first
load failing (the catch keeps `services` at `[]`). So a monitoring page could
print **"No problems detected"** having probed nothing. In the failed-load
case it prints that beside its own error banner — the header and the banner
contradicting each other on the one screen whose job is to tell an operator
whether anything is wrong.

This is source-certain and injection-independent: the claim is wrong on an
empty set regardless of _why_ the set is empty, so it needs no failed-read
injection to establish. (Which is the honest framing — the live harness could
not re-fire this page's reads through a `fetch` patch: its refresh dedupes,
and unlike the pages with a durable refresh path there was no reliable lever.
I did not claim a failed-read result I could not positively inject; I fixed
the emptiness claim, which is provable without one.)

Severity S3, not higher, because the mitigations are real: the error banner
and the "No probe results yet." body text both appear on a failed load, so the
user is not left with pure false reassurance — only a contradictory header.

#### Fixed with a four-way summary

`servicesSummary` in `lib/serviceHealth` distinguishes the states the old
ternary collapsed: probed-and-healthy → "No problems detected"; probed-with-
problems → "N needing attention"; **empty → "No services to probe"**;
**empty-and-errored → "Health unknown — could not probe"**, deferring to the
banner instead of contradicting it. A later refresh that fails while keeping
its data still summarises that data — the error travels in the banner, not the
count. Healthy path verified live unchanged (22 services → "No problems
detected").

**Mutations 4/4**, including the two that matter: an empty set reassuring
again, and an errored-empty asserting health. **Tests:** 5 in
`servicesSummary.test.ts`. No failedReadClaims row — this page never reported a
failed read as an empty account, which is what that file pins; its defect was
narrower and lives in its own test. No fixtures.

---

### 2026-08-18 — Module 25, Budgets (`/budgets`)

Three findings, all on a spend-**protection** page — where a discarded read
error does not read as "unknown" but as "you are not protected", or "you
cannot see that you are". Credit first: the month-to-date spend figure was
already exemplary — aggregated in the database through `budget_spend_since`,
returned as a discriminated result so a failed compute renders "unavailable"
rather than "$0". The three table reads around it were not.

**Healthy path is exact.** $6.92 of the $20 cap, 34.6% used, 7 agents — the
spend matches `budget_spend_since` to the cent (6.916376).

#### S2 · A failed budget read hangs the page on skeletons for ever

`budget_settings` was read with the error discarded. On failure `budgetRow` is
null — and the code takes null for "this user has no budget yet" and tries to
INSERT one. The `user_id` UNIQUE index rejects the duplicate, that error is
discarded too, `budget` stays null, and the render gate `loading || !budget`
keeps the three skeletons up permanently. No error, no retry, no end. The
unique index is the only reason this does not also write duplicate rows.

#### S1 · "No agents yet. Create one in the Agent Builder first.", for 7 agents

`agents` read failing gave `setAgents([])`, and the empty state does not merely
claim emptiness — it sends the user away to build agents they already have,
on the page where they came to cap those agents' spend.

#### S1 · Every per-agent cap rendered as unset

`agent_limits` failing gave an empty map, so every agent rendered with no cap
configured. On a page whose entire subject is which agents are capped, a read
failure paints all of them as uncapped — the most consequential of the three,
because the false state is "unprotected" and someone might act on it by
setting a cap that already existed, or trusting one that did not load.

#### Fixed by extracting the load, and by not inserting on a failed read

`lib/budgetLoad` assembles all four reads and keeps every error. The one
subtlety it encodes: a null budget row means "create one" ONLY when the read
succeeded — the insert path that both hid the failure and collided with the
unique index is now unreachable from an error. Any read failing returns
`{ ok: false, error }`; the page holds `loadError`, renders an alert with the
reason, "your caps and limits are unchanged and still enforced server-side",
and a Try again, above the skeleton gate so the hang is impossible.

**On verification, stated honestly.** The healthy path is proven live and
exact. The three failure paths are proven by `budgetLoad`'s unit tests rather
than by live injection, because this page's load runs in a mount effect keyed
on `[user]` that fires exactly once — there is no in-page refresh to re-run it
with a `fetch` patch installed, and a reload wipes the patch (the module 16
lesson). Rather than race the boot, the load logic was lifted into a pure
function and tested deterministically: eight cases including the two that
matter most — the insert fires on a real empty read and NEVER on a failed one,
and a genuinely empty agent list still loads as empty rather than as an error.
This is the same choice made for the server-fn tripwires in modules 23–24:
where the live harness cannot reach, a deterministic test is the stronger
proof, and which guard does the work is written down.

**Mutations: 7/7 killed** — each of the three swallowed errors, the
insert-on-failure path, a failed create, and both UI halves (the error branch
and the error recording).

**Tests:** 8 in `budgetLoad.test.ts`, failedReadClaims gains the budgets row.
No fixtures — reads only; no budget row was created or altered.

---

### 2026-08-18 — Module 24, Audit Log (`/audit`)

Two findings on the one page whose entire purpose is evidence. Both were
measured with the injection positively confirmed.

#### S1 · "No audit events in the retention window.", on a window holding 1,922

`load()` caught, toasted, and ran `setRows([])` — the campaign's oldest shape,
on its worst possible page. With the read failed (one interception recorded)
the audit log rendered its empty state, and after the toast expired the only
thing on screen was a bordered box saying **"No audit events in the retention
window."**

What separates this instance from the fourteen pages before it: an audit
log's empty claim is _exculpatory_. "No events" is not a UI state here — it is
a statement about what happened, the kind of statement someone screenshots
into an incident channel. A page that produces it because a token expired is
manufacturing evidence of absence.

#### S1 · 400 rows shown for a window holding 1,922 — with per-action gaps

The log merges three sources — `audit_events`, `execution_traces` (as
`model.call`), `swarm_runs` (as `swarm.run`) — each fetched newest-first with
a 300-row cap, merged, and sliced to 400. Measured against exact counts:

| source             | in window | fetched |
| ------------------ | --------- | ------- |
| `audit_events`     | 361       | 300     |
| `execution_traces` | 1,537     | 300     |
| `swarm_runs`       | 24        | 24      |

Nothing on screen disclosed any of it. And the damage is worse than a missing
count, because the caps are **non-uniform in time**: model.call's 300 of 1,537
reached back roughly three days while audit_events' 300 of 361 reached
thirteen. The merged table silently mixed a 3-day view of one action type
with a 13-day view of another — so "no model calls on the 10th" read off this
screen was an artifact of the cap, not the history. A merged-then-sliced feed
also cannot claim "the most recent 400": a capped source's excluded newer
rows lose their place to another source's included older ones.

#### Fixed: a uniform window or nothing

`lib/auditWindow` owns the rule: a merged feed of capped sources is complete
only down to the **newest "oldest fetched row" among the sources that hit
their cap**. The server fn now computes that boundary, trims the merge to it,
and returns exact head-counts over the same filters, so the visible window is
gap-free for every action type — the property an audit log exists to have.
The headline states it plainly:

> showing all 492 events since 8/14/2026, 2:04 PM — the 7-day window holds
> 838; older activity is beyond the per-source fetch cap

(492 > the old 400: dropping the arbitrary slice while trimming to the honest
boundary showed MORE gap-free rows, not fewer.) A complete window reads
"838 events over the last 7 days". The failed read now renders an error panel
— the reason, "the events themselves are still recorded", and a Try again —
verified in all three states with interceptions counted, restored clean.

The headline deliberately never says "most recent". `auditWindowHeadline`'s
tests pin that word as forbidden in the trimmed form.

#### Mutations: seven run, five killed by tests, two forced tripwires

The survivors were both wiring: the server fn skipping its trim (helpers
imported, never called), and the UI's error branch deleted while `loadError`
still appeared branched elsewhere (the headline gate satisfied the pin rule).
Both are now pinned by tripwires that state their own limits — including an
ORDER assertion that the error branch sits above the empty state in the
ternary chain, since JSX evaluates top-down and reachability is the whole
point. Second pass: 7/7.

**Tests:** 11 in `tests/unit/auditWindow.test.ts` (9 behavioral + 2
tripwires), failedReadClaims gains the AuditLog row. No fixtures — reads
only, and the retention setting was never touched.

---

### 2026-08-18 — Module 23, Traces & Logs (`/traces`)

One finding — and credit where due first: this page's failed-read handling was
already right before the campaign got to it. `loadError` is held in state, the
empty state distinguishes "Couldn't load traces" from "No traces yet", a Retry
button is offered, and the detail dialog surfaces its own errors (verified
live by corrupting the detail call's token — one interception, error shown).
Somebody built this page to the standard the campaign enforces.

#### S1 · "1,000 traces", stated as the population of an account holding 2,774

Both query paths — the `getExecutionTraces` server function and its client
fallback — carry `.limit(2000)`, and PostgREST's max-rows setting silently
truncates both to 1,000. The header printed `filtered.length` as the total:

|        | claimed          | true (90-day window) |
| ------ | ---------------- | -------------------- |
| header | **1,000 traces** | 2,774                |

Everything derived from the loaded rows inherits the truncation: the model and
agent filter dropdowns miss values present only in older rows, the notebook
count, and "Page N of M · X results". This is module 21's defect on its
sibling page — found by the same measurement, an exact head-count compared
against the claim.

#### Fixed as a window claim, not a full fetch — deliberately

Module 21's fix paged through everything, because that page computes KPI
totals and a sum over a fragment is a wrong number. This page is a **log
browser**: rows carry full `prompt` bodies, the 1,000-row load already takes
~25 seconds, and nobody reads 2,774 traces in a table. Completeness is not
the goal here; an honest window is. So:

- `getExecutionTraces` now returns `total` from an exact head-count running
  beside the capped page query — the count travels with the data.
- The header routes through `traceCountHeadline`, which learned to name its
  range ("the last day" … "the last 90 days") instead of assuming 30:
  truncated reads "showing the most recent 1,000 of 2,774 traces from the
  last 90 days"; complete reads "80 traces over the last day".
- A warning line under a truncated header says what the filters below
  actually cover, and points at the fix: narrow the date range.
- With client filters active the header claims only the loaded window:
  "5 of the 1,000 loaded traces match".

All four states verified live: truncated-90d, filtered, complete-1d (warning
absent, exact "80 traces over the last day"), and restored. The 1d count was
checked against the table rather than assumed.

#### Mutations: four run, three killed, the fourth pinned as a tripwire

The survivor was `total: traces.length` inside the server function — the
capped page presented as the population, a value swap no behavioral test can
reach without standing up `createServerFn` and `supabaseAdmin`, which would
test mocks. It is pinned by a source tripwire that says so in its own
comment: its job is to make the dodge visible in review, not impossible.
Second pass: 4/4.

**Tests:** traceWindow 15 → 18 (range labels + the tripwire),
failedReadClaims gains the traces.tsx row — which passed all eight rules on
the first run, the second page in a row already meeting the campaign's bar
for error handling. The cap was the only lie left.

---

### 2026-08-18 — Module 22, Swarm Traces (`/analytics/observability`)

Two findings, one per read, and a verification technique worth keeping.

**Everything matched when the reads succeeded.** 26 runs in `swarm_runs` over
30 days, "26 swarm runs" in the header, 26 table rows. The Quality trends strip
was checked against the app's own `parseEvalScorecard` rather than a
re-implementation of it — 5 scorecards, 75% average, 60% pass rate, 3 distinct
swarms, all four exact.

#### S1 · "0 swarm runs" and "No swarm runs yet", for an account holding 26

`const { data } = await supabase.from("swarm_runs")…` — the error discarded,
`data` null on failure, `setRuns([])`. Measured with the read 403'd and three
interceptions recorded:

|                | healthy       | read failed              |
| -------------- | ------------- | ------------------------ |
| header         | 26 swarm runs | **0 swarm runs**         |
| table          | 26 rows       | **"No swarm runs yet."** |
| any error text | —             | **none**                 |

And the empty state does not stop at claiming emptiness — it instructs:
"Execute a swarm from the Swarms canvas to see traces here." A user whose runs
merely failed to load is told to go and re-run work that already ran.

#### S2 · The onboarding card, shown to an account that had already onboarded

The same shape in `QualityTrends`, and its failure mode is the more
embarrassing of the two. With the eval-steps read 403'd, the whole stat strip
was replaced by:

> **Quality trends.** Add an **Evaluate** node to a swarm to score answers
> (accuracy, tone, safety…) with an LLM judge.

for an account with five scorecards across three swarms. The page did not print
a wrong number here — it printed a wrong _premise_, and told the user to set up
a feature they had already set up. Recorded as S2 rather than S1 on the module
16 reasoning: no count is stated, and the falsehood is carried by onboarding
copy that implies absence rather than asserting it.

#### Fixed, and the honest empty state proven to survive

The run list routes its count and empty state through `listClaim`, and
`QualityTrends` gained an error branch that outranks the onboarding card.

The verification worth keeping is how the _empty_ case was checked. A fix that
stops a page saying "you have none" is only half tested if nobody confirms it
can still say "you have none" when that is true — and emptying 26 real runs to
find out is not an option. So the injection was inverted: instead of a 403, a
**200 with an empty body**. Same code path as a genuinely empty account, no
data touched.

| read         | empty 200                            | 403                      | healthy       |
| ------------ | ------------------------------------ | ------------------------ | ------------- |
| `swarm_runs` | "0 swarm runs", "No swarm runs yet." | "—", error + reassurance | 26            |
| eval steps   | onboarding card                      | "could not be loaded"    | Evaluations 5 |

Three distinct states per read, each with its interception counted. That is the
first time in this campaign the true-empty branch has been positively
demonstrated rather than argued from the helper's unit tests.

#### Mutations: six run, four killed by tests, two by the type checker

The two survivors were the same edit on each file — dropping `error` from the
destructure. They survive the suite because these pin rules read source and
never execute it, but they do not survive `tsc`:

```
analytics_.observability.tsx(60,11): error TS2552: Cannot find name 'error'.
QualityTrends.tsx(83,11):            error TS2552: Cannot find name 'error'.
```

That was checked rather than assumed — the mutation was applied and `tsc` run
against it, both times. A defect caught by the type checker is caught; it is
worth writing down which guard is doing the work, because "the tests pass" and
"this is guarded" are different claims and this campaign exists to keep them
apart.

**Tests:** `failedReadClaims` 84 → 100 (two new rows, both green on the first
run — the first module in a while where no pin rule needed widening). No new
pure module: the run list reuses `listClaim`, which carries its own mutation
coverage. No fixtures; the database was read and never written.

---

### 2026-08-18 — Module 21, Analytics (`/analytics`)

Three findings. The first is the only one in this campaign so far where the
page was wrong about the data it _had_, not merely about a read that failed.

#### S1 · A silent row cap made every number on the page wrong

`load()` asked for `.limit(2000)`. PostgREST's `max-rows` setting capped the
response at 1,000 and supabase-js returned that first page as a complete
result — no error, no truncation flag, and the `.limit(2000)` simply never
mattered. The page then said, in words:

> **1,000 traces over the last 30 days**

to an account holding **2,731**. Every KPI is derived from the same array, so
every KPI inherited it. Measured against a paged read of the same filter:

|               | page said | truth    | error    |
| ------------- | --------- | -------- | -------- |
| traces        | 1,000     | 2,731    | −63%     |
| Spend (MTD)   | $6.01     | $6.36    | −5.6%    |
| Tokens (30d)  | 2,052.6K  | 3,767.9K | −46%     |
| Active agents | 18        | 22       | −4       |
| Avg latency   | 10,498ms  | 7,981ms  | **+32%** |

The latency row is the one worth staring at. The other four are
under-counts — bad, but bad in a direction a careful reader might guess. Average
latency was **biased upward by a third**, because the cap takes the most recent
thousand rows and that window happened to be slower than the month it was
standing in for. A truncated mean is not a smaller mean; it is a mean of a
different population, and nothing on the page said so.

The fix reads an exact `count` first, then pages with `.range()` until a short
page proves the end. The header now says `2,731 traces over the last 30 days`
and all four KPIs match an independent paged computation exactly. If the
client-side ceiling is ever reached the header switches to "showing the most
recent N of M" and a warning appears above the cards — a page is entitled to
describe itself, not the account.

#### S2 · A failed read rendered as an empty account, beside a seeder

Same shape as modules 13–20, with a sharper edge than most. `load()`
destructured only `data`, so a 403 left `traces` at `[]` and the page rendered
"**No execution data yet**" with a **Generate sample data** button — measured
live, 6 interceptions recorded, no error text anywhere.

That button writes ~600 example rows. Its server guard refuses when more than
50 traces already exist, so the write would in fact have been declined here —
but the guard is doing that work by accident. The page offered a write on the
strength of a number it did not have, and the only thing standing between a
failed read and example data mixed into a real account was a threshold chosen
for a different purpose. The error panel now declines to offer seeding at all,
and says why.

#### S2 · The team-spend breakdown said "Loading…" for ever

`TeamSpend` toasted its error and left `users` at `null`, and the render reads
`users === null ? "Loading…"`. So a failed read showed a spinner-shaped
sentence permanently — measured with the JWT corrupted so the real server
returned its own error, and still on screen after the toast expired. Now an
explicit error branch outranks the loading state.

**What was already right.** The `BY USER` table aggregates server-side through
the `admin_spend_by_user` RPC, with no row cap, and its $8.0716 for 2,731 calls
matched a paged sum of `cost_usd` to the cent. Worth recording because it is
the same page: the SQL-aggregate path was correct all along, and the defect was
entirely in the client-side array the KPI cards were built from.

#### Mutations, and a survivor that changed the fix

The first run killed **6 of 9**, and two survivors were behavioural rather than
cosmetic: reverting the paging to a single capped read, and letting an errored
page fall through so a fragment got summed as if whole. Source inspection
cannot see either — the pin test reads files, it does not run them.

So the paging loop moved out of the component into `lib/traceWindow`, where it
could be tested against a fake table: every row across pages, a short page as
the only proof of the end, an extra read when the last full page lands exactly
on the boundary, the ceiling honoured, and an errored page aborting the whole
load rather than resolving to a fragment. Second run: **9 of 11**.

The two that remain are `setLoadError` calls in analytics.tsx, and they survive
for the reason this file has now recorded three times: the rule asks whether an
error is recorded _somewhere in the file_, and this file records it in four
places, so deleting one leaves three. Killing that would need the route
component rendered, which is the thing `emptyStateLoadGate` explains it will
not do. Recorded rather than papered over.

**Pin rules broadened, not weakened.** Two rows were added and both initially
reported correct code. `TeamSpend` has no count and no list, so it routes
through an error-state branch rather than `listClaim` — the claim rule now
accepts a state guard (`loadError !== null`) as well as a helper call. And it
holds its error in state rather than destructuring one, so the "names a read
error" rule now recognises `setLoadError(...)` alongside `error: e`. Both
changes let a correctly-fixed page pass; neither lets a broken one through,
which the mutation run confirms.

**Tests:** 15 in `tests/unit/traceWindow.test.ts`, `failedReadClaims` 67 → 84.
Full suite 215 files, 4039 tests, green — a delta of exactly the 32 added. No
fixtures: this pass only read.

---

### 2026-08-18 — Module 20, Model Registry (`/model-registry`)

One finding, and it is the sharpest version of this class so far: the failed
read does not merely misreport, it argues for an action.

**What matched.** `model_registry` holds 770 rows and all three counts on the
page read 770 — the headline, the provider select and the All tab — against an
exact `0-0/770`. "Last refreshed 3w ago" matched `model_registry_meta`. The
search box filters on name, id, developer and description as it claims.

#### S1 · Four false claims, and a button that acts on them

`load()` caught, toasted, and left `models` at `[]` and `meta` at `null`, with
`setLoading(false)` in a `finally`. The injection corrupted the outgoing JWT so
the **real server** threw, returning its own `$TSR/Error` envelope with
`"Unauthorized"`, and the corruption was recorded per request:

|                                  | healthy | server threw |
| -------------------------------- | ------- | ------------ |
| "Browse N live models"           | 770     | **0**        |
| "All providers (N)"              | 770     | **0**        |
| "All (N)"                        | 770     | **0**        |
| "Last refreshed …"               | 3w ago  | **never**    |
| "No models match these filters." | no      | **yes**      |
| "Run a sync now" (admins)        | no      | **yes**      |

Every one of those is false, and they compose into an argument. The registry
appears empty; the emptiness is blamed on the filters, which is a cause the
page has no evidence for; "Last refreshed never" says the sync has never run;
and an admin is then offered a button to run one. That sync calls an external
provider and rewrites the table. **A failed read talks an administrator into a
write.**

"Last refreshed never" is the detail worth keeping. `timeAgo(null)` returns
"never", which is correct for a registry that has never synced and a lie about
a registry whose sync record could not be read — and it is the single claim on
the page that argues hardest for pressing the button.

#### Fixed, and the fix declines to offer the sync

The counts now come from `countClaim`, the panel decision from `listClaim`, the
timestamp reads "unknown" rather than "never", and the error panel says the
registry "has not been emptied and the filters are not hiding anything". The
sync button is **deliberately absent** from that panel, and the page says why:
a sync started from a failed read would be acting on a number nobody has.

Verified live in four states, each with the injection confirmed:

| Condition                 | Page                                            |
| ------------------------- | ----------------------------------------------- |
| healthy                   | 770 / 770, "3w ago"                             |
| server threw (bad token)  | "—" / "—", "unknown", alert, no sync, Try again |
| request rejected outright | same                                            |
| restored                  | 770 / 770, "3w ago"                             |

And the claim that had to survive the fix: with a healthy read and a filter
matching nothing, the page still says "No models match these filters" and still
shows 770. Filter-empty, registry-empty and read-failed are now three different
statements instead of one.

#### The headline kept its thousands separator on purpose

`countLabels` returns a plain `String(n)`, so routing the headline through it
directly would have dropped the grouping separator the moment the registry
passes a thousand — a small presentational regression smuggled in by a
correctness fix. The label decides _whether_ a number may be shown; the
headline then formats it. Worth writing down because the tempting one-liner is
wrong in a way nobody would notice until the row count grew.

#### Mutations: six run, five killed, then the survivor explained

The survivor disabled the `catch` keyword while leaving its body in place. The
rejection rule is FILE-scoped — this page has an unrelated `catch` in its
clipboard helper — so it passed. Rewritten as a real refactor would do it,
deleting the handler and the `setLoadError` inside it, it is killed by the
"records the error from a real value" rule.

That limit is now written into the test file beside the rule rather than left
to be rediscovered. It is the third time source inspection has been shown to
prove presence rather than use, and the answer each time has been the same:
move the decision into a real function with its own tests, and keep the source
rule as a tripwire rather than a proof.

The rejection rule was also **broadened**, not weakened: it named only
`.catch()`, and this page handles rejection with try/catch around the await. A
rule that reported a page for handling the case correctly would have been the
fourth to cry wolf in this campaign, so it now accepts both shapes.

---

### 2026-08-17 — Module 19, MCP Servers (`/mcp`)

One finding, and the interesting part is why four converted pages did not
prevent it.

**The arithmetic is right when the read succeeds.** Against two fixture servers
— one `connected` exposing 7 tools, one `error` exposing 3 — the header read
"1 connected" and "7 tools available", both matching a figure computed
independently from `mcp_servers`. The errored server's three tools are
correctly excluded from the total, so the sum is a real filter and not a naive
count. `timeAgo` guards a null `last_ping` and renders "never".

#### S1 · "0 connected" and "0 tools available", for an account with seven

`load()` checked its error — better than the pages that discarded it — and
toasted. But it left `servers` at its initial `[]` and ran `setLoading(false)`
regardless, so both header badges were computed from rows that never arrived:

|                        | healthy | read 403'd                      | ~10s later |
| ---------------------- | ------- | ------------------------------- | ---------- |
| "N connected"          | 1       | **0**                           | **0**      |
| "N tools available"    | 7       | **0**                           | **0**      |
| server names on screen | both    | none                            | none       |
| toast                  | —       | 3× "Failed to load MCP servers" | **gone**   |
| any error text         | —       | —                               | **none**   |

The interception was recorded (3 requests failed) rather than inferred. There
was also no empty state on this page at all, so a failed read produced two
confident zeroes above a completely blank grid.

**Zero is the worst possible wrong answer here, because it is also a perfectly
ordinary right one.** Nothing distinguished "you have no MCP servers" from "I
could not find out" — and this page's numbers feed a real decision, since an
agent author checks "N tools available" to see whether their tools are
reachable before blaming their prompt.

#### Why the four earlier conversions missed it

`lib/listClaim` answers "how many rows do I have" for a list with an empty
state. Neither badge here is the row count. They are **derived** — a filtered
length and a conditional sum — so no rule watching for `.length` was ever going
to see them, and a failed read makes both compute to 0 through entirely
innocent arithmetic.

`lib/countClaim` is the missing shape: label every count derived from one read
at once, and withhold them together. Together is the point — they come from the
same rows, so they are true together or unknown together, and labelling them
one at a time is how a page ends up admitting the failure in one badge while
printing a confident 0 in the one beside it.

The page now shows `—` for both when the read fails, an alert naming the reason
that says the counts are "unknown rather than zero", and a **Try again** button.
It also gained the empty state it never had, because otherwise the fix has
nothing to distinguish itself from: verified live, a genuinely empty account
reads "0 connected", "0 tools available" and "No MCP servers yet", while a
failed read reads "—", "—" and the alert. Try again was exercised rather than
assumed — fail, heal, click, back to 1 and 7 with the alert gone.

#### The pin was decorative, and the mutation run is the only reason that is known

Adding the row and running four mutations killed **one of four**. Deleting the
`setLoadError` so the error was toasted and never recorded — the exact defect —
survived. So did replacing the labels with the raw counts, and so did dropping
the line that clears the error on success.

The row had been pinned against `listClaim`, which the page still called for
its panel, so every rule passed while the badges lied again. A pin that names a
helper the file happens to contain proves nothing about the thing that broke.

Three changes came out of that, each mutation-verified:

- the counts moved into `countClaim`, a real function with its own tests, so
  the decision is covered at the logic level rather than by inspection;
- **an error state must be recorded from a real value, not only cleared** —
  `setLoadError(null)` on its own is not recording anything;
- **an error state must also be cleared on success** — otherwise a recovered
  page keeps showing a failure that is over, and Try again appears dead.

A fourth followed: `claim` may now name more than one helper, because this page
guards its badges with `countLabels` and its panel with `listClaim`, and
dropping either one restores a defect. Pinning only the one I had just added
left the other unguarded, which the mutation run caught immediately.

Second pass: **8 of 8 killed.**

**Fixtures:** two `mcp_servers` rows inserted directly rather than through the
Add dialog, because that flow probes a live external MCP endpoint and would
have made the test depend on somebody else's uptime. Deleted afterwards and
`mcp_servers` re-read at `*/0`.

---

### 2026-08-17 — Module 18, Secrets (`/secrets`)

Two findings, both about what this page says when the one read behind it does
not arrive. Everything it says when the read _does_ arrive is exact.

**What matched.** Two fixture secrets were created through the real dialog and
every rendered column was compared against `user_secrets`: names, descriptions,
the `Yours` / `Shared with you` badge (against `user_id === me`), the dates, and
the row count against an exact `0-1/2`. Ordering is by name and not by
insertion — proven by creating the alphabetically-first secret _second_ and
watching it render first. The `value` column is never sent to the browser at
all, which is the security claim the page makes in its own copy, checked
against the response body rather than taken on trust.

**Both failures were injected by making the real server fail**, not by
fabricating a response. The server function's reply is seroval-encoded, so a
hand-written envelope would have proved only that the client mishandles
malformed JSON. Instead the outgoing request's JWT signature was corrupted, and
the real handler's own catch returned its own envelope:

```
{"k":["ok","error"],"v":[{"t":2,"s":3},{"t":1,"s":"Unauthorized"}]}
```

`ok: false, error: "Unauthorized"`, produced by the server, serialized by the
real serializer. The corruption was recorded per-request, so the injection is
proven rather than inferred.

#### S1 · "No secrets yet" for an account holding two

`reload()` toasted the error and then ran `setSecrets([])`, so the failure
rendered as an empty account — on the page whose entire subject is credentials.
Measured at first paint and again after the toast expired:

|                                         | at first paint | ten seconds later |
| --------------------------------------- | -------------- | ----------------- |
| toast "Unauthorized"                    | present        | **gone**          |
| "No secrets yet."                       | present        | **present**       |
| "Create one, then paste its reference…" | present        | **present**       |
| rows                                    | 0              | 0                 |

This is module 15's shape exactly, and the second measurement is the reason
that method exists: the durable half of the contradiction is the false half.
The toast is also the least informative thing on the screen — a bare
"Unauthorized" with no indication of what could not be read.

It is S1 rather than module 16's S2 because this page says it in words. There
is a sentence claiming the account is empty and an invitation to create the
first secret, where /integrations only omitted a badge.

#### S2 · A rejected request left the skeleton up indefinitely

`reload()` had a `.then` and no `.catch`. supabase-js hands a network failure
back as `error`, but a **server function rejects**, and nothing was there to
catch it. With the request rejected outright:

```
{"skeletonUp":true,"anyErrorOnScreen":false,"toasts":[],
 "unhandledRejections":["TypeError: Failed to fetch"]}
```

still true four seconds in. No error, no toast, no empty state — just two
skeleton bars for ever, and an unhandled rejection in a console the user is not
reading. This page has no Refresh control, so there was no way to retry short
of reloading the browser.

#### Fixed with `listClaim`, and with a retry that was tested

The page now holds `loadError`, routes the panel decision through
`lib/listClaim`, and catches the rejection. Verified live in four states, each
with the injection confirmed by the harness:

| Condition                       | Panel                                                  |
| ------------------------------- | ------------------------------------------------------ |
| healthy                         | 2 rows, no alert                                       |
| server returns `ok:false`       | reason + "still there" + Try again, **no** empty claim |
| request rejected                | same                                                   |
| genuinely empty (after cleanup) | "No secrets yet." — the honest claim, still available  |

The last row matters as much as the others: the fix has to keep the true empty
state sayable, and the fixture cleanup doubled as that test.

A **Try again** button was added because the S2 left no way to retry, and it
was exercised rather than assumed: land in the failed state (0 rows, error
shown), heal the network, click it, and the panel returns to 2 rows with the
error gone. A retry control that is never tested is the dead control this
campaign keeps finding.

#### The mutation that survived, and why it is being recorded rather than fixed

Eight mutations, seven killed. The survivor replaced the `listClaim` call's
result with a short-circuit **while leaving the identifier in the file**, which
a source-inspection rule cannot see. Rewritten the way a real refactor would do
it — removing the call — it is killed.

That is a genuine limit of this test file rather than a fixable oversight, and
it is the limit the file already declares: it asserts by source inspection
because standing up a route component wired to Supabase and a session would
test the mocks. A rule that reads source can prove a call is present; it cannot
prove it is on the live path. Recorded here so the next person does not mistake
a green `failedReadClaims` for a behavioural guarantee.

Two new rules were added and both were mutation-verified: a row flagged
`viaServerFn` must catch a rejected read, and no file may empty its list
without setting an error beside it. The second exists because dropping the
`setLoadError` next to `setSecrets([])` restored the exact S1 above while the
suite stayed green.

#### Checked and not a defect

`reload()` returns early when `token` is undefined, which leaves the skeleton
up. That is honest — nothing is known yet — and it is transient: `token` is
`session?.access_token`, `reload` is a `useCallback` keyed on it, so the effect
re-runs the moment the session resolves. `user_secrets.updated_at` is
`NOT NULL DEFAULT now()`, so the unguarded `format(new Date(...))` in the
Updated column cannot be reached with a null.

**Fixtures:** two secrets created through the real dialog and deleted through
the real delete button, with `window.confirm` stubbed to return true because
the automation auto-dismisses it. Both confirm prompts named the right secret.
`user_secrets` re-read afterwards: `*/0`, no probe rows left.

---

### 2026-08-17 — Module 16, Integrations (`/integrations`) — RE-AUDITED

The module whose finding was withdrawn, done again with the proof that was
missing. **The withdrawal was correct and the original observation was also
correct** — what was missing was the link between them, and it turned out to be
mundane.

#### Why the injection did not fire, at last

The `window.fetch` patch was never off-path. It reaches this page's Supabase
client perfectly well; that was measured directly by logging every URL the
wrapper saw:

```
newlySeen: ["https://…/rest/v1/integrations?select=*"]
```

The mistake was in how the read was re-triggered. `loadIntegrations` runs in a
`useEffect(…, [])` and nowhere else on first paint — there is no Refresh
button on this page — so the obvious way to make it run again is to reload the
page. **A reload destroys `window`, and the patch with it.** The reads then
succeed, which is exactly what the probe reported.

That was reproduced deliberately rather than assumed. Arming the patch, setting
a `sessionStorage` marker, and reloading gives:

| After the reload        |                                    |
| ----------------------- | ---------------------------------- |
| `sessionStorage` marker | survived                           |
| `window.fetch` patch    | **gone**, `fetch` native again     |
| the page's own read     | `{integError: null, integRows: 3}` |

which is the earlier session's probe output, character for character.

Modules 13–15 were not luckier, they were differently shaped: each had an
in-page refresh path (a `refresh()`, a tab switch) that re-ran the read without
a document load, so the patch was still installed when it fired.

**The method that replaces it**, and that will be used for modules 18–31:
re-trigger the read with a **client-side remount** — `__TSR_ROUTER__.navigate`
away and back — which re-runs mount effects while leaving `window` intact. The
wrapper records every URL it sees and every URL it failed, so the injection is
confirmed by `failed` naming the request, never by what rendered. Every probe
below is reported beside the same measurement taken with the injection
disarmed, down the identical navigation path.

#### S2 · Both reads discard their error, so a failed read renders as an account with nothing in it

```ts
const [{ data: integ }, { data: creds }] = await Promise.all([…]);
```

No `error` is bound on either side, so there is nothing to report even if the
page wanted to. `data` is null on failure, `merged` stays `[]`, and every badge
on the page is derived from `merged`.

Measured, with a 403 injected on the `integrations` read alone:

|                        | injected 403 | control, same path |
| ---------------------- | ------------ | ------------------ |
| read intercepted       | 2            | 0                  |
| "Connected" on page    | **0**        | 2                  |
| "Disconnect" on page   | **0**        | 2                  |
| any error text on page | **none**     | —                  |

The account had Gemini and OpenRouter connected throughout, and the Gemini card
went from

```
Google Gemini | Gemini via Google AI Studio native API. | Connected | Configure | Disconnect
```

to

```
Google Gemini | Gemini via Google AI Studio native API. | Configure
```

A connected provider rendered exactly as one that was never configured, beside
a Configure button. The obvious response to that screen is to paste the API key
in again. Failing the sibling `provider_credentials` read instead produces the
same screen, so either half of the merge can cause it.

**On the severity, which is deliberately lower than the retracted claim.** The
withdrawn finding called this S1. It is S2. This page has no count and no empty
state — nothing on it prints a number, and there is no "you have no
integrations yet" sentence anywhere. The page's only vocabulary for connection
status is a badge, and what a failed read produces is its _absence_. That is
squarely "hides something true (silent failure, swallowed error, misleading
empty)" and it is not "states something false", which is what separated modules
13–15, where the screen said `My skills (0)` and "You haven't created any
skills yet" in so many words. The user-visible consequence is much the same;
the scale is only worth having if it is applied rather than recited.

#### Fixed, and the fix names the reason

`lib/integrationStatusClaim` is the badge-shaped equivalent of `lib/listClaim`:
a connection badge is a claim only a successful read may make. It adds the
state the page had no way to express — `"unknown"` — which before this existed
could only be rendered as `null`, the same thing an unconfigured provider
renders.

`mayOfferDisconnect` is separate from the badge on purpose. Disconnect is a
**write**, and on a failed read `disconnectProvider` resolves `existing` to
undefined and silently returns — a dead control rather than an honest refusal.

Verified live in both directions, three ways:

| Condition                       | Page                                                               |
| ------------------------------- | ------------------------------------------------------------------ |
| healthy                         | 2 Connected, 2 Disconnect, no notice, no "Status unknown"          |
| `integrations` read 403         | 0 / 0, 14 "Status unknown", notice naming the reason, `role=alert` |
| `provider_credentials` read 403 | same                                                               |
| restored                        | back to 2 / 2, notice gone                                         |

The notice says the credentials are still there, which is load-bearing copy
rather than politeness: the failure being fixed is a user concluding their keys
are gone and retyping them.

#### A hypothesis that was wrong, and checked before it was believed

The suspicion worth having here was that the failed read corrupts a **write**:
`saveProvider` resolves `const existing = integrations.find(…)` from the same
emptied state and passes `id: undefined`, which looks like it must insert a
duplicate row. It does not. `saveIntegrationForUser` falls back to a singleton
lookup by `(user_id, type, provider)` when no id is passed, and updates the row
it finds — the code says so, and says the unique indexes are "the backstop, not
the mechanism". Recorded because it was a good guess that reading the server
function disproved in a minute.

The neighbouring write paths were checked for the same reason and are also
safe: `saveGateway` refuses a blank base URL, and `saveNotifChannel` refuses a
blank webhook with no `existing`, so neither can overwrite a real config with
the blank form a failed read leaves behind. What they _do_ lose is the "leave
blank to keep the saved key" affordance — the page tells the user to paste in a
URL it already has — which is the same defect wearing different clothes and is
fixed by the same notice.

#### The mutation that survived, which is the point of doing this

The first mutation run killed 13 of 14. The survivor was the one that matters
most: reverting integrations.tsx to `setReadState({ loaded: true, error: null })`
— **the exact defect this module fixed** — and the whole suite stayed green.

`failedReadClaims.test.ts` asked only that a setter _name_ appear in the file,
and the mutant still contained `setReadState`. A rule satisfied by the presence
of an identifier is satisfied by a page that binds the error and throws it
away. A fourth rule now requires that every error the file names is referenced
again, which is the campaign's defect stated in one line: **an error you
destructure and never mention again is an error you discarded.** It holds for
all five pinned files and kills the mutant.

This is the third rule in this campaign to be wrong on its first draft. The
first two cried wolf at correct code; this one waved a defect through. Both
directions are worth the same amount of suspicion.

**Tests:** 18 in `tests/unit/integrationStatusClaim.test.ts`, plus
`failedReadClaims.test.ts` 13 → 21 (one new row, and the fourth rule applied to
all five). Mutation-verified **14/14**, each applied, confirmed on disk, killed,
restored, restore confirmed, with a clean run after. No fixtures: this pass
read the database and never wrote to it.

---

### 2026-08-17 — Module 17, Web Embedding (`/embeds`)

No findings. Recorded in full because a page that passes deserves the same
evidence as one that fails — otherwise "we checked it" means nothing.

**Counts are exact.** `embed_keys` holds 5 rows; 5 render. Names, resource
types and allowed-domain lists match one for one, and the USES column matches
`use_count` exactly (3 / 1 / 19 / 1 / 4).

**The security claims hold, and were tested rather than read.** The page
promises "disable the key and every iframe stops instantly", and each gate was
exercised against the live `/api/embed/chat` endpoint with a working control:

| Key state                        | Endpoint                                         |
| -------------------------------- | ------------------------------------------------ |
| active, no expiry (precondition) | 200, streaming                                   |
| disabled via the real UI toggle  | 403 "This embed has been disabled by its owner." |
| expiry lapsed, still active      | 403 "This embed key has expired."                |
| expiry set to 2099               | 200, streaming                                   |
| domain allow-list, honest origin | 403 "not authorized for this site"               |
| unknown key                      | 400 "Invalid embed key."                         |
| restored to baseline             | 200, streaming                                   |

The lapsed-expiry case is the interesting one: the key was left **active** so
the 403 could only come from the expiry gate, and the message differs from the
disabled one, which proves which check fired. A future expiry still returns
200, so the gate is not simply refusing everything.

**A first attempt at this test was invalid and was thrown away.** The initial
run sent `key` instead of `embedKey`, so all three cases — including the
control — returned 400 "Invalid embed key." Three identical refusals look like
a working boundary; they were a malformed request. The rule that saved it is
the control: a test where the _should-succeed_ case also fails has measured
nothing.

**A near-miss worth recording.** Calling the domain-locked key while forging
`parentOrigin: https://example.com` returned 200, which looked like an
allow-list bypass. It is not: the request came from the app's own origin, and
`embedOrigin.ts` trusts `selfHost` deliberately so the embed page can call
home. That module already documents both halves candidly — what the browser
`Origin` check closes, and that it "does not close, and cannot", because
`Origin` is only trustworthy from browsers and the embed key is public by
construction. Abuse from a scripted client is bounded by per-key budget, rate
limit and expiry instead. A page whose residual limits are written down is the
opposite of the defect this campaign hunts.

**Fixtures:** one key was disabled and re-enabled, and its expiry moved twice.
Final state re-read and confirmed identical to baseline (`is_active: true`,
`expires_at: null`) with the endpoint back to 200.

---

### 2026-08-17 — Module 16, Integrations (`/integrations`) — RETRACTED

> **Superseded.** The module was re-audited later the same day and the finding
> holds, at S2 rather than S1 — see the module 16 entry at the top. This entry
> is kept unedited because the reasoning that led to the withdrawal is worth
> more than the conclusion it reached.

**A finding was reported here and then withdrawn. It is kept because a
campaign that quietly deletes its mistakes is not evidence of anything.**

The claim was: with the two integration reads failing, a page whose account has
OpenRouter and Gemini connected rendered zero "Connected" badges, zero
Disconnect buttons and no error — an S1, and on a page where the natural
response is to paste an API key in again.

A fix was written for it and did not change the rendering. Restarting Vite,
clearing its transform cache, unregistering the `sw.js` service worker and its
`as-static-v1` cache, and finally a fresh tab with an empty module registry all
failed to make it fire — while the served component chunk demonstrably
contained the new code.

A `console.log` inside `loadIntegrations` settled it:

```
PROBE loadIntegrations {integError: null, integRows: 3, credsError: null}
```

**The reads had succeeded.** The `window.fetch` patch never reached this page's
Supabase client, so the original observation had no established cause and the
fix had no error to report. The fix was reverted; the finding is withdrawn.

Why the same injection worked on modules 13–15 is still unexplained. Those
results stand on their own evidence: there, the injected error _changed the
UI_ — badge to "—", banner appeared — which cannot happen unless the error
reached the code. That asymmetry is the lesson.

**Method change, now in force:** a failed-read finding requires positive proof
that the injection took effect — the code visibly reacting to the error, or a
probe of what the read returned. Inferring it from what rendered is what went
wrong here, and it is exactly the mistake this log exists to catch elsewhere.

Module 16 is therefore **unaudited**, not clean.

---

### 2026-08-17 — Module 15, Skill Library (`/skills`)

"Sample skills (6)" matched the six declared in `lib/sampleSkills`, six unique
ids, no duplicates. One finding, and it is the third page in a row with it.

#### S1 · The error was raised and then overwritten

`refresh()` toasted the error and then ran `setMine((data ?? []) as SkillRow[])`
**anyway** — on the failure path, unconditionally. So a 403 gave "My skills
(0)", "You haven't created any skills yet." and "Create your first skill".

This one was measured twice on purpose: at first paint, and again seven seconds
later once the toast had expired. The false claim was still there; the true one
was not. That is the whole reason a toast does not discharge this duty — it is
the only page element that is guaranteed to be gone by the time someone reads
the page.

Converted to `listClaim`, and verified in both directions: with the read failing
the tab reads `My skills (—)` with the reason and no invitation; healthy, it
reads `My skills (0)` with the honest empty state and no error.

#### A guard for the conversions, deliberately a list and not a rule

Three modules have now converted a page away from this defect, and the sweep
says roughly two dozen more reads could still have it. `failedReadClaims.test.ts`
pins the ones already converted: each must route its count through `listClaim`,
must keep the read's error, and must not print a fetched collection's raw
`.length` as its count.

It is a **list** rather than a rule over every page, because asserting it of
pages nobody has measured would fail for about twenty of them at once, and a
suite that is red by default teaches people to skip it. A row gets added when a
module's pass converts a page.

The first version of that third rule flagged `BUILT_IN_PROMPTS.length` and
`SAMPLE_SKILLS.length` — module constants that ship with the app and cannot
fail to load, so printing their length is entirely honest. It now requires a
lowercase first letter, which exempts SCREAMING_SNAKE constants by
construction. This is the second rule in this campaign to have cried wolf at
correct code on its first draft; both times the fix was to narrow the rule
rather than to weaken what it protects.

Verified by reverting each of the four conversions in turn — all four caught,
all four restored.

**Tests:** 13 in `tests/unit/failedReadClaims.test.ts`. Full suite 3912 tests,
211 files, green (+13, exactly the new file). No new pure module was needed:
the fix reuses `listClaim`, which already carries its own mutation coverage.

---

### 2026-08-17 — Module 14, Prompt Library (`/prompts`)

Both counts on this page were right. "Built-in (23)" matched the 23 prompts
declared in `lib/promptLibrary` (23 `id:` entries, 23 unique, no duplicates),
and "My Prompts (0)" matched an exact `*/0`. The four samples-style claims all
held. Two things did not.

#### S1 · A page that said both "you have none" and "the load failed"

`loadUserPrompts` DID check its error — better than the notebooks module, which
discarded it — but it only raised a toast and returned, leaving `userPrompts`
at `[]`. With a 403 on that one query the page rendered, all at once:

| Element | Said                                 |
| ------- | ------------------------------------ |
| Tab     | **My Prompts (0)**                   |
| Panel   | "You haven't saved any prompts yet." |
| Button  | "Create your first prompt"           |
| Toast   | "Failed to load your prompts"        |

The page contradicted itself, and the durable half was the false half: the
toast fades after a few seconds and the empty state does not. A user who looked
away, or came back to the tab, was left with an account that appeared empty and
an invitation to start over.

Fixed through the same `listClaim` the notebooks list uses — the tab reads
`My Prompts (—)` and the panel carries the reason and "Any prompts you have
saved are still there."

#### S3 · The tag the cards print, that the search box could not find

Every card renders its tags as `#{t}`, so the screen shows `#security`. The tag
is stored and matched as `security`. Measured in the live page:

| Typed       | Cards |
| ----------- | ----- |
| `#security` | **0** |
| `security`  | 1     |

Copying what the page shows you into the page's own search box returned nothing
out of 23. This is the module 11 shape again — _the identifier a page publishes
that its own search cannot find_ — and it is the reason that entry got a name.

A leading `#` now means "this is a tag" rather than being taken literally. Only
the first one, and only at the front, so `C#` still searches for `C#`.

#### The two filters that were one filter

`filteredBuiltins` and `filteredUser` held the same matcher twice, identical
apart from `description` being optional on a saved prompt. That is the shape
that drifts — fix the search on one tab and the other keeps the old behaviour
with nothing to notice it — so both now call `matchesPromptQuery`. Verified on
both tabs against a real saved row: `#probe` and `#adversarial` found it.

#### Not a defect: delete appearing to do nothing

The first delete click did nothing. `deletePrompt` guards on `confirm()`, and
the automated browser auto-dismisses a native confirm, so it returned false.
Recorded because it looked exactly like a dead control for one screenshot.

#### Campaign note: the failed-read class is systemic

After module 13 the same pattern was swept for rather than rediscovered
page by page: **43 reads across 27 files** destructure only `data` from a
Supabase call, and `data` is null on failure. Not all are dangerous — many have
a benign fallback — but each one that feeds a count or an empty state is this
same defect. They will be verified and fixed per module with live evidence
rather than bulk-edited on inference, which is why this is a note and not a
finding.

**Tests:** 21 in `tests/unit/promptSearch.test.ts`, mutation-verified 10/10 —
each applied, confirmed on disk, killed, restored, restore confirmed. Full
suite 3899 tests, 210 files, green (+21, exactly the new file). One fixture
prompt was created through the real dialog and deleted through the real delete
button; removal verified by id and by the table returning to an exact `*/0`.

---

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
