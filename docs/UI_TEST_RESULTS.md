# UI test results

> Part of the [AgentSwarms docs](../README.md#documentation).

The per-round record of what was driven in the browser and what the rows said.
A rendered card proves nothing: every round below presses the real control,
waits for the real round-trip, and reads the result from the DOM and from the
database row it should have written — `ml_predictions`, `swarm_run_steps`, the
persisted analyst step, `messages.metadata.sources` — never from the screen
alone. Findings that came out of a round are filed in the
[Adversarial log](./ADVERSARIAL_LOG.md) under the reference given.

Fixtures a round creates are deleted afterwards unless the entry says they were
kept for review.

<!-- newest first -->

## 2026-10-01 — Add metric to dashboard holds its form, ADVERSARIAL_LOG R215

**Why this round exists.** Found while driving R214: the dialog refilled its form on every click.

Fixtures, **kept**: BI project `r215 metric after` (1 widget, `r215 metric`).

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (real image `0ed734402123`) | Semantic Layer → SaaS Sales model → Query: total_sales by order_date, Run, Add to dashboard; title `r214 metric`; click the description text | Title back to **"SaaS Sales model"**; a dashboards refetch per click |
| Before | Click the BI project select | The form refilled; the select's options went stale before they could be clicked, and the pick stayed on the first project |
| After (hot deploy of R215) | The same; title `r215 metric`; click the description twice | Title **held**; dashboards fetched **once** since opening |
| After | Pick a project, then End + Enter in the select | Both picks held; ＋ New BI project… shows the name field |
| After | `r215 metric after`, Enter twice | **One** "Added to "r215 metric after"" toast; one project with 1 widget titled **r215 metric** |

## 2026-10-01 — A double Enter in nine create dialogs, ADVERSARIAL_LOG R214

**Why this round exists.** The fourth round of sweep 5, "a guard only the button honours".
"Before" was driven on the real image `0ed734402123`; "after" on a hot deploy of R214 onto it.

Fixtures, **kept**:
- Workbooks `r214 before` (×2) and `r214 after`.
- BI projects `r214 before` (×2), `r214 after`, `r214 widget before` (×2) and
  `r214 widget after`.
- BI folders `r214 before` (×2) and `r214 after`.
- BI workspaces `r214 before` (×2) and `r214 after`.
- Reports `r214 before` (×2) and `r214 after`.
- MCP servers `r214 before` (×2) and `r214 after`.
- ETL pipelines `r214_before`, `r214_before_toast` and `r214_after`.
- Eval datasets `r214 before`, `r214 before toast` and `r214 after`.

| Surface | Before: Enter twice | After: Enter twice |
| --- | --- | --- |
| Sheets → New workbook | **2** workbooks | **1** (`e9b96895…`) |
| BI → New BI project | **2** cards | **1** (`f4dc24fc…`) |
| BI → New folder | **2** rows | **1** |
| BI → Manage workspaces | **2**, "Workspace created" ×2 | **1**, ×1 |
| BI → Reports → New report | **2** | **1** (`83538a80…`) |
| MCP Builder → New server | **2** | **1** (`a5fef52c…`) |
| Workbench BI agent → Add to dashboard → New BI project | **2**, "Added to" ×2 | **1**, ×1 |
| ETL → New pipeline | 1, and "duplicate key value violates unique constraint "etl_pipelines_user_id_name_key"" | 1, no toast |
| Evaluations → New dataset | 1, and "duplicate key value violates unique constraint "eval_datasets_user_id_name_key"" | 1, no toast |

## 2026-10-01 — Smoke of the real image after R211 to R213

**Why this round exists.** Three rounds had been hot-deployed onto the R209 image. This round
built a real image from the R213 commit (`docker compose up -d --build agentswarms`, image
`0ed734402123`) and drove each round's fix, and an Iceberg publish, on it.

| Check | What was driven | What came back |
| --- | --- | --- |
| R213, Workbench | `SELECT sum(i % 7) AS smoke_0ed734402123 FROM range(200000000) t(i)`, Ctrl+Enter twice | **One** Recent queries row, 3275 ms |
| R211, Lakehouse editor | `INSERT INTO analytics.r211_double VALUES (3, 'smoke 0ed734402123')`, Ctrl+Enter twice; then `SELECT n, count(*) … GROUP BY n` | n 1 → 2 (R211's before), 2 → 1, **3 → 1** |
| Iceberg publish | Lakehouse → `analytics.fct_region_revenue` → Write this table into an Iceberg catalog: `local_rest`, namespace `r181`, table `smoke_0ed734402123`, Publish | The catalog logged "Successfully committed to table r181.smoke_0ed734402123 in 4242 ms" |
| R213, notebook | `r213 double run`, fresh page, cell 6, Shift+Enter twice | Running through a 43 s cold kernel start with no "Server runtime not connected"; then **one** run, output **1**; source still 2 lines |

R212 (the SCIM mint) was not repeated: its fix is the same guard as R211's, and a repeat would
mint more live tokens. Fixtures, **kept**: the Iceberg table `r181.smoke_0ed734402123`, the
`analytics.r211_double` row for n = 3, and the Recent queries row.

## 2026-10-01 — A double Shift+Enter in a notebook, a double Ctrl+Enter in the Workbench, ADVERSARIAL_LOG R213

**Why this round exists.** The third round of sweep 5, "a guard only the button honours".

Fixtures, **kept**:
- Python notebook `r213 double run` (id `f512c8b4-…`), from the starter template. Cell 6 holds
  `n = globals().get("n", 0) + 1` / `print(n)`. Its source is back to 2 lines.
- Recent queries rows `SELECT 213 AS r213_double_before` / `…_after` (×2 each, not a proof, see
  below), and `r213_slow_probe`, `r213_slow_before` (×2), `r213_slow_after`,
  `r213_slow_after_redeploy`.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R212) | Notebook, fresh page, cell 6, Shift+Enter twice | Cell output **"Server runtime not connected", 0 ms** while the first run was still starting the kernel. The start then timed out (cold container), and the cell showed "The server runtime is unavailable." while the banner said "Kernel connect timed out" |
| Before | Shift+Enter once, kernel started | Output **1** (454 ms) |
| Before | Kernel ready: Shift+Enter twice | Output **2**, then **3** 59 ms later: two runs |
| Before | The cell's source after these presses | 2 lines grew to **7**: a blank line per Shift+Enter, kept by autosave |
| Not a proof | Workbench, `SELECT 213 AS r213_double_before`, Ctrl+Enter twice; then the same as `…_after` on the R213 build | Two rows each time, about 30 ms each: the first run had finished before the second key, so neither result tests the guard |
| Probe (R213 build) | `SELECT sum(i % 7) AS r213_slow_probe FROM range(200000000) t(i)`, Ctrl+Enter once | One row, 2619 ms |
| Before (the R212 build, redeployed from a stash) | The same query as `r213_slow_before`, Ctrl+Enter twice | **Two** rows: 4099 ms and 6641 ms |
| After (hot deploy of R213) | As `r213_slow_after`, Ctrl+Enter twice | **One** row, 2474 ms |
| After (R213 rebuilt after the stash) | As `r213_slow_after_redeploy`, Ctrl+Enter twice | **One** row, 3829 ms |
| After | Notebook, fresh page, cell 6 reset to 2 lines, Shift+Enter twice | No error; one run, output **1** (178 ms) once the kernel had started |
| After | Kernel ready: Shift+Enter twice | Output **2** (58 ms): one run |
| After | Shift+Enter once | Output **3**: the guard releases. Source still 2 lines |

## 2026-10-01 — A double Enter in the SCIM token label, ADVERSARIAL_LOG R212

**Why this round exists.** The second round of sweep 5, "a guard only the button honours".

Fixtures, **kept, revoked**: SCIM tokens `r212 before` (×2) and `r212 after` (×1). No one holds
their secrets; each was revoked from the tab after the round, so none can authenticate.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R211) | IAM → SSO → Provisioning (SCIM): label `r212 before`, Enter twice | **2** live rows `r212 before` (never used, 0 requests); banner "Token for r212 before" (one secret) |
| After (hot deploy of R212) | Label `r212 after`, Enter twice | **1** live row `r212 after`; one banner; label field cleared |
| After | Revoke on each fixture row, confirm Revoke | 0 live rows; "3 revoked tokens — an IdP still using one gets a 401" |

## 2026-10-01 — A double Ctrl+Enter in the Lakehouse editor, ADVERSARIAL_LOG R211

**Why this round exists.** The first round of sweep 5, "a guard only the button honours".

Fixtures, **kept**: lakehouse table `analytics.r211_double` (n INTEGER, note VARCHAR): 2 rows for
n = 1 (before), 1 row for n = 2 (after).

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R210) | Lakehouse editor: `CREATE TABLE analytics.r211_double (n INTEGER, note VARCHAR)`, Run | 0 rows |
| Before | `INSERT INTO analytics.r211_double VALUES (1, …)`, Ctrl+Enter twice; then `SELECT count(*)` | **2** |
| After (hot deploy of R211) | `INSERT … VALUES (2, …)`, Ctrl+Enter twice | Count **1** |
| After | `SELECT n, count(*) … GROUP BY n ORDER BY n` | n 1 → **2**, n 2 → **1** |

## 2026-10-01 — A query against a table still loading, ADVERSARIAL_LOG R210

**Why this round exists.** Found smoking the real image after R209.

Fixtures, **kept**: Iceberg table `r181.smoke_5330adc2_c`. The two attempts before it committed
nothing.

| Round | What was driven | What came back |
| --- | --- | --- |
| Smoke, real image `5330adc25b2f` (R209) | Workbench, Local: `version()`, `typeof(date_trunc(…))`, `current_setting('TimeZone')`, `(SELECT count(*) FROM saas_sales)` | v1.5.4 · TIMESTAMP · UTC · **6000**; the explorer beside it "9,994 rows"; a minute later `count(*)` **9994** |
| Smoke | Publish to Iceberg `r181` / `smoke_5330adc2` | **"Failed to commit Iceberg transaction: … HTTP 500"**; the catalog's log `SQLITE_BUSY: database is locked` |
| Smoke | the same as `smoke_5330adc2_b` | the same failure |
| Smoke | `aswarm-iceberg-rest` restarted; the same as `smoke_5330adc2_c` | "Published 4 row(s)"; committed in 2123 ms, then 1925 ms |
| Before (same image) | fresh load, the Workbench, `SELECT count(*) FROM saas_sales` at once | **"Catalog Error: Table with name saas_sales does not exist!"** |
| After (hot deploy of R210) | the same, twice | "Starting the SQL engine…", then **9994** (6437 ms, then 6940 ms) |

## 2026-10-01 — The Workbench's two engines on one query, ADVERSARIAL_LOG R209

**Why this round exists.** R197's leftover: the browser's DuckDB was an older version than the
server's.

Fixtures: none. The builder pane was closed without adding.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R208) | Workbench, Local (in-browser): `typeof(date_trunc('month', TIMESTAMP '2026-01-15 10:00:00'))`, the value, `version()` | **DATE · 2026-01-01 · v1.4.3** |
| Before | the same on Lakehouse · AgentSwarms | **TIMESTAMP · 2026-01-01 00:00:00 · v1.5.5** |
| After (hot deploy of R209) | the same on Local, with `current_setting('TimeZone')`, a TIMESTAMPTZ and a DATE | **TIMESTAMP · 2026-01-01 00:00:00 · v1.5.4** · UTC · 2026-09-30 22:30:00+00 · 2026-09-30 |
| After | BI builder, Line, Local, monthly `count(*)` over `saas_sales` | a time axis: 2022-07, 2023-03, 2023-11, 2024-07, 2025-03, 2025-12 (R197: the old engine drew text labels) |

## 2026-10-01 — Smoke of the real image after R206 to R208

**Why this round exists.** The rounds since the last image went into a real image, `2ff4e7c03179`.

Fixtures, **kept**: Iceberg table `r181.smoke_2ff4e7c0`. Nothing else new; the version confirm was cancelled.

| Round | What was driven | What came back |
| --- | --- | --- |
| Smoke, real image `2ff4e7c03179` (R206–R208) | "R192 add-source", Documents and Sources | `r208-three.txt` File, indexed; `r208-two.txt` File, pending embedding; Sources "FILE · Uploaded file" |
| Smoke | "R109 chat echo", Version history, the trash, Cancel | "Delete “Autosave 1:00:42 AM”?"; Cancel left the version |
| Smoke | Agent Chat | message box enabled; "Ask a question, share a task, or try a starter below." |
| Smoke | "R205 1900 dates" | 1900, 1, 0, 1900-01-01, 1900-01-01, 1, 1900-01-02, 2, 1900-02-29, 2, 1 |
| Smoke | Publish to Iceberg `local_rest` / `r181` / `smoke_2ff4e7c0` | "Published 4 row(s)"; committed in 2034 ms, then 2271 ms |

## 2026-10-01 — An uploaded file's name and its index in a knowledge base, ADVERSARIAL_LOG R208

**Why this round exists.** R192's leftovers.

Fixtures, **kept**, in the knowledge base "R192 add-source": `r208-one.txt` and `r208-two.txt`
(both pending embedding, as their toasts said) and `r208-three.txt` (indexed).

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R207) | the knowledge base's Sources and Documents | uploaded `r192-*.txt`: **"MANUAL · Manual paste"**; documents badged **"Manual"** |
| Before | Add Source, `r208-one.txt`, the embed call failing | toast **"1 file added"**; the source "MANUAL · ok · Manual paste"; the document "Pending embedding" |
| After (hot deploy of R208) | Sources and Documents | **"FILE · Uploaded file"** for every uploaded `.txt`; documents badged **File** |
| After | Add Source, `r208-two.txt`, the embed call failing | toast **"1 file added, not fully indexed · Not indexed yet: Failed to fetch. Re-index retries; until then it is found by keyword only."** |
| After | Add Source, `r208-three.txt`, the embed working | toast "1 file added"; "Indexed · 1 chunk" |

## 2026-10-01 — The swarm Versions dialog's double Enter and trash, ADVERSARIAL_LOG R207

**Why this round exists.** Queued from R190, read in the source and not yet driven.

Fixtures: none. The version insert and delete were answered in the browser, so nothing was
written or removed; "R109 chat echo"'s one version is as it was.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R206) | Version history; "R207 double enter", Enter twice | **two inserts**, 16 ms apart; "Version saved" |
| Before | the trash on "Autosave 1:00:42 AM" | **DELETE sent at once**, no confirm; the list "No versions yet" |
| After (hot deploy of R207) | "R207 double enter", Enter twice | **one insert** |
| After | the trash | confirm "Delete “Autosave 1:00:42 AM”? This snapshot (2 nodes) is removed for good …", no request |
| After | Cancel; then the trash and Delete | Cancel: nothing sent, the row stays; Delete: one DELETE, the row gone |

## 2026-10-01 — Agent Chat when no conversation can be started, ADVERSARIAL_LOG R206

**Why this round exists.** Queued from the client write survey. Before it, R201 to R205 went into
a real image, smoked below.

Fixtures, **kept**: Iceberg table `r181.smoke_a4f99b7a`; one empty "New Chat" conversation for
"Sample · Graph RAG Explorer (Acme Corp)", made by Try again.

| Round | What was driven | What came back |
| --- | --- | --- |
| Smoke, real image `a4f99b7a55be` (R201–R205) | "R201 big numbers" | 1, 6, 1.4, 12345678902, 1500000000000000000000, 12,345,678,901,234,600, 12345678901, 24691357802 |
| Smoke | "R205 1900 dates" | 1900, 1, 0, 1900-01-01, 1900-01-01, 1, 1900-01-02, 2, 1900-02-29, 2, 1 |
| Smoke | Traces, cost column | $0.00016, $0.000005, $0.00015, $0.000005, $0.00 (free), $0.00083 |
| Smoke | BI builder, empty pane; Data Prep *Save as* | "Write a query or pick tables, then Run it."; enabled, the usual title |
| Smoke | Publish to Iceberg `local_rest` / `r181` / `smoke_a4f99b7a` | "Published 4 row(s)"; committed in 1426 ms, then 1665 ms |
| Before (same image) | Agent Chat reached client-side, the conversations read `[]`, the insert 500 | no toast; no conversation; message box **disabled** under "Ask a question, share a task, or try a starter below." |
| Before | + New Chat | a second failing insert; **no toast**, nothing changed |
| After (hot deploy of R206) | the same | toast "Could not start a conversation · conversations insert refused (injected)"; centre "A conversation could not be started, so there is nowhere to write yet: …" and **Try again** |
| After | + New Chat | toast "Could not start a new chat · …" |
| After | injector cleared, Try again | one "New Chat" made and active; message box **enabled**; starters shown |

## 2026-10-01 — Excel's 1900 dates in a grid, ADVERSARIAL_LOG R205

**Why this round exists.** The last grid items from R198's probe.

Fixtures, **kept**: workbook "R205 1900 dates" (Sheet1, rows 1 and 2).

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R204) | `=YEAR(Z9)`, `=MONTH(Z9)`, `=DAY(Z9)` (Z9 blank), `=DATE(1900,1,1)*1`, `=TEXT(1,"yyyy-mm-dd")`, `=WEEKDAY(1)`, `=DATE(1900,3,1)-DATE(1900,2,28)`, `=DATEDIF(DATE(1900,2,28),DATE(1900,3,1),"d")` | **1899, 12, 30**, 1900-01-01, **1899-12-31**, 1, **1899-12-31** (the difference, serial 1, in date format), **0** |
| After (hot deploy of R205) | the workbook, reopened | **1900, 1, 0**, 1900-01-01, **1900-01-01**, 1, **1900-01-02** (serial 2), **2** |
| After | row 2: `=TEXT(60,"yyyy-mm-dd")`, `=DAYS(DATE(1900,3,1),DATE(1900,2,28))`, `=DATEDIF(DATE(1900,3,1),DATE(1900,3,2),"d")` | **1900-02-29**, **2**, **1** |

## 2026-10-01 — Data Prep's Save as while the lakehouse loads or fails, ADVERSARIAL_LOG R204

**Why this round exists.** Queued from Phase D's survey.

Fixtures: none. The lakehouse-tables call was held or failed in the browser only.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R203) | BI → Data preparation, the lakehouse call held 20 s | lakehouse list a skeleton; *Save as* disabled, title **"The lakehouse is not configured on this deployment"** |
| Before | the call answering 500 | palette **"Could not list lakehouse tables."**, no reason, no retry; title still **"not configured"** |
| After (hot deploy of R204) | the call held 15 s | title **"Checking the lakehouse…"**; when it returned, enabled, the usual title |
| After | the request failing (`Failed to fetch`) | palette **"Could not list lakehouse tables: Failed to fetch"** and **Try again**; title "The lakehouse tables could not be read: Failed to fetch. A local dataset can still be saved." |
| After | Try again, injector cleared | **58** lakehouse tables listed; *Save as* enabled |

## 2026-10-01 — Why "Add to dashboard" is disabled, ADVERSARIAL_LOG R203

**Why this round exists.** Queued since R196.

Fixtures: none new. The BI project "R196 dates" (kept) was used, and nothing was added to it.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R202) | + Chart; the query `SELECT * FROM (VALUES ('North', 12), ('South', 7)) v(region, orders)`; Run | 2 rows · 2 cols; the bar chart drawn; title box empty, showing "Revenue by month" in grey; **Add to dashboard disabled, no title, no text** |
| After (hot deploy of R203) | + Chart, the pane empty | disabled; beneath: "Write a query or pick tables, then Run it." |
| After | the same query typed | "Run the query to see its rows." |
| After | Run | the chart drawn; "Give the widget a title."; placeholder "e.g. Revenue by month" |
| After | title "Orders by region" | **enabled**, the line gone; the pane closed without adding |

## 2026-10-01 — A paid model's cost against a free one's, ADVERSARIAL_LOG R202

**Why this round exists.** The queue's Phase E item: Prompt Compare and Traces round cost to four
places.

Fixtures: none kept. Two Prompt Compare runs, Gemini 2.5 Flash against GPT-5 Mini, together
about $0.0004, recorded as four traces.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R201) | Traces, the list | Gemini 2.5 Flash 7/1 at 02:51:39: **$0.0000**; `openrouter/free` rows: **$0.0000** |
| Before | that row's detail | Cost **$0.0000** |
| Before | Prompt Compare, Flash against Mini, "Reply with the single word OK." | Flash **~$0.0000** (7/1), Mini ~$0.0002 (13/74), under "models without a known price show ~$0" |
| After (first cut) | Traces, the list | Flash **$0.0000050**, Mini $0.00015, free **$0.00**; the trailing zero was then trimmed |
| After (hot deploy of R202) | Prompt Compare, the same prompt | Flash **~$0.0000046**, Mini **~$0.00016** |
| After | Traces, the list and the new Flash call's detail | Flash **$0.000005**, Mini **$0.00016**, free **$0.00**; detail Cost **$0.000005** |

## 2026-10-01 — Numbers past 15 digits in a grid and a table, ADVERSARIAL_LOG R201

**Why this round exists.** R200's QUEUED rows. Before it, R197 to R200 went into a real image,
smoked below.

Fixtures, **kept**:
- Workbook "R201 big numbers". Sheet1 grid holds row 1 and G1:H1. The Query table sheet runs over
  `SELECT 1 AS id, 1e-10::DOUBLE AS tiny, 5.0000000001::DOUBLE AS five, 1.3::DOUBLE AS m, 12345678901.005::DOUBLE AS amount, 1.5e21::DOUBLE AS big, 12345678901234567::DOUBLE AS long`,
  with calculated columns ceil_tiny, ceil_five, mround, text_big and text_long.
- Iceberg table `r181.smoke_f1e4fc4c`.

| Round | What was driven | What came back |
| --- | --- | --- |
| Smoke, real image `f1e4fc4ca514` (R197–R200) | "R200 table rounding", both sheets | grid 1.01, 1.01, 0.085, 0.085, 0.29, O'Neil 2-Way; table the same, share2 1.01 |
| Smoke | "R199 grid text" | 2.68, 2.68, 2.68, École Normale, 0.00, 0.085, 0.09, ß Straße Ñandú |
| Smoke | Lakehouse, `analytics.fct_region_revenue` → Publish to Iceberg `local_rest` / `r181` / `smoke_f1e4fc4c` | "Published 4 row(s) to r181.smoke_f1e4fc4c"; committed in 869 ms, then 1106 ms |
| Before (same image) | Sheet1: `=CEILING(0.0000000001,1)`, `=CEILING(5.0000000001,1)`, `=MROUND(1.3,0.2)`, `=CEILING(12345678901.005,1)`, `=TEXT(1.5E+21,"0")`, `=TEXT(12345678901234567,"#,##0")` | **0**, **5**, 1.4, **12345678901**, **1**, **12,345,678,901,234,568** |
| Before | G1 12345678901.005, H1 `=G1*2` | **###########**, **###########** |
| Before | Query: + Column ceil_tiny, ceil_five, mround, text_big, text_long; the amount column itself | **0**, **5**, 1.4, 1500000000000000000000, **12,345,678,901,234,568**; amount **1.234567890e+1** |
| After (hot deploy of R201) | the workbook, reopened | Sheet1: **1, 6**, 1.4, **12345678902, 1500000000000000000000, 12,345,678,901,234,600**, G1 **12345678901**, H1 **24691357802** |
| After | the Query sheet | amount **12345678901**; **1, 6**, 1.4, 1500000000000000000000, **12,345,678,901,234,600** |

## 2026-10-01 — Rounding in a table sheet against a grid, ADVERSARIAL_LOG R200

**Why this round exists.** R199's second probe. One workbook holds the same values in a grid
sheet and in a table sheet over a lakehouse query, with the same formulas.

Fixtures, **kept**: workbook "R200 table rounding" (Sheet1 grid, row 1; Query table sheet over
`SELECT * FROM (VALUES (1, 'o''neil 2-way', 1.005::DOUBLE, 0.29::DOUBLE, 0.01::DOUBLE + 0.075::DOUBLE)) v(id, name, price, rate, total)`,
with calculated columns round2, text2, joined, trunc2, proper and share2).

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R199) | Sheet1: A1 1.005, `=ROUND(A1,2)`, `=TEXT(A1,"0.00")`, `=0.01+0.075`, `=D1&""`, `=TRUNC(0.29,2)`, `=PROPER("o'neil 2-way")` | 1.01, 1.01, 0.085, 0.085, **0.28**, O'Neil 2-Way |
| Before | Query: + Column round2 `=ROUND([@price],2)`, text2 `=TEXT([@price],"0.00")`, joined `=[@total]&""`, trunc2 `=TRUNC([@rate],2)`, proper `=PROPER([@name])` | **1**, **1.00**, **0.08499999999999999** (the total column beside it shows 0.085), **0.28**, **O'neil 2-way** |
| After (hot deploy of R200) | the workbook, reopened | Sheet1 F1 **0.29**; Query: **1.01**, **1.01**, **0.085**, **0.29**, **O'Neil 2-Way** |
| After (final build, fast path) | + Column share2 `=ROUND([@price]*[@rate]/SUM([rate]),2)` (a whole-column total) | **1.01**, no error; "All changes saved" |

## 2026-10-01 — TEXT, number formats and PROPER in a grid, ADVERSARIAL_LOG R199

**Why this round exists.** R198's probe found the grid's own differences from Excel. ROUND and TEXT
of the same cell gave different answers.

Fixtures, **kept**: workbook "R199 grid text" (Sheet1, row 1 and H3).

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R198) | A1 2.675; B1 `=TEXT(A1,"0.00")`; C1 `=ROUND(A1,2)`; D1 `=PROPER("ÉCOLE normale")`; E1 `=TEXT(A5,"0.00")` over a blank | B1 **2.67**, C1 2.68, D1 **éCole Normale**, E1 **(empty)** |
| After (hot deploy of R199) | the workbook, reopened | B1 **2.68**, D1 **École Normale**, E1 **0.00** |
| After | F1 `=0.01+0.075`, G1 `=TEXT(F1,"0.00")` | F1 0.085, G1 **0.09** |
| After | A1 → format **Number** (`#,##0.00`) from the toolbar | A1 shows **2.68**; "All changes saved" |
| After (second deploy) | H3 `=PROPER("ß straße ÑANDÚ")` | **ß Straße Ñandú** (the ß kept, not "SS") |

## 2026-10-01 — A blank in a table sheet against a grid, ADVERSARIAL_LOG R198

**Why this round exists.** Sweep 4's grid-vs-table item. One workbook holds the same two rows in
a table sheet (a lakehouse query) and in a grid sheet, with the same formulas.

Fixtures, **kept**: workbook "R198 blanks" (Sheet1 grid; Query table sheet over
`SELECT * FROM (VALUES (1,'alice',10.5::DOUBLE),(2,'bob',NULL::DOUBLE)) v(id, customer, amount)`,
with calculated columns label, avg1, root, mround).

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R197) | Query sheet, + Column: label `=[@customer]&": "&[@amount]`, avg1 `=AVERAGE([@amount],1)`, root `=([@amount]-20)^0.5` | alice: `alice: 10.5`, 5.75, #NUM!; bob: **`bob: 0`**, **0.5**, #NUM! |
| Before | Sheet1: alice / 10.5 / `=A1&": "&B1` / `=AVERAGE(B1,1)` / `=(B1-20)^0.5`; bob / blank / the same | alice: `alice: 10.5`, 5.75, #NUM!; bob: **`bob: `**, **1**, #NUM! |
| After (hot deploy of R198) | the Query sheet, reopened | bob: **`bob: `**, **1**, #NUM!, as the grid |
| After | + Column mround `=MROUND(-[@amount],0.5)` | alice #NUM! (signs differ), bob 0 |

## 2026-10-01 — Dates from the browser engine, as text, ADVERSARIAL_LOG R197

**Why this round exists.** R196's queued item. Before it, R194 to R196 went into a real image,
smoked below.

Fixtures: Iceberg table `r181.smoke_cad98aaa`. Nothing else new; the builder previews were not
added.

| Round | What was driven | What came back |
| --- | --- | --- |
| Smoke, real image `cad98aaa39f9` (R194–R196) | "R196 dates" dashboard, fresh load | the tile reads 2026-01, 2026-02, 2026-03 |
| Smoke | Workbench, Local: tz / `current_date` / a TIMESTAMPTZ formatted | `UTC \| 1790726400000 \| 2026-09-30 22:30` |
| Smoke | Prompt Compare, Flash vs Mini | Est. cost ~$0.0000 / ~$0.0001; Tokens 7/1 / 13/62 |
| Smoke | Publish to Iceberg `r181` / `smoke_cad98aaa` | committed (create 1476 ms, then fill 4130 ms); listed |
| Before (same image) | "R196 dates" tile → AUTO | `2026-02-01 00:00:00`, `2026-03-01 00:00:00` |
| Before | builder preview, Line, Local, `saas_sales` monthly count to 2022-03 → AUTO | `2022-01-01, 2022-02-01, 2022-03-01` |
| Before | Workbench, Local, `saas_sales` month / day / revenue | `1640995200000 \| 1641254400000 \| 16` |
| After (hot deploy of R197, first cut) | BI and chart tests | `biAutoDateGrain.test.ts` failed: a bare day had been made raw; reverted |
| After | Workbench, Local, the same | `2022-01-01 \| 2022-01-04 \| 16 \| true` |
| After | Workbench, Local: TIMESTAMP, TIMESTAMPTZ, DATE, `typeof(date_trunc(…))`, `version()` | `2026-09-30 22:30:00.25 \| 2026-09-30 22:30:00+00 \| 2026-09-30 \| DATE \| v1.4.3` |
| After | "R196 dates" tile → AUTO | `2026-01-01, 2026-02-01, 2026-03-01` |
| After | the builder preview, AUTO | `2022-01-01, 2022-02-01, 2022-03-01` |

## 2026-10-01 — A BI month axis over a naive TIMESTAMP, ADVERSARIAL_LOG R196

**Why this round exists.** R195's leftover: the chart layer reads the server's text and the
browser's epoch differently. The browser was at UTC+4.

Fixtures, **kept**: BI project "R196 dates" with the tile "Orders by month (naive TIMESTAMP, R196)".

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R195) | Workbench, Local, `saas_sales`: `date_trunc('month', strptime("Order Date", '%m/%d/%Y'))`, `CAST(… AS DATE)` | `1640995200000 \| 1641254400000 \| 16`: the grid shows epoch milliseconds |
| Before | "AI from the lakehouse - generated" → Monthly Revenue Trend → D | `2023-01-01, 2023-07-01, …` (its values carry an offset: unaffected) |
| Before | "R196 dates" → Add a chart → Line → Lakehouse → `SELECT date_trunc('month', CAST(placed_on AS TIMESTAMP)) AS month, count(*) AS orders FROM analytics.stg_revenue GROUP BY 1 ORDER BY 1` → Run → DATE GRAIN month | "3 rows · 2 cols"; axis **2025-12, 2026-01, 2026-02** |
| Before (control) | Lakehouse page, the same SQL | `2026-01-01 00:00:00 \| 272`, `2026-02-01 … \| 273`, `2026-03-01 … \| 291` |
| After (hot deploy of R196) | the same chart, DATE GRAIN month; then D | **2026-01, 2026-02, 2026-03**; 2026-01-01, 2026-02-01, 2026-03-01 |
| After | titled "Orders by month (naive TIMESTAMP, R196)" → Add to dashboard | the tile reads 2026-01, 2026-02, 2026-03; Saved. (Add to dashboard was disabled until a title was given, with no hint) |

## 2026-10-01 — The browser and server SQL engines on one query, ADVERSARIAL_LOG R195

**Why this round exists.** Sweep 4, "two surfaces, two answers": the Data Catalog Workbench runs
one editor against both engines. The browser was at UTC+4, 01:40 local (21:40 UTC).

Fixtures: none.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R194) | Lakehouse page: `SELECT current_setting('TimeZone'), strftime(TIMESTAMPTZ '2026-09-30 22:30:00+00', '%Y-%m-%d %H:%M'), date_trunc('day', …), CAST(… AS DATE)` | `Etc/UTC \| 2026-09-30 22:30 \| 2026-09-30 00:00:00+00 \| 2026-09-30` |
| Before | Workbench, Local (in-browser), the same | `Etc/GMT-4 \| 2026-10-01 02:30 \| 1790798400000 \| 1790812800000` |
| Before | Workbench, tz / `current_date` / the TIMESTAMPTZ as DATE / `DATE '2026-09-30'`, Local | `Etc/GMT-4 \| 1790812800000 \| 1790812800000 \| 1790726400000` (today and the order day: 2026-10-01) |
| Before | the same, Lakehouse · AgentSwarms | `Etc/UTC \| 2026-09-30 \| 2026-09-30 \| 2026-09-30` |
| After (hot deploy of R195) | Workbench, tz / `current_date` / the order day / its time, Local | `UTC \| 1790726400000 \| 1790726400000 \| 2026-09-30 22:30` (2026-09-30) |
| After | the same, Lakehouse · AgentSwarms | `UTC \| 2026-09-30 \| 2026-09-30 \| 2026-09-30 22:30` |

## 2026-10-01 — Prompt Compare's cost against Traces, ADVERSARIAL_LOG R194

**Why this round exists.** The smoke test of the real image for R191–R193 turned it up; it opens
sweep 4, "two surfaces, two answers". The `/api/chat` bodies were tee'd in the browser to see what
the server sent. Model calls: seven short ones (about $0.0005 in all).

Fixtures: Iceberg table `r181.smoke_6b8a7e78`.

| Round | What was driven | What came back |
| --- | --- | --- |
| Smoke, real image `6b8a7e784718` (R191–R193) | Agent Chat, GET `agents` refused once | the mark and "Your agents could not be read · … · Try again"; Try again → the agents |
| Smoke | SQL Reviewer fixture chat, `/api/chat` answered 402 `budget_exceeded` | toast "You have reached your monthly AI budget ($5.00). (spent $5.12 of $5.00 this month.)", no dialog |
| Smoke | Knowledge Base, GET `knowledge_bases` held 6 s; Add Source `smoke-eta.txt` with POST `kb_sources` refused | "Loading your knowledge bases…"; "The file was not added · Not added, still listed here to try again: smoke-eta.txt: …", Sources unchanged |
| Smoke | `analytics.stg_revenue` → Publish to Iceberg → `r181` / `smoke_6b8a7e78` | the catalog: "Successfully committed to table r181.smoke_6b8a7e78 in 3954 ms" |
| Smoke (R27) | Prompt Compare, Flash + Mini + Flash Lite, Lite's request refused | Flash 2.4s and Mini 2.9s answered, Lite 0.1s failed; "Comparison (ranking excludes 1 did not answer)", Flash crowned |
| Before (same image) | Prompt Compare, Flash vs Mini, "Reply with the single word OK." | "Est. cost — / —", "Tokens ~1 / ~1"; the bodies, one chunk each, ending `[DONE]` then `event: cost` with $0.0000046 7/1 and $0.00012325 13/60 |
| Before (control) | Traces | the same calls: gpt-5-mini 13/55 $0.0001, gemini-2.5-flash 7/1 $0.0000 |
| After (hot deploy of R194) | the same run | "Est. cost ~$0.0000 / ~$0.0001", "Tokens 7/1 / 13/55", as the streamed cost events said |
| After | Traces | gpt-5-mini 13/55 $0.0001, gemini-2.5-flash 7/1 $0.0000: the two pages agree |

## 2026-10-01 — Agent Chat's failed turns, named by who refused them, ADVERSARIAL_LOG R193

**Why this round exists.** Phase D, sweep 3's survey: a cause named that the evidence cannot
support. The budget cap is opt-in through `.env` (`ENFORCE_BUDGET_CAP`) and was not switched on,
so `POST /api/chat` was answered from the browser with the route's exact bodies. Each rule fired
once.

Fixtures: none new. The five refused sends left user messages without replies in R191's
conversation "Reply with the single word OK." (kept).

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R192) | a send answered 402 `{error: "budget_exceeded", message: "You have reached your monthly AI budget ($5.00). (spent $5.12 of $5.00 this month.)"}` | dialog "AI credits exhausted · This model can't be used right now because the AI credits are exhausted. Pick another model and we'll continue this chat with full context.", five OpenRouter models offered; the route's sentence nowhere |
| Before | a send answered 403 `{error: "model_not_allowed", message: "Your administrator has not allowed openrouter/openai/gpt-4o-mini …"}` | toast "openrouter: Your administrator has not allowed openrouter/openai/gpt-4o-mini for your account. …" |
| After (hot deploy of R193) | the 402 budget body | no dialog; toast "You have reached your monthly AI budget ($5.00). (spent $5.12 of $5.00 this month.)" |
| After | the 403 body | toast "Your administrator has not allowed openrouter/openai/gpt-4o-mini for your account. Ask a superadmin to adjust your model access." |
| After (control) | 402 `{error: "AI credits exhausted for this provider."}`, the route's upstream shape | the fallback picker, "AI credits exhausted", as before |

## 2026-10-01 — Knowledge: Add Source under a refused insert, the list while it loads, ADVERSARIAL_LOG R192

**Why this round exists.** Phase C's last item: the add-source dialog. Files were seeded into its
input with a `DataTransfer`. Refusals fired once each (the injector drops a rule after its first
hit), and the list's read was held rather than refused.

Fixtures, **kept**, on the base "R192 add-source" (created for this round): documents
`r192-beta.txt`, `r192-delta.txt`, `r192-gamma.txt`. Sources: `r192-alpha.txt` (ok · 0 docs, the
before-round's orphan, left as evidence), and `r192-epsilon.txt` and `r192-zeta.txt` (error · 0
docs, from the withdraw's fallback).

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R191 on `c9e16c0b2b3b`) | Add Source → File, `r192-alpha.txt` + `r192-beta.txt`, the first POST `knowledge_documents` refused | "2 files added"; the dialog closed; Documents (1): `r192-beta.txt`; Sources (2): "r192-beta.txt · ok · 1 doc", "r192-alpha.txt · ok · 0 docs" |
| Before | from Agent Builder, GET `knowledge_bases` held 6 s → sidebar Knowledge Base | at 2 s "No knowledge bases yet."; then the list |
| After (hot deploy of R192) | the same hold | "Loading your knowledge bases…"; then the list |
| After | `r192-gamma.txt` + `r192-delta.txt`, the first document insert refused | "1 of 2 files added · Not added, still listed here to try again: r192-gamma.txt: R192 injected: the POST did not reach the database"; the dialog open with gamma alone; Sources 2 → 3 |
| After | Add source again | "1 file added"; the dialog closed; Documents (3), Sources (4); gamma, delta and beta each 1 doc |
| After (first cut) | `r192-epsilon.txt`, the document insert and DELETE `kb_sources` refused | toast "The file was added …" (wrong) and Sources not refreshed; after a reload "r192-epsilon.txt · error · 0 docs · The document was not saved: …": fixed |
| After (second cut) | `r192-zeta.txt`, both refused | Sources (6) at once: "r192-zeta.txt · error · 0 docs · The document was not saved: R192 injected: …" |
| After | the same file, POST `kb_sources` refused | "The file was not added · Not added, still listed here to try again: r192-zeta.txt: R192 injected: …"; Sources still (6); zeta still in the dialog |

## 2026-09-30 — Agent Chat's agent list and trace under refusal, ADVERSARIAL_LOG R191

**Why this round exists.** Phase C's next item: the playground's reads. Before it, R188 to R190
went into a real image, smoked below. The refusals were set in the browser on a page that reaches
Agent Chat client-side (Agent Builder, then the sidebar or a card's *Chat*).

Fixtures, **kept**: the conversation "Reply with the single word OK." on "Sample · SQL Reviewer"
(two exchanges, `openai/gpt-4o-mini`, about $0.00002 each); Iceberg table `r181.smoke_c9e16c0b`.

| Round | What was driven | What came back |
| --- | --- | --- |
| Smoke, real image `c9e16c0b2b3b` (R188–R190) | "Approval durability check" → Deploy, GET `swarm_schedules` refused | "Deployment not read · What this swarm has deployed could not be read, so this panel says nothing about it. Close and reopen to try again." |
| Smoke | Version history → Save version, POST `swarm_versions` refused | "The version was not saved · Smoke injected: the POST did not reach the database"; the list: Before restore 10:46:35 PM, R190 capture after retry, Initial version |
| Smoke | Manage, GET `swarm_components` refused | "Your components could not be read, so this list says nothing about them: Smoke injected: …" |
| Smoke | Lakehouse → `analytics.stg_revenue` → Publish to Iceberg → `local_rest` / `r181` / `smoke_c9e16c0b`, Refuse | "Published 836 row(s) to r181.smoke_c9e16c0b"; the catalog's REST listing has it |
| Before (same image) | GET `agents?select=id,name,llm_provider…` refused → Agent Chat | "Select an agent…" with a pulsing "Pick an agent to begin"; "Select an agent to start · Choose an agent from the top bar, then send your first message."; the selector opens with 0 options |
| Before (control) | a normal load | "Chat with Sample · Graph RAG Explorer (Acme Corp)"; the selector lists 9 agents |
| Before | "Sample · SQL Reviewer" → New Chat → inspector's Trace tab ("No trace yet"); GET `execution_traces` refused; "Reply with the single word OK." sent | the reply "OK"; eight refused reads of `id=eq.de74e8a5…`; "Trace not recorded · The request may have failed before the trace row was written." |
| Before (control) | Traces page | top row "Sep 30 23:15:34 · Sample · SQL Reviewer · openai/gpt-4o-mini · 4.1s · 100/1 · ok · $0.0000" |
| After (hot deploy of R191, first cut) | agents refused | "Agents not read · Try again" in the bar, running under the inspector's toggle (bar ~330 px, picker 170 px): moved |
| After | agents refused | an error mark in the bar, no pick hint; "Your agents could not be read · So there is nothing to pick yet: R191 injected: the GET did not reach the database. · Try again" |
| After | lifted → Try again | "Chat with Sample · Graph RAG Explorer (Acme Corp)"; the mark gone |
| After | SQL Reviewer, the same chat, GET `execution_traces` refused, the same prompt | "OK"; "Trace not read · The trace could not be read, so this says nothing about whether it was recorded: R191 injected: the GET did not reach the database · Try again" |
| After | lifted → Try again | "Execution Trace · success · 2136 ms · $0.000018 · 116 / 1 · openrouter · openai/gpt-4o-mini · 3d5748b5-…" |

## 2026-09-30 — Save version and Restore under a refused insert, ADVERSARIAL_LOG R190

**Why this round exists.** R189's round found the versions dialog's two writes going on as if
their insert had landed. On "Approval durability check", the `swarm_versions` insert was refused
from the browser, as in R186–R189.

Fixtures, **kept**: the versions "R190 capture after retry" (saved, 5 nodes) and "Before restore
10:46:35 PM" (pre-restore, 6 nodes: the 5 saved nodes and a Set Variable) on "Approval durability
check". The canvas was never saved; the added nodes went with a reload.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R189 on `498ec3b7ec48`) | Version history → "R190 refused capture" → Save version, POST `swarm_versions` refused | toast "Version saved"; the name cleared; the list only "Initial version · autosave · 5 nodes" |
| Before | Set Variable added (6 nodes, unsaved) → Restore on the Initial version | confirm 'Restore "Initial version"? The canvas will be replaced with this snapshot (5 nodes). Your current graph is saved as a snapshot first, so you can restore back. …' |
| Before | confirmed, the insert refused | "Version restored — hit Save to keep it."; 5 nodes |
| Before | lifted, the history reopened | only the Initial version: no *Before restore*, the 6-node graph gone |
| After (hot deploy of R190) | "R190 refused capture" → Save version, refused | "The version was not saved · R190 injected: the POST did not reach the database"; the name kept; the list unchanged |
| After | lifted, renamed "R190 capture after retry" → Save version | "Version saved"; listed "saved · 5 nodes · 9/30/2026, 10:45:52 PM" |
| After | Set Variable added (6 nodes) → Restore on the Initial version, refused | "Nothing was restored · Your current graph could not be saved as a version first, so the restore could not be undone: R190 injected: …"; still 6 nodes; the dialog open |
| After | lifted → Restore again | "Version restored — hit Save to keep it."; 5 nodes; the dialog closed; reopened, "Before restore 10:46:35 PM · pre-restore · 6 nodes" at the top |

## 2026-09-30 — The canvas's snapshot, components and versions under refusal, ADVERSARIAL_LOG R189

**Why this round exists.** Phase C's third item, the rest of the swarms batch. The reads were
refused from the browser, as in R186–R188. Each case below was first read without the refusal,
so an empty list shows the defect rather than an empty account.

Fixtures: the component "R189 fixture first 100 chars" (category Custom, the default slice code),
authored in the Component library and saved to v3, **kept**. "R109 chat echo" was published five
times, each time the same saved 2-node graph. Nothing was saved on either canvas; the added nodes
went with a reload.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R188 on `498ec3b7ec48`) | "Approval durability check" → Version history | "Initial version · autosave · 5 nodes · 9/23/2026, 1:34:27 AM · Restore" |
| Before | the same, GET `swarm_versions` refused | "No versions yet — Save the swarm or capture one above." |
| Before | Manage → New component, "R189 fixture: first 100 chars" | toast "Name must start with a letter or digit and use only letters, digits, spaces, _ or -." (validation, not a finding) |
| Before | the name without the colon → Create component | 'Created "R189 fixture first 100 chars"'; the library lists it at v1, the palette has its button |
| Before | the fixture → Save as v2, GET `swarm_components` refused (2 hits: library and palette) | 'Saved "R189 fixture first 100 chars" (v2)'; library "No components yet. Author one and it shows up in the palette."; palette "None yet — author a reusable node."; the palette button gone |
| Before | "R109 chat echo" → Deploy → Publish (the button, not a tab: this one went out before the refusal was armed) | "Published — deployed runs now use this version" |
| Before | Publish again, GET `swarms?select=published_nodes…` refused; closed; Set Variable added (3 nodes against 2) | the same toast; no badge beside Deploy |
| Before (control) | reloaded, the same node added | "Draft ahead · The canvas has changes that deployed runs are not using yet" |
| After (hot deploy of R189) | Version history, GET `swarm_versions` refused | "The versions could not be read, so this list says nothing about them: R189 injected: the GET did not reach the database" |
| After | lifted, reopened | "Initial version · autosave · 5 nodes" |
| After | the fixture → Save as v3, GET `swarm_components` refused | 'Saved … (v3)'; library and palette "Your components could not be read, so this list says nothing about them: R189 injected: …", the palette with "Try again" |
| After | lifted → the palette's Try again; Manage reopened | the fixture back in the palette; the library lists it at v3 |
| After | "R109 chat echo" → Publish with the re-read refused; Set Variable added | "Live not checked", title "What is live could not be read, so whether the canvas is ahead of it is unknown: R189 injected: …", still after the node (3 against 2) |
| After | lifted → Publish ("The canvas has unsaved edits. Publishing pins the last SAVED version …") | "Draft ahead"; "Live not checked" gone |
| After | refused again → Publish → Back to gallery | "Live not checked"; the gallery reloads the page, so no in-page switch to drive (Import and deleting the open swarm are the only ones) |

## 2026-09-30 — The deploy dialog under refusal, ADVERSARIAL_LOG R188

**Why this round exists.** Phase C's third item: the swarms batch, starting with the deploy dialog.
Before it, R183 to R187 went into a real image, smoked below.

Fixtures: none new.

| Round | What was driven | What came back |
| --- | --- | --- |
| Smoke, real image `498ec3b7ec48` (R183–R187) | ETL Pipelines; Workflows; Evaluations; Lakehouse → Publish to Iceberg `stg_revenue` → `r181` / `smoke_498ec3b7`, Refuse | five "changed since this run" marks, `r183_chip` unmarked; `r184_badge · changed since this run · failed`; the r186 dataset and runs; `Published 836 row(s) to r181.smoke_498ec3b7` |
| Before (same image) | "Approval durability check" → Deploy | "Published · pinned 9/23/2026, 1:37:47 AM"; Schedules: "R95 heartbeat", "R92 one-run probe", "R91 park probe (after)", … |
| Before | the same, GET `swarm_schedules` refused | "Not deployed · No API keys or schedules yet."; Schedules: "No schedules yet.", Add enabled |
| After (hot deploy) | the same refusal | "Deployment not read · What this swarm has deployed could not be read, so this panel says nothing about it."; Schedules: "The schedules could not be read, so this list says nothing about them: R188 injected: the GET did not reach the database. Adding one is off until they can be: an existing schedule would run the swarm twice.", Add disabled |
| After | lifted, reopened | "Published · pinned 9/23/2026, 1:37:47 AM" |

## 2026-09-30 — The node inspector's pickers under refusal, ADVERSARIAL_LOG R187

**Why this round exists.** Phase C's second item: the swarm node inspector's reads. Driven on
"Embed E2E Mini Swarm" without saving: the Researcher node's SQL Query tool switched on and
`ecom_returns` ticked in the canvas only, the inspector closed on the empty canvas and reopened,
since it reads its lists once, when it opens.

Fixtures: none new; nothing was saved.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R186) | SQL Query on, `ecom_returns` ticked | "Node will only see 1 selected table." |
| Before | the inspector reopened with GET `user_data_tables` refused | "Allowed tables (optional) · No tables yet. Upload a CSV in Data & SQL Agents."; the selection line gone |
| After (hot deploy) | the same, with GET `provider_credentials` refused too | "Your tables could not be read, so this list says nothing about them: R187 injected: the GET did not reach the database The node keeps its selection: ecom_returns."; under the provider picker "Your connected providers could not be read, so none is marked as not connected: …" |
| After (the sentence fixed) | the tables read refused again | "… did not reach the database. The node keeps its selection: ecom_returns." |

## 2026-09-30 — Evaluations' reads and deletes under refusal, ADVERSARIAL_LOG R186

**Why this round exists.** Phase C's first item: evaluations' five reads and two deletes. Each
call was refused from the browser (a `window.fetch` override answering 500 "R186 injected: the
<METHOD> did not reach the database") for that step only.

Fixtures, kept: the dataset "r186 evals" (two cases) and its three runs on "R109 chat echo",
"Contains expected text", all 2/2 at $0.

| Round | What was refused | What came back |
| --- | --- | --- |
| Before (hot deploy of R185) | GET the run's `eval_results` | "Progress 2/2 · Pass rate 100% … No results." |
| Before | GET the dataset's `eval_cases` | "r186 evals · 0 cases", New eval run disabled; the runs list "r186 evals · 2/2" |
| Before | DELETE a case, confirmed | no message; "2 cases", the case listed |
| Before | DELETE the dataset, confirmed | no message; the dataset listed |
| Before | GET `eval_cases?select=id` as run 2 started | "running · 0/2 · Run remaining 2 · Executing cases…"; nothing executed (lifted: Run remaining → 2/2) |
| Before | GET the baseline's `eval_results` on Compare against | "vs baseline: 0 improved · 0 regressed · 0 unchanged", both cases `only_b` "— → pass 1.00" |
| After (hot deploy) | GET the run's `eval_results` | "The results could not be read, so this list says nothing about them: R186 injected: the GET did not reach the database" |
| After | GET the baseline's `eval_results` | "The baseline's results could not be read: R186 injected: …"; no "vs baseline" card |
| After | GET the dataset's `eval_cases`; then lifted, Try again | "cases not read" and the error with Try again; then "2 cases" |
| After | DELETE a case, confirmed | "The case was not deleted · R186 injected: the DELETE did not reach the database"; "2 cases" |
| After | DELETE the dataset, confirmed | "\"r186 evals\" was not deleted · R186 injected: …"; the dataset listed |
| After | GET `eval_cases?select=id` as run 3 started; then lifted, Run remaining | "The run could not carry on · Its cases could not be read: …" and "No case is executing now. Run remaining carries on."; then 2/2, 100% |

## 2026-09-30 — A materialized view's failed rebuild, ADVERSARIAL_LOG R185

**Why this round exists.** Phase B's third item: R101's hover-only failure.

Fixtures, kept: `analytics.r185_base` (1 row) and the materialized view `analytics.r185_mv`
over it, manual, rebuilt successfully last.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R184) | Query `CREATE TABLE analytics.r185_base AS SELECT 185 AS id, 'base row' AS note`; `SELECT * FROM analytics.r185_base` → Save as view → `analytics` / `r185_mv` / manual | `Count 1`; "Built analytics.r185_mv — 1 row(s)" |
| Before | `ALTER TABLE analytics.r185_base RENAME TO r185_base_moved`; the `r185_mv` tab → Rebuild | the toast "Rebuild failed: Catalog Error: Table with name r185_base does not exist! …"; the badge `materialized`, title "Last rebuild failed: …" |
| Before | reload, reopen `r185_mv` | `analytics.r185_mv · 1 row(s) · Monitor this table · Define metrics on this · Publish to Iceberg · materialized · Rebuild`; no failure text on the tab |
| After (hot deploy) | reopen `r185_mv` | `last rebuild failed` (red) · "Catalog Error: Table with name r185_base does not exist! These rows are from the rebuild of 9/30/2026, 7:52:16 PM." |
| After | `ALTER TABLE analytics.r185_base_moved RENAME TO r185_base`; Rebuild | "Rebuilt — 1 row(s) in 3497 ms"; the badge `materialized`; no failure text |

## 2026-09-30 — A workflow's status over an edited graph, ADVERSARIAL_LOG R184

**Why this round exists.** Phase B's second item: sweep item 2's workflow saves.

Fixtures, kept: the workflow `r184_badge` (one SQL step, now `SELECT 184 AS r184` again) and its
two runs.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R183) | New workflow `r184_badge`; SQL statement step `SELECT 184 AS r184`; Save; Run now | "Saved"; "Run started"; the list `r184_badge · manual · less than a minute ago · succeeded` |
| Before | the statement → `SELECT * FROM analytics.r184_no_such_table`; Save; reload | the step holds the new statement; the list `r184_badge · manual · 1 minute ago · succeeded` |
| After (hot deploy) | Workflows | `r184_badge · manual · 8 minutes ago · changed since this run · succeeded`; `R96 notebook step` and `Test` unmarked |
| After | Run now; reload | `r184_badge · … · failed`, unmarked |
| After | the step dragged up the canvas (y 60 → 25.7); Save; reload | "Saved"; the position kept; still unmarked |
| After | the statement back to `SELECT 184 AS r184`; Save; reload | `r184_badge · … · changed since this run · failed` |

## 2026-09-30 — An ETL pipeline's status chip over an edited definition, ADVERSARIAL_LOG R183

**Why this round exists.** Phase B's first item: sweep item 2's ETL chip.

Fixtures, kept: the pipeline `r183_chip` (the reconciliation sample, destination "MinIO local etl
demo", its "Reconciled" target now `orders_reconciled_r183`) and its two runs.

| Round | What was driven | What came back |
| --- | --- | --- |
| Smoke, R181 and R182 on the real image `8651672bd6c6` | Lakehouse → `analytics.stg_revenue` → Publish to Iceberg → `local_rest` / `r181` / `smoke_8651672b`, Refuse | `Published 836 row(s) to r181.smoke_8651672b`: the image's freshly fetched extension build publishes |
| Before (same image) | New pipeline `r183_chip` from the reconciliation sample; destination set; Save; Run now | "Saved"; "Run started"; the run `Succeeded`, `309 rows → 2 target(s)` |
| Before | Build → "Reconciled" → Table `orders_reconciled` → `orders_reconciled_r183` → Save; ETL Pipelines | "Saved"; the card `r183_chip · last run 9/30/2026, 7:00:02 PM · 100% · Succeeded` |
| After (hot deploy) | ETL Pipelines | `r183_chip · Succeeded · changed since this run`; also marked: `matrix_transforms`, `param_probe2`, `revenue_conform`, `kafka orders`, `sample_reconciliation`; unmarked: the other fifteen, `bi_seed` and the `*_live` pipelines among them |
| After | Run on the `r183_chip` card; the page reloaded once it finished | Recent runs `Succeeded · r183_chip · 24s · 309 rows`; the card `last run 9/30/2026, 7:16:21 PM · Succeeded`, no mark |

## 2026-09-30 — An Iceberg replace without a gap, ADVERSARIAL_LOG R182

**Why this round exists.** Phase A's fourth item: R107's replace was not atomic. Every window
below is read from the catalog's own log (`docker logs aswarm-iceberg-rest`), with no poller
running (R181: a poller starves the development catalog's writer).

Fixtures, kept: `r181.swap_target` in `local_rest`, now holding `analytics.r107_src2`'s two rows.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R181) | `analytics.stg_revenue` → Publish to Iceberg → `local_rest` / `r181` / `swap_target`, Replace it (drop, then create) | `Published 836 row(s)`; the catalog: dropped 13:54:39.456, created 13:54:40.375, filled 13:54:42.076: no table for 0.9 s, then an empty one for 1.7 s |
| After, rename swap only (hot deploy) | the same | `Published 836 row(s)` in 9 s (14 s before); renamed aside 14:17:19.107, staged table renamed in 14:17:20.571, old table dropped 14:17:22.485; never empty, missing for 1.5 s. Not good enough, hence the next row |
| After (hot deploy, final) | the same, the option now "Replace it (swap the new table in)" | `Published 836 row(s)`; the catalog: ONE commit, 14:26:00.608, no rename, no drop; the table's snapshots: 1 append (836), 2 delete (836 position deletes), 3 append (836), current 3 |
| After | `analytics.r107_src2` (`id`, `note`, 2 rows) → the same table, Replace | `Published 2 row(s)`; staged, then renamed aside 14:31:32.219 and in 14:31:32.613, old table dropped 14:31:33.048 |
| After | `analytics.r107_bad` (an INTERVAL column) → the same table, Replace | `Invalid Input Error: Column type INTERVAL is not a valid Iceberg Type.`; the catalog logged no commit, rename or drop; `swap_target` still `id`, `note`, 2 records |

## 2026-09-30 — Publish to Iceberg on a freshly built image, ADVERSARIAL_LOG R181

**Why this round exists.** Found preparing Phase A's fourth item: no publish worked.

Fixtures, kept: the Iceberg namespace `r181` in `local_rest`, with `swap_target` (836 rows), the
stray staging table `swap_target__publishing_fe36c8e4`, and the probe tables (`probe_b`, `nope`,
`local_c2_*`, `d_*`, `e_*`).

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (image `817a8048bbf0`) | Lakehouse → `analytics.stg_revenue` → Publish to Iceberg → `local_rest` / `r181` / `swap_target`, Refuse | `IO Error: Failed to create directory "data": Permission denied`; the catalog logged one 404 lookup |
| Before | the same → `local_rest` / `r107` / `r181_probe`, Refuse | the same error |
| After (hot deploy) | the same as the first row | `Published 836 row(s) to r181.swap_target`; the catalog: location `s3://iceberg/r181/swap_target`, six columns (`order_id` long … `placed_on` date), current snapshot an `append` of 836 records |
| After | the same, Replace it, with a poller loading the table from the host (30/s, then 4/s), three times | `TransactionContext Error: Failed to commit … HTTP 500 … /v1/transactions/commit`; the catalog's log: `[SQLITE_BUSY] The database file is locked` on the commit into the staging table; the old table stood each time. The fixture: its SQLite store starves a writer under a steady reader |
| After | the catalog restarted, Replace it with no poller | `Published 836 row(s) to r181.swap_target`; the catalog's log: staging created 13:54:36.732 and filled 13:54:38.574, `swap_target` dropped 13:54:39.456, created 13:54:40.375 and filled 13:54:42.076, staging dropped 13:54:44.446. For 0.9 s there was no table, then for 1.7 s an empty one (R182) |

## 2026-09-30 — A swarm chat turn bound to its conversation, ADVERSARIAL_LOG R180

**Why this round exists.** Phase A's third item: the aborted turn R109 left open.

Fixtures, kept: in "Embed E2E Mini Swarm" (`d51abd6f`), the conversations the before-round made
(A "R180 turn one", its two copies, and C, overwritten) and the after-round's.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R179) | Chat → "R180 turn one: name one planet in a single word." | a reply; one conversation, A |
| Before | In A, "R180 turn two: and one moon?", New chat 1 s later | two conversations titled "R180 turn one: …", the new one highlighted, over "Start the conversation below." and "Run failed: signal is aborted without reason" |
| Before | From that screen, "R180 in a new chat: name one star." | a reply; still two conversations, the copy retitled "R180 in a new chat: …"; A holds turn one and its reply only |
| Before | `/api/chat` made to ignore the abort signal in the browser; in A, "R180 turn three: and one comet?", then C ("R180 in a new chat") 1 s later | C opens with its two messages; 11 s later C's title reads "R180 turn one: …" and "Run failed: Run aborted" shows over C; C reopened holds A's turn one, A's reply and "R180 turn three" |
| Before | In A, "R180 turn four: and one asteroid?", the dialog closed 1 s later and reopened | a third "R180 turn one: …" conversation, highlighted, over an empty screen and "Run failed: signal is aborted without reason" |
| After (image `817a8048bbf0`, with R178 and R179) | New chat → "R180 after one: name one river in a single word." | a reply; a fourth conversation, A2, highlighted |
| After | In A2, "R180 after two: and one lake?", New chat 1 s later | still four conversations, none highlighted; "Start the conversation below." and no error |
| After | From that screen, "R180 after new: name one mountain in a single word." | a reply, and a new conversation B2: five in the list; A2 opened holds "after one", its reply and "R180 after two: and one lake?", the aborted turn kept for a retry |
| After | `/api/chat` made to ignore the abort signal; in A2, "R180 after three: and one sea?", then B2 1 s later | B2 opens with its two messages; 12 s later A2 has moved to the top of the list (saved), B2 is still highlighted with its own title, and no error shows; reopened, B2 holds its two messages and A2 ends with "R180 after three: and one sea?" |
| After | In A2, "R180 after four: and one ocean?", the dialog closed 1 s later and reopened | A2 highlighted, "R180 after four" and "Running Researcher…" with Stop; the reply lands in A2 12 s later; still five conversations |
| After | The conversation read made to fail in the browser; in A2, "R180 after five: and one bay?", then B2 1 s later | the toast "Could not open that conversation · R180 injected: the conversation read failed. You are still in the conversation you had open."; the turn goes on ("Running Researcher…", Stop) and its reply lands in A2; A2 reopened holds all five turns in order |
| Smoke, same image | SQL Models → Build all; Swarms → Recent runs | `partial`: `r178_after failed` with R178's refusal, the other four built; the header of R179 and a Cancel on each of the 34 parked rows |

## 2026-09-30 — A parked swarm run cancelled from Recent runs, ADVERSARIAL_LOG R179

**Why this round exists.** Phase A's second item: the cancel R108 left open.

Fixtures, kept: the cancelled run `c4ff22a3…`. The other parked runs of "Approval durability check
(schedule)" are untouched.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (hot deploy of R178) | Swarms → Recent runs; the bell | rows `Approval durability check (schedule) · Awaiting approval · started 12h ago` back to `4d ago`, each with Open, Trace, Review approval and no Cancel; the header "Cancel a running run here; a run waiting for an approval goes on or stops when the approval is decided."; `Pending approvals (35)` |
| After (hot deploy) | Swarms → Recent runs | every `Awaiting approval` row offers Cancel beside Review approval; the header "Cancel a running run here, or one parked at an approval: that also closes its approval request." |
| After | Cancel on the first row (`started 12h ago`, run `c4ff22a3`) | the toast "Run cancelled · Its approval request is closed; nobody will be asked to decide it."; the row `Cancelled · started 12h ago · 12h 19m` with Open and Trace only; the bell `Pending approvals (34)` |
| After | That row's Trace | Observability `Approval durability check (schedule) · cancelled · run c4ff22a3` |
| After | Audit log | `swarm_run.cancel · Approval durability check (schedule)`, 1 minute ago |
| After | The page's `swarm_runs` read made to fail in the browser (a 500 carrying a statement-timeout message), then the Recent runs tab | "The runs could not be loaded, so this list says nothing about them: canceling statement due to statement timeout (R179 probe)" with Try again; the fetch restored, Try again → the list, the cancelled row first |

## 2026-09-30 — A SQL model built over a table made after its save, ADVERSARIAL_LOG R178

**Why this round exists.** Phase A's first item: the case R103 left open.

Fixtures, kept: the models `r178_target` and `r178_after` in `analytics`, and their tables.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before (image of R177) | New model `r178_target` (Table, `SELECT 178 AS id`) → Create; Lakehouse `CREATE TABLE analytics.r178_target AS SELECT 'made after the model was saved' AS note`; Build this and what it reads; `SELECT *` | "Created r178_target"; `Count 1`; "Built 1 model"; `id 178`: the table was replaced |
| After (hot deploy, first version) | New model `r178_after` (Table, `SELECT 1782 AS id`) → Create; `CREATE TABLE analytics.r178_after AS SELECT 'made after the model was saved' AS note`; Build this and what it reads; `SELECT *` | "Created r178_after"; `Count 1`; run `error · r178_after failed · A table named analytics.r178_after is at this model's target, and this model did not build it: the build would replace it. Rename the model, or rename or drop that table.`; `note · made after the model was saved`, kept |
| After, first version | `r178_target` (built before marks) → Build this and what it reads; then Build all | `r178_target built 1 rows`; Build all `partial`: `stg_revenue failed` with the same refusal and `fct_region_revenue skipped`. A model's own table refused: its creation snapshot had been expired by maintenance. Fixed in the same round |
| After (hot deploy, corrected) | Build all | `partial`: `r103_keep built 1 rows`, `r178_after failed` (the refusal), `r178_target built 1 rows`, `stg_revenue built 836 rows`, `fct_region_revenue built 4 rows` |
| Catalog, read-only | `ducklake_tag` comments on the five targets | `agentswarms: built by SQL model <id>` on `stg_revenue`, `fct_region_revenue`, `r103_keep` (a view), `r178_target`; none on `r178_after` |

## 2026-09-30 — Loan functions, ADVERSARIAL_LOG R177

**Why this round exists.** Found by probing the financial functions against Microsoft's examples.

Fixtures, kept: **"R177 loans before"** (`69507927…`) and **"R177 loans after"** (`6dc1494b…`),
typed the same way: A1 `=CUMIPMT(0.09/12,360,125000,13,24,0)`, A2
`=CUMPRINC(0.09/12,360,125000,13,24,0)`, A3 `=MIRR({-120000,39000,30000,21000,37000,46000},0.1,0.12)`,
A4 `=PDURATION(0.025,2000,2200)`.

| Round | What was driven | What came back (A1 to A4) |
| --- | --- | --- |
| Before | The typing | #NAME? ×4 |
| After | The same | -11135.23213, -934.1071234, 0.1260941304, 3.859866163; the same after a reload |

## 2026-09-30 — FLOOR, GCD, LCM and hexadecimal, ADVERSARIAL_LOG R176

**Why this round exists.** Found by probing the math functions against Excel's rules.

Fixtures, kept: **"R176 math before"** (`23bc1dec…`) and **"R176 math after"** (`2deea7de…`), typed
the same way: A1 `=FLOOR(0.3,0.1)`, A2 `=FLOOR(4.35,0.05)`, A3 `=FLOOR(2.5,-2)`, A4
`=CEILING(2.5,-2)`, A5 `=GCD(12.5,5)`, A6 `=LCM(4.9,6.2)`, A7 `=DEC2HEX(255)`, A8 `=HEX2BIN("F")`.

| Round | What was driven | What came back (A1 to A8) |
| --- | --- | --- |
| Before | The typing | 0.2, 4.3, 4, 2, 2.5, 30.38, `ff`, #NAME? |
| After | The same | 0.3, 4.35, #NUM!, #NUM!, 1, 12, `FF`, `1111`; the same after a reload |

## 2026-09-30 — A number turned into text, ADVERSARIAL_LOG R175

**Why this round exists.** Found by probing the text functions: numbers became text at 10 digits.

Fixtures, kept: **"R175 text before"** (`4b92d7a1…`) and **"R175 text after"** (`4249ab74…`), typed
the same way: A1 `123456789012`, B1 `1234567.891234`, C1 `'123456789012`, D1 `found`; E1
`=A1&"-"&B1`, E2 `=LEN(A1)`, E3 `=VLOOKUP(A1&"",C1:D1,2,FALSE)`, E4 `=DOLLAR(-1234.567)`.

| Round | What was driven | What came back (E1 to E4) |
| --- | --- | --- |
| Before | The typing | `1.23457E+11-1234567.891`, 11, #N/A, `$(1,234.57)` |
| After | The same | `123456789012-1234567.891234`, 12, `found`, `($1,234.57)`; A1 itself still shows `1.23457E+11`; the same after a reload |

## 2026-09-30 — Working days backwards, and WEEKDAY and DAYS360, ADVERSARIAL_LOG R173 and R174

**Why this round exists.** Found by probing the date functions against answers worked out by hand.

Fixtures, kept: **"R173 dates before"** (`f4ed1db4…`) and **"R173 dates after"** (`011d3751…`),
typed the same way: A1 `2024-01-12`, B1 `2024-01-08`; C1 `=NETWORKDAYS(A1,B1)`, C2
`=NETWORKDAYS(B1,A1)`, C3 `=NETWORKDAYS(DATE(2024,12,31),DATE(2024,1,1))`, C4 `=WEEKDAY(B1,11)`,
C5 `=DAYS360(DATE(2011,1,1),DATE(2011,12,31))` (C4 and C5 are R174's).

| Round | What was driven | What came back (C1 to C5) |
| --- | --- | --- |
| Before | The typing | -3, 5, -364, #NUM!, #NAME? |
| After | The same | -5, 5, -262, 1, 360; the same after a reload |

## 2026-09-30 — Newer functions in a download, ADVERSARIAL_LOG R172

**Why this round exists.** Found by comparing the download's prefix list with XlsxWriter's.

Fixtures, kept: **"R172 prefixes before"** (`1394a952…`) and **"R172 prefixes after"**
(`1f797416…`), typed the same way: A1 `=NUMBERVALUE("1.234,5",",",".")`, A2 `=ISFORMULA(A1)`, A3
`=FORMULATEXT(A1)`. Then File → Download as Excel, and the file's sheet part read.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | The typing and the download | Sheets showed 1234.5, TRUE, the formula; the file held `NUMBERVALUE(…)`, `ISFORMULA(A1)`, `FORMULATEXT(A1)` without `_xlfn.` |
| After | The same | Sheets showed the same; the file held `_xlfn.NUMBERVALUE(…)`, `_xlfn.ISFORMULA(A1)`, `_xlfn.FORMULATEXT(A1)` |

## 2026-09-30 — The spill reference A1#, ADVERSARIAL_LOG R171

**Why this round exists.** Found by probing: `=SUM(A1#)` was #NAME?.

Fixtures, kept: **"R171 spill before"** (`94f7931b…`) and **"R171 spill after"** (`6201f519…`),
typed the same way: A1 `=SEQUENCE(3)`; C1 `=SUM(A1#)`, C2 `=ROWS(A1#)`, C3 `=XLOOKUP(2,A1#,E1#)`;
E1 `=A1#*10`. After: then A1 changed to `=SEQUENCE(5)`, and a reload.

| Round | What was driven | What came back (C1, C2, C3; E1) |
| --- | --- | --- |
| Before | The typing | #NAME? ×3, each "Unknown error value" on hover; E1 #NAME? |
| After | The typing, the change, a reload | C1 6, C2 3, C3 20; E1:E3 10, 20, 30. After A1 became `=SEQUENCE(5)`: C1 15, C2 5, E1:E5 10 to 50; the same after the reload. File → Download as Excel wrote `SUM(_xlfn.ANCHORARRAY(A1))` in C1 and `_xlfn.ANCHORARRAY(A1)*10` as a dynamic array formula over E1:E5 |

## 2026-09-30 — Statistics over a range with a blank, ADVERSARIAL_LOG R170

**Why this round exists.** Found by probing: formula.js counted a blank cell as 0.

Fixtures, kept: **"R170 stats before"** (`bdfa3109…`) and **"R170 stats after"** (`c7c8a7fd…`),
typed the same way: A1 `1`, A2 left blank, A3 `3`, A4 `x`; B1:B3 `2`, `4`, `6`; D1:D8
`=GEOMEAN(A1:A3)`, `=SMALL(A1:A3,2)`, `=PERCENTILE(A1:A3,0.5)`, `=NPV(0.1,A1:A3)`,
`=CORREL(A1:A3,B1:B3)`, `=SLOPE(B1:B3,A1:A3)`, `=SUMSQ(A1:A4)`, `=RANK(4,A1:A3)`; F1
`=VSTACK("Name",A1:A3)`.

| Round | What was driven | What came back (D1 to D8; F1) |
| --- | --- | --- |
| Before | The typing | 0, 1, 1, 3.163035312, 0.6546536707, 0.8571428571, #VALUE!, 0; F1 #VALUE! |
| After | The same | 1.732050808, 3, 2, 3.388429752, 1, 2, 10, #N/A; F1:F4 Name, 1, 0, 3; the same after a reload |

## 2026-09-30 — Inserted rows take their neighbours' formats, ADVERSARIAL_LOG R169

**Why this round exists.** Open in the queue since R117: an inserted row arrived plain.

Fixtures, kept: **"R169 insert before"** (`ad2aecff…`) and **"R169 insert after"** (`fa832199…`),
each imported from `openpyxl-insert.xlsx` through the gallery's Import: A1:B1 `Item`/`Price` bold
on blue; A2 `Pens`, B2 `$10.00` with a thin bottom border; A3 `Ink`, B3 `$4.00`. Then row 2's
header menu → Insert 1 row below, and `12.5` typed in the new B3; then B2's menu → Insert cells… →
Shift cells down.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | The row, the typing, Insert cells | The new B3 plain: `12.5` in General with no border, between $10.00 and $4.00. After Insert cells, the new B2 plain under the bold blue B1 |
| After | The same, then a reload | The new B3 `$12.50` (Currency) with B2's bottom border. After Insert cells, the new B2 blue like B1, A2 `Pens` beside it still plain, and $10.00, $12.50, $4.00 moved down; the same after the reload |

## 2026-09-30 — A formula's format from what it reads, ADVERSARIAL_LOG R168

**Why this round exists.** Filed in R166: `=B1+1` over a date showed a serial number.

Fixtures, kept: **"R168 formats before"** (`9e65edad…`) and **"R168 formats after"**
(`1c964600…`), typed the same way: A1 `2023-03-15`, A2 `=A1+30`, A3 `=A2-A1`, A4 `=A1`; B1 `$1,200`,
B2 `$300.50`, B3 `=SUM(B1:B2)`, B4 `=B1*2`.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | The typing | A2 45030, A3 30, A4 45000; B3 1500.5, B4 2400 |
| After | The same, then a reload | A2 2023-04-14, A3 30, A4 2023-03-15; B3 $1,501 (B1's whole-dollar format, as Excel takes the first cell's), B4 2400; the same after the reload |

## 2026-09-29 — One order for text, ADVERSARIAL_LOG R167

**Why this round exists.** Keep hunting: the ribbon's sort and the engine's lookups compared text
differently.

Fixtures, kept: **"R167 sort before"** (`0ad9fb8d…`) and **"R167 sort after"** (`3b5a0248…`), typed
the same way: A1:B6 A10 10, A2 2, A1 1, B1 100, A20 20, A3 3; D1 `=VLOOKUP("A10",A1:B6,2,TRUE)`, D2
`=VLOOKUP("A3",A1:B6,2,TRUE)`, D3 `=MATCH("A20",A1:A6,1)`; F1 `=SORT(A1:A6)`. Then A1:B6 selected
and Data → Sort A to Z. The R166 image's smoke test also left E1:E2 (4:45 PM, 16.75) in "R166 typed
after".

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | Sort A to Z | "Sorted A1:B6 by column A"; A1, A2, A3, A10, A20, B1; F: A1, A10, A2, A20, A3, B1; D1 1, D2 20, D3 2 |
| After | The same | A1, A10, A2, A20, A3, B1, the same as F; D1 10, D2 3, D3 4 |

## 2026-09-29 — Typed times and month-name dates, ADVERSARIAL_LOG R166

**Why this round exists.** R165's queue: dates typed in other forms stay text. A probe of 17 typed
entries found every time and every month-name date read as text.

Fixtures, kept: **"R166 typed before"** (`1de40bc3…`) and **"R166 typed after"** (`6764b672…`),
typed the same way: A1:A3 `12:30`, `9:00 AM`, `25:00`, A4 `=SUM(A1:A3)` (before) or
`=SUM(A1:A3)*24` (after); B1:B2 `15-Mar-2023`, `Mar 15, 2023`, B3 `=B1+1`, B4 `=B2-B1`; C1
`2023-03-15 9:00 AM`, C2 `=ISNUMBER(C1)`. In the second, D1 `9:00` filled down to D3. The R165
image's smoke test also left H1:H3 Nov, Dec, Jan in "R165 fill after".

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | The typing | A1:A3 left-aligned text; A4 0; B1:B2 text; B3 and B4 `#VALUE!`; C1 text; C2 FALSE |
| After | The same | A1:A3 12:30, 9:00 AM, 25:00, right-aligned; A4 46.5 (hours); B1:B2 15-Mar-23; B3 45001; B4 0; C1 a date-time (`####` in the narrow column); C2 TRUE |
| Fill | D1 `9:00`, the handle dragged to D3 | 9:00, 10:00, 11:00 |

B3 shows 45001, not 16-Mar-23: a formula does not take the date format of the cell it adds to, as
Excel's does. That is older than this round, and filed.

## 2026-09-29 — The fill handle's series, ADVERSARIAL_LOG R165

**Why this round exists.** Keep hunting: a probe of the fill handle's series against Excel's
AutoFill found five that differ.

Fixtures, kept: **"R165 fill before"** (`1c043af2…`) and **"R165 fill after"** (`2d14bc2b…`), each
typed the same way: A1 2023-03-15, B1 Jan, C1 Monday, D1 Q3, E1:E2 2023-01-15 and 2023-02-15, F1
2023-01-30. Then A1:D1, E1:E2 and F1 each filled down to row 5 by dragging the fill handle.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | The fills | A 2023-03-16 to 03-19; B Jan ×5; C Monday ×5; D Q3, Q4, Q5, Q6, Q7; E 01-15, 02-15, 01-15, 02-15, 01-15; F 2023-01-31, then "2023-01-32", "2023-01-33", "2023-01-34" as text |
| After | The same | A 2023-03-16 to 03-19; B Jan, Feb, Mar, Apr, May; C Monday to Friday; D Q3, Q4, Q1, Q2, Q3; E 01-15, 02-15, 03-15, 04-15, 05-15; F 2023-01-31, 02-01, 02-02, 02-03, each a date |
| Undo | Ctrl+Z, then Ctrl+Y, after F's fill | F2:F5 empty, then back; the focus on F1 |
| A day past the month's end | G1 `2023-02-31`, G2 `=ISTEXT(G1)` | G1 stays 2023-02-31 as text; G2 TRUE |

## 2026-09-29 — A file's text stays text, ADVERSARIAL_LOG R164

**Why this round exists.** Found in passing in R163: a text "£1,234.50" imported as a number.

Fixtures, kept: **"R164 text before"** (`77392ee1…`, from the fixture's first version, without
`=1+1`, E1 and F1) and **"R164 text after"** (`d4365bdd…`, from the final one). A2 was opened with
F2 and committed unchanged.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before: import | Import the fixture | A1:A5 1234.5, 99, 500, 100000, 2000 (numbers); A6 "quoted"; B1:B5 FALSE; C1 COUNT 5, C2 COUNTA 8; D1 SUM `######` (over 100,000) |
| After: import | The final fixture | A1:A9 £1,234.50, €99, ¥500, 1e5, 2E3, 'quoted, $1,200, 007, =1+1; B1:B9 TRUE; C1 0, C2 9, D1 0; E1 1234.5 and E2 TRUE; F1 Hello |
| The formula bar | A1 | `'£1,234.50` |
| Editing | A2, F2, Enter | The editor held `'€99`; A2 still €99 and text, COUNT still 0 |

## 2026-09-29 — Number formats, ADVERSARIAL_LOG R163

**Why this round exists.** Keep hunting: a probe of 54 Excel formats against Excel's documented
output found 9 that differ; two of those were my own expectations (Excel does show `-0.00`).

Fixtures, kept: **"R163 formats before"** (`09ab9548…`) and **"R163 formats after"**
(`667b6910…`), both from `openpyxl-formats.xlsx`, with column A widened to 16 by Column width… In
the second, D2 `=TEXT(A2,"[h]:mm")&" / "&TEXT(45000,"DD/MM/YYYY")` and A20 1.25 as `[h]:mm` were
kept.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before: import | Import the fixture; Column width… 16 on A | A2:A6 `:12`, `:00:00`, `:00`, blank, `hours`; A7:A9 1,234.50, 1,234.50, -1,234.50 (red); A10:A12 2, 1, 3/8; A13 small (Excel: big); A16 high (Excel: mid) |
| After: import | The same | A2:A16 each the same as column C: 36:00, 36:00:00, 90:00, 5400, 66 hours, € 1,234.50, £1,234.50, -$1,234.50 (red), 1 1/2, 3/4, 2 5/8, big, small, high, mid |
| TEXT() | D2, `=TEXT(A2,"[h]:mm")&" / "&TEXT(45000,"DD/MM/YYYY")` | 36:00 / 15/03/2023 |
| Custom… | A20 1.25; Number format → Custom… → `[h]:mm`, Enter | A20 30:00; the dialog closed, the focus on A20 |
| Before: spacing (probe) | `formatValue` on the committed code: `#,##0_);(#,##0)` and Excel's Accounting format on 1234.5 | `1,235_)` and `_($* 1,234.50_)` |
| After: Accounting | A21 1234.5, A22 -1234.5; Custom… → `_("$"* #,##0.00_);_("$"* \(#,##0.00\);_("$"* "-"??_);_(@_)` on A21:A22 | A21 ` $1,234.50 `, A22 ` $(1,234.50)` (the $ beside the number: the fill is left out) |

Found in passing, and filed as the next round: C8 holds the text "£1,234.50" in the file and came
in as the number 1234.5 (the status bar's Count and Sum take it).

## 2026-09-29 — Formulas from older Excel, ADVERSARIAL_LOG R162

**Why this round exists.** R161 left it open: a file of older formulas read the dynamic way.

Fixtures, kept: **"R162 legacy before"** (`7c392823…`) and **"R162 legacy after"** (`832a51a4…`),
both from `openpyxl-legacy.xlsx`: Orders A1:C4 (Pen 2 5, Ink 10 1, Pad 4 3), names Price and Qty
over columns B and C. In the second, N3 `=@A2:A4` was typed and kept.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before: import | Import Excel or CSV, the fixture; Create workbook | "Orders 25 cells", "2 named ranges (Price, Qty)" |
| Before: the grid | Read | D2 and D3 `#SPILL!`, D4 `#VALUE!` and 10, 10, 12, 0 spilled into D5:D8; E the same, down to E11; F2:F4 Pen, Ink, Pad; G5:G7 Pen, Ink, Pad; H2 9; I2 6, J2 4, K2 16, L2 9 |
| After: import | The same file, with M2 `=_xlfn.SINGLE(A2:A4)&"!"` added | "Orders 26 cells" |
| After: the grid | Read | D2:D4 10, 10, 12; E2:E4 10, 10, 12; F2 Pen, F3 and F4 empty; G5 `#VALUE!`; H2 3; I2 6, J2 4, K2 16, L2 9; M2 Pen!; nothing below row 5 but G5 |
| The formulas | D2, E3, H2, I2, M2 in the formula bar | `=@Price*@Qty`, `=@B:B*@C:C`, `=SUM(LEN(@A2:A4))`, `=SUMPRODUCT((C2:C4>1)*B2:B4)`, `=@(A2:A4)&"!"` |
| Typing @ | N3, `=@A2:A4` | Ink |
| Download | Download as Excel (.xlsx), the file's XML read | D2 `Price*Qty`, E2 `B:B*C:C`, F2 and N3 `A2:A4`, H2 `SUM(LEN(A2:A4))`, M2 `(A2:A4)&"!"`, all plain; no `@` anywhere; I2, J2 and L2 dynamic array formulas; the names as they came |

## 2026-09-29 — Dynamic array formulas in downloads, ADVERSARIAL_LOG R161

**Why this round exists.** Keep hunting: whether a download computes in Excel as it does in
Sheets. No Excel or LibreOffice is on this machine, so each file was read part by part and
compared with the parts XlsxWriter writes for Excel's own dynamic array formulas.

Fixtures, kept: **"R161 array formulas"** (`8f477b6b…`) and **"R161 round trip"** (`cee50ecd…`),
imported from the second download. The downloads of "R160 duplicate rich" were read, and it was
not changed.

| Round | What was driven | What came back |
| --- | --- | --- |
| The workbook | New workbook; A1:A3 one, three, eleven; B5 `=SUM(LEN(A1:A3))`; D1 `=FILTER(A1:A3,LEN(A1:A3)>3)`; E1 `=LEN(A1)` | B5 14; D1:D2 three, eleven; E1 3 |
| Before: download | Download as Excel (.xlsx), the file's XML read | B5 `<f>SUM(LEN(A1:A3))</f>`, plain; D1 `<f t="array" ref="D1:D2">`, no `cm`; no `xl/metadata.xml`; `fullCalcOnLoad="1"`. Excel would compute B5 as `=SUM(LEN(@A1:A3))`, which is `#VALUE!` in row 5 |
| After: download | The same | B5 `cm="1"` with `<f t="array" ref="B5">`; D1 `cm="1"` with `ref="D1:D2"`; E1 still `<f>LEN(A1)</f>`; `xl/metadata.xml`, its content type and its relationship, the part identical to XlsxWriter's. openpyxl reads B5 and D1 as array formulas |
| Round trip | Import the downloaded file | "Sheet1 6 cells"; B5 `=SUM(LEN(A1:A3))` 14; D1:D2 three, eleven; E1 3 |
| The sample | Download as Excel, "R160 duplicate rich" | Dashboard and Dashboard (2): J9 and K9 (SORTBY) and J18 (FILTER) marked; the other 2,588 formulas plain, none of them an array formula |

## 2026-09-29 — Hidden sheets, ADVERSARIAL_LOG R160

**Why this round exists.** Keep hunting: Excel's hidden sheets, and the sheet tab's missing
Hide, Unhide and Duplicate.

Fixtures, kept: **"R160 hidden before"** (`b23aecb1…`, imported on the build before the fix) and
**"R160 hidden sheets"** (`64a1ffb6…`), both from `openpyxl-hidden.xlsx`. In the second, Rates!B2
was changed from 0.9 to 1.1, and **Summary (2)** was added by Duplicate; both were left for review,
with Rates and Keys hidden. **"R160 first hidden"** (`e0cc408f…`): a two-sheet file whose first
sheet is hidden. **"R160 duplicate rich"** (`cfae37c9…`): the Sales performance sample, with
Dashboard (2) and Orders (2) added by Duplicate.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before: import | Import Excel or CSV, the fixture | Summary 15 cells; Rates "(hidden in Excel)" 4 cells; no Keys |
| Before: the workbook | Create workbook | Tabs Summary and Rates; B2 900, B6 3510, B7 `#REF!` ("No sheet "Keys"") |
| Before: the tab menu | Rates' tab arrow | Rename, Move left, Move right, Delete |
| Before: download | Download as Excel (.xlsx), read with openpyxl | Summary and Rates both visible; no Keys; B7 still `=Keys!A1` |
| After: import | The same file | Summary 15 cells; Rates and Keys each "(hidden, as in Excel)" |
| After: the workbook | Create workbook | One tab, Summary; B2 900, B6 3510, B7 K-2026 |
| The tab menu | Summary's tab arrow | Rename, Duplicate, Move left, Move right, Hide, Unhide, Delete |
| The last sheet showing | Hide, on Summary | "A workbook keeps at least one sheet showing"; Summary still the only tab |
| Unhide | Unhide ▸ (Rates, Keys) → Rates | Tabs Summary and Rates; Rates in view, A1 "Currency", B2 0.9 |
| Formulas across | Rates!B2 set to 1.1; Hide, on Rates | "Hid Rates. Unhide on any sheet's menu shows it again."; Summary in view; B2:B4 1100, 2750, 440; B6 4290 |
| Duplicate | Duplicate, on Summary | "Added Summary (2), a copy of Summary"; its tab: B2 1100, B6 4290, B7 K-2026 |
| Find | Within: Workbook, "Currency" (only on hidden Rates) | "Nothing matches "Currency" in the workbook" |
| Find All | "K-2026" (on Summary, its copy, and hidden Keys) | "2 cells found": Summary B7, Summary (2) B7; not Keys |
| Download | Download as Excel (.xlsx), read with openpyxl | Summary visible, Rates hidden, Keys hidden, Summary (2) visible; `activeTab="0"`; B6 `=SUM(B2:B4)` cached 4290; Rates!B2 1.1 |
| Found: the keyboard | Hide, on Summary (2) (first build) | The focus on the page, not the grid |
| Delete, one sheet showing | Delete, on Summary (Summary (2) hidden) | "Unhide another sheet first: a workbook keeps at least one sheet showing"; nothing asked, nothing deleted |
| Undo of Hide | Find closed (the focus back on A1), then Ctrl+Z | Summary (2) back |
| Found: undo of Unhide | Unhide ▸ Rates, then Ctrl+Z (first build) | Rates hidden again but still on screen: its cells, no tab lit |
| After both fixes: Hide | Reload; Summary (2) in view; Hide | Summary in view, the focus on its A1; Ctrl+Z at once: Summary (2) back and in view |
| Saved | The reload | Rates and Keys still hidden; Rates!B2 still 1.1 |
| After both fixes: Unhide | Unhide ▸ Rates, then Ctrl+Z, Ctrl+Y, Ctrl+Z | In view in turn: Rates (focus on A1), Summary (2) (the next showing), Rates, Summary (2) |
| Redo of Hide | Hide Summary (2), then Ctrl+Z, Ctrl+Y, Ctrl+Z | In view: Summary, Summary (2), Summary, Summary (2); the focus on the grid throughout |
| First sheet hidden | Import a file: Lookup (hidden) B1 2; Report A1 `=Lookup!B1*10` | "Lookup (hidden, as in Excel) 2 cells"; opens on Report, its only tab, A1 20; the same after a reload |
| Duplicate, charts | The Sales performance sample; Duplicate, on Dashboard | "Added Dashboard (2), a copy of Dashboard"; it opens, the focus on A1; its three charts ("Revenue by month and region", "Monthly revenue, stacked", "Revenue by category"), its colour scale and its figures ($448,677 revenue) |
| Duplicate, rules | Duplicate, on Orders | Orders (2): the header row frozen, 12 filter buttons, the returned order struck through, Revenue's data bars; C2, Alt+Down lists North, South, East, West |

An earlier click of mine landed on the status bar's Zoom out, leaving Summary at 90% in this
browser; the zoom is a per-browser setting and was put back.

## 2026-09-29 — Paste special, ADVERSARIAL_LOG R159

**Why this round exists.** Keep hunting: Excel's Paste Special was missing.

Fixtures: **"R153 contacts"** (`0ceb0280…`). Every change was undone.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | B2, Ctrl+Alt+V; then B2's menu | Nothing opened; the menu: Cut, Copy, Paste, Paste values only, Paste formatting only |
| The dialog | A1:E1 copied (the menu's Copy); K1, Ctrl+Alt+V | "Paste part of A1:E1 at K1. One Ctrl+Z takes it back."; All and None chosen; the Paste button focused |
| Transpose | Transpose, Paste | K1:K5 Name, Email, City, Signed up, Chars; K1:K5 selected |
| Found: the keyboard | Ctrl+Z at once (first build) | Nothing: the focus was on the page, not the grid; K1:K5 cleared by hand |
| After the fix | The same again | The focus back on K1; Ctrl+Z empties K1:K5 |
| Operation | E2:E8 (=LEN) copied; E2, Values + Add | "Each copied number is combined…"; E2:E8 32, 30, 32, 32, 30, 30, 30; E2 `=(LEN(B2))+16`; Ctrl+Z: `=LEN(B2)`, 16 |
| Skip blanks | F2:G3 copied (F empty); A2, Skip blanks | A2 and A3 kept Asha Rao and Ben Ode; B2 g2, B3 g3; undone |
| After a cut | G2 cut; Ctrl+Alt+V | "Paste special works on copied cells; copy them instead of cutting"; no dialog; G2 still g2 (a copy then cleared the cut) |
| Notes, for the same fault | K2, Shift+F2, "focus check", Ctrl+Enter | The focus back on K2 (the note dialog was not affected); undone |

## 2026-09-29 — A model picker in Ask AI, ADVERSARIAL_LOG R158

**Why this round exists.** The user asked where Ask AI's model is set, then asked for a picker.

Fixtures: **"R154 query sheets"** (`6b6a8810…`). Three questions and one Fill with AI trial, nothing
written; the pick was left on the default.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before: the panel | Ask AI | "Assistant · reads this workbook as you see it"; no model control |
| Before: an answer | "What is the value of D1 on Sheet1?" | "The value of D1 on Sheet1 is EMEA." and "Cost $0.0007", no model named; the Audit Log: `openrouter/google/gemini-3-flash-preview` |
| After: the panel | Ask AI | A Model row: OpenRouter · "Default · openrouter/google/gemini-3-flash-preview" |
| The list | Open it | OpenRouter's live catalogue (441 models), "Default · … the assistant's model, set by an admin" first |
| A pick | Search `gemini-2.5-flash`, pick google/gemini-2.5-flash | "Google: Gemini 2.5 Flash"; kept in the browser as `openrouter::google/gemini-2.5-flash` |
| Asked on it | "What is the value of E1 on Sheet1?" | "The value of E1 on Sheet1 is 15524.94." and "openrouter/google/gemini-2.5-flash · Cost $0.0010" |
| Reload | The page again, Ask AI | Still "Google: Gemini 2.5 Flash" |
| Fill with AI | A1:A2, Fill with AI…, "the first letter", Try on 2 rows | "Model: openrouter/google/gemini-2.5-flash — change it in Ask AI."; T, E; cancelled |
| The Audit Log | After both | Model calls on `openrouter/google/gemini-2.5-flash`: "Sheets fill with AI" and "Sheets assistant" ×2 |
| A pick that is no model | `nosuch::model-x` put in the browser's store, reload, a question (first build) | The server: ""nosuch/model-x" is not a model the assistant can use; pick another, or the default." |
| Found, then fixed | The same on the first build | The picker showed "OpenRouter · model-x" for it. Now, on load: "The assistant's model you picked (nosuch/model-x) is not available to you now; it uses the default.", and the pick is cleared |
| The default | "What is B1 on Sheet1?" | "…41,399.86." and "openrouter/google/gemini-3-flash-preview · Cost $0.0016" |

My click on the question box once landed on the "Chart this" chip, which put "Chart" before the
question; the answer was still right. A model refused by an IAM rule was not driven: making a rule
changes the instance's access settings. The picker leaves such models out, and the channel refuses
them (source and the channel's own tests).

## 2026-09-29 — Text to columns, ADVERSARIAL_LOG R157

**Why this round exists.** The queue's Text to Columns, the last common Data tool missing.

Fixtures: **"R153 contacts"** (`0ceb0280…`). Every change was undone.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | The Data tab (the R156 round) | Sort A to Z, Sort Z to A, Sort…, Filter, Remove duplicates…, Data validation…, Names, Save to lakehouse |
| After: the tab | The Data tab | … Remove duplicates…, **Text to columns…**, Data validation… |
| Two columns | A2:B8, Text to columns… | "Select cells in one column to split them."; no dialog |
| The dialog | A2:A8, Text to columns… | "Split each cell of A2:A8…"; Tab ticked; destination A2; preview "Asha Rao…"; "1 column in the first 5 rows." |
| Space | Tick Space | Preview "Asha / Rao", "Ben / Ode"…; "2 columns in the first 5 rows." |
| Over data | Split (destination A2) | "Replace what is there? A2:B8 already holds data…"; Cancel: nothing changed, the focus on A2 |
| Elsewhere | Destination H2, Split | No question; H2:I8 Asha/Rao … Dev/Iyer; "Split A2:A8 into 2 columns from H2"; G unmoved; Ctrl+Z empties H:I |
| Over data, replaced | Destination A2, Split, Replace | A2 Asha, B2 Rao …; C (City) untouched; "Split A2:A8 into 2 columns from A2" |
| Undo | Ctrl+Z | The names and emails back as they were, Cleo's note in place |

## 2026-09-29 — Sort by several columns, ADVERSARIAL_LOG R156

**Why this round exists.** The queue's Custom Sort, and what a sort does to a merged cell.

Fixtures: **"R153 contacts"** (`0ceb0280…`). Every change was undone.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before: the tab | The Data tab | Sort A to Z, Sort Z to A, Filter, Remove duplicates…, …; no Sort… |
| Before: a merge | C2:C3 merged (Merge Cells, Merge), A2, Data → Sort Z to A | "Sorted A1:E8 by column A, largest first"; the merge stayed at C2:C3 over the two Dev Iyer rows, the second's Braga hidden; undone twice |
| After: the tab | The Data tab | …, Sort Z to A, **Sort…**, Filter, … |
| The dialog | A2, Sort… | "Sort A1:E8 by the first column, then…"; headers ticked; one level, Name A to Z (the active column); the Sort button focused |
| Levels | Level 1 City; Add level | "City / A to Z", "Name / A to Z" (the next unused column) |
| A column twice | Level 2 City | "City is sorted by more than once…"; Sort disabled |
| Sorted | Level 2 Name, Z to A; Sort | "Sorted A1:E8 by City, then Name (Z to A)": Braga/Dev ×2, Faro/Cleo (her note on C4), Lisbon/Asha ×2, Porto/Ben ×2; G2…G8 unmoved; the focus back on A2 |
| Undo | Ctrl+Z | The rows in their first order |
| A merge again | C2:C3 merged; A2, Sort Z to A; then Sort… | "A1:E8 has merged cells. Unmerge them to sort it." both times; nothing moved, no dialog; the merge undone |

## 2026-09-29 — Query variables, ADVERSARIAL_LOG R155

**Why this round exists.** Row Zero's connected tables take variables; a query sheet could not.

Fixtures: **"R154 query sheets"** (`6b6a8810…`). Sheet1 D1 is named **Region** and holds EMEA. The
query sheet **ByMonth** reads `WHERE region = {{Region}}`, and Sheet1 E1 is `=SUM(ByMonth[revenue])`.
All three are left in place.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | Revenue → Edit query, `… WHERE region = {{Region}}`, Ctrl+Enter (R154 build) | `SQL parse error: syntax error at or near "{"` |
| A name | D1 `EMEA`, then `Region` typed in the Name box | "D1 is named Region" |
| Preview | Lakehouse query, `SELECT month, revenue … WHERE region = {{Region}} ORDER BY month` | "Variables: Region = "EMEA""; "2 columns · 36 rows"; 2023-01 300 (EMEA) |
| Added | Named ByMonth, Add query sheet | 36 rows, EMEA's |
| A formula over it | Sheet1 E1 `=SUM(ByMonth[revenue])` | 15524.94 |
| The value changes | D1 `APAC` | E1 10349.98; ByMonth 2023-01 200 (APAC's); B1 (over the query with no variables) still 41399.86 |
| A value written to escape | D1 `APAC' OR '1'='1` | E1 0: the whole text is one value, and no region is called that |
| Back | D1 `EMEA` | E1 15524.94 |
| An undefined name | ByMonth → Edit query, `{{Nope}}`, Ctrl+Enter; then Esc | "Variables: Nope = no such name"; "{{Nope}} has no value: name a cell Nope (Data → Names) and put the value there"; not saved |
| Reload | The page again | D1 EMEA, E1 15524.94, B1 41399.86, B2 15524.94 |

## 2026-09-29 — Query sheets, ADVERSARIAL_LOG R154

**Why this round exists.** The user asked whether Sheets can query data sources and the
lakehouse straight into a sheet, as Row Zero does.

Fixtures: **"R154 query sheets"** (`6b6a8810…`), with a grid Sheet1 (a total and a lookup over
the query) and the query sheet **Revenue** over `analytics.bi_demo_sales`, left in place.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before: Lakehouse | + → Table sheet…, the Lakehouse tab | 54 tables to open; no query |
| Before: Connection | The Connection tab | "No database connections yet"; the lakehouse connection is hidden there |
| After: the tab | + → Table sheet… | Lakehouse, Lakehouse query, Data catalog, Connection, Upload CSV |
| A table into the query | Click `analytics.bi_demo_sales` | `SELECT * FROM analytics.bi_demo_sales`; the name "Query" suggested |
| Preview | Preview | "7 columns · the first 50 rows · 2035 ms", month…margin_pct |
| A write | `DELETE FROM analytics.bi_demo_sales`, Ctrl+Enter | "Only read-only queries (SELECT / WITH) are allowed" |
| A file function | `SELECT * FROM read_csv('/etc/passwd')` | "read_csv() is not available here — query lakehouse tables, or use a lake view for raw files" |
| The query | Revenue by region, Ctrl+Enter | "3 columns · 3 rows": AMER 25874.92, APAC 10349.98, EMEA 15524.94 |
| Added | Named Revenue, the footer button | The sheet: "Lakehouse query · Edit query · 3 rows", the three regions |
| Grid formulas | Sheet1: `=SUM(Revenue[revenue])`, `=XLOOKUP(A2,Revenue[region],Revenue[revenue])` | 51749.84; EMEA 15524.94 |
| Edit query | `WHERE region <> 'APAC'`, Save query | 2 rows (AMER, EMEA); Sheet1's total 41399.86 |
| Tampered read | A page read rewritten in the browser to `region <> 'NONE'` (1 request) | Still AMER and EMEA: the saved query ran |
| Reload | The page again | Revenue as saved, 2 rows |
| Audit | Audit Log | `sheets.query.create` and `sheets.query.update` with the SQL; each read a `lakehouse.select` |

Along the way the footer button said "Open table" for a query; it now says "Add query sheet". While
capturing a request's shape, the page's session token appeared in the tool's output; it was not
kept or repeated, and the capture was changed to count rewrites only. A viewer was not driven (no
second account); the viewer's copy and a share's row filter over a query are tested on DuckDB.

## 2026-09-29 — Remove duplicates, ADVERSARIAL_LOG R153

**Why this round exists.** Keep hunting: the Data tab had no way to drop repeated rows.

Fixtures: **"R153 contacts"** (`0ceb0280…`), from `openpyxl-dupes.xlsx`. Every change was undone.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | The Data tab | Sort A to Z, Sort Z to A, Filter, Data validation…, Names, Save to lakehouse; no Remove duplicates |
| After: import | `openpyxl-dupes.xlsx` | "Contacts 48 cells · 1 note"; A1:E8 a list, G a column outside it |
| The dialog | B3, Data → Remove duplicates… | "In A1:E8…"; Name, Email, City, Signed up, Chars, all checked; headers ticked; the button focused |
| Headers | Untick, tick | Column A…Column E, then the header names |
| Nothing checked | Unselect all | Remove duplicates disabled; Select all enables it |
| Every column | Remove duplicates | "Removed 2 rows repeating an earlier one; 5 rows remain in A1:E8." The capitals row and Ben's second row gone; Dev's second row (8 Mar 2026) kept |
| What moved | After it | Cleo up to row 4, her note with her (C4); E4 `=LEN(B4)`; G2…G8 unmoved; rows 7 and 8 empty in A:E |
| Undo | Ctrl+Z | All 7 rows back, in their order |
| One column | Email only | "Removed 3 rows repeating an earlier one; 4 rows remain in A1:E8." |
| Nothing to remove | The same again | "No duplicate rows in A1:E5."; undone |
| Merged cells | F2:F3 merged; A1:F8, Remove duplicates… | "A1:F8 has merged cells. Unmerge them to remove duplicates." No dialog; the merge undone |
| Found: the keyboard | K20, Data tab, Sort A to Z | The focus left on the Data tab (`BUTTON:tab`); R152's first Ctrl+Z after a sort did nothing |
| After the fix | A3, Data tab, Sort Z to A, Ctrl+Z | The focus stays on A3; sorted Dev first; Ctrl+Z puts Asha back first |

## 2026-09-29 — Cell notes, ADVERSARIAL_LOG R152

**Why this round exists.** Keep hunting: a report made in Python, with comments in it, would not
import.

Fixtures:
- **"R152 notes"** (`ad80b9cb…`), from `openpyxl-notes.xlsx`. Every change was undone, except
  the Budget rows: they are left sorted A to Z (Rent, Software, Travel).
- **"R152 roundtrip"** (`606b6ada…`), from that workbook's own download.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | Sheets → Import, `Budget with notes.xlsx` (openpyxl) | "Could not read Budget with notes.xlsx: Cannot read properties of undefined (reading 'comments')"; no workbook |
| After: import | The same file | Budget 9 cells, Notes 2 1 cell; created |
| The notes | Budget | Red corners on D2 (an empty cell), B3, A4 and B5; B3 on hover: "Asha:", then "Two trips to the Lisbon office." |
| The active cell | B3 | The note card beside it |
| Shift+F2 | C2; typed; Ctrl+Enter | "New note on C2"; saved, the corner on C2; undone |
| The cell's menu | B3 | "Edit note…" and "Delete note" |
| Sort | A2:B4, A to Z | Software and its note to A3; 450 and its note to B4 |
| Copy and paste | B4 → Copy on its menu; F4, then a paste event carrying the copied text | F4 450 with B4's note; undone |
| Find, Values | `Lisbon` | "Nothing matches "Lisbon" in this sheet" |
| Find, Notes | `Lisbon` | "1 cell found": B4, and the note under a Note column |
| Find in the workbook | `Asha`, Notes | "3 cells found": Budget B4 and B5, Notes 2 A1 |
| Replace | The Replace tab | Look in fixed to Formulas, as Excel's |
| Reload | The page again | Every note still there; D2 on hover: "Ben:", then "Ask finance about Q4." |
| Download | File → Download as Excel; openpyxl | Comments on D2, A3, B4, B5 and Notes 2 A1, each opening with its author ("Asha:", "Ben:"); `xl/comments1.xml`, `xl/comments2.xml` and their VML drawings |
| Round trip | That download imported as "R152 roundtrip" | The four Budget notes as they were; no "Author:" added, no author twice |
| Import count | That file in the Import dialog again, cancelled | "Budget 9 cells · 4 notes", "Notes 2 1 cell · 1 note" |
| Found: Clear all | B4, Home → Clear → Clear all (first build) | B4 emptied; the note, its corner and its card stayed |
| Clear contents | B4 | 450 gone; the note kept, as Excel's; undone |
| Clear all | B4 | The cell gone, with its note and card; B5 1500; undone |
| Clear notes | A3 | Software kept, the note gone; undone |
| Delete note | D2 (only a note), its menu | The cell gone; undone |

Paste on the cell's menu reads the clipboard, which the test browser refuses, so the paste went in
as the event Ctrl+V sends. The pane's window was covered for part of the round; its menus' closing
animations waited, and were finished from the page before the next click. Its viewport also went
briefly phone-sized, and the "Best on a larger screen" notice opened; it was closed. A viewer was
not driven: a read-only workbook opens no cell menu, and Shift+F2 checks it (source).

## 2026-09-29 — Freeze panes, ADVERSARIAL_LOG R151

**Why this round exists.** Keep hunting: `frozenRows` was read from and written to files, and
nothing in the grid used it.

Fixtures: **"Q1 sales (openpyxl)"** (`3c565601…`, frozen at B2 by its file), and the **"Sales
performance 2026"** sample (`66818463…`). Every change was undone or unfrozen.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | Q1 sales, wheel 300 px down and right | Row 1's headers and column A scrolled away |
| Before: the file | File → Download as Excel; openpyxl | `Sales freeze_panes = B2`: kept, and not drawn |
| Before: the menu | View tab | 100% and Gridlines only; no Freeze |
| Before: charts | Sales dashboard, wheel 600 px | At the column-header band, the element on top was the chart |
| After: opening | Q1 sales | `data-frozen="1,1"`; the rows, columns and corner panes drawn |
| After: scrolled | Wheel 300 px down and right | A1 "Region" pinned in the corner and on top; B1 slid under it (x −89); row 1 and column A's headers stay |
| Seen, then fixed | The same, on the first build | The corner showed D1 and E1 ("Total", "Updated") where A1 belonged; after the fix, A1 |
| Clicks | Scrolled; corner, frozen row over H, body, frozen column | A1, H1, H17, A17 |
| Keyboard | Up ×15 from A17 | A1; the frozen column's A2…A5 drawn as the view came back up |
| Editing a frozen cell | Scrolled 300/300; H1, F2, `Q3`, Enter | The editor in the frozen-rows pane, visible and focused; H1 Q3; H2 selected; undone |
| Freeze panes | C3, View → Freeze → Freeze panes | "Rows above and columns left of C3"; `2,2`; the corner A1, B1, A2, B2 |
| Undo | Ctrl+Z | `1,1` |
| Insert above the line | Row 1's header → Insert 1 row above | Region in A2; `2,1`; undone |
| Charts | Sales dashboard, wheel 600 px | At the header band, the column header on top; the letters over the charts |
| A frozen filter row | Orders, Freeze top row, scrolled 1,500 px | `1,0`; the Region filter button in the frozen row, on top, one copy; clicked: its menu (East 34, North 91, South 40, West 75) |
| Reload | The page again | Orders still `1,0` |
| Unfreeze | View → Freeze → Unfreeze panes | No panes; "All changes saved" |

Along the way, a missed click on the Name box let Ctrl+A and typed text land in Q1 sales' A1
("C3"). It was undone, and A1 reads Region again.

## 2026-09-29 — Find and Replace, ADVERSARIAL_LOG R150

**Why this round exists.** Keep hunting: a sheet of 240 rows had no way to find a value.

Fixtures: the **"Sales performance 2026"** sample (`66818463…`) for Find, left unchanged; the
**"R149 rule formulas"** workbook for Replace, every change undone. The viewer check used the view
share of "R148 names after".

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | Orders sheet; Ctrl+F, then Ctrl+H, in the grid; the menus | Nothing opened. No Find in any menu; only the product's Search (Ctrl+K). SO-10200 (row 201) was not in the page |
| After: Ctrl+F | In the grid | The panel opened with the focus in Find what |
| Find in the sheet | `SO-10200` on the Dashboard, Enter | "Nothing matches "SO-10200" in this sheet" |
| Find in the workbook | Within → Workbook, Find Next | Orders shown, A201 SO-10200 selected and scrolled to; "1 of 1" |
| Find All | `Asha Rao`, Workbook, Values | "55 cells found": Dashboard J9 (the leaderboard's formula answer), Orders, Reps |
| A result | Click Reps A2 in the list | Reps shown, A2 selected, the panel still open |
| Look in | Formulas, Find All | "53 cells found", Orders and Reps only: the Dashboard's answers are not typed text |
| Seen, then fixed | Find All's list at 715 px high | Before the fix: the list ran over the sheet tabs. After: the panel ends inside the grid (673 of 681 px) and the list scrolls |
| Ctrl+H | R149 workbook | Replace with shown; Look in fixed to Formulas |
| Replace All | `North` → `Norte`, Workbook | "Made 2 replacements. Undo (Ctrl+Z) takes them all back."; Find All: Sheet1 B2 and Areas A1 read Norte |
| Undo | Esc, Ctrl+Z once | Both back to North |
| A break refused | `COUNTA(` → `COUNTA((`, Replace All | "Made 0 replacements; 2 left, as the change would break their formula"; C2 3 and D5 "3 x" unchanged |
| Replace | `hello` → `hi`, Replace twice | First: G1 selected, "1 of 1". Second: G1 hi, "Replaced; no more matches". Ctrl+Z: hello |
| Seen, then fixed | Esc, then Ctrl+F again | Before the fix: the panel came back empty. After: `Asha Rao` and Workbook kept, the text selected; Enter went on to J9, "1 of 55" |
| A viewer | View as the share, Ctrl+H | Find only, no Replace; `Rate` found at D1 |

## 2026-09-29 — Rules following renames and shifts, ADVERSARIAL_LOG R149

**Why this round exists.** Keep hunting. R148's wiring showed that three paths rewrote only cells'
formulas. The round drives two of those paths in a new workbook before and after the fix.

Fixture kept: the workbook **"R149 rule formulas"** (`e706a7d1…`), with:
- Sheet1: B2 a list over the other sheet; C2 `=COUNTA(…!A1:A3)`; x, y, z in column E; B5 a list
  over them; D5 `=COUNTA(E…)&" "&E…`; G1 hello.
- The other sheet, now named Areas: North, South, West.

| Round | What was driven | What came back |
| --- | --- | --- |
| Setup | Sheet2 A1:A3 North, South, West; Sheet1 B2 Data validation → list `=Sheet2!$A$1:$A$3` | B2's list: North, South, West |
| Before: rename | Sheet2 → Rename → Regions (the dialog says formulas follow) | C2 still 3; B2's list "The list is empty." |
| Before: a listed value | Type North in B2 | Refused: "Not allowed here — Choose one of:" |
| Before: shift | E1:E3 x, y, z; B5 list `=$E$1:$E$3`; D5 `=COUNTA(E1:E3)&" "&E1`; E1 → Insert cells… → Shift cells down | D5 still "3 x"; B5's list offered x and y only |
| Along the way | Name box `A1`, Enter, then `North` typed at once | "A1 is named A1North": the Enter read the old text. The name was deleted afterwards |
| After: the Name box | Name box `G1`, Enter, `hello`, Enter, no pauses | G1 hello; no name made, no toast |
| After: rename | B2's list reset to `=Regions!$A$1:$A$3`, then Regions → Rename → Areas | C2 3; B2's list North, South, West; North typed into B2 accepted; the list's source now `=Areas!$A$1:$A$3` |
| After: shift | B5's list reset to `=$E$2:$E$4` (x, y, z), then E2 → Insert cells… → Shift cells down | x, y, z in E3:E5; D5 "3 x"; B5's list x, y, z; its source `=$E$3:$E$5` |
| Undo | Ctrl+Z | x, y, z back in E2:E4; B5's source `=$E$2:$E$4` |

Before the fix, the saved rules kept the stale sources (`=Sheet2!$A$1:$A$3`, `=$E$1:$E$3`).
The fix does not repair a rule saved before it, which is why both lists were reset before the
"after" steps.

## 2026-09-29 — Named ranges, ADVERSARIAL_LOG R148

**Why this round exists.** Keep hunting: an Excel model's names. One file was imported through
Sheets → Import before and after the fix:
- in the repo: `tests/fixtures/sheets/openpyxl-names.xlsx`;
- served to the page for the round as `/samples/sheets/r148-names.xlsx`.

The file has six names, nine formulas using them, and Excel's saved answers.

Fixtures kept:
- the workbook **"R148 names before"** (`97fd1c50…`), imported on the old build;
- the workbook **"R148 names after"** (`2f2f7018…`);
- a view share of "R148 names after" to the IAM group `sheets-share-test`, leaving out Q 3.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before: the dialog | Import the file | No mention of names. "6 kept at Excel's value" on Data and 2 on Q 3, said to use "a function Sheets does not compute" |
| Before: the sheet | D3:D9 | 60, 6, 60, 12, 10, 10, 40. Each formula over a name had the hover "refers to something outside this workbook" |
| Before: an input | B2 10 → 100 | `=SUM(B2:B4)` 150. `=SUM(Revenue)` stayed 60, `*Rate` 6, `*TaxRate` 12 |
| After: the dialog | Import the same file | "5 named ranges (Revenue, Rate, TaxRate, Other, …) come in with the sheets". "1 kept at Excel's value". A warning that Two covers several areas and was left out |
| After: the sheet | D3:D9 | D3:D8 computed: 60, 6, 60, 12, 10, 10. D9 (`=SUM(Two)`) showed 40, Excel's value, with the hover |
| After: an input | B2 10 → 100 | D3 150, D4 15, D5 150, D6 30 |
| Name Manager | Data → Names | Revenue (Monthly revenue) `Data!$B$2:$B$4` {100;20;30} (3×1); Rate 0.1; TaxRate 0.2; Other `'Q 3'!$A$1` 5; Local 0.1 |
| A bad name | New name `A1` | "A1" reads as a cell reference; choose another name |
| Add a name | Bonus = `B2*TaxRate`, with a comment | Kept as `Data!B2*TaxRate`, value 20. The save answered ok |
| Name box: a name | `revenue` | B2:B4 selected. The box reads Revenue; the status bar says Sum 150 |
| Name box: another sheet | `Other` | Q 3 shown, A1 selected (5) |
| Name box: a new name | C1:C2 selected, then `Budget` | "C1:C2 is named Budget". The ribbon says Names 7 |
| Autocomplete | `=SUM(Bud` in D1, Tab, `)*2` | The list offered Budget, "Name: 'Q 3'!$C$1:$C$2". Tab gave `=SUM(Budget)*2`. C1 set to 7 made D1 14 |
| Insert a row | Row 1 of Q 3 → Insert 1 row above | Other became `'Q 3'!$A$2` and Budget `'Q 3'!$C$2:$C$3`. D2 still 14 |
| Undo | Ctrl+Z | Other back to `$A$1`, Budget to `$C$1:$C$2` |
| Rename | Revenue → Sales in the Name Manager | Q 3!B2 became `=ROWS(Sales)`, Data!D6 `=SUM(Sales)*TaxRate`. Values unchanged |
| Reload | The page again | D3:D9 150, 15, 150, 30, 10, 10, 40 on opening. The names as left |
| Export | File → Download as Excel | 7,638 bytes. openpyxl read all 7 names, both comments, `=SUM(Sales)`, `=SUM(Budget)*2`, and saved values 150, 15, 30 |
| A viewer | Share with a group, can view, Q 3 left out → View as | Only Data was sent, with the names Sales, Rate, TaxRate, Local and Bonus (not Other or Budget). D7 `=Other*2` showed #NAME? |

## 2026-09-29 — Missing Excel functions, ADVERSARIAL_LOG R147

**Why this round exists.** Keep hunting: 187 everyday Excel functions were checked, and 41 showed
#NAME? when typed. Six of them were typed into the grid before and after the fix, and SUBTOTAL was
driven through the filter menu.

Fixture: the **"Budget and cash flow"** sample (`a6eaa792…`). Its Scenarios sheet holds the six in
K1:K6, and they are kept. The filter was left cleared.

| Round | What was driven | What came back |
| --- | --- | --- |
| Before | K1:K6: `=STDEV(E2:E4)`, `=SUBTOTAL(9,E2:E4)`, `=LET(x,E2,y,E3,x+y)`, `=TEXTAFTER("a-b-c","-",-1)`, `=INDIRECT("E"&3)`, `=RANK(E4,E2:E4)` | #NAME? in all six |
| After | The same cells after the deploy | 3,000; 36,000; 27,000; c; 15,000; 3 (Excel's answers) |
| SUBTOTAL and a filter | Ctrl+Shift+L on A1, column A's menu, untick Worst, Apply | Row 4 hidden; K2 27,000; K1 (STDEV) still 3,000 |
| Filter cleared | The same menu → Clear filter | Worst back; K2 36,000 |

Along the way, a click at the filter button's rough position missed its 16-pixel target. The menu
opened reliably at the button's exact centre, so there is no defect there.

## 2026-09-29 — Array formulas, ADVERSARIAL_LOG R144–R146

**Why this round exists.** The user asked to fix the whole-column arithmetic gap and to keep
hunting. Before the fix, 24 array formulas people use every day were checked against Excel's
answers: 15 were wrong. The formulas below were typed into the grid before the deploy and read
again after it.

Fixture: the **"Budget and cash flow"** sample (`a6eaa792…`). Its Scenarios sheet holds the five
formulas in J1:J5, next to R140/R142's formulas in H1:H5. They are kept.

| Round | What was driven | What came back |
| --- | --- | --- |
| R144, before | J1 `=SUMPRODUCT(--ISNUMBER(SEARCH("st",A2:A4)))` | 0 |
| R144, after | The same cell after the deploy | 2 ("Best" and "Worst") |
| R145, before | J2 `=MIN(IF(A2:A4<>"Base",E2:E4))` | 12,000 (E2, whatever the condition) |
| R145, after | The same | 9,000 |
| R146, before | J3 `=SUMPRODUCT(--(A:A=""))` | 1 (only the blank row inside the used five) |
| R146, after | The same | 1,048,572 |
| R146 | J4 `=MATCH(TRUE,INDEX(A:A="",0),0)` | 5, before and after (this sheet is used five rows deep) |
| R144, before | J5 `=SUM(COUNTIF(A:A,{"Best","Worst"}))` | 1 |
| R144, after | The same | 2 |
| No regression | H1:H5 (R140/R142) after the deploy | 1,048,576; 1,048,572; 1,048,575; 0; 0, as before |
| No regression | Sales sample Dashboard after the deploy | $448,677, 57.7%, 228, $1,968, 12, Gadget, Asha Rao $93,973, as before |

## 2026-09-28 — Sample workbooks (Phase I), ADVERSARIAL_LOG R140–R143

**Why this round exists.** The user asked for sample workbooks with complex functionality, charts
included, pushed in the repository as demos. Each sample was opened from the Sheets page's own
tiles, imported through the dialog, and read on screen. Its figures were compared with a separate
calculation in Python (openpyxl) from the files' own rows.

Fixtures kept (samples imported during the round):
- **"Sales performance 2026"** (`66818463…`), imported before R141 and R143's fixes;
- **"Budget and cash flow"** (`a6eaa792…`). Its Scenarios sheet has the R140/R142 formulas in
  H1:H5, and its scenario was left on Worst;
- **"Project tracker"**, from the first round.

A second Sales and a second Project tracker, imported after the fixes, show the new layout.

| Round | What was driven | What came back |
| --- | --- | --- |
| The tiles | Sheets page | "Samples to explore" row with three tiles, each with its own drawing; the files serve at `/samples/sheets/*.xlsx` (41,219 / 17,175 / 15,311 bytes) |
| Open a sample | Sales performance 2026 tile | Import dialog with the file already read: name "Sales performance 2026", Dashboard 93 cells, Orders 2,892, Products 56, Reps 63. Create workbook opened it |
| Dashboard figures | Read on screen | Revenue $448,677, margin 57.7%, orders 228, average $1,968, returned 12, best product Gadget, leaderboard led by Asha Rao at $93,973. Python gives the same |
| Doughnut | Scrolled to it | Hardware 52%, Software 22%, Services 26%; Python: 245,539 / 103,505 / 123,300 of 472,344 |
| Orders | The sheet | Filter buttons on every header; the returned order struck through in red; data bars on Revenue |
| Reps | The sheet | Traffic-light icons on Attainment (52.2% is 93,973 of 180,000); data bars; the combo of sold (columns from 0) against target (line) |
| R141, before | The Dashboard's two month charts | A flat "Month" series at about 46,000 over an axis numbered 1–12; a "Month" block on top of each stacked column |
| R141, after | The same workbook, reloaded | Four regions over Jan to Dec in both charts |
| Budget scenario | Assumptions B4 dropdown (input message "Base, Best or Worst") → Worst | Model: December customers 909, net for the year −$111,228, cash at year end $38,772. Python with Excel's rounding: 909, −111,228, 38,772 |
| R140, after | Scenarios H1:H3: `=ROWS(A:A)`, `=COUNTBLANK(A:A)`, `=COUNTIF(A:A,"<>Base")` | 1,048,576; 1,048,572; 1,048,575 |
| R142, before | H4 `=INDEX(A:A,500)`, H5 `=A500` | Both empty |
| R142, after | The same cells after the deploy | Both 0 |
| Project tracker | Tile → Create workbook | Tasks by status 5 / 4 / 1 / 4; hours left 120 / 46.2 / 22.4 / 0 (188.6); complete 40%; late tasks 2 (Data model and Auth and roles, due before 28 September); next due Data model; pie 36% / 29% / 7% / 29% |
| R143, before | Project tracker Summary; Sales Dashboard | The pie covered column F (the owners' remaining hours); the stacked chart covered the open-orders list from J22 |
| R143, after | Fresh imports of both | The charts sit right of column F, and below the list's last row |

## 2026-09-28 — AI in Sheets (Phase H), ADVERSARIAL_LOG R131–R139

**Why this round exists.** The Excel-parity list asked that "the AI assist features work properly
in the workbook". Every question below was typed into the assistant and every proposal applied
with its own button. Each answer was checked against the cells, and the table figures against
the Lakehouse query editor. Model: `openrouter/google/gemini-3-flash-preview`, the default.

Fixtures kept:
- **Workbook "Phase H assistant"** (`28f07252…`), with these sheets:
  - Sheet1;
  - Sales: 8 rows; Revenue in F from the assistant; `=VLOOKUP("Dee",C2:F9,2,FALSE)` in H2;
  - Feedback: 6 comments, with the Sentiment column filled by Fill with AI;
  - BiDemoSales: a table sheet over `analytics.bi_demo_sales`;
  - Summary: totals by region, with E1:F4 and a column chart from the assistant;
  - High Revenue: R133's #VALUE!, kept as the before;
  - Big Months.
- **A view share of it** to the group **sheets-share-test**: Sales rows where B is West, Feedback
  left out.

| Round | What was driven | What came back |
| --- | --- | --- |
| Q&A over a grid | "total units for West" | Step `Computed =SUMIFS(D:D,B:B,"West")`, answer 19. The cells give 10+6+3 = 19 |
| Revenue column | Asked for revenue; applied three proposals | F1 header; `=D2*E2` filled to row 9; currency format. F2:F9 read $25.00 … $15.00. Ctrl+Z took the format off; Ctrl+Y put it back |
| Summary sheet | Asked for a summary by region | New sheet Summary with `=SUMIFS(Sales!D:D,Sales!B:B,A2)` and the revenue twin. West 19 / $44.50, East 17 / $51.00, North 21 / $47.25 |
| R131, before | Any answer with proposals | "I've added…" while nothing was applied |
| R131, after | The same | "I will add…", and "Nothing has changed yet. Apply what you want (each one undoes with Ctrl+Z):" above the proposals |
| R132, before | "Add a column chart of total revenue by region, without the units column" | A chart over `A1:A4,C1:C4`; Apply: "is not a range" |
| R132, after | The same question | Columns side by side first (`=C2` …) and a chart of E1:F4: West 44.5, East 51, North 47.25 |
| R132, after (the retry) | "On the BiDemoSales sheet, highlight in red every row whose revenue is over 600" | Step "Checked the proposals: 1 could not be done as given; asked again". The second answer said a table sheet can't be highlighted, and proposed nothing |
| R133, before | Same, over 1000 | The retry offered a new sheet with `=FILTER(BiDemoSales, BiDemoSales[revenue]>1000)`. Applied, A2 showed #VALUE! |
| R133, after | "Make a new sheet called Big Months that lists the BiDemoSales rows with revenue over 600, using FILTER" | The answer said FILTER over a table sheet shows #VALUE! and pointed to the table sheet's filter. It offered `=SUMIFS(BiDemoSales[revenue], BiDemoSales[revenue], ">600")`, which read 21,547.09. The Lakehouse gives 21,547.09 over 28 rows |
| Table question | "What is the total revenue for EMEA in BiDemoSales?" | Step `Computed =SUMIFS(BiDemoSales[revenue], BiDemoSales[region], "EMEA")`, answer 15,524.94. The Lakehouse gives the same (Phase G) |
| Fix this error | `=VLOOKUP("Dee",B2:F9,3,FALSE)` typed in H2 (#N/A), then the chip | "searching for Dee in the Region column (B) instead of the Rep column (C)". Proposal `=VLOOKUP("Dee",C2:F9,2,FALSE)`; applied, H2 = 12 |
| R134, before | Explain this formula on H2 | A correct explanation, and a proposal of the formula H2 already held |
| R134, after | The same | The explanation, and a proposal that changes something: `C:F` for a range that grows |
| R135, before | Fill with AI, B2:B7 → C, "positive, negative or neutral", C2 typed "positive" | Five blanks. The trace showed five right answers, sent without `[ ]` |
| R135/R137, after | The same | Column C by default, with "1 already answered (used as examples)". Trial: negative, neutral, positive, negative, neutral |
| R137, before | The same dialog | The column defaulted to D, past the typed answer |
| R137, after (C full) | The same dialog after the fill | The column defaulted to D, with 6 to fill |
| R138, before | Fill 5 rows after a trial | C7 written as positive where the trial had shown neutral |
| R138, after | Trial, then Fill 5 rows | Trial said positive for C7; the fill wrote exactly the trial. No fill request after the trial's |
| Undo a fill | Ctrl+Z after Fill 5 rows | C3:C7 emptied in one step; the example in C2 stayed |
| R136, before | The fill's response | `cost: null`, while the trace said $0.00028 |
| R136, after | The same; an assistant answer; an AI SQL query | Fill `cost: 0.0002315`. The panel shows "Cost $0.0017". The Lakehouse `ai_sentiment` badge now has a cost ($0.0000 at four decimals, see the queue) |
| View as | Share to view (West rows, Feedback out), then View as | Sales shows rows 2, 4, 7 only; H2 is #N/A because Dee's row is hidden; no Feedback tab. The only chip is Summarize; proposals read View only |
| R139, before | View as after asking as the owner | The owner's conversation, with its reads of hidden rows, stayed in the panel and went to the model |
| R139, after | The same | An empty panel. "total units on Sales, by region" answered West 19 only |
| Admin settings | Admin → Developer runtime → Data platform | Assistant model `openrouter/google/gemini-3-flash-preview`, 30 a minute, 2,000 rows |
| A setting reaching the page | Rows set to 3, saved; Fill on B2:B7 → D | "That is 6 rows; one fill does at most 3 (SHEETS_AI_FILL_MAX_ROWS). Select fewer rows." Set back to 2,000 and saved |

## 2026-09-28 — Sheets sharing (Phase G), ADVERSARIAL_LOG R129–R130

**Why this round exists.** The Excel-parity list asked for sharing with users and groups, including
filtered sharing. This round drove it from the owner's side. The recipient's side needs a second
account, which this session cannot make or sign into. **View as** runs the same server filtering
the recipient gets, and is what was driven here.

**A share target that gives nobody access.** This install had no IAM groups, so an empty group
**sheets-share-test** was made (Admin → IAM → Groups, 0 members). It is kept.

Fixtures kept:
- **Workbook "Phase G sharing"** (`9fb2aa01…`), with these sheets:
  - Sheet1: `=COUNTA(BiDemoSales[region])` in A1, `=SUM(BiDemoSales[revenue])` in A2.
  - Summary: a grid imported from a CSV of regions, amounts and reps.
  - Costs: a grid.
  - BiDemoSales: a table sheet over `analytics.bi_demo_sales`, 108 rows.
- **Its share to sheets-share-test:** can view, Summary West only, BiDemoSales EMEA only, Costs
  left out.
- **The group sheets-share-test.**

| Place | What was done | Result |
|---|---|---|
| Share → A person | `nobody@example.invalid` | "No one here signs in as nobody@example.invalid" |
| Share → A group → sheets-share-test, View | Summary: column A is West (1 header row); Costs off; BiDemoSales: region is EMEA | "Shared"; the list reads "Can view · Summary: only rows where column A is West · BiDemoSales: only rows where region is EMEA · Leaves out Costs", with the table-access warning |
| View as | the share | banner "as the group sheets-share-test sees it: only some rows of Summary, BiDemoSales; 1 sheet left out"; sheets Sheet1, Summary, BiDemoSales; no ribbon, Add sheet, tab menus, Share or Rename; formula bar read-only |
| View as → Summary | read the cells | Region/Amount/Rep, West 10 Ana, West 30 Cho; rows 3, 5, 6 hidden |
| View as → Summary | typed 999, Enter, Delete | nothing changed; nothing pending |
| View as → BiDemoSales | the page | "36 rows", only EMEA; only Refresh offered |
| View as → BiDemoSales → Filter region | the value list | "EMEA 36" only |
| View as → Sheet1 | A1, A2 | 36 and 15,524.94; the Lakehouse gives 36 EMEA rows, 15,524.94 |
| Share → change to Edit → View as | the share | all four sheets, 108 and 51,749.84; still read-only |
| Share → back to View with the same filters | saved | as before |
| Share → Stop sharing | confirmed | "No longer shared with sheets-share-test"; "Only you can open this workbook" |
| The old View as link | opened | "That share no longer exists" |
| Shared again, same filters | saved | as before (kept) |
| Audit log | read | `sheet.share` ×4 and `sheet.unshare` ×1 on "Phase G sharing", by this account |
| Sheets page | the owner's | 11 workbooks, card menus Open / Rename / Delete, no "Shared with me" (nothing is shared with this account) |
| R130, as the owner | Sheet1 typed, then reloaded | before: 108 and 51,749.84 typed, 1 and #VALUE! after a reload; after: 108 and 51,749.84 after a reload |
| R129 | a table opened with a forged "upload" origin | before: accepted, "from forged.csv", the table refused writes; after: "Opening a table can't say it was imported" |

Not driven, and why:
- **Anything as the recipient.** Their Sheets page and its "Shared with me", an editor's real
  edits and a viewer's real session all need a second account. Please check them with one: share a
  workbook with its email and sign in as it.
- **A person share's warning** about table sheets they cannot read. The only person share tried was
  to an account that doesn't exist.
- **Downloads in View as.** Downloading writes a file; the export function carries the
  restriction, and the tests pin it.

## 2026-09-26 — Sheets' tables read-only outside Sheets, ADVERSARIAL_LOG R126–R128

**Why this round exists.** The user saw the tables Sheets makes in the Lakehouse and asked that
they be changed only from Sheets. This round drove the guard, and the three findings made while
building it, before and after.

**How a forged save was sent (R127).** A `fetch` wrapper in the page changed one field, the origin,
in the app's own settings-save request for a sort. The session token was never printed.

Fixtures kept for review:
- **Workbook "R126 held table".** Its sheets:
  - HeldRows: an upload, `r126_held.held_rows` (3 rows).
  - BiDemoSales: opens `analytics.bi_demo_sales`, sorted by month descending.
  - LaterRows: an upload, `r126_held.later_rows`, now the model's before-case row `model_col = 1`.
  - LaterView: an upload, `r126_held.later_view` (2 rows).
  - PredProbe: an upload, `r126_held.pred_probe`, now the before-case's 836 predictions.
- **Schema `r126_held`.**
- **SQL model `later_rows`.** Paused, because each build is refused.
- **Materialized view `r126_held.later_view`.** Manual; each rebuild is refused.

Not kept:
- the schema `lake` (made and dropped twice);
- `r126_held.held_rows_copy` and `lake.r126_ok`;
- the first BiDemoSales, the forged one, which was deleted as part of the after-check.

| Place | What was done | Before | After |
|---|---|---|---|
| Lakehouse SQL | `UPDATE analytics.orders_jan_feb_2024 SET note = note WHERE 1 = 0` (uploaded by "Sheets E2E M1") | ran, 0 rows | refused, naming the sheet and workbook |
| Lakehouse SQL | `SELECT count(*)` from it | read | read |
| Lakehouse SQL | `UPDATE analytics.bi_demo_sales …` (only opened by sheets) | ran | ran |
| Lakehouse → analytics.orders_jan_feb_2024 | the table's page | Insert row and Drop, no owner shown | "Held by Sheets · Sheets E2E M1 › OrdersJanFeb2024Csv", linking to the workbook; no Insert row, no Drop |
| Lakehouse SQL on `r126_held.held_rows` | INSERT, DROP TABLE, ALTER TABLE ADD COLUMN | (uploaded this round) | each refused; SELECT reads; the suggested `CREATE TABLE r126_held.held_rows_copy AS SELECT *` runs and the copy takes an INSERT |
| Lakehouse → Drop schema r126_held | confirmed in the dialog | (after only) | "r126_held holds the rows of 1 Sheets table sheet: held_rows (sheet "HeldRows" in "R126 held table")…"; the schema stays |
| R126, SQL, schema `lake` present | `CREATE TABLE lake.ice_sales.r126_probe AS SELECT 1 AS x` | ran; the table was made | refused: a read-only Iceberg mount |
| R126, SQL | `UPDATE lake.analytics.orders_jan_feb_2024 …` | refused only because no `lake` schema existed then | the Sheets refusal |
| R126, SQL | `DROP TABLE memory.main.r126_other` | — | refused: not the lakehouse |
| R126, SQL | `CREATE TABLE lake.lake.r126_ok AS SELECT 1 AS x`, then DROP | — | both run (the caller's own schema) |
| R127, BiDemoSales | a sort saved with its origin changed to an upload | accepted; "from forged.csv"; `UPDATE analytics.bi_demo_sales` refused as held | the sort saved, the origin not; no "from forged.csv" after a reload; the UPDATE runs |
| R127 | the forged sheet deleted | — | `bi_demo_sales` writable again |
| R128, SQL Models → later_rows | saved while the name was free; `later_rows.csv` uploaded to the name; Build this and what it reads | "Built 1 model"; the table became `model_col = 1`; the sheet said "has different columns now" | "1 failed, 0 skipped, 0 built" with the Sheets message, in the Builds tab too; changed to `SELECT 2` and built again, the table still reads 1 |
| R128, Lakehouse → later_view → Rebuild | view saved; its table dropped; `later_view.csv` uploaded to the name | not driven | "Rebuild failed: r126_held.later_view holds the rows of the sheet "LaterView"…"; the 2 uploaded rows stay |
| R128, ML → revenue_facts model → Batch prediction | scored into `r126_held.pred_probe`; that table dropped; `pred_probe.csv` uploaded to the name; scored again | started and succeeded, 836 rows; the `label` column gone | refused in the dialog with the Sheets message; no job |

Not driven, and why:
- **Another account locked out (R127).** It needs a second account.
- **An ETL pipeline or an Iceberg import into a held table.** Both run the same check before
  they start, and the tests pin where.
- **The view's before case (R128).** The shape is the model's.

## 2026-09-26 — A session refresh across the app: 14 editors and dialogs, before and after, ADVERSARIAL_LOG R125

**Why this round exists.** R120 found a Sheets load keyed on the session's access token, which
changes on every refresh and rebuilt the editor from the saved copy. The same shape was listed as
open in 19 other files. This round read every hook keyed on the token (see R125 for how they were
found) and drove each one that could lose work, before and after the fix.

**How a refresh was forced.** In the page, the stored session (`sb-…-auth-token` in
localStorage) was set to expire five seconds later and a `visibilitychange` event was sent.
supabase-js then refreshed the session within 2–30 s. The check read only whether the token
changed; the token itself was never printed.

Fixtures: none kept. Edits were made and never saved; "Test" (ETL), "Revenue pack - known series"
(report), "Test" (workflow), `analytics.bi_demo_sales` (layout) and the model "threshold_probe
(payment_rows)" were left as they were. The four API keys created to show the one-time banner, all
named "refresh test (revoke me)", were revoked in the same step. The admin settings, IAM rules and
audit retention were typed into and never saved.

| Place | The unsaved work | Before (no fix) | After |
|---|---|---|---|
| ETL → "Test" pipeline | renamed "Test renamed, not saved"; a Filter rows node added, its panel open | name back to "Test", the node gone, Save still enabled | name, node and Save kept |
| BI → Reports → "Revenue pack - known series" | renamed; a fifth Heading block | name and blocks back to the saved four | kept |
| Workflows → "Test" | renamed; a SQL statement step added, inspector open | name back, step gone, inspector closed | kept; picking "R96 notebook step" still loads it |
| Admin → Developer runtime → Data platform | 45 and 80 in the two version limits | 30 and 50 again | 45 and 80 |
| Audit log | retention box 30, Set not pressed | 7 again | 30 |
| Lakehouse → bi_demo_sales → Layout | keys region then month, 256 MB, keep clustered | no keys, 128, off (the dialog blanked first) | kept |
| Admin → IAM → Access, a user picked | an OpenRouter · * rule added to the draft | "No rules — this user is unrestricted", Save rules disabled | the draft and Save kept; the page's own Refresh keeps it too |
| Model → Accuracy → operating point | the 0.50 line picked (its "What changes" note shown) | back to 0.30, note gone | 0.50 and its note |
| Model → Accuracy → fairness | region and plan ticked; favourable "2" | unticked, box empty | kept |
| Model → Versions → Require approval | two example.com addresses typed | box empty, still editing | kept |
| Model → Publish as API → Create key | the "cannot be shown again" banner | banner gone, dialog open | banner kept |
| Notebook → Publish → Create key | the same banner | gone | kept |
| Sheets E2E M1 → BiDemoSales (table sheet) | four cells selected | selection gone, rows re-fetched | four cells still selected |
| BI → Revenue Command Center → Total revenue → Explore data | sorted by Country, page 3 | page 1, unsorted | page 3, "Brazil" still first |

The explore dialog kept resetting after the token was taken out of its query. The dashboard
passed a fresh `[]` for "no drill path" on every render, and a refresh re-renders it; the dialog now
keys its query on what the drill path says. The table sheet's loader was also keyed on the
workbook object, which is new on every render of the page.

Not driven, and why: an outcome source being changed (none set in this account), a warm
deployment's idle time and copies (none deployed), an experiment's description (no experiments),
a connection import's table pick (no database connection), the Git sync settings (no saved
config; one needs a personal access token), and a typed delete confirmation (no dataset of this
account has dependents, and without any the dialog asks for no typing). Each has the same one-line
fix, pinned by `tests/unit/tokenReloadSweep.test.ts`.

## 2026-09-26 — The Sheets page: search, sort, thumbnails, ADVERSARIAL_LOG R122–R124

**Why this round exists.** The Sheets page was a plain list of names and "No description". Asked
for a searchable, more polished gallery, this round rebuilt it. It also read where the page's
"edited" time came from, which turned out to be wrong (R122). Using the editor to make a card
turned up two more defects, R123 and R124.

Fixtures: the nine workbooks already kept from earlier rounds; one workbook made, renamed and
deleted from its card here ("Gallery check (temporary)"). Thumbnails were read from the DOM and
from `sheet_workbook_previews`, times from `sheet_workbooks` and `sheet_tabs`.

| Step | Result |
|---|---|
| Open Sheets (after clearing the thumbnail cache) | nine cards, each with the corner of its first grid sheet as it reads: values not formulas, the blue header fill with white text and the red -350 of "Q1 sales (openpyxl)", Phase D's green paid rows and red quantities from its rules; "9 charts" on Phase E's card (first shown as "3 charts", the thumbnail's list of types, fixed) |
| Press `/` | the search box takes the keyboard; the `/` is not typed into it |
| Type `quarterly` | "3 of 9 workbooks": the two Phase F workbooks and "Long sheet names (R118)", found by a sheet named Quarterly…; the word marked in their sheet chips |
| Escape; type `rules orders` | "1 of 9": Phase D (one word in its name, one in a sheet's) |
| Type `budget 2031` | "No workbooks match “budget 2031”" with Clear search, which brings all nine back |
| Sort → Name | club members, Long sheet names, Q1 sales, …, Sheets E2E Rules (Phase D): case ignored |
| Layout → List; reload | the list (name with a small sheet-shaped thumbnail, sheets, edited, created) and the Name order, both kept |
| Start → Blank workbook → "Gallery check (temporary)" → type a small table, bold the header | the workbook opens; back on the page its card shows region / sales in bold, 1200 and the rest: the editor kept the thumbnail a second after the edit, and the workbook's time stayed on the edit |
| Sort → Last edited; open Phase D by clicking its thumbnail; K6 → Delete; ← Sheets | Phase D first, "2s ago" (R122: before the fix it stayed fourth, "edited 4h ago", with the sheet saved at 19:12:13 and the workbook at 15:36:59) |
| The card's ⋯ → Rename… → "Gallery check renamed (temporary)" | "Renamed to …", first in the list |
| ⋯ → Delete… → Delete workbook | "Deleted …", nine workbooks; its thumbnail row went with it (no thumbnail without a workbook) |
| Ctrl+B on A1:B1 of the new workbook, before the fix | bold, and the app's sidebar opened; again: bold off, sidebar closed (R123) |
| After | Ctrl+B three times: bold on, off, on, the sidebar still; F2 then Ctrl+B: the sidebar still; with the page focused, Ctrl+B still opens and closes the sidebar |
| Dark theme, before | the pink rule cells of Phase F (20, 30) showed near-white text, unreadable, in the grid and on the card (R124) |
| After | C2: `rgb(31, 31, 31)` on `rgb(255, 199, 206)`; the thumbnails likewise |

Found while building it (new code, fixed before commit): a merge's fill showed only in its first
cell of a thumbnail, and two tests could not fail (the merge case drew nothing under the merge
anyway; "cafe" is found in "café" even without folding accents). Both were caught by the
mutation run and given tests that can fail.

## 2026-09-25 — Sheets: Insert cells and Delete cells, and version history

**Why this round exists.** Excel's Insert and Delete cells move only part of a row or column, and a
workbook people rely on needs a way back to how it stood yesterday. Both had to work from the menus,
keep every formula pointing where it pointed, and survive a reload.

Fixture (kept): workbook "Sheets E2E Cells & Versions (Phase F)", imported through the Sheets page
from `cells_f.xlsx` (written with openpyxl: Item/Q1/Q2/Q3/Total with `=SUM(B2:D2)` down E and a sum
row, pointers `G2 =C3*2`, `G3 =SUM(C1:C9)`, `G4 =D2`, a red rule over B2:D4 above 15, and A8:B9
merged). Also kept: "Sheets E2E Cells & Versions (Phase F) (2026-09-25 18:41)", opened from a
version before the naming fix below. Every step was a right-click, a menu item, a radio button or a
key; formulas were read from the formula bar and versions from `sheet_workbook_versions`.

| Step | Result |
|---|---|
| C3 → Insert cells… → Shift cells right → Insert | row 3 only moves: C3 empty, 6 and 7 in D3:E3, the total in F3 as `=SUM(B3:E3)` (18), G3's `=SUM(C1:C9)` now in H3 and unchanged (44); G2 `=D3*2` (12); C5 `=SUM(C2:C4)` stays (22) |
| Ctrl+Z, Ctrl+Y | the sheet as imported, then the shift again |
| C3 → Delete cells… → Shift cells left | back exactly: `=SUM(B3:D3)`, `=C3*2`, `=SUM(C1:C9)` |
| C2:D2 → Insert cells… → Enter (Shift cells down) | C and D move down from row 2: E2 `=SUM(B2:D2)` 10, E3 55, E4 14; C6 `=SUM(C3:C5)`; G2 `=C4*2`; G3 `=SUM(C1:C10)`; G4 `=D3`; the rule over B2:D4 stays (it reaches outside the columns that moved) |
| Ctrl+Z; D2 → Delete cells… → Enter (Shift cells up) | G4 `=#REF!`, shown as #REF!; D4 `=SUM(D2:D3)` (the range lost its deleted cell) |
| Ctrl+Z | G4 `=D2` again |
| B7 → Insert cells… → Shift cells down | refused: "The merged cell A8:B9 would be cut in two; unmerge it first, or insert whole rows." Nothing moved |
| B7 → Insert cells… → Entire row | a row above 7; the merged note now A9:B10 |
| Reload | as left; the first save had taken an automatic version (18:41:39), later saves inside 30 minutes none |
| File → Version history… | the automatic version: "Automatic · 1 sheet · 1 KB" |
| Type "Sent to finance" → Enter | "Saved the version "Sent to finance"", listed first as Named |
| B2 → 999 → Enter; Version history → Restore "Sent to finance" | the question says what is kept; Enter answers Cancel (the app's safe default), the button restores: B2 10, totals 60 and 84; a version "Before restoring Sent to finance" taken first, one byte larger (999 for 10) |
| Ctrl+Z right after | nothing: the editor starts a fresh history on the restored sheets |
| Restore "Before restoring Sent to finance" | B2 999 again: a restore undone from the list |
| Open a copy of the automatic version | a new workbook with that version's sheet (the shifted row 3), this one unchanged |
| After the naming fix: restore the automatic version | "Restored the version of 9/25/2026, 10:41:39 PM"; the row written: "Before restoring the version of 9/25/2026, 10:41:39 PM" |
| Admin → Developer runtime → Data platform | "Minutes between automatic versions" 30, "Automatic versions kept per workbook" 50 |

Found while building it (new code, fixed before commit):

- **The build failed with the version helper in the browser bundle.** The grid save imported
  `takeVersion`, a plain function, from another `*.functions` module; the browser build keeps a
  module's plain functions and their server imports, and so pulled in the Supabase admin client. The
  error named an unrelated file (`integrations.functions.ts`), the first importer the checker met.
  The helper moved to `versions.server.ts`, and a test now requires that a `*.functions` module
  import only types from another (every other file in the repo already did).
- **Version names mixed time zones.** A copy was named "(2026-09-25 18:41)", the server's UTC, beside
  a list that said 10:41 PM; and restoring a "Before restoring …" version wrote "Before restoring
  Before restoring …". Names now use the time as the browser shows it, and any version but a named
  one is spoken of by its time.

Seen during the round, not a finding: while the terminal was busy, the workbook gained a filter on
A1:E5 and the pane went back to the Sheets list (saved at 18:46:30, between two of this round's
steps; nothing in the app navigates there on its own). It was taken for someone using the same
pane and left in place.

## 2026-09-25 — Sheets charts: every type from Insert → Chart, redrawn from the cells, to Excel and back

**Why this round exists.** A spreadsheet's numbers are read as pictures. Every chart type had to be
made from the ribbon, draw the right marks from the cells, follow edits and inserted rows, move and
resize, undo, and survive a download to Excel and an import back.

Fixture (kept): workbook "Sheets E2E Charts (Phase E)", imported through the Sheets page from
`revenue_e.csv` (Month, North, South, East, West for twelve months; Spend and Sales in G:H). Each
chart below was made with Insert → Chart over a range typed in the name box; the checks read the
drawn SVG (bars, lines, areas, slices, points, polygons, axis ticks).

| Step | Result |
|---|---|
| A1:E13 → Insert → Chart | the dialog opens on Column with a live preview of the range; the preview first showed no axes (a fragment around them, fixed), then month ticks and a value axis |
| Column, "Revenue by region" → Insert | "Chart inserted"; a 480×300 chart beside the data: 48 bars, Jan…Dec, 0–200, legend North/South/East/West |
| B2 100 → 250 | the Jan/North bar grows from 91.5 to 176 px, the axis rescales to 260 |
| Drag the chart's top edge | it moves below the data (42, 322) and saves |
| Line, smooth, axis titles Month / Revenue | 4 smooth curves, the two axis titles |
| Area, Stacked | 4 areas, the axis to 800 (the regions summed) |
| A1:B13 → Pie, data labels | 12 slices, labels 13%, 6%, 7%…; a mistyped range first ("A1:B13North by month") was refused: "is not a range such as A1:D13" |
| A1:C13 → Doughnut | 12 slices with a hole (inner radius 51 of 79) |
| G1:H13 → Scatter, axis titles Spend / Sales | 12 points on a number axis 9–45, placed beside G:H |
| Column and line | 12 columns (North) and 3 lines |
| Radar | 4 polygons over 12 month spokes |
| Bar, 100% stacked | 48 bars, 0%–100% along the bottom, months down the side |
| Double-click it → Edit chart (the dialog says Save) → Column → Save | "Chart updated"; a 100% stacked column chart |
| Click it → Delete | "Chart deleted (Ctrl+Z brings it back)", 8 charts; Ctrl+Z → 9 |
| Drag its corner | 480×300 → 590×389, its place unchanged |
| Rows 1–2 → Insert 2 rows above | every chart's range moves (A1:E13 → A3:E15, G1:H13 → G3:H15) and each still draws; Ctrl+Z back |
| Reload | all nine, the resized one at 590×389 |
| File → Download as Excel | openpyxl reads 9 charts: BarChart, LineChart, AreaChart, PieChart, DoughnutChart, ScatterChart, BarChart (the combo, with a line part), RadarChart, BarChart (percentStacked), each over `'Revenue 2026'!…` |
| File → Import sheets… that file | "Revenue 2026 (2)" with the nine charts: same types, titles, ranges, places and sizes, every one drawing |
| Phase D's workbook: Amount filter → By condition → type 2000 → Enter | the filter applies (Enter now does what Apply does); Data → Clear |

Found while building it (new code, fixed before commit): the column and bar charts drew no axes,
because recharts looks for its axes among a chart's direct children and they were wrapped in a
fragment.

## 2026-09-25 — Sheets rules: conditional formatting, data validation, filter and sort, ADVERSARIAL_LOG R119–R121

**Why this round exists.** A spreadsheet people run a business on colors its exceptions, refuses
bad input, and filters down to what matters. Each of those had to work from the ribbon, survive a
reload, follow inserted rows, and go to Excel and back.

Fixture (kept): workbook "Sheets E2E Rules (Phase D)", imported through the Sheets page from
`orders_d.csv` (20 orders: region, rep, product, qty, price, date, status), with an Amount column
`=E2*F2` filled down. Every step below was a click or a keystroke in the browser; downloads were
captured in the page and read with openpyxl.

| Step | Result |
|---|---|
| I2:I21 → Home → Conditional → Data bars → Blue | bars drawn in proportion; "Rule added to I2:I21" |
| E2:E21 → Highlight cells rules → Greater than… → 100 | 120 and 150 light red with dark red text; 60 and 8 plain |
| H2:H21 → Text that contains… → `void` | "Void" highlighted (case ignored, as in Excel) |
| F2:F21 → Color scales → Green – Yellow – Red | 9.5 green, 12 yellow (the median), 18.75 orange, 30 red |
| A2:D21 → New rule with a formula… → `=$H2="Paid"`, green | every Paid row green across A:D, other rows plain |
| I2:I21 → Top/bottom rules → Top 10 items… → 3, yellow | 4500, 2812.5, 1800 yellow; the data bars stay under them |
| Manage rules… | six rules, newest first, each with its range; deleted "void", narrowed greater-than to E2:E10, Save → H6 plain, E16 plain, E5 still red |
| Ctrl+Z | the deleted rule and the full range back |
| H2:H21 → Data → Data validation… → List "Open, Shipped, Paid, Void", input message "Status / Pick where the order stands.", Stop titled "Unknown status" | "Validation set on H2:H21"; the message shows beside the active cell; a dropdown button beside it |
| H3 → type `Lost` | Stop alert "Unknown status — Choose one of: Open, Shipped, Paid, Void", Retry focused; Retry → back in the edit with "Lost"; `paid` → kept (the list ignores case), and row 3 turned green through the formula rule |
| H4 → the dropdown → Void | H4 = Void, red through the text rule; the keyboard back in the grid |
| E2:E21 → Whole number between 1 and 100, Warning; E3 → 150 | Warning "Enter a whole number between 1 and 100 — Keep this value?"; Yes → 150 kept, Amount 1425 |
| A2:A21 → Custom `=COUNTIF($A$2:$A$21,A2)=1`, message "That order number is already used."; A3 → A-1001 | refused with that message (the formula sees the typed value); Cancel → A3 unchanged |
| B5 → Ctrl+Shift+L | "Filter on A1:I21", a button on each of the nine headers |
| Region → untick all, tick North → Apply | only the five North rows; a funnel on Region |
| Amount → By condition → Greater than 1000 | four rows (North and over 1000) |
| Amount → Sort Z to A | 4500, 1800, 1200, 1140; the filter reapplied; I2 `=E2*F2` = 4500 (formulas moved with their rows) |
| Data → Clear | all 20 rows back, no funnels |
| B3 → Data → Sort A to Z | East…West, the header row kept on top, amounts with their rows |
| File → Download as Excel | openpyxl: autoFilter A1:I21; top10 rank 3, dataBar, expression `$H2="Paid"`, colorScale, containsText with `NOT(ISERROR(SEARCH("void",H2)))`, cellIs greaterThan 100; validations: custom COUNTIF (stop, its message), whole 1–100 (warning), list `"Open,Shipped,Paid,Void"` with its prompt and title |
| Reload the page | every rule, validation, the filter buttons and the sorted order still there |
| After the fixes: Conditional → Less than… → type `10`, Enter (no click) | the value box had the keyboard; both 4s highlighted; the keyboard back in the grid |
| H5 → Alt+Down | the list opens on its first choice; Escape closes it, H5 unchanged |
| H6 → `Lost` → Cancel | H6 still Paid; ArrowDown moves on from the grid |
| Row 2 header → Insert 1 row above | every rule and validation one row down: A3 green, E3 red, bars from I3; `Lost` in the new row 2 accepted, in H4 refused; Ctrl+Z ×2 back |
| File → Download as Excel, then File → Import sheets… that file | "Orders Q3 (2)" arrives with the same colors, bars, filter buttons, the Status list with its message and Stop alert, and the Qty Warning |
| R121, before: Region's filter → click Search → press N, o (real key presses) | the menu closed and cell H8 opened for editing holding "No"; Alt+Down on H5 → Down, Down → Enter left the list open and H5 unchanged |
| R121, after (rebuilt image): the same | the search box reads "No" and the list shows only "North 5"; no cell edit. Alt+Down on H5 → Down focuses Shipped (the selection stays on H5) → Enter → H5 = Shipped, the list closed, the keyboard back in the grid. Amount → By condition → press 4, 0, 0, 0 → the value box reads 4000 |
| On the rebuilt image | Manage rules names "Color scale: Green – Yellow – Red" and "Data bar: Blue"; its first box has the keyboard |
| R120 and R119 | see ADVERSARIAL_LOG (session refresh; `-$350.00`) |

Found while building it (new code, fixed before commit): a dialog opened from a menu item did not
have the keyboard (the menu's focus trap took it back as the menu closed), and after Apply the
keyboard fell to the page; Alt+Down moved the selection instead of opening the list; a custom
validation formula read the cell's old value, so a duplicate passed; ExcelJS crashed writing an
icon set without thresholds, turned a limit such as `TODAY()` into NaN on reading (the file's own
text is now read), and wrote text rules without the text Excel shows (added to the file after
ExcelJS writes it); a "begins with" rule came back as a plain formula rule.

## 2026-09-25 — Sheets and Excel files: import .xlsx and CSV, download .xlsx and CSV

**Why this round exists.** People arrive with Excel files and leave with them. A workbook that
cannot take a colleague's .xlsx, or hand one back that opens right in Excel, is a dead end.

Fixtures (kept, in `tests/fixtures/sheets/`): `openpyxl-sales.xlsx`, written by openpyxl (not the
library this code uses), with theme and indexed colors, borders, a merge, wrap, a link, hidden
row and column, frozen panes, `[Red]` formats, dates, and a sheet named `Bob's notes`; and
`excel-features.xlsx`, carrying what Excel itself saves: formula results, `_xlfn.` names, an array
formula, CUBEVALUE, a link to another workbook, and CUBEMEMBER inside IFERROR. The browser read
each through the dialog's file input (a `File` set on it, as choosing one does); downloads were
captured in the page and checked with openpyxl.

| Step | Result |
|---|---|
| Sheets → Import Excel or CSV → `openpyxl-sales.xlsx` | preview: Sales 30 cells, Bobs notes "(was Bob's notes)", Lists 1 cell; name "Q1 sales (openpyxl)" |
| Create workbook | Arial 12 bold white on `#376092` header (openpyxl's Office 2007 theme, tint −25%), `#,##0` with −350 red, totals computed (7820), the struck bold italic red total with its thick red top and double bottom, `2024-03-02` dates, the A8:D8 merge centered, row 10 wrapped at 60 px, the link, column A 159 px, column F and row 14 hidden |
| Lists!A1 | `='Bobs notes'!B1*2` → 15640 (the renamed sheet followed into the formula) |
| Bobs notes!B2 `=CUBEVALUE("x","y")` | `#NAME?`, "Unknown function CUBEVALUE" (openpyxl saved no value to show) |
| File → Import sheets from Excel or CSV… → `excel-features.xlsx` | "Summary 16 cells · 3 kept at Excel's value", with the explanation; Add sheets → Orders and Summary tabs |
| Summary | UNIQUE spills Acme/Globex/Initech, SUMIFS 2180/−150/2200, XLOOKUP −150, 51.5%; CUBEVALUE 98765, the other-file link 5500 and IFERROR(CUBEMEMBER) "Q1 2024" at Excel's value, each with an amber corner and a note saying why it does not recalculate |
| Orders!C2 → 2000, back to Summary | B2 2980, share 59.2%; the saved values unchanged |
| File → Download as Excel (.xlsx) | "Q1 sales (openpyxl).xlsx", 11,429 bytes; openpyxl: every style above, the merge, wrap, height, link, width, hidden F and 14, frozen B2; `=_xlfn.UNIQUE(...)` an array formula over A2:A4; `=_xlfn.XLOOKUP(...)`; saved values including 98765; Orders C2 = 2000 |
| File → Download this sheet as CSV (Summary) | BOM, CRLF, values as shown (the spill, 59.2%) |
| Sheets → Import → `club members.csv` (`;`, a blank row, `=HYPERLINK(...)`, `+44 …`, `"plain, with comma"`) | `;` detected; dates formatted; 12% and 7.50%; the HYPERLINK and the phone number kept as text; the blank row kept |
| Sheets E2E M1 → Download as Excel | its five sheets; the four table sheets as Excel tables named BiDemoSales, BiDemoSalesPivot…, so Sheet2's `=SUMIFS(BiDemoSales[revenue], …)` resolves in Excel; `order_date` as real dates |
| Import `budget.xlsx` that is not a workbook; `legacy.xls` | "budget.xlsx is not an Excel workbook…"; "legacy.xls is an Excel 97–2003 workbook (.xls)… save it as .xlsx"; Add sheets stays disabled |
| R118, before (the image before the fix): "Long sheet names (R118)", Sheet1 renamed to a 44-character name, Sheet2!A1 `='Quarterly revenue by region and product line'!A1*2` → Download as Excel | the file's sheet is cut to `Quarterly revenue by region and`, Sheet2's formula still names the 44-character sheet (a sheet the file does not have); with a third sheet whose name starts with the same 31 characters, "Could not download: Worksheet name already exists" |
| R118, after (rebuilt image): the same workbook → Download as Excel | sheets `Quarterly revenue by region and`, `Sheet2`, `Quarterly revenue by region (2)`; Sheet2!A1 `='Quarterly revenue by region and'!A1*2`, value 10 |

Found while building it (new code, fixed before commit): a spilled formula was written as a
*shared* formula group (each cell would compute the whole array) instead of an array formula;
the reader took an array's other cells as typed values, blocking the spill; ExcelJS silently
drops a hidden row that has no cells; `;` lost to `,` in CSV detection when the file had a blank
line; a file that was not a zip reported "Can't find end of central directory"; "1,200" lost its
thousands separator (Excel keeps `#,##0`).

## 2026-09-25 — Sheets formatting: fonts, colors, borders, merges, links, zoom, row heights, ADVERSARIAL_LOG R115–R117

**Why this round exists.** Excel users format as they go, and a sheet that
cannot hold a font, a fill, a border or a merged title is not one they can
hand to anyone. This round drives the new ribbon (Home, Insert, Data, View),
the context menus for cells, rows and columns, and the grid's new geometry
(rows and columns of their own size, hidden ones, zoom).

Workbook: **Sheets E2E Formatting** (`382872da-dc98-4280-8d2b-06c4c5e10c81`), kept.
Host build on the running app (`dist` swapped in), then the image before commit.

| Step | Result |
|---|---|
| Type a small table: Region / Sales / Notes, four regions, `=SUM(B2:B5)` | 3330; a long note runs on over D–F as in Excel |
| A1:C1 → Font Georgia (menu shows each font in its face), size 14, Bold | computed `font-family: Georgia`, 16.5 px, weight 600; row 1 grew 24 → 28 px; keyboard back in the grid |
| Fill palette → theme blue; Font color palette → white | B1 `rgb(68,114,196)` on `rgb(255,255,255)` |
| A1:C6 → Borders → All borders, then Thick outside borders | 18 border overlays; the thick frame drawn on the range's edge |
| C2 → Wrap text | row 2 grew to 91 px, text in four lines, A2/B2 at the bottom (Excel's default) |
| A2:B2 → Middle align, Center | `align-items: center`, `justify-content: center` |
| A9 "Quarterly sales by region", C9 "x", A9:C9 → Merge & Center | Excel's warning "keeps only the upper-left value"; Merge → one cell 311 px wide (A+B+C = 312), centered, C9 cleared, name box A9:C9 |
| From A10, ↑ then → | ↑ selects the merge as one (A9:C9); → leaves it to D9 |
| Ctrl+Z, Ctrl+Y | C9 "x" back and unmerged; merged again |
| E3 "Docs", Ctrl+K, `javascript:alert(document.cookie)` | refused: "Only web (http, https), email (mailto:) and in-workbook (#Sheet1!A1) links are allowed" |
| Same dialog, `example.com/docs` | stored `https://example.com/docs`; cell blue `rgb(5,99,193)`, underlined; a chip under the cell with the address |
| Chip → open; Ctrl+click the cell (window.open recorded, not followed) | both `["https://example.com/docs","_blank","noopener,noreferrer"]` |
| E5 "Jump to total", Insert → Link, `#Sheet1!B6` → chip | selection moved to B6; nothing opened |
| B2:B6 → Currency; Decrease decimal; Increase decimal | `$1,200.00`, `-$350.00`, `$3,330.00` → `$1,200.0` … → back to two places |
| Number format → Custom… `"$"#,##0.00;[Red]-"$"#,##0.00` | B3 red `-$350.00`, the format button reads "Custom" (after R117) |
| Reload the page | every format, the merge, the wrap, the links and the widths came back from the server |
| Ctrl+K in the grid | only the link dialog (address focused); the app's search palette stayed shut. On the Sheets list Ctrl+K still opens the palette |
| Right-click A3 → Insert 1 row above → Ctrl+Z (keyboard) | row inserted, the merge moved down with it; Ctrl+Z restored both (after R115) |
| Status bar +, level menu 150%, Ctrl+wheel ×3 in, ×3 out | 110% (col A 104 → 114 px, font 16.5 → 18.2 px); 150% (156 px); 100 → 130 → 100 |
| Column D header → Hide column D; ←/→ from E1 | headers A B C E, a marker on E; ← goes to C1, → back to E1 |
| Select C:E → Unhide columns | A B C D E again |
| Row 10 header → Row height… | the box focused with `18` selected; `40` → 53 px; double-click the row's edge → back to 24 px |
| A1:C1 → Format painter → drag A12:C12 | A12:C12 blue, Georgia, 16.5 px; the painter switched itself off |
| C3: Ctrl+5, Ctrl+I, Ctrl+U | `underline line-through`, italic; the three buttons pressed |
| A4 → Increase indent ×2; A5 → Increase font size ×2 | 24 px left padding; 11 → 12 → 14, row 5 → 28 px |
| A12:C12 → Clear formats; E3 → Clear hyperlinks → Ctrl+Z | styles gone, row back to 24 px; link gone, then back |
| View → Gridlines off / on | the lines go and return; borders stay |
| Copy B5:B6, G5 → Paste values only | G6 = 3330 as a number (not `=SUM`), currency kept |
| H5 → Paste formatting only, type -42 | red `-$42.00` inside the copied borders |
| E7: "Line one", Alt+Enter, "Line two", Enter | the cell holds `Line one\nLine two`, wraps, row 7 → 40 px |
| Drag column E's edge wider, one Ctrl+Z | 104 → 204 px; one undo → 104 (the drag is one step) |
| B20 → Insert 1 column left (column B crosses the merge A9:C9) | the merge grew to A9:D9 (415 px); `=SUM(B2:B5)` became `=SUM(C2:C5)`; undo restored both |
| Sheet tab menu → Rename → type, Enter | the box focused with "Sheet1" selected; tab reads "Summary" (after R117) |

Found on the way and fixed before commit (new code, not shipped):
- Ctrl+K opened the link dialog and the app's search palette together, and
  the typing went into the palette. The grid now stops the key, and the
  palette ignores a Ctrl+K another control has claimed.
- The link dialog closed with focus on the page; it hands it to the grid.
- A ribbon item that opens a dialog (Custom…) had its dialog's focus pulled
  back to the grid; the grid only takes the keyboard when no dialog is open,
  and after a question closes.
- Several Ctrl+wheel notches in one frame moved the zoom one step; each
  notch now steps from the latest zoom.

Findings from this round: R115–R117 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-25 — Sheets: grid and table sheets, imports, pivots, formulas over tables, saving to the lakehouse and the catalog, ADVERSARIAL_LOG R112–R114

**Why this round exists.** Sheets is new (Data & BI → Sheets): grid sheets
computed in the browser, table sheets computed by the lakehouse. Every
feature below was pressed in the browser on the running app, and the result
was read from the DOM, the formula bar, the save state and, for the
lakehouse side, from the Data Catalog page. The dev loop built on the host
and swapped the container's `dist`; the committed state was then verified
again on a real image build.

Workbook: **Sheets E2E M1** (`13cb50a0-51e1-4aa7-a354-1c96d058ada7`), kept.

### Grid sheet

| Driven | Read back |
| ------ | --------- |
| New workbook "Sheets E2E M1" | opens on `Sheet1`, "Saved" |
| Typing `Region` Tab `Amount` Tab `Qty` Tab `Total` Enter, then four rows | cells as typed; `=B2*C2` → `21`; numbers right-aligned |
| Tab, Tab, Enter from A6 | the active cell is `A7` (Enter returns to the row's first column) |
| Fill handle from D2 to D5 | `21, 60, 5, 30`; status bar `Average: 29 Count: 4 Sum: 116` |
| `=SUMI` Tab, then `A:A,"West",D:D` Enter | editor `=SUMIF(A:A,"West",D:D` (no suggestions after `D:D`), hint `SUMIF(range, criteria, [sum_range])`; cell `26` |
| `=SUM(` then drag B2 → B5, Enter | editor `=SUM(B2:B5`; bar `=SUM(B2:B5)`; cell `43` |
| `=1/0` | `#DIV/0!` in red |
| `=UNIQUE(A2:A6)` in H1 | `West, East, North, South` spilled to H1:H4 |
| `x` in H2 | H1 `#SPILL!`, title "The result needs 4×1 cells and a typed cell is in the way"; Delete restores the spill; Ctrl+Z back to `#SPILL!`; Ctrl+Y back to the spill |
| B2:B6 → Number format → Currency | `$10.50`, `$20.00`, `$3.00`; D and F unchanged |
| + → Grid sheet; `=Sheet1!D2*2`, `=SUM(Sheet1!D:D)` | `42`, `116` |
| Sheet1 menu → Rename → "Sales Data" | tabs `Sales Data · Sheet2`; Sheet2 bars `='Sales Data'!D2*2`, `=SUM('Sales Data'!D:D)` |
| Right-click A3 → Insert 1 row above | old row 3 on row 4 with `=B4*C4`; `=SUM(B2:B5)` → `=SUM(B2:B6)`; `=UNIQUE(A2:A6)` → `=UNIQUE(A2:A7)`; Ctrl+Z restores all three |
| A1:D6 copied, pasted at A10 (the app's own copy/paste handlers) | A10:D15 filled, formats kept, D11 `=B11*C11`; the whole-column `SUMIF` in F2 → `52` |
| Paste of text from outside: a quoted "Widget, large", `12.5%`, `2024-01-31`, `=1+1`, `$1,200` | `Widget, large`, `12.50%`, `2024-01-31`, `2`, `$1,200` |
| Reload of the page | every value, format and formula as left |
| Same workbook in a second tab: B17 "from tab two" (saved); first tab: C17 "from tab one" | first tab: "Saved elsewhere since you opened it · Reload theirs · Keep mine" |
| Reload theirs | B17 `from tab two`, C17 empty, "All changes saved", toast `Showing the saved "Sales Data"`, no page reload |
| Second tab D17 "theirs" (saved); first tab E17 "mine" → Keep mine; reload the second tab | E17 `mine`, D17 empty |

### Table sheets, pivots, formulas over tables

| Driven | Read back |
| ------ | --------- |
| + → Table sheet → Lakehouse → `analytics.bi_demo_sales` | tab `BiDemoSales`, `108 rows`, 7 columns with type icons, 816 ms |
| revenue menu → Sort largest to smallest | `941.3, 939.92, 917.17, …`; "All changes saved" |
| region funnel → Values | `AMER 36 · APAC 36 · EMEA 36`; untick AMER and APAC → `36 rows (filtered)`, chip "region in EMEA" |
| + Column, name `rev_per_unit`, `=[@re` | suggestions `[@region] text`, `[@revenue] number`; ArrowDown, Tab, `/[@units]` → `=[@revenue]/[@units]`, "Gives a number for each row." |
| Add column | `rev_per_unit` (Σ) `10.65622642` for 564.78 / 53 |
| Pivot → group by region, Sum of revenue | tab `BiDemoSalesPivot`: `AMER 25874.92 · APAC 10349.98 · EMEA 15524.94`, 529 ms |
| Sheet2: `=SUMIFS(BiDemoSales[revenue], BiDemoSales[region], "EMEA")` | `15524.94` (the pivot's EMEA) |
| `=XLOOKUP("APAC", BiDemoSalesPivot[region], BiDemoSalesPivot[sum_revenue])` | `10349.98` |
| `=BiDemoSales[revenue]` | `#VALUE!`, title naming SUM, SUMIFS, COUNTIFS, AVERAGEIFS, XLOOKUP, VLOOKUP, INDEX |
| `=COUNTIFS(BiDemoSales[plan],"pro",BiDemoSales[revenue],">500")` | `14` |

### Imports

| Driven | Read back |
| ------ | --------- |
| Upload CSV "Orders Jan-Feb 2024.csv" (quoted comma, escaped quotes, a blank, dates) | `analytics.orders_jan_feb_2024`, 4 rows; `Acme, Inc.`, `Initech "West"`, order_date typed as a date, the blank note blank |
| The same file again | `analytics.orders_jan_feb_2024 already exists. Pick a new name; importing never replaces a table.` |
| Data catalog tab, search `sheets_revenue` | `analytics.sheets_revenue_by_region`, `analytics.sheets_revenue_by_region_v2`, both "lakehouse"; Open → a table sheet with the three rows |
| Connection tab | "No database connections yet. Add one under Integrations → Data Sources." (none in this account; not created, to keep credentials out of the round) |

### Saving to the lakehouse and the catalog

| Driven | Read back |
| ------ | --------- |
| Pivot → Save to lakehouse → `sheets_revenue_by_region`, description, tags `finance, sheets-e2e` | before the fix: "Saved analytics.sheets_revenue_by_region — 3 rows", then "The table is saved, but it was not added to the catalog: … violates check constraint "catalog_assets_status_check"" |
| After the fix, `sheets_revenue_by_region_v2`, certified | "Saved … — 3 rows. In the data catalog with its columns, owner, tags, description and lineage." |
| Data Catalog, search `sheets_revenue` | `sheets_revenue_by_region_v2 · Certified · Lakehouse catalog · table · 2 · 3`, tags `sheets · finance · sheets-e2e` |
| Open the asset | lineage upstream `analytics.bi_demo_sales`; columns `region VARCHAR AMER`, `sum_revenue DOUBLE`; status Certified; owner the account's email; the description and tags as typed |

### Found while building, fixed before the commit

- Typing into the grid was lost when text arrived without a keydown (IME
  composition, dictation, the automation's insertText). The grid now keeps
  a textarea focused on the active cell that turns input into an edit.
- After Enter or Tab the grid took focus back one frame late; a key pressed
  in between went to the page (Tab walked to "Add sheet", Enter opened it).
  Focus now returns synchronously.
- Scrolled right past the first screen of columns, the row numbers scrolled
  away: the sticky header's container was only as wide as the viewport.
- Ctrl+A, the corner and a row header put the active cell at the far end and
  scrolled the view there. The active cell is now the anchor, as in Excel.
- Accepting a suggestion turned `=SUMI` into `=SUMISUMIF(`: the caret was
  read back from whatever input `editorRef` pointed at. It is now kept in
  the edit's state.
- The function hint was a bar that pushed the grid down one row mid-formula,
  so a click meant for B2 picked B1. It floats now.
- A tab menu's item also "clicked" the tab (portal events bubble through
  React).
- Catalog search dropped `_` from the term; LIKE's characters are escaped now.
- The catalog status was written as `active`, which the catalog's constraint
  refuses; it is `certified` or `draft`, and a failed catalog step can be
  retried from the dialog.
- The import dialog said "You own no lakehouse schema" while the schemas
  were still loading, kept the file's extension in the sheet name, and
  sent people to a Data Sources page under Data & BI, where there is none
  (it lives under Integrations).

Fixtures kept: the workbook above; `analytics.orders_jan_feb_2024`,
`analytics.sheets_revenue_by_region`, `analytics.sheets_revenue_by_region_v2`
(certified in the catalog).

Findings from this round: R112–R114 in the [Adversarial log](./ADVERSARIAL_LOG.md).

**On the committed image** (a real `docker compose up -d --build`, not the dev
copy of `dist`), the same workbook:

| Step | Result |
|---|---|
| Open "Sheets E2E M1" | grid renders, "Saved" |
| Click the "Sales Data" tab, press Tab twice, Enter | focus reached the "Sheet2" tab (`role=tab`, tabindex 0) and Enter switched to it |
| Right-click B3, then press on an empty part of the grid | the menu closed (it no longer relies on a click handler on a plain div) |
| Right-click B3 → "Insert 1 row above" | row 3 empty, "East" moved to A4 |
| Toolbar Undo | A3 "East", A4 "West", B3 "$20.00" again |
| Documentation → Work with data → "Sheets" | `/docs/sheets`, heading "Sheets" |

Found on the way: after choosing a context-menu item, keyboard focus fell to
the page body, so Ctrl+Z did nothing until the grid was clicked. It predates
this change; recorded as R115 and fixed with the formatting milestone.

## 2026-09-25 — Writing into a read-only Iceberg mount, and removing its catalog, before and after, ADVERSARIAL_LOG R111

**Why this round exists.** The mount dialog calls an Iceberg mount
read-only, but the statement guard refused writes only through a
data-lake mount, and removing a catalog drops its mounts with CASCADE.
Driven on catalogs registered for the round, on the development
catalog's endpoint, so that `local_rest` and its mounts stayed untouched.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 08:49:45 | on image `abd4e27a1a31`, Iceberg → Add catalog `r111_rest`, `http://192.168.1.85:8181`, `s3://iceberg/`, no authentication | `Registered r111_rest: 2 namespaces` |
| 08:50:04 | Mount `r107` as `ice_r111` | `Mounted 2 tables` |
| 08:50:21 | Query: `CREATE TABLE ice_r111.r111_written AS SELECT 1 AS id, 'written into a read-only mount' AS note` | succeeded (`Count 1`) |
| 08:50:35 | `SELECT id, note FROM ice_r111.r111_written` | `1 row(s)`: `1 · written into a read-only mount` |
| 08:51 | Remove `r111_rest` | confirm `Remove "r111_rest"? Its 1 mounted schema(s) go with it. Tables in the catalog itself are untouched.` → Remove |
| 08:51:34 | the same SELECT | `No access to schema "ice_r111"`; the DuckLake catalog: `r111_written` begin snapshot 559 (04:50:21 UTC), end snapshot 560 (04:51:07 UTC), the snapshot that ended `ice_r111` |
| 08:5x | ML Models → revenue_facts plan classifier → Predictions → Batch prediction | "Output schema (yours)": `analytics`, `ice_r107_after`, `ice_r107_final`, `ice_r107_fixed`, `ice_r107_four`, `ice_r107_regress`, `ice_r107_three`, `ice_r107_two`, `ice_sales` |
| 08:57:52 | staged for the after-drive, still on the old image: Add catalog `r111b_rest`; mount `r107` as `ice_r111b`; `CREATE TABLE ice_r111b.r111b_kept AS SELECT 1 AS id, 'kept in a mount before the fix' AS note` | registered; `Mounted 2 tables`; the row reads back |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 09:10:50 | on image `5c76a79c3e5c`, Query: `CREATE TABLE ice_r111b.r111_after AS SELECT 1 AS id`, then `INSERT INTO ice_r111b.r111b_kept VALUES (2, 'appended through the mount')` | each: `Schema "ice_r111b" is a read-only Iceberg mount — query it, or write to a regular schema. Publish to Iceberg puts a table into the catalog.`; `SELECT … FROM ice_r111b.r111b_kept` still reads its one row |
| 09:11:23 | Batch prediction dialog | "Output schema (yours)": `analytics` alone |
| 09:21:26 | on image `321d1a9f4ad9`, Remove `r111b_rest` → Remove | toast `Not removed: ice_r111b.r111b_kept is a table of your own inside a mounted schema, and would be dropped with it. Copy it to a regular schema first (CREATE TABLE analytics.… AS SELECT * FROM ice_r111b.r111b_kept), then drop the mounted schema in the explorer, which says every table in it goes.`; the catalog is still listed |
| 09:21:52 | `SELECT` the table, then `CREATE TABLE analytics.r111b_kept_copy AS SELECT * FROM ice_r111b.r111b_kept`, then read the copy | the row intact, `Count 1`, the copy reads `1 · kept in a mount before the fix` |
| 09:22:22 | explorer `ice_r111b (3)`: `r107_pub`, `r107_pub__publishing`, `r111b_kept · 817 B` → Drop schema | confirm `Drop schema "ice_r111b"? Every table in it is dropped too. This cannot be undone.` → `Dropped ice_r111b` |
| 09:23:04 | mount `r107` as `ice_r111c` (`Mounted 2 tables`), then Remove `r111b_rest` | `Removed r111b_rest`: a mount of views only does not block a removal |
| 09:23:57 | Query → Save as view → Schema | `analytics` alone |

Fixtures kept: `analytics.r111b_kept_copy`. The catalogs `r111_rest` and
`r111b_rest`, and their mounts, were removed as part of the round.

Findings from this round: R111 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-25 — Opening a swarm when its list cannot be read, before and after, ADVERSARIAL_LOG R110

**Why this round exists.** The swarm canvas took a failed read of the
owner's swarms for an empty account, and created "My First Swarm". Driven
from the gallery, where Open navigates client-side, so a fault installed
on the page reaches the canvas's first read: `GET
swarms?select=*&order=created_at.asc` answered 503 `R110 injected: the GET
did not reach the database`.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 01:47:57 | on image `b1409a24ad3d`, gallery (18 swarms), list read refused → Open on "R109 chat echo" | four refused `GET`s, then `POST swarms` 201 at 01:48:04 |
| 01:48:06 | the canvas | URL `?swarm=d10c86c5-…`, name "My First Swarm", 0 nodes, "Start wiring your swarm"; no toast |
| 01:48:25 | Back to swarm gallery | `My Swarms 19`: "My First Swarm" new at the top, "R109 chat echo · 2 nodes" unchanged |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 02:04:10 | on image `abd4e27a1a31`, gallery (19 swarms), list read refused → Open on "R109 chat echo" | four refused `GET`s and no `POST`; "Could not load your swarms · R110 injected: the GET did not reach the database. Nothing was opened or created, and your swarms are as you left them. · Try again · Back to gallery" |
| 02:04:26 | fault lifted → Try again | `GET` 200; the canvas opens "R109 chat echo" with 2 nodes |
| 02:04:40 | URL `?swarm=00000000-0000-4000-8000-000000000110` | toast `That swarm is not in your list · Opened "Swarm 1" instead.` |
| 02:04:49 | the gallery | still `My Swarms 19`, one "My First Swarm" |

Fixtures kept: the "My First Swarm" the before-drive created, with no
nodes, kept as the record of the defect. "R109 chat echo" is unchanged.

Findings from this round: R110 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-25 — A swarm chat opened through a failed read, and saves that failed in silence, before and after, ADVERSARIAL_LOG R109

**Why this round exists.** The swarm chat dialog ("Chat with this swarm" on
the canvas) read and wrote `swarm_chats` without reading the answers. Driven
on a swarm made for it, "R109 chat echo": an Input and an Output, so every
reply is the message itself and no model is called. The failures were
injected from the browser, since these are direct PostgREST calls. Each
refused call answered 503 with `R109 injected: the <METHOD> did not reach
the database`.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 01:01:21 | on image `57b70c28882f`, Chat → "R109 turn one", then "R109 turn two" | `POST` 201, then `PATCH` 204 of chat `c7a47254`; four bubbles |
| 01:01:38 | New chat → open "R109 turn one" with its read refused | four refused `GET`s; at 01:01:45 the conversation is highlighted over "Start the conversation below.", with no error |
| 01:01:54 | fault lifted → "R109 after a failed read" | `PATCH` 204 of `c7a47254`; the list retitles it "R109 after a failed read" |
| 01:02:07 | dialog closed, reopened, the conversation opened cleanly | two bubbles, "R109 after a failed read" and its reply: turns one and two are gone |
| 01:02:15 | update refused → "R109 unsaved turn" | the turn and its reply on screen, no error; reopened at 01:02:23 it is not there |
| 01:02:31 | New chat, insert refused → "R109 never saved" | the turn on screen, no error, the list unchanged |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 01:20:42 | on image `b7d8cdf59b82`, the conversation opened cleanly → "R109 after turn A" | `PATCH` 200; four bubbles |
| 01:20:49 | New chat → open it with its read refused | four refused `GET`s; toast `Could not open that conversation · R109 injected: the GET did not reach the database. You are still in the conversation you had open.`; not selected |
| 01:21:05 | fault lifted → "R109 after a refused read" | `POST` 201: a new conversation, not a `PATCH` of `c7a47254` |
| 01:21:13 | `c7a47254` opened cleanly | its four bubbles, intact |
| 01:21:19 | update refused → "R109 turn B, refused save" | `Not saved: R109 injected: the PATCH did not reach the database What you see here since the last save is gone when you leave this conversation.` and "Save again" |
| 01:21:29 | fault lifted → "Save again" | `PATCH` 200; the notice goes; reopened at 01:21:45, six bubbles, turn B among them |
| 01:21:56 | New chat, insert refused → "R109 insert refused" | the same notice; the list does not gain it |
| 01:22:02 | fault lifted → "Save again" | `POST` 201; the list gains "R109 insert refused", selected |
| 01:22:23 | list read refused → dialog closed and reopened | `Could not load conversations: R109 injected: the GET did not reach the database`, over the last list read |
| 01:36:14 | on image `b1409a24ad3d` (the notice's missing stop added), update refused → "R109 turn C, refused save" | `Not saved: R109 injected: the PATCH did not reach the database. What you see here since the last save is gone when you leave this conversation.` |
| 01:36:21 | "Save again" | `PATCH` 200; reopened, eight bubbles |

Fixtures kept: the swarm "R109 chat echo" (`d10c86c5`) and its three
conversations: "R109 after a failed read" (`c7a47254`, eight messages),
"R109 after a refused read" and "R109 insert refused".

Findings from this round: R109 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-25 — A parked swarm run in Recent runs, before and after, ADVERSARIAL_LOG R108

**Why this round exists.** Recent runs showed any status it did not know as
"Running", and a run parked at a human approval is stored as `suspended`.
Driven on runs earlier rounds left parked: five "Approval durability check
(schedule)" runs whose approvals are pending, and four from R92 whose
approvals were decided before R92's fix. Swarm Observability, which prints
the raw status, was the reference.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 23:40:14 | on image `b413a02e6aad`, Agent Swarms → Recent runs | five `Approval durability check (schedule) · Running` rows, `1175m 26s`, `1240m 3s`, `1272m 8s`, `1300m 42s` and `1321m 35s`, each with only Open and Trace; the header `Cancel a running or paused run here.` |
| 23:44:22 | Swarm Observability | the same five runs `suspended`, started Sep 24 at 04:04:38, 03:00:02, 02:27:57, 01:59:23 and 01:38:29; the header's bell `Pending approvals (5)` |

### The first fix, and what two drives found in it

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 00:11:18 | on image `0bbcf3e09334` (every `suspended` run read "Awaiting approval"), Recent runs | the five read `Awaiting approval` with `Review approval` and no duration; the header `Cancel a running run here; a run waiting for an approval goes on or stops when the approval is decided.` |
| 00:11 | "Review approval" on the first row | the inbox opens: `Pending Approvals 5`, paused 20h, 21h, 21h, 22h, 22h ago |
| minutes later | the rest of the list | four more rows read `Awaiting approval` with `Review approval`, but none of their approvals is in the inbox. They are runs `3bf09de5`, `24e93ade`, `4f0c9e04` and `987e92ba`, from Sep 23. Trace on `3bf09de5`: `suspended`, with its `Human approval` step `SUCCESS`, which is R92's forked resume |
| 00:29:22 | on image `a5d418394794` (the requests decide), Recent runs | five `Awaiting approval` with `Review approval`; four `Decided, not resumed` with no button, but still `45h 30m`, `46h 1m`, `46h 30m` and `46h 51m` |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 00:41:53 | on image `57b70c28882f`, Recent runs | 5 `Awaiting approval`, each with `Review approval` and no duration; 4 `Decided, not resumed`, `started 1d ago`, with no duration and no button; 7 `Error` and 14 `Success` as before, with their durations |
| 00:42:04 | "Review approval" on the fifth parked row | the inbox opens: `Pending Approvals 5`, paused 20h, 21h, 22h, 22h, 23h ago |
| 00:42 | scrolled to a `Decided, not resumed` row | it sits directly under `Approval durability check (schedule) (api) · Success · 5s · 3 steps`, the run that holds its work |

Nothing was approved or rejected. Fixtures kept: the nine parked runs and
their five pending approvals, all from earlier rounds.

Findings from this round: R108 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-24 — Replacing an Iceberg table with one the catalog cannot store, before and after, ADVERSARIAL_LOG R107

**Why this round exists.** "Publish to Iceberg" with "Replace it (drop,
then create)" ran a DROP and then a CREATE. A create that failed after the
drop left the catalog with no table. A column type the Iceberg writer
refuses, an INTERVAL, makes that failure on demand. Driven on tables and
an Iceberg namespace made for the purpose: `analytics.r107_src` (1 row),
`analytics.r107_bad` (an INTERVAL column), `analytics.r107_src2` (2 rows),
and namespace `r107` in the development catalog `local_rest`. A mount is
the read-only check of what the catalog holds: it reports "Mounted N
tables".

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 22:39:47 | on container image `987d1ff3b46c`, `r107_bad` → Publish to Iceberg → `local_rest` / `r107` / `r107_probe`, Refuse | toast `Invalid Input Error: Column type INTERVAL is not a valid Iceberg Type.` The writer refuses the type, with no drop involved |
| 22:40:28 | `r107_src` → Publish → `r107` / `r107_pub`, Refuse | `Published 1 row(s) to r107.r107_pub` |
| 22:41:13 | the same again, Refuse | `Catalog Error: Table with name "r107_pub" already exists` |
| 22:41:54 | `r107_bad` → Publish → `r107` / `r107_pub`, Replace it | the same INTERVAL error; the catalog's log: `Dropped table: r107.r107_pub` |
| 22:42:45 | Iceberg → Mount a namespace → `local_rest` / `r107` as `ice_r107` | `Mounted 0 tables` |

### The first fix, and what a drive found in it

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 22:59:26 | on image `d071cd16aab0` (staging under the fixed name `<table>__publishing`), `r107_src` → Publish → `r107_pub`, Refuse, to put the table back | `Published 1 row(s) to r107.r107_pub` |
| 22:59:54 | `r107_bad` → Replace `r107_pub` | the INTERVAL error |
| 23:00:27 | Mount `r107` as `ice_r107_after` | `Mounted 1 table`: the table survived |
| 23:04 | Query: `CREATE TABLE analytics.r107_src2 AS SELECT * FROM (VALUES (1, 'first'), (2, 'second')) AS t(id, note)` | `Count 2` |
| 23:05:30 | `r107_src2` → Replace `r107_pub` | `Published 2 row(s) to r107.r107_pub` |
| 23:05 | Query: `SELECT * FROM ice_r107_after.r107_pub ORDER BY id` | `2 row(s)`: `1 first`, `2 second` |
| 23:05:55 | Mount `r107` as `ice_r107_regress` | `Mounted 1 table`: no staging table left |
| 23:14:01 | `r107_src` → Publish → `r107` / `r107_pub__publishing`, Refuse: a table the owner happens to give that name | `Published 1 row(s) to r107.r107_pub__publishing` |
| 23:14:24 | Mount `r107` as `ice_r107_two` | `Mounted 2 tables` |
| 23:15:08, 23:16:35 | `r107_src2` → Replace `r107_pub` | `… HTTP 500 for HTTP DELETE to '…/namespaces/r107/tables/r107_pub__publishing…'`. The replace was dropping the owner's table. The catalog refused it only because its SQLite store was locked (`[SQLITE_BUSY] The database file is locked` in its log) |
| 23:15:26 | Mount `r107` as `ice_r107_three` | `Mounted 2 tables` |
| 23:18 | restarted the catalog container, whose state is on a volume; its REST listing of `r107` | `r107_pub`, `r107_pub__publishing` |
| 23:20:39 | `r107_src2` → Replace `r107_pub`, same dialog | `Published 2 row(s) to r107.r107_pub`; the catalog's log, first: `Dropped table: r107.r107_pub__publishing` |
| 23:20:52 | Mount `r107` as `ice_r107_four` | `Mounted 1 table`; the REST listing shows `r107_pub` alone. The owner's table is gone |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 23:35:40 | on image `b413a02e6aad` (a staging name made for each publish), `r107_src` → Publish → `r107` / `r107_pub__publishing`, Refuse: the owner's table put back | `Published 1 row(s) to r107.r107_pub__publishing` |
| 23:36:01 | `r107_bad` → Replace `r107_pub` | the INTERVAL error; the catalog's log looks up `r107_pub__publishing_4482b342`, which was never created, and drops nothing |
| 23:36:23 | Mount `r107` as `ice_r107_fixed` | `Mounted 2 tables` |
| 23:36:55 | `r107_src` → Replace `r107_pub` | `Published 1 row(s) to r107.r107_pub`; the catalog's log, in order: committed `r107_pub__publishing_81ccfb38`, dropped `r107_pub`, committed `r107_pub`, dropped `r107_pub__publishing_81ccfb38` |
| 23:37:17 | Mount `r107` as `ice_r107_final` | `Mounted 2 tables` |
| 23:37 | Query: `SELECT … FROM ice_r107_final.r107_pub`, then the same from `ice_r107_final.r107_pub__publishing` | `1 row(s)` each, `1 published`: the owner's table is untouched |

The one path not driven is a catalog refusing the drop of the old table,
which should now remove the staging table. The lock that produced it
cannot be brought on at will, so a unit test covers it.

Fixtures kept for review:

- Lakehouse tables `analytics.r107_src`, `analytics.r107_bad` and
  `analytics.r107_src2`.
- Iceberg namespace `r107` in `local_rest`, with `r107_pub` and
  `r107_pub__publishing`.
- The mounts `ice_r107`, `ice_r107_after`, `ice_r107_regress`,
  `ice_r107_two`, `ice_r107_three` and `ice_r107_four`, plus
  `ice_r107_fixed` and `ice_r107_final`.

Some of those mounts show views over tables that have since been dropped
or recreated.

Findings from this round: R107 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-24 — Deleting a dataset when the database refuses, before and after, ADVERSARIAL_LOG R106

**Why this round exists.** The browser's `deleteDataset` never read the
database's answer, so the page said "Deleted" whatever happened. The
refusal was injected from the browser, which reaches this write because
it is a direct PostgREST call: the DELETE on `/rest/v1/user_data_tables`
answered 500 with `R106 injected: the delete did not reach the database`.
Driven on a scratch dataset only.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 22:02:40 | on container `79cc1f0208c9`, BI → Data preparation → Local tables → `sftest_campaigns` onto the canvas → Flow name `r106 scratch`, Output table `r106_scratch` → Run & save dataset | toast `Saved "r106_scratch" with 4 rows`; Local tables reads 34 |
| 22:03:25 | refusal injected → `r106_scratch` → Delete dataset (`1 thing depends on this dataset…`) → type `r106_scratch` → Delete dataset | one DELETE refused; toast `Deleted "r106_scratch"`; the dialog closes |
| 22:03:31 | the refreshed list | `r106_scratch · 33 cols · 4 rows · prep` still at its top |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 22:20:27 | on container `987d1ff3b46c`, refusal injected → the same delete | toast `"r106_scratch" was not deleted: R106 injected: the delete did not reach the database`; the dialog stays open; the list still shows it |
| 22:20:46 | refusal removed → Delete dataset in the same dialog | toast `Deleted "r106_scratch"`; it leaves the list |
| 22:21 | page reloaded → Data preparation → Local tables | `33`, with no `r106_scratch` |

Fixtures: the scratch dataset is gone, deleted as part of the round. The
prep flow `r106 scratch` remains, now pointing at a dataset that no longer
exists.

Findings from this round: R106 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-24 — Building a feature view's training set onto an existing table, before and after, ADVERSARIAL_LOG R105

**Why this round exists.** R101's sweep. A training set is written with
`CREATE OR REPLACE TABLE <output>`, and nothing asked what was at the name.
Driven only on tables and a feature view made for this round. The view's
source `analytics.revenue_facts` is only read.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 21:05 | on container `0be169f13e15`, ML Models → Feature views → New view `r105_features`, table `analytics.revenue_facts`, key `order_id`, latest row wins by `placed_at` → Create | toast `Created r105_features`; the card reads `key order_id · latest by placed_at · not attached to a model` |
| 21:07 | Lakehouse → `CREATE TABLE analytics.r105_keep AS SELECT 105 AS id, 'not a training set' AS note` | `Count 1` |
| 21:12:52 | Training set → Label table `revenue_facts`, As of `placed_at`, key `order_id`, Write to `r105_keep` → Build | toast `The label table already has a column named placed_at. …` (the view's own validation) |
| 21:13 | Lakehouse → `CREATE TABLE analytics.r105_labels AS SELECT order_id, placed_at AS label_at FROM analytics.revenue_facts ORDER BY order_id LIMIT 20` | `Count 20` |
| 21:13:53 | Training set → Label table `r105_labels`, As of `label_at`, key `order_id`, Write to `r105_keep` → Build | toast `Built analytics.r105_keep — 20 row(s)`; the panel shows the ASOF JOIN it ran |
| 21:15 | `SELECT * FROM analytics.r105_keep LIMIT 2` | `order_id · label_at · net_usd · payment_rows · status · …`: `1002 · 2026-03-25 · 807.94 · …`. The row and its columns are gone |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 21:29 | on container `79cc1f0208c9`, `CREATE TABLE analytics.r105_keep2 AS SELECT 1052 AS id, 'still not a training set' AS note` | `Count 1` |
| 21:30:23 | Training set → `r105_labels` / `label_at` / `order_id` → Write to `r105_keep2` → Build | toast `analytics.r105_keep2 already exists, and no training set of yours wrote it. Building there would replace its rows with the training set. Pick a new output table, or drop that table first if replacing it is what you mean.` |
| 21:30:35 | Write to `r105_labels` → Build | toast `analytics.r105_labels is the label table. Building the training set there would replace the labels it is built from. Pick another output table.` |
| 21:30:52 | Write to `r105_keep` (written by the before-drive's build) → Build | toast `Built analytics.r105_keep — 20 row(s)` |
| 21:32 | `SELECT (… r105_keep2 note), (… count r105_labels), (… count r105_keep)` | `still not a training set · 20 · 20` |

Fixtures kept: the feature view `r105_features`, and the tables
`analytics.r105_keep` (a training set), `analytics.r105_keep2` and
`analytics.r105_labels`.

Findings from this round: R105 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-24 — A batch prediction written onto an existing table, before and after, ADVERSARIAL_LOG R104

**Why this round exists.** R101's sweep. The sandbox writes a batch
prediction's output with `CREATE OR REPLACE TABLE`, and starting one asked
only whether the output schema was yours. Driven only on tables made for
this round. The input `analytics.revenue_facts` is only read.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 20:18 | on container `cf409cf0925a`, Lakehouse → `CREATE TABLE analytics.r104_keep AS SELECT 104 AS id, 'not a prediction' AS note` | `Count 1` |
| 20:21:46 | ML Models → `revenue_facts plan classifier` → Predictions → Batch prediction → Input `analytics.revenue_facts`, Output schema `analytics`, Output table `r104_keep`, `v7 · logistic_regression · production` → Predict | toast `Batch prediction started` |
| 20:22:24 | the job list | `succeeded · batch via ui · analytics.revenue_facts → analytics.r104_keep · 836 · 10s · moderate · 0.11` |
| 20:23 | Lakehouse → `SELECT count(*) FILTER (WHERE note = 'not a prediction') FROM analytics.r104_keep` | `Binder Error: Referenced column "note" not found … Candidate bindings: "net_usd", "order_id", "proba_enterprise", …`; `count(*)` = 836 |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 20:48 | on container `0be169f13e15`, `CREATE TABLE analytics.r104_keep2 AS SELECT 1042 AS id, 'still not a prediction' AS note` | `Count 1` |
| 20:49:43 | Batch prediction → output `r104_keep2` → Predict | the dialog stays open: `analytics.r104_keep2 already exists, and no prediction of yours wrote it. Scoring into it would replace its rows with predictions. Pick a new output table, or drop that table first if replacing it is what you mean.` |
| 20:49:53 | the same dialog → output `revenue_facts`, filter `region = 'EMEA'` → Predict | `analytics.revenue_facts is the table being scored. Writing the predictions there would replace it with only the rows the filter keeps. Pick another output table.` |
| 20:50:15 | output `r104_keep` (written by the before-drive's prediction), filter cleared → Predict | `Batch prediction started`, then `succeeded · … → analytics.r104_keep · 836 · 60s` |
| 20:52 | `SELECT (… r104_keep2 note), (… count revenue_facts), (… count r104_keep)` | `still not a prediction · 836 · 836` |

Fixtures kept: `analytics.r104_keep`, now predictions, and
`analytics.r104_keep2`, the refused target.

Findings from this round: R104 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-24 — A SQL model named like an existing table, before and after, ADVERSARIAL_LOG R103

**Why this round exists.** A model's name is its target table, and a build
runs `DROP <other shape> IF EXISTS` and then `CREATE OR REPLACE` on it.
Saving a model checked the name against materialized views, not ordinary
tables. Driven only on tables made for this round.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 10:13 | on container `820d1915bef9`, Lakehouse → `CREATE TABLE analytics.r103_keep AS SELECT 103 AS id, 'a table no model built' AS note` | `SELECT *` → `103 · a table no model built` |
| 10:14:57 | SQL Models → New model → Name `r103_keep`, Schema `analytics`, Stored as `View — the query runs on every read`, SQL `SELECT 1 AS x` → Create | toast `Created r103_keep`; the list shows `r103_keep VIEW` |
| 10:15:09 | Build this and what it reads | toast `Built 1 model`; run `r103_keep · built · 1 rows` |
| 10:15 | Lakehouse → `SELECT * FROM analytics.r103_keep` | `x integer`, `1`. The table and its row are gone |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 10:30 | on container `cf409cf0925a`, `CREATE TABLE analytics.r103_keep2 AS SELECT 1032 AS id, 'still no model built this' AS note` | `Count 1` |
| 10:31:12 | New model → `r103_keep2`, `analytics`, View, `SELECT 1 AS x` → Create | toast `analytics.r103_keep2 already exists, and this model did not build it. Building the model would replace it (a view-stored model drops the table first). Give the model another name, or drop the table first if replacing it is what you mean.`; no model created |
| 10:31:40 | open `r103_keep` → SQL `SELECT 2 AS x` → Save | `Saved r103_keep`. A model keeping its own target is not asked |
| 10:31:50 | Build this and what it reads | `Built 1 model` |
| 10:32 | `SELECT (SELECT x FROM analytics.r103_keep), (SELECT note FROM analytics.r103_keep2)` | `2 · still no model built this` |

Fixtures kept: the model `r103_keep` (a view, `SELECT 2 AS x`), and the table
`analytics.r103_keep2`.

Findings from this round: R103 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-24 — Importing a dataset as a "new" table onto an existing name, before and after, ADVERSARIAL_LOG R102

**Why this round exists.** R101's sibling sweep. The Lakehouse "New table"
dialog's Import dataset half built with `CREATE OR REPLACE TABLE`, while its
Define columns half refuses an existing name. Driven only on tables made for
R101 and this round.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 09:39 | on container `91a6460a6a93`, `analytics.r101_keep2` holds `7 · still precious` (R101's after-drive) → schema `analytics` → New table (+) → Import dataset → Platform dataset `f1_constructor_standings` → Table name `r101_keep2` → Import | toasts `Imported 10 row(s)` and `Table analytics.r101_keep2 ready` |
| 09:40 | `SELECT * FROM analytics.r101_keep2 LIMIT 3` | `wins · points · position · constructor · nationality`: `14 · 833 · 1 · McLaren · British`, …. The previous row and columns are gone |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 09:59:47 | on container `820d1915bef9`, New table → Import dataset → `f1_constructor_standings` → `r101_keep2` → Import | toast `analytics.r101_keep2 already exists. Importing would replace its rows with this dataset. Pick a new name, or drop the table first if replacing it is what you mean.`; the dialog stays open |
| 10:00:00 | the same dialog, Table name `r102_import` → Import | `Imported 10 row(s)`, `Table analytics.r102_import ready`; `count(*)` = 10 |
| 10:00:30 | `CREATE TABLE analytics.r102_keep AS SELECT 102 AS id, 'untouched by the import' AS note` | `Count 1` |
| 10:00:59 | New table → Import dataset → `f1_constructor_standings` → `r102_keep` → Import | the same refusal, naming `analytics.r102_keep` |
| then | `SELECT * FROM analytics.r102_keep` | `102 · untouched by the import` |
| 10:01:32 | `SELECT 1 AS one` → Save as view → `analytics` / `r102_keep` (R101's check, now shared) | `analytics.r102_keep is an existing table, not a materialized view. …` |

Fixtures kept, all made for R101 and R102 and holding nothing else:
`analytics.r101_keep` (a manual view), `analytics.r101_keep2` (now the f1
constructor standings, from the before-drive), `analytics.r102_keep` and
`analytics.r102_import`.

Findings from this round: R102 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-24 — Saving a materialized view onto an existing table's name, before and after, ADVERSARIAL_LOG R101

**Why this round exists.** A materialized view is built with `CREATE OR
REPLACE TABLE`, and "Save as view" never asked what was already at the name
it was given. Driven only on tables made for the purpose.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 09:10 | on container `5c5895ec55d0`, Lakehouse → Query → `CREATE TABLE analytics.r101_keep AS SELECT 1 AS id, 'precious row' AS note` → Run | `1 row(s)`, `Count 1` |
| then | `SELECT * FROM analytics.r101_keep` → Run | `id integer · note varchar`, `1 · precious row` |
| 09:11:27 | editor `SELECT 42 AS answer` → Save as view → Schema `analytics`, Table name `r101_keep`, `manual` → Save and build | toast `Built analytics.r101_keep — 1 row(s)`; the dialog closes. It said nothing about the name |
| then | `SELECT * FROM analytics.r101_keep` → Run | `answer integer`, `42`. The row and both columns are gone |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 09:24 | on container `91a6460a6a93`, `CREATE TABLE analytics.r101_keep2 AS SELECT 7 AS id, 'still precious' AS note` → Run, then `SELECT *` | `7 · still precious` |
| 09:25:18 | `SELECT 42 AS answer` → Save as view → `analytics` / `r101_keep2` / `manual` → Save and build | toast `analytics.r101_keep2 is an existing table, not a materialized view. Saving a view there would replace its rows with this query's answer. Pick a new name, or drop the table first if replacing it is what you mean.`; the dialog stays open |
| then | Escape, then `SELECT * FROM analytics.r101_keep2` | `7 · still precious`, untouched |
| 09:25:54 | `SELECT 43 AS answer` → Save as view → `analytics` / `r101_keep` (a registered view since the before-drive) → Save and build | toast `Built analytics.r101_keep — 1 row(s)`; `SELECT *` reads `answer · 43` |

Fixtures kept: `analytics.r101_keep`, now a manual materialized view of
`SELECT 43 AS answer`, and `analytics.r101_keep2`, an ordinary table. Both
were made for this round and hold nothing else.

Findings from this round: R101 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-24 — Calling a Builder MCP server that had scaled to zero, before and after, ADVERSARIAL_LOG R100

**Why this round exists.** Builder servers stop after 15 idle minutes by
default, and the first call starts them again, which takes up to 90 s at the
endpoint. Agents and swarm Tool nodes gave that first request 15 s, and Test
connection gave it 12 s. "Stop" on the server's page puts it in the same
state an idle spell does.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 03:53 | on container `52e61c76e4f1`, MCP Builder → `R99 hello` → Stop | no `nb-` container left; the Deploy tab reads "the server starts on the first call (a few seconds)" |
| 03:53:42 | Agent Swarms → `R99 MCP tool call` → MCP Tool Call node, `{"name": "r100 before"}` → Test this node → Run node | after about 12.5 s, OUTPUT `{"error":"The operation was aborted due to timeout"}`. The endpoint answered `initialize` 200 after 17.7 s; the sandbox logged no DELETE |
| 03:54:58 | MCP Builder → Stop again | the sandbox is gone |
| 03:55:19 | Integrations → MCP Servers → `R99 hello` (`● Active · 2 tools · 37m ago`) → Refresh | after about 11 s, the toast `Probe failed: The operation was aborted due to timeout`; the card reads `● Error · 2 tools · 0s ago` |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 04:11 | on container `5c5895ec55d0`, MCP Builder → `R99 hello` | the Deploy tab reads "the server starts on the first call, which waits around half a minute for it, and stops again after 15 minutes idle" → Stop |
| 04:12:28 | the same node, `{"name": "r100 after"}` → Run node | after 28.4 s, OUTPUT `…"content":[{"text":"Hello, r100 after!","type":"text"}],"isError":false…`. The endpoint logged initialize 200 in 23.4 s, then 202 and 200; the sandbox logged `DELETE /mcp 200` |
| 04:13:23 | MCP Builder → Stop | the sandbox is gone |
| 04:13:37 | MCP Servers → `R99 hello` (still `● Error` from before) → Refresh | after about 16 s, the toast `Discovered 2 tools`; the card reads `● Active · 2 tools · 0s ago`. The endpoint's initialize took 14.6 s |

Fixtures: as R99 (`R99 hello`, registered, and the swarm `R99 MCP tool
call`). The server is left running from the last Refresh, and idle reaping
will stop it.

Findings from this round: R100 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-24 — A swarm calling a Builder MCP server's tool, before and after, ADVERSARIAL_LOG R99

**Why this round exists.** The agents' MCP client sent `tools/list` and
`tools/call` with no `initialize` and no session id. Measured first against
fastmcp 4.0.3 from the sandbox image, both came back `400 Bad Request:
Missing session ID`. The swarm Tool node's MCP Tool Call uses the same
client with no model in the loop, so it can be driven deterministically.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 03:17 | MCP Builder → New server `R99 hello` (Hello world template) → Deploy | `Deployed — 2 tools.` |
| 03:17:43 | Access → Your agents switch on | toast `Registered — your agents can call it now.`; switch reads on |
| 03:19 | Agent Swarms → New Swarm (`Swarm 17`) → Input, Tool (deterministic), Output, wired; Tool → MCP Tool Call, `R99 hello`, `greet`, `{"name": "r99 before"}` | the node shows its three fields filled |
| 03:19:59 | Test this node → Run node | after 1.4 s, OUTPUT `{"error":"400: {\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32600,\"message\":\"Bad Request: Missing session ID\"}}"}`. MCP endpoint log `status 400`; sandbox log one bare `POST /mcp` → 400 |

The swarm was not saved. Leaving the canvas left `Swarm 17` empty, which is
why the after-drive rebuilt the node.

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 03:38 | on container `52e61c76e4f1`, `Swarm 17` renamed `R99 MCP tool call`, one Tool node set as before with `{"name": "r99 after"}` → Save | toast `Swarm saved` |
| 03:39:05 | Test this node → Run node, sandbox cold (stopped by the rebuild) | about 13 s, OUTPUT `{"error":"The operation was aborted due to timeout"}`. The endpoint's `initialize` was answered 200 after 35.5 s of cold start. That is a separate fault, queued for R100 |
| 03:39:49 | Run node again, sandbox now warm | OUTPUT `…"content":[{"text":"Hello, r99 after!","type":"text"}],"isError":false…`. Sandbox log: `POST 200`, `202`, `POST 200`, `DELETE /mcp 200` |
| 03:41:24 | arguments `{"name": "r99 again"}` → Run node | `Hello, r99 again!`; endpoint log 1.48 s, 1.11 s, 1.17 s for initialize, initialized and the call; sandbox `DELETE /mcp 200` |

Fixtures kept: the MCP server `R99 hello`, registered for agents, and the
swarm `R99 MCP tool call` with its one MCP Tool Call node.

Findings from this round: R99 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-24 — Deploying and testing an MCP server that keeps its streams open, before and after, ADVERSARIAL_LOG R98

**Why this round exists.** Every MCP reply was read with `res.text()`,
which on an event stream waits for the server to close it. The spec only
says a server SHOULD close it. On a stock FastMCP server the deploy failed
this way once, then passed 8 of 8 (23–42 s, one of 119 s), so a server that
keeps its streams open was written to make it certain: MCP Builder → New
server `R98 held stream`. It is a small Streamable HTTP server that answers
at once and then holds each stream open for 90 s with keep-alives every
5 s.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 02:18:26 | every stream held open → Deploy | after **49.1 s** the toast `The operation was aborted due to timeout`; badge **Error**. Sandbox log (UTC): `answered initialize` 22:18:42.44, next request 22:18:57.44 (15 s later), `answered tools/list` 22:18:57.45 |
| 02:20:20 | only `tools/call` held open → Deploy | `Deployed — 1 tool.`; badge Running |
| 02:22:10 | Tools → `echo` → `{ "text": "r98 before" }` → Call echo | sandbox `answered tools/call` 5 ms after the click; the server function threw `The operation was aborted due to timeout` at **61.2 s**; the page showed no output and no toast, and the button stayed disabled on its spinner (read again 50 s later, unchanged) |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 02:47:12 | on container `1d2c788bbb32`, every stream held open → Deploy | `Deployed — 1 tool.` in **15.1 s**; badge Running. Sandbox: `answered initialize` 22:47:24.250, next request 70 ms later, `answered tools/list` 22:47:24.322 |
| 02:47:50 | Tools → `echo` → `{ "text": "r98 after" }` → Call echo | `{"content":[{"type":"text","text":"echo: r98 after"}]}` in **1.26 s**, the stream still held open |
| 02:48:40 | `{ "text": "never" }` → Call echo (the server never answers this one) | sandbox `stayed silent on tools/call`; after **61.0 s** the console shows `Error: tools/call → no answer within 60s` and the button is enabled again |
| 02:50:16 | `HTTP Test` (stock FastMCP, streams close) → Deploy | `Deployed — 2 tools.` in about 18 s |

Fixtures kept: the `R98 held stream` app, whose source is the after
version: every stream held open, and `never` left unanswered. Stop it
from its page when done; idle reaping takes it otherwise. One slip on
the way, recorded because it cost a deploy's worth of time: a paste over
the editor with `execCommand("selectAll")` did not select CodeMirror's
whole document once its lines were virtualised, so the new source was
inserted ahead of the old one (174 lines). It was caught by reading the
editor back line by line before deploying, and redone with the editor's
own Ctrl+A.

Findings from this round: R98 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-24 — AI-drafting an ETL pipeline under a model rule, before and after, ADVERSARIAL_LOG R97

**Why this round exists.** IAM's model rules are enforced at `/api/chat`.
The ETL, lakehouse and skill generators, the graph builder and embedded BI
called providers directly. Model rules apply to superadmins in the default
allow mode, so this account can carry one.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 01:13 | Admin → IAM → Access → Model access → User → this account → OpenRouter `openrouter/free` → Add rule → Save rules | the chip `OpenRouter · openrouter/free`; `Save rules` greys out |
| 01:13:20 | from the same session, `POST /api/chat` asking for `openai/gpt-4o-mini` | `403 {"error":"model_not_allowed","message":"Your administrator has not allowed openrouter/openai/gpt-4o-mini for your account. …"}` — the guarded door refuses |
| then | ETL Pipelines → `Test2` (Code) → AI assist, picker left as it opens (`OpenRouter · Server default`), brief `Load a three-row table called r97_probe with columns id and name.` → Generate | `POST /api/etl/generate → 200`, a drafted pipeline, and `"model":"openai/gpt-4o-mini"` |

The model the rule refused on the chat path, called anyway, for a click on
the page's own default.

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 01:31 | on container `3c3996a4c9ad`, the same pipeline, brief and untouched picker → Generate | `POST /api/etl/generate → 403`; the toast `Your administrator has not allowed openrouter/openai/gpt-4o-mini for your account. Ask a superadmin to adjust your model access.`; nothing in the editor, `Save` still greyed |
| 01:32 | the picker set to `openrouter/free` → Generate | `→ 200` with a drafted pipeline and `"model":"openrouter/free"` |
| 01:34 | the rule removed → Save rules, then reload | `No rules — this user is unrestricted (unless rules apply from elsewhere).` |
| 01:35 | `Test2` reopened | its original code, `# AgentSwarms ETL pipeline.` at the top; nothing generated was saved |

Fixtures: none left. The rule is gone and `Test2` is as it was. One
accident on the way, recorded because it matters: a stale element reference
landed on the delete button of the pipeline `kafka orders`; its
confirmation dialog stopped it, it was cancelled, and a reload showed all
20 pipelines, that one included.

Findings from this round: R97 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-24 — A workflow's Notebook step with the server runtime switched off, before and after, ADVERSARIAL_LOG R96

**Why this round exists.** Admin → Developer runtime says the runtime
switch decides whether notebooks may launch server kernels. Only the
interactive route asked. The master switch applies to superadmins too, so
it can be driven from this account; the grant half and the published-key
half are held by the tests.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| earlier | Workflows → New workflow `R96 notebook step` → Notebook step → `My Python notebook` → Save | toast `Saved` |
| 00:01:20 | Admin → Developer runtime → **Enable server runtime** off → Save settings, then reload | the switch reads off from the server |
| 00:01 | Developer workspace → `My Python notebook` | `Server runtime required — Notebooks run on real container kernels … That runtime isn't available yet, so cells can't execute.`; no Run button |
| 00:01:47 | `docker ps -a --filter name=nb-` | none |
| 00:02:12 | Workflows → `R96 notebook step` → Run now | toast `Run started`; the host: `nb-f2968348-31f8-4d03-8680-971ec7a3fd7e · Up 8 seconds` |
| 00:02:34 | — | `Showing run · succeeded`; Runs: `succeeded · manual · My Python notebook · Logs f2968348` |
| after | the runtime switched back on for the rebuild | reads on after a reload |

The same notebook, the same minute, the same switch: the workspace refused
to run it, and the workflow ran it on a server kernel.

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 00:19:26 | on container `a949a9bae152`, **Enable server runtime** off → Save settings, then reload | reads off |
| 00:19:33 | `docker ps -a --filter name=nb-` | none |
| 00:20:11 | `R96 notebook step` → Run now | `Showing run · failed`; Runs: `failed · less than a minute ago` above the earlier `succeeded · 18 minutes ago`, the step reading `The notebook step cannot run: The server runtime is not enabled on this instance. An administrator can enable it in Admin settings.` |
| 00:20:17 | `docker ps -a --filter name=nb-` | still none: no kernel was started |
| 00:21:05 | the runtime switched back on → Save settings, then reload | reads on |
| 00:21:55 | Run now again | `Showing run · succeeded` |

Fixtures: the workflow `R96 notebook step` is kept, with three runs
(succeeded, failed, succeeded) that are the evidence above. **Enable server
runtime is ON**, as it was before the round, read back from the server.

Findings from this round: R96 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-23 — A 15-minute schedule across a restart with nobody looking, before and after, ADVERSARIAL_LOG R95

**Why this round exists.** The in-process scheduler was started only by the
notification bell's mount effect, so opening any page to check it would
start it. Both halves were therefore run with every page closed, and read
afterwards from timestamps the app wrote itself: a schedule's last-run
stamp, Recent runs, and the app log.

### Before the fix

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 22:33:39 | Swarms → `Approval durability check` → Deploy → Schedules → `R95 heartbeat`, Every 15 minutes, the refund request, Reject approvals on → Add | toast `Schedule added` |
| 22:33:48 | — | the heartbeat's first run: `every 15 min · last 9/23/2026, 10:33:48 PM · error` (the gate refuses, as R91 describes; only the time matters here) |
| 22:35:12 | every app tab closed; `docker restart agentswarms-share-agentswarms-1` | HTTP back at 22:35:26 |
| 22:48:48 | — | the heartbeat is due. It does not run |
| 23:00—23:02 | — | `docker logs` holds no `[lakehouse] maintenance:` line, which every pass in those two minutes writes, and no model call since the restart |
| 23:03:27 | a page is opened: Swarms → Recent runs | `Approval durability check (schedule) · Error · started 13s ago` directly above `· started 30m ago`, nothing between |
| 23:04 | the heartbeat's row | `every 15 min · last 9/23/2026, 11:03:53 PM · error` — fifteen minutes late, 26 seconds after somebody looked |

### After the rebuild

| Time | Driven | Read back |
| ---- | ------ | --------- |
| 23:05:02 | every app tab closed; the fixed image swapped in with `docker compose up -d --no-deps agentswarms` | container `b9e14441145c`, HTTP back at 23:05:38 |
| 23:05:38 | — | `docker logs`: one line per worker, eight in all — seven `[agentswarms] worker … scheduler started; catch-up pass left to another worker` and one `… catch-up pass ran` seven seconds later |
| 23:18:53 | — | the heartbeat is due |
| 23:19:45 | — | `docker logs`: its model call, `[chat-turn] … "model":"openrouter/free","status":"success"`, with no page open |
| 23:21:13 | a page is opened: the swarm's Deploy dialog → Schedules | `R95 heartbeat · every 15 min · last 9/23/2026, 11:19:46 PM · error` — 53 seconds after it was due, 87 seconds BEFORE anybody looked |
| 23:22 | its switch turned off | the row reads `paused` |

Fixtures: `R95 heartbeat` is kept and paused, so it costs nothing and can
be switched back on to repeat either half. The seven daily schedules from
R90—R92 are unchanged.

Findings from this round: R95 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-23 — Two sandboxes that outlived their work, before and after, ADVERSARIAL_LOG R94

**Why this round exists.** R93's count of what the host had kept ended `1
Created`: a sandbox that never ran. Chasing that found a second exit as
well, and the second one accounts for the 122 that exited 0 — including,
as this round's own before half shows, a training run that finished
perfectly.

### Before the fix

| Driven | Read back |
| ------ | --------- |
| Admin → Developer runtime → Machine learning → `Training GPUs` 0 → 1 → Save settings, then reload | the field reads `1` back from the server |
| `docker ps -a --filter name=nb-` before training | 139 sandboxes, 1 of them `Created` |
| ML Models → `threshold_probe (payment_rows)` → Train new version → Train | the job ends `failed`; its Jobs row reads `docker start failed (500): {"message":"failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during c…` |
| the host | a NEW sandbox `nb-d8376a51-b932-4810-b514-5cfee162a336 · Dead`, 140 in the list, named in nothing the owner can read |
| **and the other exit**: the same model trained with the setting restored, a run that SUCCEEDS | `24m ago · succeeded · 84s · lightgbm · F1 (macro) 58.8%` — and `nb-620c9267-4c4e-4e41-b837-90d5d4fb8ebb · Exited (0)` still on the host nine minutes later, with nothing in the app's log |

The second row is the one that matters. R93 taught the refresher to tear
down what it finds; a batch sandbox that finishes properly reports its own
result, which makes its row terminal, and from that moment the refresher
returns at its first line and never finds it. That is where 122 of the 139
came from.

### After the rebuild

| Driven | Read back |
| ------ | --------- |
| S1, on container `d2e50dac6904`, the same forced failure: ML Models → `threshold_probe (payment_rows)` → Train new version → Train, with `Training GPUs` still 1 | the job ends `failed` with the same `docker start failed (500): … failed to create task for container …`, and the host is unchanged: 139 sandboxes, no new one |
| Admin → Developer runtime → Machine learning → `Training GPUs` 1 → 0 → Save settings, then reload | the field reads `0` back from the server; training works again |
| S2, on container `7ec7707c988b`, Train new version → Train with the setting restored | a real sandbox `nb-96758b65-8b4c-4740-8fb4-524d4bfbc4f9 · Up 18 seconds`, 141 on the host |
| the same host once the run finished | `nb-96758b65-…` is **gone**: 0 rows for it, 140 in the list |
| the model's Jobs tab | `2m ago · succeeded · 59s · lightgbm · F1 (macro) 58.8%` above `24m ago · succeeded · 84s · lightgbm · F1 (macro) 58.8%` |

Those two job rows are the round in one line. They are the same training,
run twice, minutes apart, and both succeeded. The older one's sandbox is
still on this host. The newer one's was taken away the moment it reported
its result.

S1's other half — the sentence a failed removal adds — is held by the
tests: the removal succeeded on both of this host's attempts, and a DELETE
that fails is not something the browser can arrange.

Fixtures: `Training GPUs` is back to 0, verified by reading it from the
server after a reload, and a training run afterwards succeeded in 59s.
`threshold_probe (payment_rows)` gained versions v3 to v5 and five job
rows, which are the evidence above. The leftovers from before the fix were
left on the host as the evidence they are: `nb-4698447a-…` (`Created`, 18
September), `nb-620c9267-…` (`Exited (0)`, this round's before half), and
the 138 older ones; `docker container prune` removes them all.

Findings from this round: R94 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-23 — A kernel's sandbox after the kernel ends, before and after, ADVERSARIAL_LOG R93

**Why this round exists.** The host had been running the stack for two
weeks. Its container list had 139 sandboxes on it that no session still
pointed at, every one of them already ended.

### Before the fix

| Driven | Read back |
| ------ | --------- |
| `docker ps -a --filter name=nb-` on the development host | 139 sandboxes: `122 exit 0`, `16 exit 1`, `1 Created` |
| the same list by creation time | oldest `2026-09-09 21:39`, newest `2026-09-22 19:34` — thirteen days of them |
| `docker ps` | 14 running containers, not one of them an `nb-…` sandbox: every single leftover had already ended |
| `docker system df` | `Containers 158 ACTIVE 14` |

Nothing in the app says a word about any of this. The sessions behind those
139 sandboxes read `succeeded`, `stopped` or `error` in the table, which is
true; what no record anywhere says is that the container each one names is
still sitting on the host. The reaper had run on every cron pass for two
weeks and could not have touched them: it reads rows that are still live,
and these had all been made terminal by the refresher, which removes
nothing.

### After the rebuild

| Driven | Read back |
| ------ | --------- |
| on container `b454b7c4aaaa`, Developer workspace → `My Python notebook` → Run on the pure-Python cell | the cell answered from the server kernel: `mean: 500 ms`, `p50: 300.0 ms`, `max: 1450 ms`, `'2 slow calls out of 8'`, `100 ms` |
| `docker ps -a --filter name=nb-` on the host | a new sandbox `nb-0d2e5be3-7f30-45f0-84a6-bf4aa4d4dc3b · Up 16 seconds`; 140 in the list |
| a new cell, `import os, signal; os.kill(1, signal.SIGTERM)`, Run — the sandbox ends ON ITS OWN, which is the whole point | the cell answered `gateway closed the connection (code 1005)` in 553 ms |
| the host, straight away | `nb-0d2e5be3-… · Exited (0) 13 seconds ago`, still on the host and still 140: the app has not looked yet |
| Developer workspace, reopened — which is what makes the app reconcile its sessions | `nb-0d2e5be3-…` is **gone** from `docker ps -a`, and the list is back to 139 |

That last line is the round. Under the old code the reopen wrote `stopped`
onto the row and left the container standing, which is how the other 139
got there. Those 139 stay: their rows went terminal long ago, so the
refresher returns before it reaches them, and they have to be removed by
hand with `docker container prune`. The fix is about the ones that have not
happened yet.

Findings from this round: R93 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-23 — A parked run, its approval and its record, before and after, ADVERSARIAL_LOG R92

**Why this round exists.** While driving R91 the gallery's Recent runs tab
showed four `Approval durability check` runs still `Running`, with live
durations and Cancel buttons, minutes after their approvals had been
granted. The work was somewhere else.

### Before the fix

| Driven | Read back |
| ------ | --------- |
| Swarms → Recent runs, 33 minutes after approving a parked run | `Approval durability check (schedule) (api) · Success · started 33m ago · 5s · 3 steps · $0.0000`, and directly under it `Approval durability check (schedule) · Running · started 34m ago · 34m 59s`, still offering Open, Trace and Cancel |
| Trace on that `Running` row | `Approval durability check (schedule)` / `suspended` / `Sep 23, 2026, 2:59:13 AM · run 3bf09de5` / `STEPS 0 · ERRORS 0 · DURATION 0ms · TOKENS IN 0 · TOKENS OUT 0 · COST $0.0000` |
| its Timeline tab | three real steps: `Request · input · 107ms`, `Summarise for the approver · agent · openrouter/free · 9927ms · 76/495 tok`, `Human approval · approval · 339ms` |
| Trace on the `(api)` row above it | `Approval durability check (schedule) (api)` / `success` / `Sep 23, 2026, 3:00:55 AM · run 7f9912e2` / `STEPS 3 · ERRORS 0 · DURATION 3919ms · TOKENS IN 75 · TOKENS OUT 1` |

One park, one approval, one piece of work — and two records. The run a
person opens says it has no steps, no duration and no cost, three lines
above its own timeline of ten seconds of work; the row that holds the rest
is named for the resume rather than for the run, and nothing links them.

### After the rebuild

| Driven | Read back |
| ------ | --------- |
| on container `693a0ae3a632`, a new schedule `R92 one-run probe` with "Reject approvals" OFF, then the sweep | the bell `Pending approvals (1)`; Recent runs `Approval durability check (schedule) · Running · started 39s ago` |
| Trace on that row | `Approval durability check (schedule)` / `suspended` / `Sep 23, 2026, 4:03:32 AM · run c4a3f7bb` / `STEPS 0 · DURATION 0ms · COST $0.0000` — a parked run still carries no totals, because it is not over |
| Approve | `All caught up · No agents waiting for approval.` |
| the SAME url, `/analytics/observability/c4a3f7bb-…`, reloaded | `Approval durability check (schedule)` / `success` / `run c4a3f7bb` / `STEPS 5 · ERRORS 0 · DURATION 42818ms · TOKENS IN 155 · TOKENS OUT 948` · `Data flow (4)` |
| its Timeline tab | five steps, each once: `Request 115ms`, `Summarise for the approver · agent · openrouter/free 37493ms · 85/947 tok`, `Human approval 343ms`, `Approved? · condition · google/gemini-3-flash-preview 4656ms · 70/1 tok`, `Result 211ms`, then `FINAL OUTPUT: Refund #4821: $240 for damaged item received. Risk: Refund granted without return verification.` |
| Swarms → Recent runs | one row for the whole thing: `Approval durability check (schedule) · Success · started 2m ago · 1m 56s · 5 steps · $0.0000`, with no `(api)` twin beside it and no `Running` row left behind — the stranded `Running · 67m 1s` above it is from before the rebuild |

The numbers add up, which is the point: 115 + 37493 + 343 + 4656 + 211 ms is
the 42818 ms the run reports, and 85 + 70 in / 947 + 1 out are its 155 and
948. The first half was carried, not re-counted, and nothing in the
timeline appears twice.

Fixtures kept: the `Approval durability check` swarm now carries seven
daily schedules from R90, R91 and R92 (`R90 park probe`, `R90 park probe
(after)`, `R91 reject probe`, `R91 park probe`, `R91 reject probe
(after)`, `R91 park probe (after)`, `R92 one-run probe`), all already
run, left active so any of these rounds can be re-driven. Each one parks
or errors once a day until it is switched off in the Deploy dialog.

Findings from this round: R92 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-23 — Both positions of "Reject approvals", driven against the warning that describes them, ADVERSARIAL_LOG R91

**Why this round exists.** The Deploy dialog's amber warning said that
turning "Reject approvals" OFF makes the swarm auto-approve every approval
step and bypass human oversight. Two schedules on the same swarm, one per
switch position, settle what each one actually does.

### Before the fix

| Driven | Read back |
| ------ | --------- |
| Swarms → My Swarms → `Approval durability check` → Open → Deploy | the amber warning: `This swarm has 1 human-approval step` / `Nobody is present to decide them on a headless run. Leave **Reject approvals** ON (the default) and those runs stop safely at the gate. Turning it OFF makes the swarm **auto-approve** every approval step — your human oversight is bypassed.` |
| Schedules → `R91 reject probe`, the template's refund request, "Reject approvals" **ON** → Add | toast `Schedule added` |
| Schedules → `R91 park probe`, the same input, "Reject approvals" **OFF** → Add | toast `Schedule added` |
| the server's cron sweep | `R91 reject probe · every 1440 min · last 9/23/2026, 2:27:25 AM · error`, and under it the executor's own words: `Stopped at human-approval step "Human approval": this run has nobody to approve it. That is the safe default. To let this swarm wait for a real decision, turn off "Reject approvals" on the API key or schedule — the run will then park here and resume when someone approves it.` |
| the same sweep | `R91 park probe · every 1440 min · last 9/23/2026, 2:27:44 AM · suspended`; the bell `Pending approvals (1)` — one request, `Human approval · paused · 1m ago · MEDIUM · Approve this request` |
| Approve | `All caught up · No agents waiting for approval.` |

Neither position approved anything on its own. ON ended the run at the
gate and asked nobody; OFF parked it and asked a person, who decided. The
refutation of the warning was printed by the app an inch below it, in the
schedule row the warning is about.

### After the rebuild

| Driven | Read back |
| ------ | --------- |
| the Deploy dialog on container `b645e0532188` | `This swarm has 1 human-approval step` / `Nobody is watching a headless run, so **Reject approvals** decides what happens at the gate. Neither setting approves anything on its own. ON (the default) stops the run at the step and ends it as an **error**: nothing past the gate runs, and nobody is asked. OFF **parks** the run instead — it waits at the gate, the request lands in your approvals bell, and it carries on from that step once someone decides.` / `A parked run answers its caller with status: suspended and no output, so keep this ON for an integration that needs its answer in one call.` |
| Schedules → `R91 reject probe (after)` with the switch **ON**, and `R91 park probe (after)` with it **OFF** → Add, then the sweep | `R91 reject probe (after) · last 9/23/2026, 2:59:13 AM · error` with the executor's same message; `R91 park probe (after) · last 9/23/2026, 2:59:25 AM · suspended`; the bell `Pending approvals (1)` — `Human approval · paused · MEDIUM · Approve this request — Customer requests a full refund for a damaged item. Refund amount is $240. Risk: potential fraudulent claim leading to loss.` |
| Approve | `All caught up · No agents waiting for approval.` |
| `/docs/swarms` | `Approval nodes are auto-rejected by default, which ends such a case with an error rather than a verdict. Turning that off does not approve them: the case parks as suspended and waits for a person, which is rarely what a batch wants, so remove the gate from a swarm you mean to evaluate unattended.` |

The behaviour did not change in this round; only the words that describe
it did. Both positions do now what the dialog says they do, and the
sentence a reader is most likely to act on — which switch keeps a human in
the loop — now points at the right one.

Fixtures kept: the `Approval durability check` swarm and its four
schedules (`R91 park probe`, `R91 reject probe`, `R90 park probe`, `R90
park probe (after)`), all daily and all already run, left in place so both
halves of this round can be re-driven.

Findings from this round: R91 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-23 — A swarm parked at a human approval and resumed, before and after, ADVERSARIAL_LOG R90

**Why this round exists.** A headless run that reaches an approval step
writes three things: a checkpoint, a `suspended` stamp, and the approval
row that asks a person. Two of them dropped their answers, and the resume
path gated on the word the failing stamp writes.

### Before the fix

| Driven                                                                                                   | Read back                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Swarms → Library → `Approval durability check` → Load template → Save                                    | toast `Swarm saved to your library`                                                                          |
| its Deploy dialog → Schedules → `R90 park probe`, input the template's refund request, "Reject approvals" off → Add | toast `Schedule added`; the row `every 1440 min · not run yet · active`                                      |
| the server's sweep                                                                                       | Observability `Approval durability check (schedule) · suspended · 0 steps`; the bell `Pending approvals (1)` |
| the pending approval                                                                                     | `🛡️ Human approval paused · 2m ago · MEDIUM · Approve this request · Refund request #4821: full refund for a reported damaged item. Amount: $240. Biggest risk: refunding without damage verification may enable a false claim.` |
| Approve                                                                                                  | toast `Approved: Approve this request — Human approval is resuming.`; the run `success · 3 steps · 0 errors · 3534ms`; the bell back to `Pending approvals` |

The whole chain lands here, which is what makes the failure modes
invisible in normal use: the stamp writes `suspended`, so the resume's
`status !== "suspended"` gate lets the decision through. When that stamp
fails the same click is swallowed as a duplicate and the run stays parked
for ever. That half cannot be produced from the browser against the
server executor, so it is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `8668f6fb8012`); a second
schedule added on the same swarm, again with "Reject approvals" off.

| Driven                                                        | Read back                                                                                             |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| the sweep, on the new schedule                                | within six seconds the bell went to `Pending approvals (1)`; Observability `Approval durability check (schedule) · suspended` |
| the pending approval                                          | `🛡️ Human approval paused · just now · MEDIUM · Approve this request · Full refund requested for damaged item (request #4821). Amount: $240. Biggest risk: Approving may encourage fraudulent damage claims…` |
| Approve                                                       | toast `Approved: Approve this request — Human approval is resuming.`; the run `success · 3 steps · 0 errors · 3728ms`, the bell back to `Pending approvals` |

All three writes report themselves as before: the approval row, the
suspended stamp and the resume. What a failure now does — say that
nobody was asked, retry the stamp and say what it leaves, and resume on
the checkpoint rather than on the word the stamp writes — is held by the
tests.

Fixtures kept: the `Approval durability check` swarm and its two
schedules (`R90 park probe`, `R90 park probe (after)`), both daily and
both already run, left in place so this round can be re-driven.

Findings from this round: R90 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — An MCP server deployed, before and after, ADVERSARIAL_LOG R89

**Why this round exists.** One function records six outcomes into the
column MCP Builder shows, and the deploy's own record is the only place
the tools agents call are written down. All five writes dropped their
answers.

### Before the fix

| Driven                                                                    | Read back                                                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| MCP Builder → `HTTP Test` → Open                                          | `/http-test-s71kjg · Stopped · Deploy`, and the standing banner `The tool list changed … calls are blocked until you review them` |
| Deploy, on a container image that had just restarted                      | after about 90 s, toast `The operation was aborted due to timeout`; the app **`Error`** — while its sandbox `nb-dbc29e1c…` was up and finished starting moments later |
| Deploy again                                                              | after 33 s, toast `Deployed — 2 tools.`; the app **`Running`**, with `Stop` beside it                            |

The second deploy drives the whole chain this round guards: the status
writes, the tools record and the version snapshot. Every one of them
landed. The first is worth keeping for a different reason: the app was
marked `Error` over a server that came up seconds later, because the
request gave up before the server's own 90-second cold-start budget. That
is a mismatch between two timeouts, not a dropped write, and it is queued
as its own candidate.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `00a64721c026`); the same
app deployed again on it.

| Driven                                             | Read back                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| MCP Builder → `HTTP Test` → Deploy, app `Running`   | after about 65 s, toast `Deployed — 2 tools.`; the app still `Running`, `Stop` beside it |

The chain reports itself as before: the status write, the tools record
and the version snapshot all land. What a failure now says — a status
the page will go on showing, a deploy answered as a failure because the
tools agents call were not written down, a version that cannot be rolled
back to, an empty Logs tab, an unrecorded use — is held by the tests, a
failed database write not being producible from the browser against the
MCP service.

Findings from this round: R89 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Agent Chat across a conversation change, before and after, ADVERSARIAL_LOG R88

**Why this round exists.** The stale-list class R76 opened, on the page
where it costs the most: the sidebar highlights one conversation while
the transcript shows another's, and a reply goes to the highlighted one.

### Before the fix

| Driven                                                                                            | Read back                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Agent Chat → `Sample · Graph RAG Explorer (Acme Corp)`, the conversation `Make a 2-slide PowerPoint…` | 13 messages, the first `You Make a 2-slide PowerPoint about the saas_sales table…`                             |
| the second conversation `List my data tables…`, with every `GET /rest/v1/messages` rejected      | 2.5 s in: **13 messages, the same first one**; the sidebar highlighting the second conversation                |
| the same, 10 s in, after the client's four attempts                                               | toast `Could not load this conversation's messages · TypeError: Failed to fetch`; **still 13 messages**, still the first conversation's |

The selection and the transcript disagree, with nothing on the page
saying so. A reply typed here is written to the conversation the sidebar
highlights, not the one being read.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `bc6e32cc54f1`); the same
two conversations, the same rejection.

| Driven                                                                        | Read back                                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| the conversation `Make a 2-slide PowerPoint…`                                  | 13 messages, the first `You Make a 2-slide PowerPoint about the saas_sales table…`                     |
| the second conversation, with every `GET /rest/v1/messages` rejected — 2.5 s in | **nothing listed**; a `role="status"` line reading `Loading this conversation…`                        |
| the same, 11 s in, after the client's four attempts                           | toast `Could not load this conversation's messages · TypeError: Failed to fetch`; the transcript empty, the page's own `Chat with Sample · Graph RAG Explorer (Acme Corp)` invitation, and the second conversation highlighted |

The selection and the transcript now agree: the previous conversation's
messages are gone the moment another is picked, the wait says so, and a
read that failed leaves nothing to mistake for this conversation.

Findings from this round: R88 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A prep flow run twice, before and after, ADVERSARIAL_LOG R87

**Why this round exists.** A rebuild is a delete and an insert, and the
delete's error was dropped: had it failed, the new rows were appended to
the old ones and the dataset came out doubled under a flow that said it
had saved.

### Before the fix

| Driven                                                                                                   | Read back                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| BI Workspace → Data preparation → Open a flow → `Summary data`, output table set to `r87_prep_probe` → Run & save dataset | toast `Saved "r87_prep_probe" with 9,992 rows` after 27 s — the dataset created            |
| Run & save dataset again, on the same output — the rebuild branch                                        | toast `Saved "r87_prep_probe" with 9,992 rows` after 27 s                                   |
| Data Catalog → Local tables → `r87_prep_probe`                                                           | `table · csv · 3 columns · 9,992 rows · 81.6 KB` — replaced, not appended                  |

The second run is the path this round guards: snapshot, delete, write the
schema, insert. Its delete landed here, so the count held at 9,992. Had it
failed, the same success toast would have stood over 19,984 rows and every
figure read from the dataset would have doubled. That failure cannot be
produced from the browser against the prep service, so it is held by the
tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `04cfed91a5fc`); the
same flow run twice again on it.

| Driven                                                                           | Read back                                              |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| BI Workspace → Data preparation → `Summary data`, output `r87_prep_probe` → Run & save dataset | toast `Saved "r87_prep_probe" with 9,992 rows` after 24 s                                                |
| Run & save dataset again — the rebuild branch                                    | toast `Saved "r87_prep_probe" with 9,992 rows` after 30 s                                                |
| Data Catalog → Local tables → `r87_prep_probe`                                   | `table · csv · 3 columns · 9,992 rows · 81.6 KB` — replaced again, not appended                                             |
| the probe dataset deleted afterwards                                             | the impact dialog `Delete “r87_prep_probe” … 1 thing depends on this dataset … PREP FLOWS THAT PRODUCE IT: Summary data`, the name typed to confirm, then `Deleted "r87_prep_probe"`                                             |

A rebuild whose delete lands replaces, as before. One whose delete fails
now stops before the insert and says so, leaving the dataset with the rows
it had rather than doubling it — held by the tests, a failed database
write not being producible from the browser against the prep service.

Findings from this round: R87 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A swarm run and its whole trace, before and after, ADVERSARIAL_LOG R86

**Why this round exists.** The tracer writes everything the Observability
page shows — the run, a row per step, a row per edge, and the close with
its totals — and all four sat in catches a supabase answer never reaches.

### Before the fix

| Driven                                                                                          | Read back                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Swarms → `Embed E2E Mini Swarm` → Open → the run dock, input "Write one sentence about why a run record must say what happened." → Run | the trace filling live: `▶ start in`, `✓ done in`, `▶ start research`, `✓ done research …`, `▶ start edit`, `✓ done edit …`, then `235 tok ↑115 ↓120 ~$0.0001` |
| Observability                                                                                    | `8 swarm runs` (was 7); the new row `Sep 22 20:44:21 · Embed E2E Mini Swarm · success · 4 steps · 0 errors · 9219ms · 115/120 · $0.0001` |
| that run's trace                                                                                 | `STEPS 4 · ERRORS 0 · DURATION 9219ms · TOKENS IN 115 · TOKENS OUT 120 · COST $0.0001`; the four steps `Task input INPUT · SUCCESS 0ms`, `Researcher AGENT · SUCCESS 5710ms · 53/26t`, `Editor AGENT · SUCCESS 3509ms · 62/94t`, `Result OUTPUT · SUCCESS 0ms`; `Data flow (3)` |

All four write kinds are on that page: the run, its steps, its three
edges and the close's totals. Every one of them lands here. What a
failure did — a step with no row and its outcome dropped, an edge with a
null endpoint, a finished run left `running` with no totals — cannot be
produced from the browser against the tracer, and is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `9571f511504a`); the
same swarm run again on it.

| Driven                                                                         | Read back                                                                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Swarms → `Embed E2E Mini Swarm` → Open → the run dock, the same input → Run    | the trace filling live again, then `245 tok ↑119 ↓126 ~$0.0001`                                                                                                                         |
| Observability                                                                  | `9 swarm runs` (was 8); the new row `Sep 22 21:05:59 · Embed E2E Mini Swarm · success · 4 steps · 0 errors · 10937ms · 119/126 · $0.0001`                                                                                                                         |
| that run's trace                                                               | `STEPS 4 · ERRORS 0 · DURATION 10937ms · TOKENS IN 119 · TOKENS OUT 126 · COST $0.0001`; the four steps `Task input INPUT · SUCCESS 1ms`, `Researcher AGENT · SUCCESS 7242ms · 53/30t`, `Editor AGENT · SUCCESS 3692ms · 66/96t`, `Result OUTPUT · SUCCESS 2ms`; `Data flow (3)`                                                                                                                        |

The four write kinds report themselves as before: the run, its steps, its
edges and the close's totals. What a failure now says — a step that could
not be recorded, an outcome that leaves a step showing as running, an edge
the graph will not draw, a run retried once and then said — is held by the
tests, a failed database write not being producible from the browser
against the tracer.

Findings from this round: R86 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — The BI schedule, the alert and a dataset's versions, before and after, ADVERSARIAL_LOG R85

**Why this round exists.** An alert's `last_state` decides whether a
person is told again; a schedule's `next_run_at` decides whether the
dashboard refreshes again; a restore's column list decides what every
reader thinks the rows are. All three writes dropped their errors.

### Before the fix

| Driven                                                                                          | Read back                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| BI → dashboard `db14d61a…` → "Scheduled refresh & data alerts"                                  | `Scheduled refresh` off; `Data alerts — Checked after each scheduled refresh; a rule notifies once when it trips and re-arms when the condition clears.` |
| Data Catalog → Local tables → `snow_prepared` (not a sample)                                    | `QUALITY CHECKS not run` and `VERSION HISTORY — No previous versions. One is recorded automatically each time this dataset is overwritten by an upload or a prep flow.` |

The three writes this round guards are made by the sweep and by a restore
of a version this account has none of: the alert's state and the
schedule's clock are written only by `processDueSchedules`, which runs on
the cron pass, and no dataset here has a version to restore. What the
browser shows is the surface they drive — the schedule's own switch, the
alert rule's "notifies once when it trips", the version list that a
restore would act on — and all of it is unchanged by the fix. Every
failure path is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `1edfd98ba6c9`); the
same two surfaces reloaded onto it.

| Driven                                                                | Read back                                                                                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| BI → dashboard `db14d61a…` → "Scheduled refresh & data alerts"        | `Scheduled refresh` off; the alert rule's wording unchanged — `notifies once when it trips and re-arms when the condition clears` |
| Data Catalog → Local tables → `snow_prepared`                         | `VERSION HISTORY — No previous versions.`; the panel unchanged                                                                   |

Nothing the browser can reach changed, which is what this round wanted:
the alert's state write, the schedule's clock and the restore's column
list are written by the sweep and by a restore, and each now says what a
failure leaves. Those paths are held by the tests.

Findings from this round: R85 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A data monitor run and its incident, before and after, ADVERSARIAL_LOG R84

**Why this round exists.** The data monitor's records: a verdict not
stamped on the monitor, an incident not opened, extended or resolved
while the owner was told it was.

### Before the fix

| Driven                                                                                        | Read back                                                                                                                |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Data monitors → the alerting monitor `revenue_facts · negative net rows`, its open incident   | `Opened 16d ago · seen 16 times · last 6m ago`                                                                            |
| its Run now                                                                                   | toast `Value 2 is above the maximum of 0.` after 5 s                                                                      |
| the incident, two seconds later                                                               | `Opened 16d ago · seen 17 times · last 1s ago` — the verdict stamped and the incident extended                            |

A check whose stamp and incident writes land reports itself. The writes
run in the monitor runner on the server, so a failed one cannot be
produced from the browser: the defect half — a verdict the monitor's row
never took, an alert with no incident, "Recovered" over an incident still
open — is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `fe257b08f644`);
the Data monitors page reloaded onto it.

| Driven                                                                    | Read back                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| the open incident of `revenue_facts · negative net rows`                  | `Opened 16d ago · seen 17 times · last 23m ago`                                     |
| its Run now                                                               | toast `Value 2 is above the maximum of 0.` after 3 s                                |
| the incident, two seconds later                                           | `Opened 16d ago · seen 18 times · last 1s ago` — the verdict stamped, the incident extended |

The two writes a still-failing check makes — the monitor's verdict and
the incident's extension — are driven here and report themselves as
before. The resolve path needs the table to pass, which means changing
the data under it, so the "Recovered, incident still open" title and the
failed-open notification are held by the tests, along with every write
that fails: a failed database write cannot be produced from the browser
against the monitor runner.

Findings from this round: R84 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A SQL model built, before and after, ADVERSARIAL_LOG R83

**Why this round exists.** The SQL model build's records: a run left
"running" after it finished, a model's badge left on the previous build or
on "edited", lineage rewritten beside what could not be cleared.

### Before the fix

| Driven                                                                    | Read back                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| SQL Models → `stg_revenue` → Build this and what it reads                 | the button disabled and spinning for about 40 s; toast `Built 1 model`                                        |
| Builds                                                                    | the new run on top: `success · manual · 1m ago · 60.6s · selected stg_revenue · stg_revenue built 836 rows`     |

A build whose close and stamps land reports itself: the run closed with
its outcome and the model's row, the model built with its row count. The
writes run in the model runner on the server, so a failed one cannot be
produced from the browser: the defect half — a run left "running", a
badge left on the previous build or on "edited", a graph drawn beside
what could not be cleared — is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `56d9a5952a68`);
the SQL Models page reloaded onto it.

| Driven                                                                     | Read back                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `stg_revenue` → Build this and what it reads                               | toast `Built 1 model` after 9 s; Builds: `success · manual · 8s ago · 7.5s · selected stg_revenue · stg_revenue built 836 rows` |
| the model's own header                                                     | `built · 41s ago · 836 rows · builds into analytics` — the stamp landed                                                        |
| the SQL edited by one newline → Save                                       | toast `Saved stg_revenue`; `edited 1s ago · not built since` and `last build, of the previous definition: built · 836 rows · 1m ago` |
| Build this and what it reads, on that edit                                 | toast `Built 1 model`; the edited mark gone, the header `built · 18s ago · 836 rows · builds into analytics`                   |

Both of R83's stamps are driven here: the model's outcome, and the clear
of R60's "edited — not built since" mark by the build of that very edit.
The writes run in the model runner on the server, so a failed one cannot
be produced from the browser: the defect half — a run left "running", a
badge left on the previous build or on "edited", a graph drawn beside what
could not be cleared — is held by the tests.

Findings from this round: R83 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A catalog source re-crawled, before and after, ADVERSARIAL_LOG R82

**Why this round exists.** The catalog crawl's records: a crawl that
succeeded but left its source "crawling", stale assets reported removed and
still listed, lineage cleared and not rewritten — or rewritten beside what
could not be cleared.

### Before the fix

| Driven                                                                                  | Read back                                                                                                        |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Data Catalog → Sources → `Lakehouse catalog` (10) → "Re-crawl, schedule, remove" → Re-crawl | a spinner on the source; the asset list growing from `21 of 21+` to `54 of …` as the crawl wrote                 |
| about 85 s later                                                                        | toast `Crawled "Lakehouse catalog" — 21 assets, 184 columns · 11 added`; the spinner gone — the source `ready`   |

A crawl whose status writes land reports itself. The writes run in the
crawler on the server, so a failed one cannot be produced from the
browser: the defect half — a source left "crawling" over a crawl that
succeeded, stale assets claimed removed, a lineage graph left stale or
mixed — is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `d218d394edca`);
the Data Catalog reloaded onto it, `Lakehouse catalog` now 21 assets.

| Driven                                                                          | Read back                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Lakehouse catalog` → "Re-crawl, schedule, remove" → Re-crawl                    | a spinner on the source; 23 s later toast `Crawled "Lakehouse catalog" — 21 assets, 184 columns`   |
| the source, after                                                               | the spinner gone — the source `ready`; nothing added or removed this time, so no drift noted        |

A crawl whose ready mark and asset writes land reports itself as before.
One whose ready mark fails twice now fails the crawl with the reason
instead of leaving the source "crawling"; stale assets are claimed removed
only once they are; lineage is never written beside what could not be
cleared — held by the tests, since a failed database write cannot be
produced from the browser against the crawler.

Findings from this round: R82 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A scheduled retrain judged, before and after, ADVERSARIAL_LOG R81

**Why this round exists.** The promotion the API and the schedule make
kept the three writes in the order R73 fixed on the page path and dropped
every error, saying "promoted" whatever happened.

### Before the fix

| Driven                                                                                             | Read back                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ML Models → `revenue_facts · groups` → Automation → `Nightly retrain · retrain · No tuning · promote when better` → Run now | toast `Training started` 22 s later; the schedule row `started`; Versions (25)                                                              |
| the same row, four minutes later                                                                   | `kept 4m ago` — the candidate judged against production and kept                                                                              |
| the bell                                                                                           | `"revenue_facts · groups" v25 trained; production kept · silhouette: 0.2490 vs production 0.2490 (not better) · 3m ago`                       |

A verdict whose promotion is not attempted, or whose writes land, reports
itself. The API path — a version registered from outside — needs an ML API
key and an artifact in the lake bucket, which these rounds never mint or
upload; both halves of that path, and a promotion whose writes fail, are
held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `09f1a7bb3de1`);
the same model reloaded onto it, Automation tab, the schedule `kept 23m ago`.

| Driven                                                   | Read back                                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Nightly retrain · promote when better` → Run now        | toast `Training started` 20 s later; Versions (26) on reload                                                                           |
| the schedule row, two minutes later                      | `kept 2m ago` — the candidate judged against production and kept                                                                        |
| the bell                                                 | `"revenue_facts · groups" v26 trained; production kept · silhouette: 0.2490 vs production 0.2490 (not better) · just now`               |

A verdict whose promotion is not attempted, or whose writes land, reports
itself as before. A promotion whose writes fail is now answered as such on
every path — `promoted: false` and `promotion_error` from the API, `kept`
with `last_error` on the schedule and "trained, but could not be promoted"
to the owner — held by the tests, since a failed database write cannot be
produced from the browser against a server function, and the API path
needs a key and an artifact these rounds never mint. Version v26 is kept as
a candidate.

Findings from this round: R81 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A server kernel started and stopped, before and after, ADVERSARIAL_LOG R80

**Why this round exists.** The sandbox's own record, under every ML and ETL
sandbox: a container the session row never learned of, a stopped container
whose row stays live, a touch the idle reaper never sees.

### Before the fix

| Driven                                                                                       | Read back                                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer workspace → `My Python notebook` → Run cell                                        | the toolbar `Starting kernel…`; `POST /api/notebook/runtime` answering a session `starting`, then — sixteen polls and about 70 s later — `ready` |
| the same page, after                                                                         | `Kernel error: Kernel connect timed out` — the browser could not reach the kernel's gateway (`gatewayUrl: ""`; `NOTEBOOK_GATEWAY_URL` is unset in this deployment), an environment limit, not this round's |
| Developer workspace → Running kernels                                                        | `1 live · ready · My Python notebook · started 2:06:25 PM · Stop`                                                                          |
| Stop                                                                                         | toast `Kernel stopped` about 14 s later; the Running kernels panel gone — no live kernel                                                    |

The session's container was recorded (the runtime answered `ready`, which
needs the ref) and its stop was recorded (the panel emptied). The writes run
in the runtime service, so a failed one cannot be produced from the browser:
the defect half — a container the row could not take left running, a
stopped container's row left live — is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `c28597f45d18`);
the same notebook reloaded onto it.

| Driven                                                                  | Read back                                                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `My Python notebook` → Run cell                                         | `Starting kernel…`; `POST /api/notebook/runtime` answering a new session `starting`, then `ready` after eleven polls — the container recorded on the row, since `ready` needs its ref |
| Developer workspace → Running kernels                                   | `1 live · ready · My Python notebook · started 2:39:43 PM · Stop`                                                     |
| Stop                                                                    | toast `Kernel stopped` 8 s later; the Running kernels panel gone                                                       |

A session whose container ref and stopped mark land reports itself as
before. One whose ref could not be written is now stopped again and the
start fails as a start; one whose stopped mark could not be written is
said — held by the tests, since a failed database write cannot be produced
from the browser against the runtime service. As before, the page then
reports `Kernel connect timed out` over the ready kernel: `NOTEBOOK_GATEWAY_URL`
is unset in this deployment.

Findings from this round: R80 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Training a version, before and after, ADVERSARIAL_LOG R79

**Why this round exists.** The training job's records: a job claimed
"succeeded" and then a version write that dropped its error — a finished
job over a version "training" for ever — and workers written onto the job
without reading the answer.

### Before the fix

| Driven                                                                                                | Read back                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| ML Models → `revenue_facts · groups` → Train new version → "Train a new version … trains v22", time budget 5 → Train | toast `Training started` about 45 s later                                                                    |
| Jobs                                                                                                  | the new job `running 19s`, then `succeeded 38s kmeans_k2 · Silhouette 0.249`                                  |
| Versions (22)                                                                                         | `v22 candidate kmeans_k2 0.249 836 45s ago`; `v1 production` unchanged                                          |
| Train new version again → Train                                                                       | `Training started` 24 s later; the job `succeeded 12s` before its view could be opened — no cancel to drive     |
| Versions (23)                                                                                         | `v23 candidate kmeans_k2 0.249 836 27s ago`                                                                    |

A job whose outcome writes land shows the version ready, as a candidate,
under a job that succeeded. The writes run in the training service, so a
failed version write cannot be produced from the browser: the defect half —
a job "succeeded" over a version left "training" — is held by the tests.
Versions v22 and v23 are kept as candidates.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `9112063e9cde`);
the same model reloaded onto it.

| Driven                                                                                  | Read back                                                                                          |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Train new version → "Train a new version … trains v24", time budget 5 → Train           | toast `Training started` 15 s later                                                                |
| Jobs                                                                                    | the new job `running 19s`, then `succeeded 52s kmeans_k2 · Silhouette 0.249`                        |
| Versions (24)                                                                           | `v24 candidate kmeans_k2 0.249 836 11s ago`; `v1 production` unchanged                               |

A job whose version write lands shows a ready candidate under a job that
succeeded, as before; one whose write fails twice is now failed with the
reason instead of left "succeeded" over a version "training" — held by the
tests, since a failed database write cannot be produced from the browser
against the training service. Version v24 is kept as a candidate.

Findings from this round: R79 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — An ETL run cancelled, before and after, ADVERSARIAL_LOG R78

**Why this round exists.** The ETL run's records: a sandbox started that
the run row never learned of, a cancel said over a row still running, a
watermark a successful run could not keep — and a page that said
"Stopping", or nothing, whatever the server answered.

### Before the fix

| Driven                                                                                      | Read back                                                                                                                        |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| ETL Pipelines → `bi_seed` (7 s runs, 108 rows) → Run                                        | toast `Run started` about 25 s later; `Running now 1`                                                                            |
| the pipeline → Runs, a minute in: `Running … 1m 15s` → Cancel, as the sandbox was finishing | **no toast of any kind**; the row read `Succeeded … 1m 16s 108 rows → 1 target(s)` a moment later — the cancel had answered `false` and the page said nothing |
| Run again → the pipeline → Runs, 14 s in: `Running … 14s` → Cancel                          | **no toast**; the row `Cancelled … 16s`                                                                                          |

A cancel that lands shows the row; one that did not — the run already
over — shows nothing at all. The server side — the cancel's write, the
sandbox's session, the watermarks — runs in server functions and the
sandbox, so a failed database write cannot be produced from the browser:
that half is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `906b223c7b32`,
after an intermediate image `53d14b03e6b1` carrying everything but the
page's catch); the ETL page reloaded onto it. Runs of `bi_seed` now finish
17–46 s after `Run started`, so each path below is its own run.

| Driven                                                                                                       | Read back                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `bi_seed` → Run → `Run started` → the pipeline → Runs: `Running … 10s` → Cancel                              | the row `Cancelled … 11s` six seconds later, no toast — a cancel that landed shows the row (and on `53d14b03e6b1`, `Running … 3s` → `Cancelled … 3s`) |
| Run again → Runs: `Running … 32s` → Cancel, with every `POST /_serverFn/…` rejected                          | toast **`Could not cancel the run · Failed to fetch. It is still running.`**; the row still `Running`; the page's own reload saying `Couldn't load pipelines: Failed to fetch` |
| Run again → Runs: `Running … 16s` → Cancel, the sandbox finishing at 17 s                                    | toast **`Could not cancel the run · That run is not running.`** — the server's own answer; the row `Succeeded … 17s 108 rows → 1 target(s)` |

Before the fix the second and third rows said nothing at all. The server
side — the cancel's write, the sandbox's session, the watermarks — is held
by the tests, a failed database write not being producible from the
browser against a server function.

Findings from this round: R78 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A warm endpoint deployed and stopped, before and after, ADVERSARIAL_LOG R77

**Why this round exists.** The server-side write survey's largest cluster:
the ML endpoint module, 23 writes with their result dropped. The ready
stamp answered ok over a row left `starting`; `undeploy` said "stopped"
over a row left `ready`; a copy whose session write failed could never be
stopped.

### Before the fix

| Driven                                                                                          | Read back                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| ML Models → `revenue_facts · groups` → Automation → Warm endpoint `off` → Deploy                | toast `Starting the endpoint and loading the model…`; a scorer sandbox up (`[score] listening on 0.0.0.0:8888`); the server function answering `{ ok: true, version: 1 }` |
| the panel, a second later                                                                        | toast `Serving v1`; `Warm endpoint serving v1`, `Stop`, `Redeploy production`, `0 requests served · not called`                            |
| Stop                                                                                             | the server function answering `{ ok: true }` after 24 s; toast `Endpoint stopped`; `Warm endpoint off`, `Deploy`                            |

The endpoint runs in a sandbox the server starts and stops, so a failed
database write cannot be produced from the browser: the defect half — ok
over a stamp that failed, "stopped" over a row still ready — is held by
the tests. What the browser holds is the regression half: a deploy and a
stop whose writes land report themselves exactly as before.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `46df8dfdd4a3`);
the same model reloaded onto it, Automation tab, `Warm endpoint off`.

| Driven                                    | Read back                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy                                    | toast `Starting the endpoint and loading the model…`; about 80 s later the server function answering `{ ok: true, version: 1 }`, toast `Serving v1` |
| the panel, a second later                 | `Warm endpoint serving v1`, `Stop`, `Redeploy production`                                                                                |
| Stop                                      | the server function answering `{ ok: true }` after 19 s; toast `Endpoint stopped`; `Warm endpoint off`, `Deploy`                          |

A deploy whose ready stamp lands and a stop whose three writes land report
themselves as before. A stamp or a stop that could not be written now
answers with the state it left — held by the tests, since a failed database
write cannot be produced from the browser against a server function.

Findings from this round: R77 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Knowledge Bases across a base change, before and after, ADVERSARIAL_LOG R76

**Why this round exists.** Seen while pressing the siblings of R64: the page
kept the previous base's documents on screen, under the next base's name,
until the next read landed — and kept counting them on the tab after that
read had failed.

### Before the fix

| Driven                                                                                                   | Read back                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge Bases → `RAG eval · Halvard Systems`                                                           | heading `RAG eval · Halvard Systems`; 12 documents listed, the first `04-regional-availability-and-compliance-matrix-2026-01.md`; `Documents (12)` |
| `Test`, with every `GET /rest/v1/knowledge_documents` rejected — read 2.5 s in                           | heading **`Test`**; **the same 12 documents still listed**, the same first one; **`Documents (12)`**                                        |
| the same, 10 s in, after the client's four attempts                                                      | `Could not load the documents: TypeError: Failed to fetch`; nothing listed; **`Documents (12)`** still on the tab                             |
| fetch restored; `RAG eval` then `Test` again                                                             | `No documents in this knowledge base.`; `Documents (0)` — what `Test` holds                                                                 |

For the seven seconds a read spends failing — or however long a slow one
takes — the page presents the previous base's list as this base's; and a
count that outlives the read it came from is a claim about rows the page
never read.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `ae7506f1384c`);
the Knowledge Bases page reloaded onto it. The same two bases, the same
rejection — this time of both reads, `knowledge_documents` and
`kb_sources`.

| Driven                                                                                       | Read back                                                                                                                              |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `RAG eval · Halvard Systems`                                                                 | 12 documents listed, the first `04-regional-availability-and-compliance-matrix-2026-01.md`; `Documents (12)`, `Sources (0)`             |
| `Test`, with every `GET` of both tables rejected — read 2.5 s in                             | heading `Test`; **nothing listed**; `Loading documents…` (a `role="status"` line); **`Documents (…)`, `Sources (…)`**                   |
| the same, 10 s in, after the client's four attempts on each read                             | `Could not load the documents: TypeError: Failed to fetch`; nothing listed; **`Documents (?)`, `Sources (?)`**                          |
| fetch restored; `RAG eval` then `Test` again                                                 | `No documents in this knowledge base.`; `Documents (0)`, `Sources (0)`                                                                 |

The previous base's rows are gone the moment the next base is picked; the
tab counts say what has been read — nothing yet, or nothing at all — and
the panel says it is loading rather than that there is nothing.

Findings from this round: R76 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A workflow run closing, before and after, ADVERSARIAL_LOG R75

**Why this round exists.** The server-side write survey's next file, the
workflow runner. Its closing write was conditional — only the replica that
still saw the run as running wins — and it read back the rows alone, so a
close whose write FAILED looked like a close another replica had made and
returned without a word: a run "running" for ever, no audit entry, no
notification.

### Before the fix

| Driven                                                                                       | Read back                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Workflows → `Test` (no steps) → a Wait step added from the palette, `Wait (seconds)` set to 2 → Save | toast `Saved`; the canvas holds one node, `Wait`                                                        |
| Run now                                                                                      | toast `Run started`; ten seconds later the list reads `Test manual · less than a minute ago succeeded` |
| Runs tab                                                                                     | one run, `succeeded less than a minute ago · manual`, its one step `Wait`                              |

The close runs in the workflow runner on the server, so a failed row write
cannot be produced from the browser: the defect half — a failed close read
as "another replica closed it first" — is held by the tests. What the
browser holds is the regression half: a run that closes still reports
itself, in the list and on the Runs tab, exactly as before.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `0dd063722838`);
the Workflows page reloaded onto it, `Test` with its one Wait step.

| Driven                                   | Read back                                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Test` in the list, before the run       | `Test manual · 10 minutes ago succeeded` — the earlier run                                                             |
| Run now                                  | toast `Run started`; ten seconds later the list reads `Test manual · less than a minute ago succeeded`                 |
| Runs tab                                 | two runs, `succeeded less than a minute ago · manual` above `succeeded 10 minutes ago · manual`, each with its `Wait`  |

A run whose closing write lands reports itself as before, in the list and
on the Runs tab; one whose write fails is now retried and, failing twice,
logged with what a person needs — held by the tests, since a failed
database write cannot be produced from the browser against the server-side
runner.

Findings from this round: R75 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Dropping a lakehouse schema, before and after, ADVERSARIAL_LOG R74

**Why this round exists.** The server-side write survey's next file. Dropping
a schema runs `DROP SCHEMA` and then two catalog-row deletes whose errors
were dropped; removing a materialized view, one. Each reported done
whatever the rows answered.

### Before the fix

| Driven                                                                                   | Read back                                                                                             |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Lakehouse → New schema → `r74_probe` → Create                                            | `3 schemas · 21 tables`, `r74_probe` in the object explorer                                             |
| `r74_probe` → Drop schema and everything in it → "Drop schema "r74_probe"? …" → Drop schema | toast `Dropped r74_probe`; the explorer still `3 schemas` with `r74_probe` listed until a reload — stale, not undropped |
| Reload                                                                                   | `2 schemas · 21 tables`; `r74_probe` gone                                                             |

The drop runs in a server function, so a rejected row delete cannot be
produced from the browser: the defect half — done reported over a catalog
row that stayed — is held by the tests. The browser holds the regression
half: a drop that lands reports itself as before.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `0dd063722838`);
the Lakehouse page reloaded onto it, `2 schemas · 21 tables`.

| Driven                                                                                                    | Read back                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| New schema → `r74_probe` → Create                                                                         | a few seconds later `3 schemas · 21 tables`, `r74_probe (0)` in the object explorer                               |
| `r74_probe` → Drop schema and everything in it → "Drop schema "r74_probe"? Every table in it is dropped too. This cannot be undone." → Drop schema | toast `Dropped r74_probe`; the explorer `2 schemas · 21 tables` with `r74_probe` gone, this time without a reload |
| Reload                                                                                                    | `2 schemas · 21 tables`; no `r74_probe`                                                                           |

A drop whose catalog-row deletes land reports itself as before; one whose
row delete fails now names the row that stayed, with the schema already
gone — held by the tests, since a failed database write cannot be produced
from the browser against a server function.

Findings from this round: R74 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Promoting a model version, before and after, ADVERSARIAL_LOG R73

**Why this round exists.** The server-side write survey (237 error-less
writes in 64 files), taken to the one that changes what agents and
dashboards compute with: promoting a version to production. All four of
its writes dropped their error and it answered ok.

### Before the fix

| Driven                                                                                                                    | Read back                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| ML Models → `revenue_facts · groups` → Versions (21) → v21 (candidate) → Promote → "Promote v21 to production? Agents and dashboards using this model switch to it immediately." → Promote | toast `v21 is now in production`; v21 `production`, v1 `archived`                                                          |
| v1 → Promote → confirm                                                                                                     | toast `v1 is now in production`; v1 `production`, v21 `archived` — the fixture restored, v21 left archived rather than candidate |

The promotion runs in a server function, so a rejected database write
cannot be produced from the browser: the defect half — `ok: true` over a
write that failed — is held by the tests. What the browser holds is the
regression half: a promotion that lands reports itself exactly as before.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `0dd063722838`);
the same model reloaded onto it, Versions tab.

| Driven                                                                                                                        | Read back                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `revenue_facts · groups` → Versions (21): v1 `production`, v21 `archived`                                                     | the fixture as the earlier round left it                                                        |
| v21 → Promote → "Promote v21 to production? Agents and dashboards using this model switch to it immediately." → Promote      | toast `v21 is now in production`; v21 `production`, v1 `archived` — stage, pointer and archive all landed |
| v1 → Promote → confirm                                                                                                        | toast `v1 is now in production`; v1 `production`, v21 `archived` — the fixture restored          |

A promotion whose five writes all land reports itself as before; one whose
write fails now says which step failed and what state it left — held by the
tests, since a failed database write cannot be produced from the browser
against a server function.

Findings from this round: R73 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — The sibling paths of R60–R72, every one driven, on the R72 container

**Why this round exists.** Each round above drove one path through its fix
and left the siblings — the same guard on the next button over — to the
tests. This round presses every sibling reachable from the browser, on the
container that carries R72 (`f308cd0a9c0a`), with the same rejected writes
and reads. Nothing here is a new fix; it is the proof the earlier fixes
asked for.

| Round | Driven                                                                                                                                                                  | Read back                                                                                                                                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R60   | SQL Models → `stg_revenue` → definition edited by one character → Save                                                                                                  | toast `Saved stg_revenue`; header `edited 1s ago · not built since` and `last build, of the previous definition: failed · 57 rows · 2m ago`; the build dot on the edited state, not the old outcome              |
| R66   | Agent Builder → agent limit changed, with `POST /rest/v1/agent_limits` rejected                                                                                         | toast `Could not save the agent limit TypeError: Failed to fetch. The value shown is what is saved.`; status `Not saved — agent limit: TypeError: Failed to fetch`; the field back on the saved `10`             |
| R71   | Bell (30 unread) → Mark all read, with `PATCH /rest/v1/notifications?read_at=is.null` rejected                                                                         | toast `Could not mark the notifications read …`; the popover's items still listed; badge still `30 unread`                                                                                                       |
| R71   | Bell → one notification (`"revenue_facts · groups" v21 trained; production kept`), with `PATCH /rest/v1/notifications` rejected                                         | toast `Could not mark the notification read TypeError: Failed to fetch. It is still unread.`; badge still `30 unread`                                                                                            |
| R72   | Agent Chat → the 10-message conversation → Regenerate on the last reply, with `DELETE /rest/v1/messages` rejected                                                      | toast `Could not regenerate the reply TypeError: Failed to fetch. The previous reply could not be removed, so it stands.`; 10 bubbles before and after; no new reply streamed                                   |
| R72   | Agent Chat → Delete on the chat `Make a 2-slide PowerPoint about the saas_sales tab` → confirm, with `DELETE /rest/v1/messages` rejected                               | toast `Could not delete the chat …`; the chat still listed; 10 bubbles                                                                                                                                           |
| R72   | Agent Chat → Edit a message, `(edited)` appended → Resend, with `DELETE /rest/v1/messages?id=in.(…)` rejected                                                            | toast `Could not resend the edited message TypeError: Failed to fetch. The conversation is unchanged.`; 10 bubbles; the original text still in place                                                             |
| R64   | Knowledge Bases → `Test` selected after `RAG eval · Halvard Systems`, with every `GET /rest/v1/knowledge_documents` and `GET /rest/v1/kb_sources` rejected                | `Could not load the documents: TypeError: Failed to fetch` on the Documents tab and `Could not load the sources: TypeError: Failed to fetch` on Sources — after the client's four attempts (0 s, 1 s, 3 s, 7 s) |
| R68   | Knowledge Bases → `Test` (0 documents) → its Trash → `Delete "Test"? …` → Delete knowledge base, with `DELETE /rest/v1/knowledge_bases` rejected                         | toast `Could not delete the knowledge base TypeError: Failed to fetch. Its embeddings were already removed — re-index it to restore retrieval.`; `Test` still listed and still selected                          |
| R70   | BI → dashboard `db14d61a…` → Schedule & alerts → alert `Total Sales · row count > 1` added as a fixture; its Trash with `DELETE /rest/v1/bi_alerts` rejected              | toast `Could not delete the alert TypeError: Failed to fetch. It is still set and will still fire.`; the row still listed                                                                                        |
| R70   | The alert's mail button (`Also email me when this alert triggers`), with `PATCH /rest/v1/bi_alerts` rejected                                                            | toast `Could not change the alert's email setting TypeError: Failed to fetch. It is unchanged.`                                                                                                                |
| R70   | The alert's switch, on → off, with `PATCH /rest/v1/bi_alerts` rejected                                                                                                   | toast `Could not switch the alert off TypeError: Failed to fetch. It is still on and will still fire.`; the switch back on. Then deleted for real: the row gone, no toast                                        |
| R69   | Integrations → the Google Gemini card → Disconnect → `Disconnect gemini? The stored key is deleted, not disabled. …` → Disconnect, with `PATCH /rest/v1/integrations` rejected    | toast `Could not disconnect the provider TypeError: Failed to fetch. The provider is still connected.`; the card still `Connected`                                                                               |

**Not driven, and why.** The encrypted-provider disconnect (Bedrock, Azure
OpenAI, Vertex, OCI) and the notification-channel disconnect: no such
provider or channel is connected in this account, and connecting one means
typing a key or a webhook secret, which these rounds never do. Both stay
held by the R69 tests, which pin the `error` read and the message on each.

**Seen on the way, filed rather than fixed.** While the `Test` base's
documents were still loading — seven seconds under the client's retries —
the previous base's 12 documents stayed listed under the `Test` heading,
and after the load failed the tab still read `Documents (12)` for a base
with none. Queued as a candidate: the previous base's list is a stale read
rendered as the current one.

All rejected fetches were restored afterwards; the alert fixture was
deleted; no knowledge base, chat, provider or notification was changed.

## 2026-09-22 — Agent Chat, a message delete that failed, before and after, ADVERSARIAL_LOG R72

**Why this round exists.** The write-side survey's last file, back on the
Agent Chat page: its four deletes — a message, a chat, the reply a
regenerate replaces, the tail an edit-and-resend replaces — all dropped
their error.

### Before the fix

| Driven                                                                                                       | Read back                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Agent Chat → "Sample · Graph RAG Explorer (Acme Corp)", its conversation of 10 messages                      | 10 bubbles                                                                                    |
| Delete on the last bubble ("I could not find any information…"), with every `DELETE /rest/v1/messages` rejected | **9 bubbles**; one DELETE rejected; **no toast**                                                |
| Reload                                                                                                       | **10 bubbles** — the message was never deleted                                                 |

A message deleted on screen and not in the database is a message that
comes back.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `f308cd0a9c0a`);
the same agent and conversation reloaded onto it. Same bubble, same
rejection.

| Driven                                                                                                      | Read back                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete on the last bubble ("I could not find any information…"), with every `DELETE /rest/v1/messages` rejected | **10 bubbles** — the message back at once; toast **`Could not delete the message · TypeError: Failed to fetch. It is still in the conversation.`**; one DELETE rejected |

The conversation shows what is stored, and the toast says why the press
changed nothing. The chat delete, the regenerate and the edit-and-resend
share the shape and are held by the tests; no real delete was made.

Findings from this round: R72 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — The notification bell's Clear, before and after, ADVERSARIAL_LOG R71

**Why this round exists.** The write-side survey's next file. The bell
clears and marks notifications read optimistically and dropped every
write's error.

### Before the fix

| Driven                                                                                          | Read back                                                                                                              |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Bell (`Alerts & notifications (30 unread)`) → open                                              | `Notifications` · `Mark all read` · `Clear`; newest: `"revenue_facts · groups" v21 trained; production kept`            |
| Clear, with every `DELETE /rest/v1/notifications` rejected                                       | popover **`No notifications — dashboard alerts and scheduled-refresh results land here.`**; badge **`Alerts & notifications`** (no count); one DELETE rejected; **no toast** |
| Reload                                                                                          | badge `Alerts & notifications (30 unread)` — nothing was cleared                                                        |

Thirty notifications were "cleared" on screen and none in the database.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `5b6a98fb8215`);
the page reloaded onto it. Same bell, same rejection.

| Driven                                                                                     | Read back                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bell (`Alerts & notifications (30 unread)`) → open → Clear, with every `DELETE /rest/v1/notifications` rejected | the list **back** (`"revenue_facts · groups" v21 trained; production kept`, …); badge **`Alerts & notifications (30 unread)`**; toast **`Could not clear the notifications · TypeError: Failed to fetch. They are still there.`**; one DELETE rejected |

The list and the badge show what is stored, and the toast says why the
press changed nothing. No notification was cleared: the thirty are as they
were. The two read-marks share the shape and are held by the tests.

Findings from this round: R71 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A BI data alert switched off, before and after, ADVERSARIAL_LOG R70

**Why this round exists.** The write-side survey's next file, the BI
schedule dialog: every write in it — removing the schedule, deleting an
alert, switching one on or off, its email setting — dropped its error.

### Before the fix

| Driven                                                                                                                                       | Read back                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| BI → "AI verification - generated from saas_sales" → Scheduled refresh & data alerts → Widget `Total Sales`, threshold `1` → Add alert         | toast `Alert added — it's checked after every scheduled refresh`; `Total Sales · row count > 1`, switch on |
| The alert's switch pressed, with every `PATCH /rest/v1/bi_alerts` rejected                                                                    | switch **off** on screen; one PATCH rejected; **no toast**                                       |
| Reload → Scheduled refresh & data alerts                                                                                                     | `Total Sales · row count > 1`, switch **on** — the alert was never switched off                   |

An alert switched off on screen that is still on in the database will
still fire; the dialog showed the switch the person made, not the one that
was stored.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `0e9ad05ab36b`);
the dashboard reloaded onto it. Same alert, same rejection.

| Driven                                                                                            | Read back                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Scheduled refresh & data alerts → `Total Sales · row count > 1`, switch on                          | as left                                                                                                                                    |
| The alert's switch pressed, with every `PATCH /rest/v1/bi_alerts` rejected                          | switch **back on**; toast **`Could not switch the alert off · TypeError: Failed to fetch. It is still on and will still fire.`**; one PATCH rejected |
| `fetch` restored → the alert's delete                                                             | the alert is gone from the dialog; only the schedule switch remains — the fixture is gone for real                                          |

The switch shows what is stored, and the words say what that means. The
schedule removal, the alert delete and the email setting share the shape and
are held by the tests.

Findings from this round: R70 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Integrations, a disconnect that failed, before and after, ADVERSARIAL_LOG R69

**Why this round exists.** The write-side survey's next page. The
Integration Hub disconnects a provider or a notification channel and said
"disconnected" whatever the request answered.

### Before the fix

| Driven                                                                                                                                          | Read back                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Integration Hub → LLM Providers → OpenRouter (`Connected`) → Disconnect → "Disconnect openrouter? The stored key is deleted, not disabled…" → Disconnect, with every write to `provider_credentials` and `integrations` rejected | toast **`Provider disconnected`**; one `PATCH /rest/v1/integrations?id=eq.…` rejected; the card **still `Connected`, its Disconnect still there** |
| Reload                                                                                                                                          | OpenRouter still `Connected`                                                                               |

The dialog had just said the stored key is deleted, not disabled; the page
then said it was done; nothing was.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `4da715363ad2`);
the page reloaded onto it. Same provider, same rejection, same dialog.

| Driven                                                                                                                       | Read back                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Integration Hub → OpenRouter → Disconnect → confirm, with every write to `provider_credentials` and `integrations` rejected | toast **`Could not disconnect the provider · TypeError: Failed to fetch. The provider is still connected.`**; the card **still `Connected`, its Disconnect still there**; one PATCH rejected; **no "Provider disconnected"** |

The page now says what is true — the provider is still connected — and
says nothing else. No real disconnect was made: the key stays where it
was. The encrypted-provider and notification-channel paths share the shape
and are held by the tests.

Findings from this round: R69 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Knowledge Bases, a document delete that failed, before and after, ADVERSARIAL_LOG R68

**Why this round exists.** The write-side survey's next page. The Knowledge
Bases page deletes a base, a document, or a source's documents, and said
"Deleted" whatever the request answered.

### Before the fix

| Driven                                                                                                                       | Read back                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Knowledge Bases → `Test` → Add Document: name `R68 probe`, a one-sentence body → Add 1 Document & Process                     | `Documents (1)`, `R68 probe` listed                                                        |
| Delete on the document → "Delete "R68 probe"? Its chunks and embeddings go with it…" → Delete document, with every `DELETE /rest/v1/knowledge_documents` rejected | toast **`Document deleted`**; one DELETE rejected; **`Documents (1)`, `R68 probe` still listed** |
| Reload → `Test`                                                                                                              | `Documents (1)`, `R68 probe` still there                                                   |

The page said the document was deleted and showed it in the same breath.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `ce7602e87093`);
the page reloaded onto it. Same fixture, same rejection.

| Driven                                                                                                   | Read back                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge Bases → `Test` (`Documents (1)`, `R68 probe`)                                                  | as left                                                                                                                                                                         |
| Delete on the document → confirm, with every `DELETE /rest/v1/knowledge_documents` rejected              | toast **`Could not delete the document · TypeError: Failed to fetch. Its embeddings were already removed — re-index the knowledge base to restore retrieval.`**; `Documents (1)`, `R68 probe` still listed; **no "Document deleted"** |
| `fetch` restored → Delete → confirm                                                                       | toast `Document deleted`; `Documents (0)`; the fixture is gone for real                                                                                                         |

A delete that fails is said, with what the earlier step already did and what
to do about it; a delete that lands says so and is gone. The base and
source variants share the shape and are held by the tests.

Findings from this round: R68 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — The swarm canvas's delete, before and after, ADVERSARIAL_LOG R67

**Why this round exists.** The write-side survey's next page. The swarm
gallery already says "Failed to create swarm" and "Failed to delete"; the
canvas, which has its own create and delete, did not.

### Before the fix

| Driven                                                                                                                 | Read back                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Swarms gallery → New Swarm (with every `POST /rest/v1/swarms` rejected)                                                 | toast `Failed to create swarm` — the gallery's own path, already honest; `My Swarms 15` unchanged                    |
| `fetch` restored → New Swarm                                                                                            | `Swarm 16` created and opened in the canvas                                                                        |
| Canvas → Delete swarm → "Delete this swarm? Swarm 16 will be permanently removed…" → Delete swarm, with every `DELETE /rest/v1/swarms` rejected | toast **`Swarm deleted`**; the canvas switched to `Swarm 1`; one DELETE rejected                                     |
| Reload the gallery                                                                                                     | **`My Swarms 16`; `Swarm 16` is still there**                                                                        |

The canvas said the swarm was gone and moved on; the swarm was not gone.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `8f15b4f4261f`);
the gallery reloaded onto it. Same fixture, same rejection.

| Driven                                                                                                                | Read back                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Swarms gallery (`My Swarms 16`) → Open `Swarm 16` → canvas                                                            | canvas on `Swarm 16`                                                                                   |
| Delete swarm → confirm, with every `DELETE /rest/v1/swarms` rejected                                                   | toast **`Could not delete the swarm · TypeError: Failed to fetch`**; the canvas **stays on `Swarm 16`**; one DELETE rejected |
| `fetch` restored → Delete swarm → confirm                                                                              | toast `Swarm deleted`; the canvas moves to `Swarm 1`                                                   |
| Reload the gallery                                                                                                    | `My Swarms 15`; no `Swarm 16` — the fixture is gone for real                                           |

A delete that fails now changes nothing and says why; a delete that lands
says so and is gone. The canvas's create failure is held by the tests: its
control is not on the canvas toolbar, and the gallery's own create already
said "Failed to create swarm".

Findings from this round: R67 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Budgets, a cap whose save failed, before and after, ADVERSARIAL_LOG R66

**Why this round exists.** The write-side survey's next page. Budgets saves
every change optimistically, and the page has a button that says the
settings are auto-saved.

### Before the fix

| Driven                                                                                                            | Read back                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Budgets & Guardrails                                                                                              | Monthly Hard Cap `20`; `Month-to-date spend: $1.79 / $20.00`                                                |
| Every `PATCH /rest/v1/budget_settings` rejected (`Failed to fetch`); cap typed as `25`, focus moved on             | cap `25`; **`Month-to-date spend: $1.79 / $25.00`**; one PATCH rejected; **no toast**                        |
| The page's "Settings auto-save on change" button pressed                                                          | toast **`All settings auto-saved`**                                                                          |
| Reload                                                                                                            | cap `20`; `Month-to-date spend: $1.79 / $20.00`                                                            |

A cap that was never saved was the cap on screen, and the page said so in
so many words.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `cb763ab67128`);
the page reloaded onto it. Same rejection, same edit.

| Driven                                                                                                | Read back                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budgets & Guardrails                                                                                  | cap `20`; status button `Settings auto-save on change`                                                                                                                                                      |
| Every `PATCH /rest/v1/budget_settings` rejected; cap typed as `25`, focus moved on                     | cap **back to `20`**; `Month-to-date spend: $1.79 / $20.00`; toast **`Could not save the budget · TypeError: Failed to fetch. The value shown is what is saved.`**; status **`Not saved — budget: TypeError: Failed to fetch`** |
| The status button pressed                                                                             | toast `Not saved — budget: TypeError: Failed to fetch`                                                                                                                                                      |
| `fetch` restored; cap typed as `21`, focus moved on                                                    | cap `21`; `Month-to-date spend: $1.79 / $21.00`; status **`Saved 12:56 AM`**                                                                                                                                 |
| Cap typed back to `20`; reload                                                                        | cap `20`; `$1.79 / $20.00`; status `Settings auto-save on change`                                                                                                                                            |

A write that fails is undone on screen and said; a write that lands is
said with its time; the button says only what the last write did. The cap
is back at its saved 20.

Findings from this round: R66 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — Agent Chat, a message whose save failed, before and after, ADVERSARIAL_LOG R65

**Why this round exists.** The failed-read survey's largest file, the Agent
Chat page, turned out to have the write-side twin of the problem: five of
its six message inserts dropped their error, so a turn that was never saved
looked exactly like one that was.

### Before the fix

| Driven                                                                                                                       | Read back                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Chat → "Sample · Graph RAG Explorer (Acme Corp)", its conversation of 10 messages                                      | 10 bubbles, last: "According to the documents, what products does Acme Corp sell?" / "I could not find any information…"                       |
| Every `POST /rest/v1/messages` rejected (`Failed to fetch`); "R65 probe: reply with the single word OK" sent by the icon button | 12 bubbles: `You R65 probe: reply with the single word OK` · `Assistant OK`; **two POSTs rejected, no toast, no mark of any kind**                |
| Reload, same agent, same conversation                                                                                        | 10 bubbles; the probe turn is **gone**                                                                                                          |

Nothing distinguished the two unsaved messages from the ten saved ones until
they were not there.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `c643ca45cde6`);
the same agent and conversation reloaded onto it. Same rejection, same
send.

| Driven                                                                                                   | Read back                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every `POST /rest/v1/messages` rejected; "R65 probe two: reply with the single word OK" sent by the icon | 12 bubbles; under both new bubbles: **`not saved — it will not be here after a reload`**, hover text `TypeError: Failed to fetch`; two POSTs rejected                                                                    |
| A third probe, read 2.5 s after the send                                                                 | toast **`This message was not saved to the conversation · TypeError: Failed to fetch. It will not be here after a reload.`**                                                                                            |
| `fetch` restored, reload                                                                                 | 10 bubbles again once the one reply that landed after the restore (an orphan "OK") was deleted through its bubble; nothing marked, nothing missing that was not said to be                                                |

The two halves the page needed: the mark on the message, and the reason at
the moment of failure. The conversation is back to its ten messages.

Findings from this round: R65 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The Agent Builder and Knowledge Base lists, before and after, ADVERSARIAL_LOG R64

**Why this round exists.** The failed-read survey, taken to the two builder
pages every other page starts from: each dropped its list read's error and
showed the empty state — with a call to action — over rows it could not read.

### Before the fix

| Driven                                                                                                            | Read back                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Builder                                                                                                     | nine agents listed (`RAG eval · Halvard support`, `Predictive Analyst`, `Sample · Graph RAG Explorer (Acme Corp)`, …)                                                       |
| Agent Builder with every `/rest/v1/agents?…` request rejected (`Failed to fetch`, eight attempts), reloaded in-app | **`No agents yet` · "Create your first agent to get started — pick a model, write a system prompt, and add tools as you go." · a `New Agent` button** — nothing about a failure |
| Knowledge Bases                                                                                                   | six knowledge bases listed (`RAG eval · Halvard Systems`, `Sample · People Operations Playbook`, …)                                                                          |
| Knowledge Bases with every `/rest/v1/knowledge_bases?…` request rejected (eight attempts), reloaded in-app         | **`No knowledge bases yet.`** — nothing about a failure                                                                                                                      |

The obvious response to either screen is to make another one.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `3154635e5810`);
both pages reloaded onto it. Same rejections, same in-app reloads.

| Driven                                                                                        | Read back                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Agent Builder                                                                                 | nine agents listed                                                                                                           |
| Agent Builder with every `/rest/v1/agents?…` request rejected (eight attempts), reloaded in-app | **`Could not load your agents` · `TypeError: Failed to fetch` · a `Try again` button**; no "No agents yet", no call to action |
| `fetch` restored, `Try again` pressed                                                          | the nine agents are back (`RAG eval · Halvard support`, `Predictive Analyst`, …)                                             |
| Knowledge Bases with every `/rest/v1/knowledge_bases?…` request rejected (eight attempts), reloaded in-app | an alert: **`Could not load your knowledge bases: TypeError: Failed to fetch`**; no "No knowledge bases yet."           |

A read that failed now reads as a failure, with the reason and a way back;
the empty states are reserved for a read that answered with nothing. The
documents and sources lists of a knowledge base carry the same alert and are
held by the source-anchored tests.

Findings from this round: R64 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The home dashboard's status band, before and after, ADVERSARIAL_LOG R63

**Why this round exists.** The landing page's one sentence — "Everything is
running" or "N things need attention" — is built from seven counts. A count
whose read failed landed as zero, and one of the seven asked its column for
a value it cannot hold.

### Before the fix

| Driven                                                                                                                   | Read back                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Models → `stg_revenue` → test "Minimum row count" 100 (the model has 5 rows) → Save → Build                           | Builds tab: `error · manual · 16s ago · 15.3s · stg_revenue failed 5 rows row_count_min on the table failed: 1 row(s)`                          |
| Dashboard                                                                                                                | band `1 thing needs attention · 1 open data incidents · checked 10:35 PM`; **no "SQL models failing" chip**; the SQL models card: `2 models`, no warning |
| Dashboard with every `/rest/v1/etl_runs` request rejected (`Failed to fetch`, four attempts recorded), reloaded in-app    | band `1 thing needs attention · 1 open data incidents · checked 10:36 PM` — the pipeline-runs check is **absent, not unknown**                     |

A model that failed its build a minute earlier is not on the band because the
band asks for `last_status = 'error'` and the column holds `failed`. A check
that could not be read is indistinguishable from one that found nothing.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `5f104cac7842`);
the dashboard reloaded onto it. Same failing model, same rejected request.

| Driven                                                                                                                 | Read back                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard                                                                                                              | band `2 things need attention · 1 open data incidents · 1 SQL models failing · checked 11:24 PM`; the SQL models card: `2 models · 1 failing`                                                                                  |
| Dashboard with every `/rest/v1/etl_runs` request rejected (`Failed to fetch`, four attempts recorded), reloaded in-app  | band `2 things need attention · 1 check could not be read · 1 open data incidents · 1 SQL models failing · ? pipeline runs failed today — could not be read · checked 11:25 PM`; the chip's hover text `TypeError: Failed to fetch`; the ETL pipelines card: `20 pipelines · could not be checked` |

The model that failed its build a minute earlier is now on the band and on
its card. The check that could not be read is a chip of its own with the
reason, the sentence counts it separately, and the card it belongs to says
so — none of it a zero. `stg_revenue` keeps its `row_count_min 100` test
and `limit 5` for now; both are fixtures of this round.

Findings from this round: R63 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The ML model page's Jobs count, before and after, ADVERSARIAL_LOG R62

**Why this round exists.** Sweep 2's last named row, ML predictions: the
model page printed the length of a capped list as the count of jobs, and its
two list handlers dropped the errors of every read they made.

### Before the fix

| Driven                                                       | Read back                                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| ML Models → `revenue_facts · groups` (card: "21 versions")   | tabs `Versions (21)` · `Jobs (20)`                                                                                          |
| Jobs tab                                                     | 20 rows, oldest `17d ago · succeeded · 12s · kmeans_k2 · Silhouette 0.249`; nothing says older jobs exist                   |

Twenty-one versions came from at least twenty-one jobs; the tab counted the
twenty it was given.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `4cc73580b8f3`);
the same model page reloaded onto it.

| Driven                                          | Read back                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ML Models → `revenue_facts · groups`            | tabs `Versions (21)` · **`Jobs (20+)`**                                                                                              |
| Jobs tab                                        | 20 rows, oldest `17d ago · succeeded · 12s · kmeans_k2 · Silhouette 0.249`; under the table: **The newest 20 jobs. Older jobs exist and are not listed here.** |
| Predictions tab                                 | 11 runs listed (newest `7d ago · succeeded · rows via ai_analyst · 10 row(s)`), no note — the list is under its cap of fifty          |

The count and the note come from the extra row the handler now fetches. The
failed-read half — a versions, jobs or runs read that errors — is server-side
and cannot be produced from the browser without failing the database; it is
held by the source-anchored tests on both handlers, and the page's own error
state (which the client already had) shows what it throws.

Findings from this round: R62 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — A governed query at its cap, before and after, ADVERSARIAL_LOG R61

**Why this round exists.** Sweep 2, the semantic layer: a prefix presented
as the whole. The Semantics page's query runner asks for a hundred rows and
counted whatever came back as the result.

### Before the fix

| Driven                                                                                                  | Read back                                                                                              |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Semantic Layer → SaaS Sales model (`saas_sales`, 9,994 rows) → Query → `total_sales` × `order_id` → Run | `100 row(s)`; compiled statement ends `LIMIT 100`; 100 rows in the table — nothing says the query has 9,894 more groups |

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `e4b0a5c268a3`);
the page reloaded onto it. Same model, same query, same Run.

| Driven                                                                                                  | Read back                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic Layer → SaaS Sales model → Query → `total_sales` × `order_id` → Run                            | `first 100 rows of a larger result — the preview stops at 100; add a filter or a coarser grain to see everything`; compiled statement ends `LIMIT 101`; 100 rows in the table                    |

The runner fetched the hundred-and-first row, found it, cut the result at
the hundred the page asked for and said so; the statement shown is the one
that ran. The analyst's step note and the dashboard's parameter re-run share
the same verdict from the same runner and are held by the source-anchored
tests; the scheduled refresh's flag is the R26 test's anchor, moved to the
new line.

Findings from this round: R61 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — A SQL model edited after its build, before and after, ADVERSARIAL_LOG R60

**Why this round exists.** Sweep item 2: a badge that outlives what it vouched
for. The SQL Models page shows a model's last build — status, time, row
count — and a save that replaces the model's SQL leaves all three standing.

### Before the fix

| Driven                                                                                       | Read back                                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Models → `stg_revenue`                                                                    | `built · 11d ago` · `836 rows` · `builds into analytics.stg_revenue`; list dot `bg-emerald-500`; SQL ends `where net_usd is not null`      |
| Append `limit 5` to the SQL, press Save                                                      | toast `Saved stg_revenue`; header **still** `built · 11d ago` · `836 rows`; list dot **still** `bg-emerald-500`; SQL now ends `limit 5`    |

The row count is the previous definition's; the SQL on the row can produce at
most five. Nothing on the page distinguishes this from a model whose build is
current.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `7396b05ad49f`);
the page reloaded onto it. The migration is **not yet applied** to the live
database — `npx supabase db push` was refused by this session's permission
gate — so this half proves the rebuilt app against the un-migrated database;
the edited state is driven once the migration is pushed (below, when it is).

| Driven                                                                 | Read back                                                                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Models → `stg_revenue` (SQL still ends `limit 5` from the save above) | `built · 11d ago` · `836 rows`, dot `bg-emerald-500` — no mark column, so the page falls back to the last build's stamps exactly as before                        |
| "Build this and what it reads"                                         | toast `Built 1 model`; Builds tab, newest run: `success · manual · 25s ago · 18.5s · selected stg_revenue · stg_revenue built 5 rows`; Model tab: `built · 22s ago` · `5 rows` |

The runner's guarded clear skipped cleanly on a row with no mark, and the
stamps landed; the page reads them as before. The trigger itself was proven in
both directions against the empty local Postgres twin in a throwaway schema
(set by a SQL, name, schema, materialization or tests change; not by a
description, tags, schedule or pause change; not by a jsonb-equal re-save of
the tests; not cleared by a build's own stamp; cleared by the runner's guarded
update), and the schema was dropped afterwards. `stg_revenue` is left with
`limit 5` for the post-migration drive, which restores it.

### On the live database, after the migration (2026-09-22)

`npx supabase db push` was run by the owner; `db push --dry-run` reports the
remote up to date. Driven on the R72 container (`f308cd0a9c0a`), which
carries the R60 page and runner:

| Driven                                                                                          | Read back                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Models → `stg_revenue` (`failed · 11h ago` · `5 rows`, red dot, from R63's row-count test)  | as left                                                                                                                                                                       |
| SQL changed (`limit 5` → `limit 57`) → Save                                                     | `Saved stg_revenue`; header **`edited 1s ago · not built since`** · **`last build, of the previous definition: failed · 5 rows · 11h ago`**; list dot **amber**, hover `Edited since its last build` |
| Control: `fct_region_revenue` (`built · 12d ago · 4 rows`) → description changed only → Save    | `Saved fct_region_revenue`; header **still `built · 12d ago · 4 rows`**, dot green — a description is not the definition                                                       |
| `stg_revenue` → Build                                                                           | run `error · stg_revenue failed 57 rows row_count_min…`; header **`failed · 46s ago · 57 rows`**, red dot, **no "edited"** — the build that read the definition cleared the mark |
| Fixture restored: test removed and limit removed → Save (`edited 1s ago · not built since` again) → Build | `success · stg_revenue built 836 rows`                                                                                                                                       |

Both directions, on the live trigger: the mark on a definition change and
not on a description change, and the mark cleared by the build that read
it. `stg_revenue` is back to its original SQL, no tests, 836 rows.

Findings from this round: R60 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The scheduler on the Monitoring page, before and after, ADVERSARIAL_LOG R59

**Why this round exists.** R57 gave the scheduler's pass a record of its
failures and nowhere to show them. R59 adds the scheduler to the Monitoring
page's services. This is a new surface, so the browser proves both halves:
that the row was absent, and that it is present with the live pass's figures.

### Before the fix

| Driven                | Read back                                                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monitoring            | `2 needing attention · checked 6:30:34 PM`; twelve services — Application server, Supabase, Document renderer, JS sandbox, Notebook gateway, Notebook egress proxy, Lakehouse catalog, Spark Connect, Docker API proxy, Online feature store, Vector store (Qdrant), Object store (MinIO) — and no scheduler |

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
container (`ba1fe8ede7eb`, up 4 minutes). Same page, same health check.

| Driven                | Read back                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monitoring            | `No problems detected · checked 8:37:06 PM`; thirteen services — the twelve above and, third in the list after Supabase, **Scheduler · Healthy** · "Runs every schedule the platform has — BI refreshes, prep flows, crawls, ETL, retention — once a minute, in this process." · `last_pass=5 s ago · processed=0 · prep_flows=0 · failures=0` |

The row's figures are the live pass, not a fixture: `last_pass=5 s ago` on a
process four minutes old is the tick that ran just before the check. The two
services that needed attention before the rebuild were optional services that
were down at the time and are up now; the count is unrelated to this round.
The degraded branches — a pass with failures, a scheduler that has stopped, a
process that never passed — cannot be produced from the browser without
breaking the server's own reads, and are held by the six behavioural tests on
`schedulerProbe`.

Findings from this round: R59 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — Grounded retrieval, before and after, ADVERSARIAL_LOG R58

**Why this round exists.** R58 changes what the model is told when a
knowledge-base search cannot be checked or completed, and makes the ACL filter
fail closed. Every one of those failures is the server's own — the vector RPC,
the ACL read, the document scan — so the browser proves the REGRESSION half:
a grounded agent answers as before when nothing fell short. The defect half is
behavioural on the pure prompt builder (`tests/unit/retrievalDegraded.test.ts`)
and source-anchored on the retrieval function, the tool and the route.

### Before the fix

| Driven                                                                                                   | Read back                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Chat → "Sample · Graph RAG Explorer (Acme Corp)" → "According to the documents, what products does Acme Corp sell?" | 24 s: `I could not find any information regarding the products sold by Acme Corp in the available documents. The knowledge graph returned no matches for "Acme Corp" or "products."` — zero citations, no toast |

Whether that is a true absence or a search that fell short is exactly what
the answer could not say: the same words come back from an empty knowledge
base and from a failed one.

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
bundle (`playground-V1hgo98G.js`). Same agent, same question, same submit.

| Driven                                                                                                   | Read back                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Chat → "Sample · Graph RAG Explorer (Acme Corp)" → "According to the documents, what products does Acme Corp sell?" | 48 s: `I could not find any information in the available documents regarding the products sold by Acme Corp. The knowledge graph search returned no results for this entity or its related products.` — zero citations, no toast |

The answer has the same shape as before the fix, and now that shape means
something: none of the new wording — "the search could not be completed",
"retrieval was partial", "could not be checked" — appears, so this is a
knowledge base with no match, not a search that fell short. The wording for a
search that fell short is held by the behavioural tests on the prompt builder,
which cannot be reached from the browser without failing the server's own
reads.

Findings from this round: R58 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The scheduler's pass, before and after, ADVERSARIAL_LOG R57

**Why this round exists.** R57 makes the scheduler's pass record every folded
sweep and every failed read in an `errors` field, and the cron endpoint's `ok`
follow it. The reads and steps are the server's own, so the browser proves the
REGRESSION half through the one thing it can see: the body of the
`/api/bi/cron` POST the page makes every few minutes. The defect half is
behavioural (`tests/unit/cronPassFailures.test.ts`): against the unpatched
source a failed schedule read resolved `0` — nothing due — with no error
anywhere.

### Before the fix

| Driven                                                  | Read back                                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The page's own `/api/bi/cron` POST, read from the network log | `{"ok":true,"skipped":false,"ran":true,"processed":0,"prep_flows":0,"quality_checks":0,"catalog_crawls":0,"etl_runs":0,"matview_refreshes":0,"sql_model_builds":0,"workflow_runs":0,"workflow_steps":0,"analyses":0,"swarm_schedules":0,"kernels_reaped":0,"ml_evaluations":0}` — no field for anything that failed |

### After the rebuild

The `agentswarms` service rebuilt and recreated; the Monitoring page reloaded
(client chunk `monitoring-Dbmpp_RF.js`, unchanged — this round is server-side).

| Driven                                                          | Read back                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The page's next `/api/bi/cron` POST, read from the network log  | `{"ok":true,"skipped":false,"ran":true,"processed":0,"prep_flows":0,"quality_checks":0,"catalog_crawls":0,"etl_runs":0,"matview_refreshes":0,"sql_model_builds":0,"workflow_runs":0,"workflow_steps":0,"analyses":0,"swarm_schedules":0,"kernels_reaped":0,"ml_evaluations":0,"errors":[]}` |
| Monitoring                                                      | `2 needing attention · checked 7:16:50 PM`; the same twelve services; no scheduler row — the surface is R59's                                                                                                                                 |

The pass ran clean under the live deployment, and for the first time the
answer says so with a field rather than by the absence of one: `errors: []`,
and `ok` computed from it.

Findings from this round: R57 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — Credential and audit reads, the regression half, ADVERSARIAL_LOG R56

**Why this round exists.** R56 makes two server-side reads fail with their
reason instead of answering "not configured" and "an id". The failures are
the server's own and cannot be injected from the browser, so — as in R41 and
R53 — the browser proves the REGRESSION half: a model call that resolves its
credential still answers, and the Audit Log still shows people. The defect
half is proved behaviourally (`tests/unit/serverReadFolds.test.ts`): against
the unpatched source a failed credential read resolved `null`.

### After the rebuild

The `agentswarms` service rebuilt and recreated; the pages reloaded onto the
new bundle (`audit-D7coIzc4.js`).

| Driven                                                                    | Read back                                                                                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Audit Log, before the rebuild                                             | 333 rows, 334 email mentions, no 8-character ids, no "deleted account", no toast                                                         |
| Audit Log, after the rebuild                                              | 333 rows, 334 email mentions, no 8-character ids, no "deleted account", no toast — identical                                             |
| Workbench → BI Agent → "How many rows does saas_sales have?" (submit pressed) | `The 'saas_sales' table contains 9,994 rows` as a KPI in 14 s; every `/api/bi` POST in the exchange 200 — the credential lookup resolved |

The user list behind attribution and the credential behind the model call
both read cleanly under the live deployment; what changed is only what each
answers when it cannot, which the behavioural tests hold.

Findings from this round: R56 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The report generator over a failed read, before and after, ADVERSARIAL_LOG R55

**Why this round exists.** The queue's next "failed read rendered as absence"
was the BI report route's bare hydration catch. The dialogs it feeds are
reachable from the browser, and the rejection is armed before the in-app
navigation so the route mounts under it — the real catch meeting a real
failure.

### Before the fix

| Driven                                                                                      | Read back                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BI Workspace → Reports → "Revenue pack - known series", every `user_data_tables` request rejected | the designer, **no toast**; 2 rejected reads                                                                                                                     |
| Generate with AI                                                                            | Source `Local & prepared datasets`; Table placeholder and notice both `No local datasets — upload data on the Data & SQL page first.`; `Plan the report` disabled; 4 rejected reads |

The account holds thirty-three local datasets.

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
bundle (`bi-D0lePUV8.js`). Same report, same rejection armed before the
in-app navigation.

| Driven                                                                          | Read back                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reports → "Revenue pack - known series", every `user_data_tables` request rejected | toast `Could not load local datasets: could not list datasets: Error: injected: user_data_tables unreachable` at 7 s — the catch that used to be bare; 4 rejected reads                              |
| Generate with AI                                                                | placeholder and notice both `Local datasets could not be read — could not list datasets: Error: injected: user_data_tables unreachable`; `Plan the report` disabled — the advice to upload is gone |
| The same report reloaded with `fetch` untouched → Generate with AI              | Table `sftest_users` selected, no notice, `Plan the report` enabled, no toast                                                                                                                          |

An empty list with a reason now shows the reason; an empty list without one
still says where to get data (the behavioural test holds that case); a kept
list is not blocked by a failed re-read.

Findings from this round: R55 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — A deck generated over a failed read, before and after, ADVERSARIAL_LOG R54

**Why this round exists.** The queue's next "failed read rendered as absence"
was the document generator's data fill. It is reachable from the browser: the
fill hydrates the datasets client-side, so rejecting `user_data_tables` in the
page is the real failure the real code meets. Each drive is a real model round
trip (Gemini 2.5 Flash via OpenRouter) that plans the deck, then the browser
builds it.

### Before the fix

| Driven                                                                                                                   | Read back                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Chat → PowerPoint mode, every `user_data_tables` request rejected, "a 2-slide deck: bar chart of sales by region, KPI of row count", send | 21 s: `Here's your PowerPoint — Make-a-2-slide-PowerPoint-about-the-saas.pptx` · `PowerPoint · ready` · Download; **4 rejected reads, no toast, no error** |

The plan asked for a chart and a KPI; the fill could read nothing; the deck
was delivered as if it had.

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
bundle (`playground-DZ4tALaf.js`). Same page, same prompt, same submit.

| Driven                                                                     | Read back                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PowerPoint mode, every `user_data_tables` request rejected, the same prompt | 31 s: the deck card, **and** the toast `Charts could not be filled — could not read your datasets: could not list datasets: Error: injected: user_data_tables unreachable · The deck was built with its chart slides falling back to text. Check the data connection and generate it again.`; 4 rejected reads |
| PowerPoint mode, `fetch` restored, the same prompt                          | 60 s: the deck card (`SaaS Sales Executive Overview`); **no toast** — neither the read-failure error nor the partial-fill warning; no rejected reads                                                                                                              |

So the failure now says what happened and the deck still ships; the clean run
is unchanged: charts filled, nothing to warn about.

Two things about driving this panel, for the next round that needs it: Return
in the box does not send (the icon beside it does, and after a generation the
document mode resets to plain chat), and a 12-second toast that the pointer
happens to rest on never expires — it sat over the send icon for several
minutes and swallowed every click until it was removed.

### Fixtures

Each drive leaves a conversation in Agent Chat titled after its prompt, with
the generated `.pptx` attached (uploaded to the `chat-docs` bucket by the page
as part of delivery). They are kept — deleting chat history is not this
round's to do — and are listed here so they are not mistaken for the user's
own work.

Findings from this round: R54 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The model policy under a live read, before and after, ADVERSARIAL_LOG R53

**Why this round exists.** R53 makes four IAM reads fail closed instead of
answering "no policy". The failure cannot be injected from the browser — the
reads are the server's own — so, as in R41, the browser proves the REGRESSION
half: the live policy still resolves and a model call still goes through. The
defect half is proved by behavioural tests on the real functions
(`tests/unit/iamPolicyReadFailure.test.ts`): against the unpatched source a
failed `iam_settings` read resolved `null` — unrestricted — and a failed
`iam_group_members` or `iam_model_rules` read resolved `[]`; a failed role
read answered "Forbidden: superadmin access only", closed but for the wrong
reason.

### Before the fix — the live policy

| Driven                                          | Read back                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| IAM → Settings                                  | `Deny by default (allow-list only)` switch **off**; `Allow anyone to sign up` on                    |
| IAM → Access → Model access                     | no rules — "By default everyone can use every model"                                               |

So the live policy collapses to `null`, unrestricted, and every model call
this deployment makes goes through `getEffectiveModelRules` first.

### After the rebuild

The `agentswarms` service rebuilt and recreated (server code only — the client
chunk `data-sql-CiXUwY60.js` is unchanged from R52, as it should be).

| Driven                                                                        | Read back                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IAM → Settings                                                                | `Deny by default (allow-list only)` still **off**; `Allow anyone to sign up` on — the policy this deployment runs under is unchanged                          |
| Workbench → BI Agent → "How many rows does saas_sales have?" (submit pressed) | `The 'saas_sales' table contains 9,994 rows of data.` as a KPI chart (`10.0k`, 1 row) in 6 s; every `/api/bi` POST in the exchange answered **200**           |

The model call goes through `llmJsonServer` → `getEffectiveModelRules` first;
after the fix a failed policy read would have been an error response here
instead of an answer, and the four reads succeeded. That is the regression
half. The defect half — a failed settings read resolving `null`, unrestricted —
is proved by `tests/unit/iamPolicyReadFailure.test.ts` against the real
function, which resolved exactly that before the fix and rejects after it.

One thing learned about the panel on the way: Return in the question box does
nothing — it is not a form — and the first `/api/bi` 200 I read was the
panel's suggested-questions call, not a question. The icon button beside the
box is the submit, and the round above pressed it.

Findings from this round: R53 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The catalog's first paint, sampled before and after, ADVERSARIAL_LOG R52

**Why this round exists.** R51's validation sampled a fresh load every two
seconds instead of reading it once, and the sample showed two wrong answers
before the right one. Same technique here: a full reload, the page left alone,
the Sources panel and the resource log read every two seconds.

### Before the fix

| t    | Read back                                                    |
| ---- | ------------------------------------------------------------ |
| 8 s  | `Local tables 0` — loading, rendered as a count; 0 server-function calls |
| 18 s | `Local tables 33`, no `sftest` row; still 0 server-function calls — a pass made before the session resolved |
| 20 s | `Local tables 26` · `sftest 7`; 1 call, made at 17.97 s      |

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
bundle (`data-sql-CiXUwY60.js`) and left alone, sampled every two seconds.

| t    | Read back                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 11 s | `Local tables …` · `All assets 21+` · footer `21 of 21+ assets`; no banner; 0 server-function calls   |
| 23 s | `Local tables 26` · `sftest 7` · `All assets 54` · `54 of 54 assets`; 1 call, made at 21.6 s          |

No sample read `0`, and none read `33`: the loading state is an ellipsis with
floored totals, and the first pass waited for the session, so the first
attribution painted is the right one. The one server-function call is the
only one made.

Findings from this round: R52 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — Where a synced dataset came from, under a failed read, ADVERSARIAL_LOG R51

**Why this round exists.** The first normal reading after R50's rebuild was
`Local tables 33`, not 26, with the `sftest` connector row missing from the
Sources panel. R50's entry blamed a connections server call failing while the
container was still starting; that was a reading taken once, and it was wrong
(see the sampled timeline below). The symptom itself — a failed attribution
read filed as "local" — was then reproduced on purpose by rejecting that read
alone.

### Before the fix

| Driven                                                                            | Read back                                                                                                                                       |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Data Catalog, loaded normally                                                     | `All assets 54` · `Local tables 26`; Sources panel lists `sftest 7`                                                                             |
| Data Catalog mounted with the attribution read (`select=id,saas_connection_id`) rejected | `All assets 54` · `Local tables 33`; no `sftest` row; the seven `sftest_*` datasets shown with SOURCE `Local tables`; no toast, no banner; 8 rejected requests |

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
bundle (`data-sql-tERoPyTu.js`).

| Driven                                                                            | Read back                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data Catalog mounted with the attribution read rejected                           | `Local tables 33`, no `sftest` row, and the banner `Where synced datasets came from could not be read — they are listed under Local tables until it can be: … Retry`; 14 s                            |
| Retry, `fetch` restored                                                           | `Local tables 26` · `sftest 7`; banner gone; 11.5 s                                                                                                                                                  |
| Re-read under the rejection over the known attribution (Workbench → Catalog)      | `Local tables 26` · `sftest 7` stand; banner `Where synced datasets came from could not be re-read — showing the last known attribution: … Retry`; 18 s                                              |
| The same toggle with `fetch` restored                                             | banner gone, 26 · `sftest 7`; 15.5 s                                                                                                                                                                 |

### The first load, sampled instead of read once

| Driven                                        | Read back                                                                                                                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh full load, untouched, sampled every 2 s | 8 s: `Local tables 0` (loading), 0 server-function calls · 18 s: `Local tables 33`, no `sftest` row, still **0** server-function calls · 20 s: `Local tables 26` · `sftest 7`, after the one call at 17.97 s |

So the 33 after a rebuild is not a failed call: the first `reloadLocal` runs
before the session has resolved, with no token, skips the connections read by
design and paints every synced dataset as an upload; the token-driven re-run
corrects it two seconds later. A wrong paint for two seconds, after a ten
second wait, on every full page load — R52, next.

Findings from this round: R51 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The catalog under a failed local read, before and after, ADVERSARIAL_LOG R50

**Why this round exists.** R49's validation left the page on the Data Catalog
view with the table-list read still rejected, and the Sources panel read
`Local tables 0`. This round measured that properly, fixed it, rebuilt, and
measured it again. Same technique: `window.fetch` patched in the page to reject
one table's requests; the real catch running against a real rejection.

### Before the fix

| Driven                                                                     | Read back                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Data Catalog, loaded normally                                              | `All assets 54` · `Local tables 26` · footer `54 of 54 assets`                                          |
| Data Catalog mounted with every `user_data_tables` request rejected        | `All assets 21` · `Local tables 0` · footer `21 of 21 assets` — no toast, no banner, one `console.warn` |

Thirty-three assets gone silently: the 26 local tables and the 7
connector-synced datasets that are stored the same way.

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
bundle (`data-sql-Cofp-IJh.js`).

| Driven                                                                          | Read back                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data Catalog mounted with every `user_data_tables` request rejected             | `All assets 21+` · `Local tables —` · footer `21 of 21+ assets`; banner `Local tables could not be loaded: could not list datasets: … Retry`; 7.5 s                             |
| Retry, `fetch` restored                                                         | `All assets 54` · `Local tables 26` · `54 of 54 assets`; banner gone; 17.5 s                                                                                                    |
| Reload over the populated list under the rejection (Workbench → Catalog toggle) | counts stand at 54 · 26 · `54 of 54`; banner `Local tables may be stale — the last reload failed: … Retry`; 6 s                                                                 |
| The same toggle with `fetch` restored                                           | banner gone, 54 · 26; 7.5 s                                                                                                                                                     |
| BI → Data preparation mounted under the rejection                               | toast `Could not load datasets: …`; section header `Local tables —` (was `0`); expanded: `Tables could not be loaded: … Retry`; 7 s                                             |
| Retry, `fetch` restored                                                         | `Local tables 33`; error state gone; 8 s                                                                                                                                        |

**Seen on the way, queued.** The first normal reading after the rebuild was
`Local tables 33`, not 26, and the `sftest` connector row was missing from the
Sources panel. The container was still `health: starting`; the catalog's
`listConnectionsFn(...).catch(() => [])` swallowed that failure and the 7
connector-synced datasets were filed as local uploads. The Retry a minute later
read 26. That is the next round. *(Corrected in R51: sampled every two seconds,
this is a two-second paint made before the session resolved; no server call had
been made, let alone failed.)*

Findings from this round: R50 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The pager sweep driven to its end, and two defects only the browser found, ADVERSARIAL_LOG R43–R49

**Why this round exists.** R43 to R47 closed the hand-rolled-pager sweep on
unit tests and mutants. This round drove each of them against the live
deployment and read the figures back from the rows they claim to describe —
and then made the same pages' reads fail, which is where R48 and R49 came from.
The failure paths were reached by patching `window.fetch` in the page to reject
one table's requests; the real handler ran against a real rejection.

### What was driven, and against what truth

| Round | Driven                                                                          | Read back                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| R43   | Lakehouse → import `saas_sales`                                                 | `SELECT COUNT(*)` in the lakehouse: **9,994**; the Workbench's own count of the source: **9,994**; audit event `lakehouse.import` `rows: 9994` |
| R44   | BI → Data Prep → run "Summary data"                                             | `9,992 rows · 3 cols`; `user_data_table_versions` and quality `total_rows` **9,992** — the prep source's exact count                             |
| R45   | Audit Log → Export                                                              | **1,960** lines, every one parsed, ids distinct, no error line — equal to the live `audit_events` count                                          |
| R46   | Workbench, first load (five-window parallel reader)                             | `saas_sales` **9,994** rows and `nba_team_seasons` **1,050**, both equal to the database                                                        |
| R47   | Analytics → traces (`pageTraces`)                                               | headline `1,109 traces over the last 30 days` — `execution_traces` holds exactly 1,109                                                           |
| R48   | Workbench → Refresh, every `user_data_rows` request rejected — BEFORE           | console `Uncaught (in promise) could not count rows of …`; icon spinning indefinitely; no toast; list intact                                    |
| R49   | Workbench → Refresh, every `user_data_tables` request rejected — BEFORE         | thirty tables replaced by `No tables yet. Upload a file to get started.`; no toast; spinner cleared at ~3.5 s; 38 rejected requests             |
| R49   | the same, with `fetch` restored and Refresh pressed again                       | the same list back, `sftest_users` first — nothing had been lost                                                                               |

### After the rebuild

The `agentswarms` service was rebuilt from source and recreated; every other
container stayed up. The page was reloaded so it took the new bundle
(`data-sql-nbwNpl_R.js` — the pre-rebuild chunk was `data-sql-Dh2zJ77u.js`).

| Round | Driven                                                                                      | Read back                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R49   | Workbench → Refresh, every `user_data_tables` request rejected                              | toast `Could not refresh datasets: could not list datasets: Error: injected: user_data_tables unreachable`; list intact, `sftest_users` first; `Last refresh failed: could not list datasets: … — showing the previous list.`; spinner cleared at 8 s |
| R49   | `fetch` restored, Refresh                                                                   | the same list, note gone, 11.5 s                                                                                                                                                                                                   |
| R48   | Workbench → Refresh, every `user_data_rows` request rejected                                | toast `Could not refresh datasets: could not count rows of "sftest_users": …`; spinner cleared at 7.5 s; list intact; the stale note; 132 rejected requests                                                                        |
| R48   | `fetch` restored, Refresh                                                                   | the same list, note gone, 12 s                                                                                                                                                                                                     |
| R49   | Workbench MOUNTED under the rejection (in-app navigation away and back, patch kept)         | `Datasets could not be loaded: could not list datasets: … Retry` in place of "No tables yet"; the injection log held only the list read — **zero** seeder existence checks; Retry with `fetch` restored brought the list back in 12 s |
| R49   | Workbench → `SELECT COUNT(*) AS n FROM saas_sales`                                          | **9,994** — unchanged by the seeder's no-op RPCs in the pre-fix round                                                                                                                                                              |
| R49   | BI → Data preparation, MOUNTED under the rejection                                          | toast `Could not load datasets: could not list datasets: …`; with the Local tables section expanded, `Tables could not be loaded: … Retry`; Retry with `fetch` restored → `Local tables 33` in 8 s                                  |
| R49   | Data preparation → Reload tables under the rejection, list populated                        | the toast; badge still `Local tables 33`; no error state, no "No local tables yet"; a restored reload → 33                                                                                                                         |

**Observed, not fixed here.** While the prep tab is in its failed state the
collapsed section header still reads `Local tables 0`, and the Catalog view's
Sources panel read `Local tables 0` under the same failed list — the count of
an empty list stated as a fact beside an error. Both are the first items of the
next round.

### The two things only the browser found

**A Refresh with nowhere to put the throw (R48, S2).** R46 made the checked
reader throw instead of registering a partial table, and the first call site to
meet that throw was the workbench's Refresh handler — four lines, no try. Every
unit test of the reader passed; the spinner that never stopped was visible only
on the page.

**A failed list answered as an empty account (R49, S1).** `hydrateFromSupabase`
returned `[]` when the table list could not be read, and the page took `[]` at
its word. The injection log then filled with the sample seeder's own existence
checks, every one rejected — the mount path had read the empty list as an empty
account and started seeding. Its registration RPC returns the existing id
without writing, which is the only reason that round changed nothing; the row
insert beneath it is guarded by a count read whose error is dropped the same
way. Both are proved by behavioural tests now: the real seeder, a client whose
reads fail one at a time, and both failure cases resolving `true` before the
fix.

### Not driven, and why

**The seeder's insert-on-failed-count path.** Reaching it on the live project
means making the `user_data_rows` count fail while the registration RPC
succeeds, and success would append 9,994 duplicate rows to a shared sample
table. It is proved by the behavioural test and the mutant that deletes the
guard, and by nothing else.

**The three callers queued from R49.** `docGen/biData`, `bi_.report` and
`chatBi` render absence on a failed list; each needs its own page driven and
gets its own round.

### Fixtures and side effects

**One mis-click, corrected.** The lakehouse import dialog's Radix picker kept
`f1_constructor_standings` selected from a previous open, and the first import
brought in that 10-row table instead of `saas_sales`. The table was dropped, the
picker's trigger text verified before the second submit, and the 9,994-row
import above is the second attempt. The imported `analytics.zz_ui_check_saas_sales`
was deleted afterwards; the lakehouse is back at its 20 tables.

**One flow re-pointed, restored.** Running "Summary data" with a throwaway
output name wrote that name into the user's flow (`user_prep_flows.output_table_name`
became `zz_ui_prep_check`). It was restored to `summary_segment_data` directly
in the database and the fixture table and its versions deleted; quality tests
and results are back at 0.

**The injected window fired the seeder.** While `user_data_tables` requests
were being rejected, the mount path's background `ensureSampleDataset` ran its
18 existence checks against the rejection and called `upsert_sample_dataset`
for each. The RPC body was read: it returns the existing id and writes nothing
when the sample is registered, and no row insert followed because the
`user_data_rows` count was not injected. `saas_sales` still counts 9,994 in the
"after" table above.

Findings from this round: R48 and R49 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The partiality sweep, driven page by page, ADVERSARIAL_LOG R36–R42

**Why this round exists.** Rounds 36 to 41 were proved by unit tests, mutation
harnesses and read-only database probes, and not one of them had been driven in
a browser. Driving them found **two defects the whole apparatus had missed** —
one of them shipped, load-bearing, and years old in spirit: every group budget
query the product has ever made returned a 400.

The app was rebuilt from source and the `agentswarms` service recreated; every
other container stayed up. The failure paths were reached by patching
`window.fetch` in the page to reject the specific requests under test, which is
the real catch branch running against a real failure rather than a stub.

### What was driven, and against what truth

| Round | Driven                                                             | Read back                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R36   | `/monitoring`, every `/_serverFn/` POST rejecting, Refresh pressed | before: `2 needing attention · checked 12:55:18 AM`; after: `3 needing attention at the last successful check` + `Live updates have stopped — every figure below is from the last successful check, not from now.` |
| R37   | `/model-registry`                                                  | `Browse 770 live models across all major providers.` — unchanged by the rewrite to an exact count plus paging                                                                                                      |
| R38   | `/knowledge`, "RAG eval · Halvard Systems"                         | `Indexed 12/12 documents`; twelve badges 8, 6, 9, 6, 3, 4, 29, 11, 6, 9, 4, 5 — summing to **100**, the base's true `kb_chunks` count                                                                              |
| R40   | run `97b11bf3`                                                     | `STEPS 4`, four rows in canvas order, `Data flow (3)`, `$0.0001` — identical to the pre-change baseline                                                                                                            |
| R40   | the same run with `swarm_run_steps` / `swarm_run_edges` rejecting  | banner `The detail of this run could not be read … The totals above come from the run itself and still stand`, no truncation caveat, `Data flow (—)`                                                               |
| R41   | `/dashboard`                                                       | `Spend (month to date) $1.68`, panel `$1.69 / 1.1k runs / 1.6M tokens` — unchanged, against a DB truth of `$1.677463` over `1,104` traces                                                                          |
| R42   | `/admin/iam` → Budgets, with one real group                        | `$1.68+?` and `(≥34%)`, tooltip `At least this much: 1 call used a model with no known price…` — DB truth: `$1.677463`, cap `$5.00`, exactly **1** unpriced row                                                    |

### The two things only the browser found

**Group budgets had never worked (R42, S1).** With a real group on screen the
spend cell read `unknown`, and its tooltip carried
`invalid input syntax for type uuid: ""`. `budget_spend_since(_user_id uuid, ...)`
is called by both group callers with `userId: ""`. Confirmed straight against the
database: `""` → 400, `null` → 200 `1.677463`, single-user control → 200
`1.677463`. So `groupSpend` always returned null, and a team cap either enforced
nothing or refused every member of the group on every call, depending on
`BUDGET_FAIL_CLOSED`. All 100 budget tests passed throughout — every one of them
is source-anchored and none had ever put an argument on the wire.

R39's own change is why it surfaced: the cell said "unknown" instead of the
confident `$0.00` the previous browser-side sum would have produced.

**A truncation caveat over a failed read (R42, S2).** With the step read
failing, the run detail page showed its error banner and, directly beneath it,
`Showing the first 0 of 4 steps` — what a SUCCESSFUL read of a prefix looks like
— while the tab beside it said `Data flow (0)`. Two sentences, one failure,
different stories. A unit test could not see it: the helper is correct for
`{ fetched: 0, total: 4 }`, and the defect was entirely at the call site.

### Not driven, and why

**The capped branches of R38 and R40.** Reaching them needs more than 50,000
chunks in one collection, or more than 20,000 steps in one run. This deployment
holds 104 and 28. Covered by unit tests and mutants, and by nothing else.

**R41's defect itself.** It only bites where PostgREST's `db-max-rows` is below
the page size requested; on this project the two are both 1,000. Changing a
hosted project's setting is not this campaign's to make, so the UI round proves
the REGRESSION half — `$1.68` survives the rewrite — and the defect stays proved
by the mutant that restores the original loop and fails.

### Fixtures

One IAM group, `ZZ UI check — group budgets (delete me)`, with one member and a
$5.00 cap, created so the Budgets tab had a figure to compute. Deleted after the
round along with its membership and its `budget_limits` row.

`MODEL_REGISTRY_MAX_ROWS` was set in `.env` and the registry's page size lowered
in source to force the truncation branch on real data; both were reverted and
the service rebuilt from the restored files.

**One unintended write.** "Refresh now" on the Model Registry page runs a real
sync against AIMLAPI rather than re-reading the table, and pressing it took the
registry from **770 to 792 models**. Not destructive — it is the page's own
maintenance action over a public catalog that was eight weeks stale — but it was
not the read it was mistaken for, and it is recorded here rather than left to be
noticed later.

Findings from this round: R42 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-20 — An alert's aggregate, run against the real engine, ADVERSARIAL_LOG R28

**Driven.** Not a dashboard round. The fix makes an alert ask the database for
its aggregate when the widget's snapshot is a prefix, and the risk a unit test
cannot cover is whether that SQL parses and answers correctly on a real engine
— which is exactly the class the dangling `GROUP BY` bug belonged to. So the
generated string was run through the **Workbench** against the lakehouse.

| Driven                                                                     | Read back                                      |
| -------------------------------------------------------------------------- | ---------------------------------------------- |
| The SQL `alertAggregateSql` builds for the live "Revenue by Region" widget | `51749.84` in one row — the seeded truth total |

That is the number an alert on `sum(total_revenue)` should compare against. The
prefix it used before is whatever the first N rows happened to add up to.

**Not driven.** The notification and email that a partial widget now produces,
and the once-only transition into the `partial` state. Reaching them needs a
scheduled refresh over a widget whose snapshot actually hits the row cap, and
nothing in the seeded data is that large. They are covered by unit tests and
mutants, and by nothing else.

Findings from this round: R28 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-20 — A direct widget's sentences follow its live result, ADVERSARIAL_LOG R27

**Driven.** Generated one widget over the lakehouse, switched it to **direct
query** from its own menu, then narrowed it with a dashboard filter so the live
result stopped matching the snapshot. Widget objects read out of React state,
which is the only place the derived display object exists — by design, since it
is never written anywhere.

| Driven                                        | Live rows | Displayed note                                       |
| --------------------------------------------- | --------- | ---------------------------------------------------- |
| Generated, import mode                        | 3         | `The data has 3 rows, not 5.` — and stored           |
| Menu → **Use direct query (live)**, no filter | 3         | `The data has 3 rows, not 5.` — unchanged, correct   |
| Dashboard filter `region = AMER`              | **1**     | **`The data has 1 row, not 5.`** — derived from live |
| Filter cleared                                | 3         | back to `The data has 3 rows, not 5.`                |

**The last row is the proof that nothing is persisted.** The sentence returned
to its original wording when the filter came off, which it could only do if it
were being derived per view rather than written back. Before this change the
middle row would have read "3 rows" over a single live bar.

Findings from this round: R27 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-20 — Stale prose withdrawn when its figures stop holding, ADVERSARIAL_LOG R26

**Driven.** The existing dashboard on the rebuilt image, 30 chart widgets of
which 23 carry a narrative. Narratives were read out of React state, because
the widget's prose is only shown on hover and the DOM does not carry it until
you are pointing at it.

| Driven                                                      | Read back                                                                                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read narratives before touching anything                    | The R24 artifact — a widget now querying five MONTHS — still carried "The top region, AMER, generated $25.9k… The three regions together generated $51.7k". Its rows total about 9k |
| Press **Refresh** (first run of the check on these widgets) | That narrative **withdrawn**. Seven of the nine Region-titled narratives kept theirs. One more went: Units Sold by Region — see below                                               |
| Press **Refresh** again, nothing changed in between         | 23 narratives before, **23 after, zero withdrawn**. The check does not churn, and does not delete prose from widgets whose data has not moved                                       |

**One withdrawal is unverified, and is recorded that way.** Units Sold by Region
has rows APAC 2121, EMEA 2118, AMER 2115 — total 6354, average 2118 — and prose
beginning "A total of 6.4k units were sold across all regions, with an average
of 2.1k units per region. APAC led with the highest sales at 2…". Every figure
in that fragment grounds. Whatever failed lies past the 130 characters that were
captured, and the prose was gone before that mattered; version history offers
restore, not read, and restoring would have destroyed the demonstration. It is
not claimed as a correct catch.

**The second refresh is the result that matters.** A check that deletes content
is dangerous in proportion to how often it fires wrongly, and over 23 narratives
whose data was untouched it fired not once.

Findings from this round: R26 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-20 — A single-value card says which row it draws, ADVERSARIAL_LOG R25

**Driven.** The existing generated dashboard on the rebuilt image — no new
generation, because the dashboard already held the three cases and inventing a
fourth would have proved less. Widget objects were read out of React state to
get `chart.type`, `valueField` and the real row arrays, then the rendered DOM
was read back for what the cards actually say.

| Card (live, unchanged)                               | Before                     | After                                                      |
| ---------------------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| **Revenue by Region** — kpi, 3 rows, `total_revenue` | `AMER 25.9k`, nothing else | `AMER 25.9k` **+ "1 of 3 rows"**                           |
| **Units Sold by Plan** — kpi, 3 rows, `total_units`  | `FREE 2.1k`, nothing else  | `FREE 2.1k` **+ "1 of 3 rows"**                            |
| **Best Month by Revenue** — kpi, 36 rows, `month`    | `2025-05`                  | `2025-05`, **no caveat** — correct, row zero is the answer |
| **Total Revenue** — kpi, 1 row                       | `51.7k`                    | `51.7k`, unchanged                                         |
| **Total Units Sold** — kpi, 1 row                    | `6.4k`                     | `6.4k`, unchanged                                          |

**Two caveats on the whole dashboard, and they are the right two.** Counted in
the DOM across roughly twenty-six widgets: exactly two nodes matching
`1 of N rows`, owned by Revenue by Region and Units Sold by Plan. The genuine
one-row totals stayed clean, and the ordered-label KPI stayed clean. A guard
that fires where it should not is worse than the gap it closes — on a dashboard
this size, that is the half the UI can actually prove.

**Nothing was regenerated or edited.** These cards were built in earlier rounds
and were left exactly as they were; only the renderer changed. That is the point
of computing the count at render rather than storing it — it reaches widgets
that already exist, and it cannot go stale on the ones that do not change.

Findings from this round: R25 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-20 — A note re-checked when the rows under it change, ADVERSARIAL_LOG R24

**Driven.** The running instance on the rebuilt image, against the lakehouse
`analytics.bi_demo_sales`. Widget objects were read out of React state through
the fiber, not inferred from the card, so "the field is stored" is a fact about
the object rather than about the pixels.

| Driven                                                                 | Read back                                                                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generate one widget, "Top 5 Regions by Revenue", over a 3-region table | Title `Top 5 Regions by Revenue — The data has 3 rows, not 5.`, and `reconcile_note` stored on the widget as that exact sentence. 3 rows                          |
| Press **Refresh** with the data unchanged                              | Every still-correct note preserved byte-for-byte across ~26 widgets. The no-write path, which is what stops a refresh dirtying the document over a sentence       |
| Rename the claim in the editor, `Top 5` → `Top 3`, and save            | **`Top 3 Regions by Revenue`** — note withdrawn, `reconcile_note` cleared, three bars (AMER/EMEA/APAC). The claim now matches the data, so the caveat retired     |
| Re-read the widget edited during the FIRST attempt                     | `Top 5 Regions by Revenue — The data has 3 rows, not 5.` with **5 rows**. The stale note, still standing — orphaned by the pre-fix builder. Left on the dashboard |

**The first attempt failed, and the failure was the second finding.** The plan
was: generate a widget with a note, edit its SQL so the count changes, refresh,
watch the note go. It did not go. The widget had no `reconcile_note` at all —
`BiBuilderPane` rebuilds its widget from an explicit list of fields, so editing
any widget dropped the new one and orphaned the note permanently. The test
method destroyed the thing under test. Fixed, and that widget is deliberately
left on the dashboard as the before-picture.

**Not exercised live.** The case where the DATA changes under a widget and the
note is rewritten rather than withdrawn — the seeded table's row counts do not
move, and nothing here manufactured a change to claim otherwise. All four write
sites call one function; its withdraw, rewrite, preserve and refuse branches are
covered by unit tests and eleven mutants.

**Kept for review.** Dashboard **"Reconciled titles - lakehouse"** —
`/bi/712429e4-4211-42ce-9422-d94c7cfc45dd` — now carries the stale note and the
retired one within a screen of each other.

Findings from this round: R24 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-20 — A chart's columns checked against its query, ADVERSARIAL_LOG R23

**Driven.** Four generations against the lakehouse (`analytics.bi_demo_sales`),
Gemini 2.5 Flash, each narrowed with **Clear all** to a single pick, on the
image rebuilt with the new check. `window.fetch` patched to record every
`/api/` call, so the SQL and the chart spec are readable side by side.

| Driven                                                              | Read back                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus: rank months, write no `LIMIT`                                | `SELECT month, SUM(revenue) AS total_revenue … ORDER BY total_revenue DESC`, no limit → 36 rows. **`truncate` fired live for the first time**: "Top 5 Months by Revenue — Showing the top 5 of 36." Five bars, axis 0–2.0k, tooltip `2025-12 total_revenue: 1.8k` |
| Focus: title "Best Month by Revenue", SELECT the month column only  | `SELECT month … ORDER BY SUM(revenue) DESC LIMIT 1`. The chart step chose **kpi on `month`** — a field that IS in the result — so the field check correctly said nothing. Renders "MONTH WITH HIGHEST REVENUE / 2025-05"                                          |
| Focus: same, more explicit — no aggregate in the SELECT list        | Model wrote `SELECT month, SUM(revenue) AS total_revenue … LIMIT 5` anyway. Fields present, claim 5 = 5 rows, nothing to reconcile                                                                                                                                |
| Focus: the literal one-column SQL, spelled out to be used unchanged | Same again. The SQL step declines to omit the measure                                                                                                                                                                                                             |

**The path this round was built for did NOT fire live, and this entry does not
pretend it did.** Four generations, four queries that all selected their own
measure. The bug is real and was observed twice in R22, before this check
existed — both of those runs produced `SELECT month` alone under a bar chart
declaring `yField: "revenue"` — but the SQL step would not reproduce it on
demand here. `unplottable` and the re-point repair are covered by 15 unit tests
and 14 mutants, and by nothing else.

**What four clean generations DO show.** A new guard that fires when it should
not is worse than the gap it closes: it would have turned four correct charts
into tables with an apology on them. None of the four grew a note, and the two
that had something to reconcile got the title note only. That is the half of
this change the UI can prove, and it is the half most likely to go wrong.

**Kept for review.** Dashboard **"Reconciled titles - lakehouse"** —
`/bi/712429e4-4211-42ce-9422-d94c7cfc45dd` — now carries the whole sequence
under one title: R20's correct generation, R22's false note, R22's repair
(five labels, no bars — the widget this round's check exists for), and R23's
truncate. The empty-bars widget is deliberately left as it was generated.

Findings from this round: R23 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-19 — A title that names an N the query capped itself below, ADVERSARIAL_LOG R22

**Driven.** Two generations against the lakehouse (`analytics.bi_demo_sales`,
the seeded 36-month series), Gemini 2.5 Flash, each narrowed with **Clear all**
to the single pick `Top 5 Months by Revenue` so one widget could be watched
end to end — once on the image that shipped R20/R21, once on the image rebuilt
with the fix. `window.fetch` patched to record every `/api/bi` call and clone
its reply, so the SQL the model wrote is readable beside the title it wrote.

**What the steer was for, and what it actually produced.** R20 closed with
`truncate` and `widen` unexercised live, because the un-steered generator wrote
correct limits every time. The focus text here told the model _not_ to write a
`LIMIT` — aimed at `truncate`. The model wrote `LIMIT 1` both times instead,
which is the `widen` case, and that is how the bug turned up. The steer did not
produce the outcome it was written for; it is recorded as what it was.

| Driven                                                  | Read back                                                                                                                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generate, pre-fix image, one pick                       | Model wrote `... GROUP BY month ORDER BY SUM(revenue) DESC LIMIT 1` under a title claiming 5. Widget rendered **`Top 5 Months by Revenue — The data has 1 row, not 5.`** — of a 36-month table. The R22 finding |
| Generate, rebuilt image, same pick, same focus          | Model wrote `... ORDER BY revenue DESC NULLS LAST LIMIT 1`. Widget rendered **`Top 5 Months by Revenue`, no note**, five month labels: 2025-05, -04, -06, -03, -12                                              |
| Opened that widget's editor and read its persisted SQL  | `SELECT month FROM analytics.bi_demo_sales WHERE revenue IS NOT NULL ORDER BY revenue DESC NULLS LAST **LIMIT 5**` — rewritten, so a later refresh agrees with the screen                                       |
| Cross-checked the five against R20's correct generation | The 4h-old widget on the same dashboard, whose SQL carried its own `LIMIT 5`, draws the same five months. The widened query returned the RIGHT five, not merely five                                            |

**Chart nodes were read, not assumed.** Counts above come from
`.recharts-rectangle` and `svg text` on the card after scrolling it into view —
these widgets virtualise, and a card measured while off-screen reports zero
bars and no labels whatever it actually draws. A first pass here did exactly
that and briefly showed the known-good R20 widget as empty.

**A second defect, found in the same frame and NOT fixed.** The repaired widget
draws **no bars** — five month labels along the x-axis, no y-axis ticks, no
rectangles. The model's SQL selects only `month`; it never selects `revenue`,
so the chart spec's `yField: "revenue"` has no column to plot. The R20 widget
beside it draws five bars and a 0–2.0k axis, which is what a correct generation
looks like. The title check cannot catch this — it reads the title against the
row count, and both agree. Reconciling a chart's declared fields against its
own result columns is a different check and a separate change; it is recorded
here as open, not quietly folded into this round.

**Kept for review.** Three widgets titled `Top 5 Months by Revenue` now sit on
dashboard **"Reconciled titles - lakehouse"** —
`/bi/712429e4-4211-42ce-9422-d94c7cfc45dd` — a correct generation from R20, the
false note this round found, and the same generation repaired.

Findings from this round: R22 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-19 — The analyst's answer, checked, ADVERSARIAL_LOG R21

**Driven.** Two questions through the **AI analyst** pane on the rebuilt image,
`window.fetch` patched to record every `/api/bi` call and clone its reply, so a
narrative retry is visible as a request carrying the correction prompt.

| Asked                                              | Read back                                                                                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "What is total revenue by region?"                 | One narrative call, no retry. `$2.3M` vs 2,297,201.86 · `$1.0M` vs EMEA 1,042,800 · `$415k` vs APJ 415,500, passing at exactly the ±500 its written precision allows |
| "What share of total sales does each region hold?" | Chosen to invite an invented percentage. No retry. 45.4% and 18.1% are the real shares; "about 33.3%" is the mean of the share column                                |

**What this does not show.** The catch path fired in neither run. Both answers
were correct — which is what giving the model computed facts is for — so the
check had nothing to reject. It is covered by unit tests and by a mutant that
severs it; two attempts at inducing an invented figure is not evidence that one
cannot occur, and no claim is made here that it is.

**A probe that nearly lied.** The first version detected a correction by
searching the request body for "must not appear", and duly reported one — on
the **SQL** step, whose prompt contains that phrase for unrelated reasons. The
marker is now the narrative correction's own opening sentence. Recorded because
a probe matching something other than what it claims will confirm whatever you
were hoping for.

Findings from this round: R21 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-19 — Titles reconciled against queries, ADVERSARIAL_LOG R20

**Driven.** The running instance on the rebuilt image. Three whole-dashboard
generations against the lakehouse, each chosen to put a different reconciliation
path under load, plus a direct re-read of the two widgets that produced the
original findings.

**Why chart types were read from the DOM, not assumed.** A widget that renders
one value with a label looks in a text dump exactly like a bar chart with one
bar. Every claim below about what a widget IS comes from checking the rendered
node — `recharts` present or absent, the `svg text` labels, the count of
`.recharts-rectangle` — because assuming it once already put a wrong sentence
in this log (see the correction on R19).

| Driven                                                        | Read back                                                                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-read "Top 5 Products by Sales" on the pre-fix dashboard    | A real recharts bar chart, **14 category labels**, SQL with no `LIMIT`. The R20 finding, confirmed rather than inferred                                           |
| Re-read "Revenue by Region" on the pre-fix dashboard          | `recharts` absent, no `svg text`, one value and a label — a **KPI**, not the bar chart R19 described. Correction filed                                            |
| Generate 13 widgets, lakehouse, no focus                      | Nothing to reconcile: every generated query matched its title. "Revenue by Region" came back without a `LIMIT` this time                                          |
| Generate 8 widgets, focus on rankings                         | "Top 5 Months by Revenue" → exactly 5 bars, and the right five: 2025-05, -04, -06, -03, -12, matching the seeded series' five highest months                      |
| …same run                                                     | "Top 3 Plans by Units Sold" → SQL carried `LIMIT 3`, **3** bars, 3 `svg text` labels. The trailing `—` in the card's text is not a category, it is a sibling node |
| Generate 1 widget, "top 5 regions" against a table with three | **The path that proves the wiring.** Title rendered as `Top 5 Regions by Revenue — The data has 3 rows, not 5.`                                                   |

**The bug this round existed to find.** On the first attempt at the last row,
the widget rendered correctly and the title carried **no note**: the generator
assigns `widget.title = picks[i].title || widget.title` two lines after the note
was applied, overwriting it. Twenty unit tests and seventeen mutants were green
— they asserted the note was produced, never that it survived. One forced
generation found it. Fixed, and the test now asserts the ORDER of the two
assignments with a mutant that reinstates the overwrite.

**Kept for review.** Both versions are on the same dashboard, adjacent:

- Dashboard **"Reconciled titles - lakehouse"** —
  `/bi/712429e4-4211-42ce-9422-d94c7cfc45dd` — two widgets titled "Top 5 Regions
  by Revenue", one from before the fix and one after, each drawing AMER / EMEA /
  APAC; only the second says what the data actually had.

**Not exercised live.** `truncate` and `widen` did not fire in any of these
runs, because the generator wrote correct `LIMIT`s every time. Both are covered
by unit tests and mutants; neither has been seen repairing a live generation,
and this entry does not claim otherwise.

Findings from this round: R20 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-19 — Every figure an AI card states, checked, ADVERSARIAL_LOG R19

**Driven.** The running instance on the rebuilt image, signed in as the owner.
The **AI insight** control on four widgets of the AI-generated lakehouse
dashboard, each one a different shape: a 36-row time series with no shares
computable, a second time series, a 3-row breakdown, and a self-capped query.

**How the catch was observed.** `window.fetch` patched to record every
`/api/bi` call and clone its reply, so a rejected first draft is visible as a
second call carrying the correction prompt — the same technique the log's
Method section describes for failed reads, and for the same reason: the screen
alone cannot tell you a retry happened. A full page reload destroys the patch,
so every measurement below was taken without one.

**The reference series.** `analytics.bi_demo_sales`, seeded from
`base(t) = 1000 + 25t + 200·sin(2πt/12) + 10·sin(7t)` — 36 months, total
**51,749.84**, regions weighted 0.5 / 0.3 / 0.2 — so every figure a card states
was checkable rather than plausible.

| Widget                       | Calls | Read back                                                                                                                                                                          |
| ---------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monthly Revenue Trend        | **2** | A first draft rejected and rewritten. Final card: total `$51,749.84`, max `$1,882.60` (2025-05), mean `$1,437.50` (= 51,749.84/36), low `$1,000` at January 2023 — every one exact |
| Monthly Units Sold Trend     | **2** | Rejected a **correct** sentence — the "b" of "both" read as a billion suffix (R19). After the fix: **1 call**, no correction, card still says "January 2023"                       |
| Revenue by Region            | **1** | Card claimed `100%` and "no other regions", every figure verifying, because the SQL ends `LIMIT 1` (R19). After the fix: the card states the cap itself and claims no share        |
| Sales by Region (saas_sales) | **1** | `$2.3M`, `$1.0M`, `45.4%`, `$837.9k`, `36.5%`, `$415.5k`, `18.1%` — all traceable, shares sum to 100.0%. Note `$837.9k`, not the `$837k` the checker rejects                       |

**What the two calls prove.** A second `/api/bi` call carries a system prompt
naming the offending figures, so the count is direct evidence of the check
firing — not an inference from what rendered. On "Monthly Revenue Trend" the
rejected draft and the accepted one were captured side by side; the correction
changed `177` to `176.5` and dropped a month the data did not support.

**Kept for review.** Both "Insight — Revenue by Region" cards are left on the
dashboard on purpose, the before and the after together:

- Dashboard **"AI from the lakehouse - generated"** —
  `/bi/c9bbdd5c-eab3-4717-b3bf-dc4a0392b9b3` — card `aaaf9b5f` is the one
  claiming 100% of revenue for AMER; card `9167dfa9` is the same button pressed
  after the fix, disclosing that the query returned only the top region.

Findings from this round: R19 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-18 — BI dashboarding and reporting end to end, ADVERSARIAL_LOG R18

**Driven.** The running instance, signed in as the owner. Three surfaces: a
hand-built dashboard over a series whose every value was known before the first
tile existed; a paginated report the AI planned and built; and a whole
dashboard the AI generated unaided. Then the AI extras on top of them — the
per-widget insight, the insight sweep, the NL analyst, and an ontology over the
built-in lakehouse.

**The reference series.** `analytics.bi_demo_sales` in the lakehouse, seeded by
ETL pipeline `bi_seed` from `base(t) = 1000 + 25t + 200·sin(2πt/12) +
10·sin(7t)` — 108 rows, 36 months, three regions weighted 0.5 / 0.3 / 0.2,
total **51,749.84**. Every number a tile showed could therefore be checked
rather than eyeballed.

### Visual types

| Driven                                                                                                                                                                                                                                                   | Read back                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 25 of the 26 types on one dashboard: column, bar, stacked column, stacked bar, bar race, line, area, combo, scatter, pie, nightingale, radar, funnel, sankey, treemap, word cloud, heatmap, box plot, waterfall, KPI, gauge, matrix, map, bubbles, table | Every one rendered from the lakehouse table. Matrix checked cell by cell against the seeded series; treemap and table totals 51.7k; heatmap rows AMER/APJ/EMEA against 36 month columns                         |
| The 26th, **Ontology**, built from the lakehouse (21/21 tables)                                                                                                                                                                                          | 21 entities, 1 source — and the AI step timed out at 60s, leaving 0 relationships and heuristic labels (R18)                                                                                                    |
| Forecast, 6 periods, built-in seasonal                                                                                                                                                                                                                   | 1874.2 / 1997.0 / 2095.4 / 2148.6 / 2147.7 / 2099.5 against truth 1906.24 / 2034.84 / 2131.80 / 2178.14 / 2169.33 / 2116.02 — **MAPE ≈ 1.4%**, peak at step 4 in both, band widening 208.5 → 510.6 = √6 exactly |
| Filled map and bubble map over a column of ISO alpha-2 codes                                                                                                                                                                                             | "10 rows not matched to a country" on both — 2 of 280 codes resolved, `GB` among the failures (R18)                                                                                                             |

### The AI half

| Driven                                                                          | Read back                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Generate a report** over `saas_sales`, twice from the same brief              | A 4-section plan each time with a chart type and a rationale per section. Run 1 built 3 of 4 and disclosed the shortfall; run 3 built all 4 (11 blocks). Header, footer, `{{page}} of {{pages}}` and the repeated table header all behave |
| **Generate Entire Dashboard** over `saas_sales`, no focus given                 | An executive summary and 13 widgets across 13 chart types, all 13 built. Two carry a `PARTIAL` badge where the snapshot hit its row cap                                                                                                   |
| **AI analyst** (NL → SQL → chart → narrative), asked for total sales and profit | `SELECT SUM(Sales) AS total_sales, SUM(Profit) AS total_profit FROM saas_sales` → 2.30M / 286.4k, matching both generated KPI tiles and the 14-row product breakdown, which sums to 2,297,201.86                                          |
| **AI insight** on "Sales by Region"                                             | A structured card — what the data shows / watch out for / next steps — whose three percentages summed to **106%** (R18)                                                                                                                   |
| **Scan** on the generated dashboard                                             | "Swept 10 widgets and found 2 things worth a look… 4 could not be swept", each with its reason. Deterministic, no model call. The 2025-11 outlier at 3.1 MAD from the median                                                              |
| **Build ontology with AI**, lakehouse only                                      | AI enrichment refused at the 60s deadline, disclosed in the widget, heuristic fallback shown (R18)                                                                                                                                        |

### Blocked, and why

Neither AI generator can be pointed at a lakehouse or warehouse table — both
offer local datasets (and, for dashboards, a governed semantic model) only — so
the "generate from the lakehouse" path was exercised through the **Ontology**
builder, which does list it, and through a dashboard widget carried into a
report. Recorded in the log as a product decision rather than a defect.

**Kept for review.** The user asked for these to be left in place:

- Dashboard **"BI verification — known series"** — `/bi/64a77e4b-041a-4d41-b58c-092745558f7a`
  — the 25 visual types over the seeded lakehouse series, including the two map
  widgets that produced the country-code finding and the verified forecast.
- Dashboard **"AI verification - generated from saas_sales"** —
  `/bi/db14d61a-6fe7-4862-a428-42eabb600ad2` — everything on it was written by
  the AI: the executive summary, 13 widgets, the insight card whose percentages
  summed to 106%, and the ontology widget.
- Report **"Revenue pack - known series"** —
  `/bi/report/d27fef19-1c65-4287-9161-424d0e7c6d93` — the AI-planned paginated
  report, saved at the 3-section version that produced the preview/PDF finding.

### Re-driven on the rebuilt image

The same widgets, after the fixes, on the same data:

| Widget                                     | Before                                       | After                                                                                        |
| ------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Revenue by country, filled and bubble      | "10 rows not matched" of 11                  | "3 rows not matched" — all 8 real countries draw, `GB` included; the 3 are `??`, `U S`, `XX` |
| Report trend axis, and both AI time charts | `1667260800000`                              | `2022-05 … 2025-12`, on AUTO, no user action                                                 |
| "Top Products by Revenue" table            | `410379.26499999943`                         | `410,379.26` — the text the PDF prints                                                       |
| Data ontology                              | 0 links, "AI enrichment unavailable (… 60s)" | **76 entities, 55 relationships, 5 sources, "AI-built"**                                     |
| AI insight on "Sales by Region"            | 48% + 39% + 19% = **106%**                   | 45.4% + 36.5% + 18.1% = **100.0%**, with the total it divided by stated                      |

### Re-driven again: both AI generators, pointed at the lakehouse

After the source picker was added to both dialogs (and the report editor's own
route was given a real warehouse context):

| Driven                                                                                                            | Read back                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Generate Entire Dashboard** → source "Lakehouse — AgentSwarms Lakehouse (built-in)" → `analytics.bi_demo_sales` | All 21 lakehouse tables offered, none with a misleading "0 rows". 13 widgets built. **Total Revenue 51.7k** — the seeded series total — and AMER 25.9k, matching the regional split verified earlier                         |
| The generated KPI's own editor                                                                                    | SQL `SELECT SUM(revenue) AS total_revenue FROM analytics.bi_demo_sales`, source **"Lakehouse — AgentSwarms Lakehouse (built-in)"** — so refresh and drill-through return there                                               |
| **Generate a report** → same source → same table, 3 sections                                                      | 9 blocks. The detail table's 36 monthly rows sum to **51,749.84**, against 51,749.79 recomputed from the seeding formula `1000 + 25t + 200·sin(2πt/12) + 10·sin(7t)` — the 5-cent gap is per-row rounding in the stored data |
| The same report's chart axis and table cells                                                                      | `2023-01 … 2025-12` on AUTO and `1,131.56` rather than a raw float — the earlier two fixes holding on a lakehouse-sourced page                                                                                               |

**Kept for review** (added to the list above):

- Dashboard **"AI from the lakehouse - generated"** — `/bi/c9bbdd5c-eab3-4717-b3bf-dc4a0392b9b3`
  — 13 widgets, every one of them written by the AI against the lakehouse.
- Report **"Lakehouse pack - generated"** — `/bi/report/aee89589-104e-49c7-ad0f-29e0a5efb9ed`
  — the AI-planned paginated report whose numbers reconcile to the cent.

Findings from this round: R18 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-18 — A shipped sample pipeline, run; what the product wrote, it could not read back

**Driven.** The running instance, signed in as the owner. `recon_live2`,
created from the bundled **Orders ↔ payments reconciliation** sample — the
most complex graph the product ships: two Python sources, a dedupe, an
aggregate, a **full outer join**, a Python classifier, a two-way filter branch,
and two object-storage targets in **different file formats**. Ten nodes, nine
edges, one run.

The expected answer was computed first, independently, by re-deriving the graph
node by node in pandas inside the runtime image over the same two CSVs — so the
run had something to be wrong against.

| Step                                        | Reference (computed first) | The run reported                   |
| ------------------------------------------- | -------------------------- | ---------------------------------- |
| orders.csv / payments.csv                   | 308 / 290 rows             | 8 / 5 columns, both read           |
| dedupe on `order_id`                        | 300 (8 duplicates dropped) | —                                  |
| payments per order                          | 284 groups                 | `order_id, paid_total, n_payments` |
| **full outer join**                         | **309 rows**               | **309 rows loaded**                |
| classify                                    | 11 columns out             | 11 columns out                     |
| → `finance/orders_reconciled` (**parquet**) | **257**                    | **257**                            |
| → `finance/recon_exceptions` (**jsonl**)    | **52**                     | **52**                             |

Succeeded in 49s. Every number matched, including the classification split
(ok 257 · missing_payment 25 · amount_mismatch 12 · orphan_payment 9 ·
duplicate_payment 6).

Then the Data Catalog was opened on the two tables it had just re-crawled, and
the round stopped being about the join.

### What the catalog said about the files the run had just written

| Asset               | Catalog said         | Actually in the bucket                                 |
| ------------------- | -------------------- | ------------------------------------------------------ |
| `orders_reconciled` | parquet · 257 rows   | `1789716743.9029138.58bdd233ab.parquet` — correct      |
| `recon_exceptions`  | ndjson · **10 rows** | `1789716749.8566182.2f2a328a13.**jsonl.gz**` — 52 rows |

And **Query data** on `recon_exceptions`, the catalog's own button over the
catalog's own asset:

```
IO Error: No files found that match the pattern
"s3://etl/finance/recon_exceptions/*.ndjson"
```

One cause, three faces, all of them "dlt gzips text output":

| #   | Defect                                                                                                                                                                                                                | How it surfaced                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | **The catalog globbed a name nothing has.** `*.${logical format}` over a folder of `*.jsonl.gz` — the fqn is the catalog's join key, so the Workbench, an ETL catalog-asset source and lineage all pointed at nothing | pressing Query data                                             |
| 2   | **The row count was counted in compressed bytes.** Newlines that happen to occur in a gzip stream; 52 rows became a confident, plausible **10**                                                                       | comparing the catalog's row count with the run's own load count |
| 3   | **The object-storage source could not read it back.** `fs.open(k, 'rb')` hands pandas gzip: `UnicodeDecodeError: … byte 0x8b`                                                                                         | reproduced in the runtime image with fsspec + pandas, both ways |
| 4   | **The run and the crawler would then disagree.** A run REPORTS its target's fqn and `catalog_lineage` joins on that string — fixing the crawler alone would have broken the lineage edge instead                      | followed from 1; what dlt writes was then measured, not assumed |

Defect 3 is the one that decides how bad this was: this product's own
object-storage target is what writes the `.gz`, so "pipeline B reads what
pipeline A wrote" — the medallion pattern the other bundled sample
demonstrates — could not work for csv or jsonl at all.

What dlt actually names its files was measured in the runtime image against
dlt 1.30.0 rather than assumed, because assuming is how this happened:

| loader format | file left in the bucket                     |
| ------------- | ------------------------------------------- |
| jsonl         | `1789717247.006242.313c9cc5f7.**jsonl.gz**` |
| csv           | `1789717247.5861135.1a09cd7f30.**csv.gz**`  |
| parquet       | `1789717248.6333005.a2880ca09f.parquet`     |

Spark's naming is different again (`part-*.json`, `part-*.snappy.parquet`), so
the two engines report different globs for the same graph — on purpose, and
asserted as such.

### Union and the quality gate — the last two transform kinds with no live evidence

**`union_live`** — the two halves the reconciliation run wrote, put back
together: a **Data Catalog asset** source on `finance/orders_reconciled`
(Parquet, 257 rows) and another on `finance/recon_exceptions`
(**gzipped** NDJSON, 52 rows) → **union** → `analytics.recon_union`.

The picker named the second one `Reads JSONL at
finance/recon_exceptions/*.jsonl.gz` — the glob the crawler had just corrected
— and the sandbox opened it with pandas, which is the read that used to die on
`byte 0x8b`.

Succeeded in 1m 23s, **309 rows → 1 target**. Read back from the lakehouse:

| recon_status      | rows | reference |
| ----------------- | ---- | --------- |
| ok                | 257  | 257       |
| missing_payment   | 25   | 25        |
| amount_mismatch   | 12   | 12        |
| orphan_payment    | 9    | 9         |
| duplicate_payment | 6    | 6         |
| **total**         | 309  | 309       |

257 + 52 = 309, and the five categories are the reconciliation's own, so the
union is provably the two inputs and nothing else.

**`gate_live`** — `analytics.recon_union` (309 rows) → **quality gate** →
`analytics.gate_out`. Five rules, run in order, covering five of the six check
kinds and all three severities:

| #   | Rule                                | Severity | Expected | The run said                |
| --- | ----------------------------------- | -------- | -------- | --------------------------- |
| 1   | `allowed_values(recon_status ∈ ok)` | drop     | 52       | `DROP … removing 52 row(s)` |
| 2   | `not_null(customer_id)`             | warn     | 5        | `WARN … 5 row(s) violate`   |
| 3   | `range(amount ≥ 0)`                 | warn     | 4        | `WARN … 4 row(s) violate`   |
| 4   | `regex(order_id ~ ORD-[0-9]+)`      | fail     | 0        | silent — nothing to report  |
| 5   | `row_count_min(300)`                | fail     | abort    | **run FAILED**              |

> `RuntimeError: Quality gate Quality gate: row_count_min(300) failed — 257 row(s), need 300`

257 is 309 minus the 52 that rule 1 dropped, so the ordering is real: rule 5
measured the frame rule 1 had already shrunk. Rules 2 and 3 counted their
violations **after** the drop too — 5 nulls and 4 negative amounts among the
257 survivors, not the 15 and 13 in the whole table.

Lowering rule 5 to 250 and re-running: **Succeeded, 257 rows → 1 target.**

With these two, **all fifteen transform kinds have been run against real data
from the canvas**, not only compiled.

### One more thing the round found, by mis-clicking

Creating `recon_live` from the sample produced the **blank starter graph** —
two nodes where the sample has ten — under the name chosen for the sample, and
nothing said so. The New pipeline dialog had been dismissed earlier by a
mis-aimed click on the overlay while a template was selected; Radix unmounts
the dialog's content but not the component holding its state, so on reopening
the tile was still highlighted. Clicking the tile you want is what anybody
does — and the tile toggles. The create path already cleared both fields; only
the dismiss path did not.

### And the fix did not reach the pipeline that found it

With everything deployed and the catalog re-crawled, re-running `recon_live2`
**still wrote the old target fqn** — its lineage edge went on pointing at a
filename that does not exist, beside a catalog asset that was now right.
Pressing **Save** to recompile did nothing: the button is disabled when the
graph has not changed.

The generated program is a cache of the graph, and the run executed the cache.
Every visual pipeline on an upgraded deployment keeps running the previous
release's program until somebody edits it for an unrelated reason — runs still
succeeding, nothing pointing at it. This sitting had already paid for it once
without noticing: the SQL step's move off ibis never reached a pipeline created
before that rebuild, and its stored requirements went on installing ibis.

### A node left half-configured, and what it said

Building the platform-dataset case, the "Choose a dataset" select was never
opened. The graph **saved**, the run **started**, and it failed with

```
requests.exceptions.HTTPError: 404 Client Error: for url:
http://agentswarms:8080/api/notebook/runtime/source
```

— the app's own internal API, named as though it were the problem. Targets had
said the right thing all along ("Node “Reconciled” has no bucket selected",
"Lakehouse table must be a valid identifier … got ''"); sources and transforms
reached pandas, requests or DuckDB first and failed in whichever library got
there. Every required field is now refused at compile, naming the node.

### Three more node kinds, driven

| Pipeline        | Graph                                                             | Result                                           |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| `platform_live` | **platform dataset** `summary_segment_data` → lakehouse           | **9,992 rows** — the count the picker advertised |
| `http_live`     | lakehouse `analytics.gate_out` (257) → **HTTP API (reverse ETL)** | **3 requests, 257 records** at the receiver      |

The reverse-ETL target was driven against a real HTTP receiver on the kernel
network, counting what arrived: `rows=100 · rows=100 · rows=57`, 257 records
carrying all thirteen columns. Batching at 100 rows per request is exactly what
the node was configured for.

Its first attempt failed, and that is the finding: the receiver was on `:8099`,
its host was on the allow-list, the generated `allowed_domains` file carried
`.echo-target.local` — and the run died with

```
requests.exceptions.HTTPError: 403 Client Error: Forbidden for url:
http://echo-target.local:8099/hook
```

which reads as the endpoint refusing. It was squid: `http_access deny
!Safe_ports`, and Safe_ports is 80, 443, 9000, 19000. Moving the receiver to
port 80 made the same pipeline succeed first try. The allow-list covers hosts;
nothing covered ports, so the one rule that could refuse a perfectly configured
node was invisible until it fired from inside a container.

### The same graph on the other engine

`spark_live` — lakehouse `analytics.recon_union` (309) → filter
`recon_status == 'ok'` → lakehouse `analytics.spark_out`, with **Engine = Spark
cluster** in Settings. Succeeded in 10m 12s:

```
[etl] spark: connected to sc://spark-connect:15002 (4.2.0)
[etl] spark: staged 257 row(s) at s3a://lakehouse/main/_spark_stage/n3/…
[etl] {"rows_loaded": 257, … "engine": "spark",
       "lineage_sources": ["lakehouse:analytics.recon_union"]}
```

**257** is the same number the pandas engine produced for the same predicate in
`gate_live`, from the same table, with all thirteen columns carried through.
Two engines, one answer. (Ten minutes is this host, not the product: code
generation alone took 7 s on a cold JVM with 8 CPU and 11 GB.)

An earlier attempt failed with **"The run never acquired a sandbox session."** —
the app container was rebuilt while that run sat queued. The message is the
reaper's and it is the right one; noted here because it appears in the run list
above and was self-inflicted.

Kept for review: pipelines **`recon_live2`** (the bundled sample, three runs),
**`union_live`**, **`gate_live`** (one failed run and one succeeded, on purpose),
**`platform_live`**, **`http_live`** and **`spark_live`**, with their runs and
logs; lakehouse
tables `analytics.recon_union` (309), `analytics.gate_out` (257) and
`analytics.platform_out` (9,992) and `analytics.spark_out` (257); bucket
datasets `finance/orders_reconciled`
and `finance/recon_exceptions`. Two throwaway containers can be removed with
`docker rm -f`: **`agentswarms-echo-target`** (the reverse-ETL receiver, on the
kernel network as `echo-target.local`, allow-listed under Admin → Developer
runtime) and the earlier `agentswarms-redpanda-test`.

**Tests:** 21 in `tests/unit/catalogGzipDataset.test.ts`, 7 in
`tests/unit/etlRunRecompiles.test.ts`, 30 in
`tests/unit/etlUnfinishedNode.test.ts` and 6 in
`tests/unit/etlEgressPort.test.ts`, twenty-five guards
mutation-checked one at a time (each reversion caught) with a control mutant
that was correctly missed. The reader is exercised as real Python in the
runtime image, failing without `compression='infer'` and working with it; the
lakehouse mount's fqn regex and the Catalog's "Query data" test are pulled out
of the source and executed, so they are checked by behaviour, not spelling.

## 2026-09-18 — The ETL node catalogue, driven; Kafka against a real broker

**Driven.** The running instance, signed in as the owner, building pipelines
node by node on the canvas rather than from templates — which is how three of
the four defects below were found. Streaming ran against a local Redpanda
(`redpandadata/redpanda:v24.2.7`, alias `redpanda-test.local`) on the kernel
network, fed with `rpk`.

### A long chain of transforms, off an HTTP JSON source

`matrix_transforms`: **orders API (HTTP/JSON)** → filter → select → rename →
derive → deduplicate → limit → **lakehouse table**, every node added from the
toolbar and wired automatically.

| What        | Configured as                            | Read back from `analytics.matrix_out`           |
| ----------- | ---------------------------------------- | ----------------------------------------------- |
| source      | `orders.json`, records path `data.items` | 308 rows arrived                                |
| filter      | `amount > 0`                             | the 7 non-positive rows gone                    |
| select      | order_id, customer_id, country, amount   | exactly those columns, plus the derived one     |
| rename      | `amount → gross`                         | the column is `gross`                           |
| derive      | `net = gross * 0.9`                      | **`sum(net)/sum(gross) = 0.9000` exactly**      |
| deduplicate | (all columns)                            | **`count(DISTINCT order_id) = 250 = count(*)`** |
| limit       | 250                                      | **250 rows**                                    |

### Kafka, against a real broker

`kafka_live`: **Kafka topic** → filter (`status == 'paid'`) → **lakehouse
table** (append). 120 JSON messages produced to `orders_stream`, then 30 more.

| Run | Topic state                                 | Result                 | Table after                                                |
| --- | ------------------------------------------- | ---------------------- | ---------------------------------------------------------- |
| 1   | 120 messages, 90 of them `paid`             | Succeeded, **90 rows** | 90 rows, `sum(amount)` **22666.44** — to the cent          |
| 2   | nothing new                                 | **FAILED** — see below | —                                                          |
| 3   | nothing new, after the fix                  | Succeeded, **0 rows**  | unchanged                                                  |
| 4   | 30 more on a DIFFERENT partition, 20 `paid` | Succeeded, **20 rows** | **110 rows**, **25869.13**, 2 partitions, 110 distinct ids |

Run 4 is the one that matters: only the new partition's messages were read,
none of the 120 was read twice, and the totals add up exactly
(22666.44 + 3202.69 = 25869.13).

### What driving it found

| #   | Defect                                                                                                                                           | How it surfaced                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1   | **"Add rename" did nothing** — one of fifteen transform kinds could not be configured from the canvas at all                                     | clicking it, twice by mouse and once by `.click()` on the element |
| 2   | **A caught-up stream failed on every quiet tick** (`KeyError: 'status'` on a frame with zero rows and only `_stream_*` columns)                  | run 2 above                                                       |
| 3   | **A failed access check read as a refusal** — `no access to lakehouse schema "analytics"` while the same owner queried that schema seconds later | a run in between, then the SQL editor                             |
| 4   | **An HTTP node pointing at an unreachable host** returned forty lines of urllib3 instead of naming the host                                      | pointing an HTTP API source at the app's own origin               |

Defect 2 took two attempts, and the second attempt is the lesson: the first
guard tested for "no rows AND no columns", which is what a bare
`pd.DataFrame()` looks like — and it did not fire, because a quiet Kafka read
returns its five `_stream_*` metadata columns. The live run failed again,
identically. Row count is the honest test.

Kept for review: pipelines **`matrix_transforms`** and **`kafka_live`** with
their runs, tables `analytics.matrix_out` and `analytics.kafka_orders`, and the
Redpanda container `agentswarms-redpanda-test` (removable with `docker rm -f`;
its host is on the egress allow-list as `redpanda-test.local`).

## 2026-09-17 — Lakehouse, ETL and ML, by real runs from the UI, ADVERSARIAL_LOG R16

**Driven.** The running instance on :8080, signed in as the owner, in the
lakehouse SQL editor, the visual pipeline editor and the ML pages. Nothing here
is a rendered card: every row is a real statement against the live catalog or a
real run in the sandbox container, read back from the result grid, the run list
and the run's own log line. The ETL rounds ran on the image built at `b9aef9f`;
the lakehouse rounds on the rebuild that added `64e34dd`, which is the commit
the first pass of this same round produced.

### Lakehouse: what a write may read, and what a quote may contain (`e045783`, `e335335`, `64e34dd`)

**Driven.** The SQL editor on the rebuilt image, in `analytics`, against the
live DuckLake catalog. Row 3 and row 5 are the regression checks (my first two
attempts at this fix broke one each); rows 4 and 6 are the security checks.

| #   | Statement                                                                                | Expected                            | What came back                                                                          |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `SELECT 'A--B' AS dashes, '/*' AS open_c, '*/' AS close_c`                               | three columns, values intact        | 1 row, 1746 ms — `A--B`, `/*`, `*/`                                                     |
| 2   | the same three literals, one statement earlier (previous image)                          | —                                   | "unterminated quoted string" for the first; the other two silently became ONE column    |
| 3   | `UPDATE analytics.authz_probe SET plan = plan WHERE authz_probe.net_usd > 0`             | succeeds — the alias-qualifier case | Count 9                                                                                 |
| 4   | `CREATE TABLE analytics.authz_probe2 AS SELECT * FROM nosuch.customers`                  | refused, naming the schema it reads | `No access to schema "nosuch" — it doesn't exist, or nobody shared it with you`         |
| 5   | `UPDATE analytics.authz_probe SET status = 'A--B /* not a comment */' WHERE net_usd > 0` | succeeds; the literal survives      | Count 9, then `SELECT status, count(*) …` → `A--B /* not a comment */` ×9, `paid` ×1    |
| 6   | `SHOW ALL TABLES`                                                                        | refused — catalog-wide listing      | `"SHOW" needs a schema-qualified target here — catalog-wide listings are not available` |

Row 2 is the reason row 1 is here: the literal-aware stripper was written for
the write-authorization work and then used only there, so every SELECT kept the
two regexes that did not know what a string was. Reading the diff would not
have shown it — the commit message even claimed the opposite. Typing a
perfectly ordinary statement into the editor did.

Kept for review: `analytics.authz_probe` (10 rows; 9 of them now carry the
comment-shaped status string from row 5).

### Run parameters reach a visual pipeline (`b9aef9f`)

The claim to disprove: before this commit a parameter could be typed into
"Run with parameters", accepted, pinned on the run row and handed to
`entrypoint(inputs)` — and change nothing, because `_tick` never read its
argument. The only way to see it was to compare row counts between two runs.
So that is the test.

**Setup.** New pipeline `param_probe2` from the "Medallion branch-out" sample
(pre-wired: HTTP source → standardise → valid/rejected branches → three object
storage targets). One field edited, in the "Valid rows" filter:

```
is_valid                →   is_valid and country == '{{params.country|DE}}'
```

Saved. Settings → Default destination = "MinIO local etl demo". The source CSV
(`/etl-samples/orders.csv`, 308 rows) carries US 47, JP 34 among its countries.

| Run                 | Parameters          | Result    | Total | `orders_silver` (parameterised branch) | `orders_quarantine` | `revenue_by_country` |
| ------------------- | ------------------- | --------- | ----- | -------------------------------------- | ------------------- | -------------------- |
| 7:30:43 PM, 1 m 1 s | `{"country": "US"}` | Succeeded | 64    | **43**                                 | 18                  | 3                    |
| 7:32:47 PM, 28 s    | `{"country": "JP"}` | Succeeded | 52    | **31**                                 | 18                  | 3                    |

Read from: the Runs tab (status, duration, "N rows → 3 target(s)") and each
run's own **Logs** dialog, which carries the sandbox's `rows_loaded` line with
a per-target breakdown and load ids.

Two runs of one saved pipeline, one program, different data. The controlled
part is what did **not** move: the quarantine and country-KPI branches do not
reference the parameter and read 18 and 3 both times, so the 43 → 31 is the
parameter and nothing else.

### Auto-ingest and a row cursor cannot share a source (`9dd4c9e`)

**Setup.** Pipeline `param_probe`, a "Object storage files" source on the MinIO
bucket, folder `raw/revenue/orders`, **auto-ingest on** and **incremental
cursor `updated_at`** — the combination that used to compile, run once, and
die on its second run inside `json.loads`.

| What                       | Read from                | Result                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The canvas refuses it live | the validation banner    | `Source "Object storage files" uses auto-ingest AND an incremental cursor on "updated_at". They are two cursors for one source and overwrite each other — the pipeline would fail on its second run. Keep auto-ingest to load only new FILES…` |
| Save keeps the draft…      | the Save toast           | "Saved — but the graph can't run yet: …" then the same sentence                                                                                                                                                                                |
| …and the run is refused    | the trigger's reply      | `{ok: false}` — no run row, nothing reached the sandbox                                                                                                                                                                                        |
| The message names both     | the banner and the toast | the node label the user clicked and the column the user typed                                                                                                                                                                                  |

**A finding this round produced.** The refused run's reply was
`"Pipeline has no code to run"` — true (the graph never compiled, so
`source_code` stayed empty) and useless: it reads like the pipeline is empty
and points at a code tab a visual pipeline does not have. `startEtlRun` now
recompiles the stored graph before falling back to that sentence, so Run says
what the editor said. Tests: `tests/unit/etlRunRefusalReason.test.ts`.

Kept for review: pipelines **`param_probe2`** (two succeeded runs with their
parameters and logs) and **`param_probe`** (left in the refused state, so the
banner and the Save toast can be seen without rebuilding it).

### ML: the decision threshold on a warm endpoint (`837180d`)

The hardest of the four to drive, because it needs a **two-class** model (a
single line means nothing otherwise), a threshold set on its production
version, and a **warm** endpoint — the path a deployed model actually answers
from, and the one that was ignoring the line. None of the instance's existing
models qualified: the plan classifier predicts four classes, and no version
anywhere carried a threshold. So the round builds one.

**Setup, all through the UI.** ML → Train a model → `analytics.revenue_facts`,
target `payment_rows` (the profiler labels it "Classification · 2 distinct"),
whole table, no tuning. Trained in ~2 minutes: lightgbm, F1 macro 58.8%,
ROC AUC 86.7%, 96% of rows in the majority class. Accuracy tab → Operating
point → **the line drawn at 0.30** for the class "2" (audited:
`ml.threshold.set`, detail `{version: 1, threshold: 0.3, positive_label: "2"}`).
Automation tab → **Deploy** → "Warm endpoint · serving v1 · 1 of 1 copy
answering".

**Finding the row that tells the two apart.** A threshold only changes an
answer where the positive class scores between the line and 0.5. One batch run
over all 836 rows, then in the SQL editor:

```sql
SELECT order_id, prediction, threshold_applied, proba_2
FROM analytics.threshold_probe_payment_rows_predictions
WHERE proba_2 >= 0.3 AND proba_2 < 0.5
```

Exactly one row: **order 1197** — Customer 058, AMER, pro, `net_usd` 0 — at
`proba_2` 0.3549. argmax calls it "1"; a line at 0.30 calls it "2".

**That row, through the warm endpoint.** Predictions → Try it, with order
1197's six feature values typed in.

| Version's line | Predicted | Probability shown   | `threshold_applied` | `served` | Latency |
| -------------- | --------- | ------------------- | ------------------- | -------- | ------- |
| 0.30 on "2"    | **2**     | 35.5% (= `proba_2`) | **0.3**             | `warm`   | 0.104 s |
| removed        | **1**     | 64.5% (= `proba_1`) | absent              | `warm`   | 0.124 s |

Same row, same endpoint, same artifact; the only difference is the version's
decision threshold. Before this commit the second line was the ONLY answer the
warm path could give — the batch path sent the threshold and the warm path sent
neither it nor the positive label. The probability reported also tracks the
answer rather than the winner, so the row declined at 0.35 does not claim 64.5%
confidence in a decision nobody made.

**What the first attempt found instead.** The same row scored "1" with no
`threshold_applied` on a warm endpoint whose app container definitely carried
the fix. The scorer is not in the app image: `score()` lives in
`docker/notebook-runtime/score_server.py`, baked into
`agentswarms/notebook-runtime`, and the rebuild had named a single service
(`docker compose up -d --build agentswarms`). The old image's signature was
still `def score(rows)`. Rebuilding that image and redeploying the endpoint
produced the table above. The documented upgrade — `docker compose up -d
--build` with no service name — rebuilds both; docs/DEPLOYMENT.md now says so
out loud, because the failure is silent in exactly this way.

Kept for review: model **`threshold_probe (payment_rows)`**
(`/ml/3476e695-e025-4499-9315-1f77da0539c3`) with its line at 0.30, its warm
endpoint, its three predictions and its batch table
`analytics.threshold_probe_payment_rows_predictions` (836 rows).

### The three fixes this round produced, driven on the next image

| What                                        | Driven                                                                    | Result                                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run explains a graph that will not compile  | **Run now** on `param_probe`, still in its refused state                  | the toast, and the trigger's own reply, now carry `Source "Object storage files" uses auto-ingest AND an incremental cursor on "updated_at"…` — the canvas's sentence, where "Pipeline has no code to run" used to be |
| A row count is not offered "drop"           | Quality gate node → severity dropdown, read twice                         | check `not_null` → **Fail / Warn / Drop bad rows**; switch the check to **Min row count** → **Fail / Warn** only                                                                                                      |
| Promote-when-better cannot judge an anomaly | new anomaly model, retrain schedule with promote-when-better, **Run now** | v2 trained, production kept, and the notification reads `anomaly_rate: 0.0203 vs production 0.0203 — this metric describes how much was flagged, not how well, so it cannot decide a promotion. Production kept…`     |
| …and the control, in the same inbox         | the clustering model's own scheduled retrain, two hours earlier           | `silhouette: 0.2490 vs production 0.2490 (not better)` — a real quality metric keeps the original wording                                                                                                             |

**One limit, stated rather than papered over.** The retrain produced the same
`anomaly_rate` as the incumbent (0.020335 both, 17 rows of 836), because
isolation forest is deterministic on unchanged data with a fixed contamination
and the contamination is fixed when the model is created. So the DECISION would
have been "kept" under the old comparison too; what the live run proves is the
message. The direction itself — candidate 0.40 against incumbent 0.02 reading
as "better" — is covered by `tests/unit/mlOps.test.ts`, mutation-verified.

**And a control the fix turned into a no-op**, caught by the same round: the
schedule dialog's "Promote the new version when its primary metric beats
production" would still tick for an anomaly model and then never fire. It is
now disabled there, with the reason in place of the label, and the save writes
`promote_if_better: false`.

**The controls the refusals left behind, both directions.** Driven on the
final image, with a schedule saved two builds earlier that still carries
`promote_if_better: true`:

| Where                                 | Anomaly model                                                                                               | Control (classification / clustering)         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| New-schedule dialog                   | checkbox `disabled`, unchecked, label replaced by "…the share of rows it flagged — how much, not how well…" | enabled, ticked, original label               |
| Schedule list subtitle                | `retrain · No tuning` — the suffix is gone though the stored flag is still true                             | `retrain · No tuning · promote when better`   |
| Predictions panel, single row         | —                                                                                                           | "Explain this answer" present                 |
| Batch-prediction dialog               | —                                                                                                           | "Write reason codes beside every row" present |
| Both of those, on the **recommender** | absent                                                                                                      | —                                             |

**And one more control, proved broken before it was fixed.** "Explain this
answer" on `revenue_facts · recommendations`, one row, through the panel: the
prediction succeeded and the stored row reads
`input: {"kind":"rows","count":1,"explain":true}`,
`result.explanations: null`, with the only warning about cold start. The flag
travelled from the checkbox into the request and was dropped without a word,
because the recommendation branch returns before both explain blocks. Neither
explain control is rendered for that task now, and the program says why to any
caller that asks anyway.

Kept for review: model **`anomaly_promote_probe`** with its two versions and
the `promote_probe retrain` schedule, the notification in the bell, and the
recommender's explained prediction row (`7635d72e`), which is the evidence for
the paragraph above.

## 2026-09-16 — A knowledge base chooses its own vector index, ADVERSARIAL_LOG R15

**Driven.** The store seam against this machine's real Supabase project and the
running Qdrant container, with `VECTOR_STORE` unset so the instance default was
Postgres — the case a per-collection choice has to get right and every
instance-wide guard got wrong. `tests/integration/kbVectorStore.test.ts`, run as
`QDRANT_URL=http://localhost:6333 npm run test:integration`.

| What                                    | Read from                                  | Result                                                                                      |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| A collection differs from its instance  | `storeKindByKnowledgeBase` on two real KBs | the one that chose Qdrant → `qdrant`; its neighbour → `pgvector`                            |
| Its vectors are answered by Qdrant      | a real search over the real container      | planted vector first at similarity > 0.99, all three ids returned, 7.3 s round trip         |
| The move is reversible                  | the same collection searched in pgvector   | the same chunk first — the embeddings never left `kb_chunks`                                |
| A store cannot widen what a caller sees | a search naming the other collection       | empty                                                                                       |
| Leaving a store clears only that store  | delete from Qdrant, then search both       | Qdrant empty, Postgres unchanged                                                            |
| The fixtures are gone                   | `knowledge_bases`, `knowledge_documents`   | zero `__itest__` rows; the 4 vectors left in Qdrant are an earlier sample's, not this run's |

**A green run that proved nothing, first.** Every test began with an early
return for an unbuilt fixture, and a test that returns early passes. Five ticks,
no Qdrant touched. The cause: the shipped sample collections have a null owner,
so borrowing the first knowledge base borrowed nobody. The file now fails when
`QDRANT_URL` is set and the fixture did not build.

**Then the control itself**, after the owner signed in to a production build of
the commit served on :8081 beside the running instance. The 100-chunk RAG eval
collection was moved to Qdrant and back, through the dialog.

| What                                | Read from                                 | Result                                                                                          |
| ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| The control names the real default  | the Retrieval tab on open                 | "Instance default — pgvector"                                                                   |
| It warns before it moves data       | choosing Qdrant                           | the notice about moving vectors appears; no "not configured" warning, since QDRANT_URL was set  |
| Saving moves the vectors            | the toast                                 | "Retrieval settings saved — 100 vector(s) moved into qdrant"                                    |
| They are really there               | Qdrant's own API                          | 4 points → 104; exactly 100 for this collection; a stored chunk's vector finds itself at 1.0000 |
| The choice sticks                   | reopening the dialog                      | opens on Qdrant, and the move warning is gone                                                   |
| Retrieval still answers             | Agent Chat, multi-hop question            | firmware 5.2 and "45 seconds on 3 or more links", cited                                         |
| …and handles a version conflict     | Agent Chat, recency question              | 768 nodes, naming the older 512 document and why it is superseded                               |
| **The query really went to Qdrant** | Qdrant's request counter, before/after    | +1 per question while the collection was on Qdrant                                              |
| Switching back is a plain save      | the toast                                 | "Retrieval settings saved", no move — pgvector needs no copy                                    |
| …and clears only what left          | Qdrant's API                              | this collection's 100 points gone, the other collection's 4 untouched                           |
| **And stops using Qdrant**          | the counter after a question, post-switch | unchanged, while the answer still came back correctly cited                                     |
| Both moves are recorded             | `audit_events`                            | `vector_store.knowledge_base_changed`, pgvector→qdrant 100, then qdrant→pgvector 0              |

Nothing kept: every row the integration test created was deleted, and the eval
collection was restored to the settings it had before this round.

## 2026-09-16 — Every service by default, proved by a fresh clone, ADVERSARIAL_LOG R14

**Driven.** A clone of the commit installed from scratch with
`bash scripts/setup.sh`, beside the running stack with its published ports
remapped so neither touched the other. Its `.env` was made the documented way:
`.env.example` plus this machine's Supabase keys, nothing else edited.

| What                            | Read from                                    | Result                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The clone is runnable           | `git ls-files -s` in the clone               | `scripts/setup.sh` arrives `100755`                                                                                                                                                                                                     |
| One command, every service      | `docker compose ps` in the clone             | 11 services from `bash scripts/setup.sh`, no flags, in 444 s                                                                                                                                                                            |
| The app answers                 | `curl /api/health` on the remapped port      | 200, five seconds after the installer returned                                                                                                                                                                                          |
| The object store has its bucket | `docker compose logs minio-init`             | "Bucket created successfully `lake/lakehouse`" — after three bugs: the Docker Hub image is not pullable, the folded-YAML command read the access key as a command, and the health grace was too short for a first-run format under load |
| The install wired itself        | the clone's `.env`                           | `VECTOR_STORE`, `QDRANT_URL`, `FEATURE_STORE_URL`, `SPARK_CONNECT_URL`, `LAKEHOUSE_CATALOG_URL`, `LAKEHOUSE_DATA_URL`, `LAKEHOUSE_S3_ENDPOINT` all set; the catalog password generated into both places that carry it                   |
| The app reaches every service   | `node` inside the app container              | qdrant, minio, docgen, notebook-gateway, js-sandbox all HTTP 200; valkey tcp open; the catalog and Spark refused at that moment                                                                                                         |
| Those two refusals              | the same probes after they finished starting | the catalog: "accepting connections" and healthy once Postgres' first-boot init ended; Spark: still fetching its connector jars (the installer says it does), and tcp open on a stack whose ivy volume already holds them               |
| The running stack was untouched | `docker compose ps` in the repository        | unchanged throughout                                                                                                                                                                                                                    |

Nothing kept: the clone, its containers and its volumes were removed at the end.

## 2026-09-15 — Installers, compose, Dockerfiles, manifests, backup and restore, ADVERSARIAL_LOG R13

**Driven.** Every installation and deployment asset, statically where a
cluster is not needed and live against the running stack where it is: the
three shell installers and the PowerShell one (parsed, `--help` / `-Help`
exercised), the five Dockerfiles through `docker build --check`, the compose
file rendered with and without every profile, the four Kubernetes manifests
through the new structural checker, the doc-command checker over 73
documents, `scripts/ui-smoke.mjs` over every route of the running server, a
real backup and the documented restore drill against the live catalog and
lake, the runtime verifier and the notebook hardening suite.

| What                                  | Read from                                                    | Result                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell and PowerShell installers parse | `bash -n`, the PowerShell parser                             | six shell scripts and `setup.ps1` parse; every `--help` prints its whole header (they cut mid-sentence before, and `setup-k8s.sh` and `setup.ps1` had none)                                                                                                                                                                                           |
| Exec bits                             | `git ls-files -s`                                            | all six shell scripts were `100644` — `./scripts/setup.sh` as the in-app page said would be "Permission denied" on a fresh Linux or macOS clone; now `100755`, and the page says `bash scripts/setup.sh` like every other doc                                                                                                                         |
| Installer ↔ compose parity            | `scripts/check-infra.mjs`                                    | seven compose profiles, each a flag of both installers and part of `--all`; `setup.sh --help` had lost `--featurestore` and both installers said "six profiles" — fixed and pinned                                                                                                                                                                    |
| Dockerfiles                           | `docker build --check`, all five                             | one warning (the publishable Supabase key in ENV — the anon key, public by design; the directive skips the rule with that reasoning); the other four clean                                                                                                                                                                                            |
| Compose                               | `docker compose config -q`, with and without `--profile all` | renders                                                                                                                                                                                                                                                                                                                                               |
| Kubernetes manifests                  | `scripts/check-infra.mjs` (js-yaml), no cluster              | 47 documents: every workload's selector matches its template, every container has an image, every Service and PodDisruptionBudget selects a pod, the HPA targets a defined Deployment, the two secrets pods read are created by the installer or the handbook; two Deployments without requests sit in a namespace whose LimitRange supplies them     |
| Documented commands                   | `npm run check:doc-commands`                                 | 73 documents, every `npm run` script, every script a page runs, every manifest path and every `--profile` name resolves                                                                                                                                                                                                                               |
| Every route                           | `scripts/ui-smoke.mjs` against the running server            | 83 routes, 0 failing (no 500, no error boundary)                                                                                                                                                                                                                                                                                                      |
| Backup                                | `npm run backup -- --out <scratch>`                          | catalog dump 83,803 bytes / 161 objects via the live catalog container; 79 lake objects (3,384,762 bytes) mirrored; all 25 catalog-referenced data files present in the bucket; the application database skipped as documented (no `SUPABASE_DB_PASSWORD` for the hosted project); 6 secrets listed by name only                                      |
| Restore drill                         | `npm run restore -- <dir> --drill`                           | scratch database `lakehouse_catalog_drill` restored — 11 tables, 17 data files, snapshot 460 — compared with the live catalog (unchanged) and dropped; 25 objects re-uploaded under a scratch prefix, sizes verified, prefix removed; **DRILL PASSED**                                                                                                |
| Runtime verifier                      | `bash deploy/notebooks/test/verify-runtime.sh`               | before: 15 of 16, the failure "Kernel reaches the platform — All connection attempts failed" was the verifier pointing the kernel at the host gateway from an `internal` network; after mirroring the product's callback URL: **16 of 16**, "Kernel reaches the platform (knowledge bases: 19)"                                                       |
| Notebook hardening suite              | `bash deploy/notebooks/test/security-suite.sh`               | builds the runtime image as `agentswarms/notebook-runtime:test` and launches it hardened: non-root uid, read-only rootfs, writable work dir, apt blocked, no Docker socket, no provider secrets, all capabilities dropped, pids and memory limits, no-new-privileges; the frameworks import and a runtime pip install works — **12 passed, 0 failed** |
| Infra checker in the gate and CI      | `package.json`, `.github/workflows/ci.yml`                   | `check:doc-commands` and `check:infra` run in `npm run check` and in CI; nine mutants (an exec bit lost, a help line dropped, the count regressed, the verifier's origin, the Dockerfile directive, the page's dot-slash, a Service selecting nothing) caught, a comment-only control missed                                                          |

Nothing to keep or clean up: the backup went to the session scratch directory,
the drill removed its scratch database and prefix, and no rows were created.

## 2026-09-15 — Agent Chat with a complex knowledge base: accuracy, tool bloat, context bloat, ADVERSARIAL_LOG R12

**Driven.** Knowledge Bases → the fixture collection → **Index 12 documents**
(indexed 12/12, 100 chunks, all embedded); Agent Builder, **New Agent**
(name, prompt, `openai/gpt-5.2`, the collection toggled on the Knowledge
tab, no tools) → **Create Agent**; Agent Chat → two questions typed into the
box and sent with the button; the twenty-question rounds through `/api/chat`
from the signed-in page with the chat page's own request body, answers read
from the stream. Then **Edit → Tools** with thirteen tools on → **Update
Agent**, the round again, and the tools off again.

| What                               | Read from                                                               | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The corpus                         | `knowledge_documents`, `kb_chunks`                                      | 12 documents (1,300–24,000 characters), 100 flat chunks of 14–290 tokens, `text-embedding-3-small` via OpenRouter, `retrieval_settings` null                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Baseline, 20 questions             | the stream: answer, `citations`, `sources`, usage                       | 11 pass · 3 partial · 6 fail; every citation exactly 560 characters; 705 prompt tokens and 9.8 s a turn on average; no hallucination — each miss said the excerpt lacked the table, the price, the RTO                                                                                                                                                                                                                                                                                                                                                                         |
| Where the answer chunk ranked      | the same RPCs the server calls, per question                            | the SLA table (chunk 0) at vector rank 3 behind the document's own boilerplate at rank 1, so the one-chunk collapse dropped it; keyword search ranks the two SLA tables 1 and 2 for the short phrasing and finds nothing for the long one                                                                                                                                                                                                                                                                                                                                      |
| After the fix, same 20 questions   | the stream, rebuilt image                                               | **20 pass**; citations 500–3,100 characters, ~10,000 of grounding a turn; 2,434 prompt tokens and 6.5 s a turn on average; 512-or-768 answered with both figures and the firmware condition; the credit capped at €6,000; Mumbai Q1 2027 from the newer report                                                                                                                                                                                                                                                                                                                 |
| Typed into the real chat           | DOM + `messages.metadata.sources`                                       | "What is the RTO … and what heartbeat-loss condition declares one?" → 20 minutes; 45 seconds on 3 or more links, cited [1]; Sources (5) rendered under the answer, the runbook first with chunks 0, 1 and a later one joined; the persisted row carries five `kb` sources of 1,037–2,748 characters (conversation `4f327f20-db7f-4bde-a824-1c6000f5984c`)                                                                                                                                                                                                                      |
| Thirteen tools on                  | the stream's `tool` events, usage                                       | 20 pass; 10,390 prompt tokens and 8.2 s a turn; three `calculator` calls, all on the credit question (37,016 tokens, 18.0 s); weather / date / local tables / arithmetic each called its tool once and answered from it; no web search, SQL or ML call on a knowledge-base question; `cached_tokens: 0` throughout                                                                                                                                                                                                                                                             |
| 24-turn conversation               | the stream, full history sent each turn                                 | prompt tokens 2,162 → 4,222 then flat (20-message window), 4.7–13.5 s a turn, every answer right; "what was my first question" answered wrongly and confidently at turn 25 because nothing was persisted for the summariser to fold                                                                                                                                                                                                                                                                                                                                            |
| Rolling summary, rows persisted    | `messages` rows written as the page writes them; the stream             | window forced to 4 messages; the fifth turn carried `memory_used {summaryUsed: true}` and the reply listed the folded questions as "referenced only in the conversation summary", declining to quote them verbatim                                                                                                                                                                                                                                                                                                                                                             |
| Overlap trimmed (third image)      | the stream's `citations`, same runbook question                         | the runbook citation is 2,144 characters instead of 2,304: chunks 0 and 1 joined once — "## Do not" and the RPO sentence appear once where the second image showed them twice — and the answer is unchanged                                                                                                                                                                                                                                                                                                                                                                    |
| Per-tool cost, then the SQL budget | the stream's `cost` event, one tool enabled at a time, same question    | each tool's prompt tokens over the bare request: `sql_query` 5,240, `ml_predict` 701, `kb_graph_search` 508, `data_health` 264, `weather` 185, `web_browse` 185, `calculator` 162, `datetime` 154; n8n, MCP and notifications 0 until something is connected. On the fourth image, with the listing budgeted at 4,000 characters: `sql_query` 1,416 (twice, identical), the thirteen-tool request 5,613 across two rounds against 26,924 across four before                                                                                                                    |
| Similarity floor (fifth image)     | the stream: `citations`, usage; ten off-topic questions then the twenty | before: every question grounded on five documents (~2,400 prompt tokens); measured best-chunk similarity 0.38–0.75 for the twenty, 0.10–0.32 for the ten off-topic, no keyword hit off-topic. After, floor 0.3: nine of the ten off-topic questions carry 0 citations at 155–167 prompt tokens and are answered plainly (weather declined, the date, a haiku, Canberra); "how many local data tables" at 0.32 still grounds (3 citations, 1,952 tokens) and is answered honestly; the twenty: **20 pass**, no question below 4 citations, 2,358 prompt tokens and 6.8 s a turn |
| A 36,000-character question        | the stream                                                              | status 200, the right answer, 10,108 prompt tokens, five citations — the query embedding survived; the 4,000-character input guardrail is off by default                                                                                                                                                                                                                                                                                                                                                                                                                       |

Kept for review: the collection **RAG eval · Halvard Systems**
(`461854a2-6b32-444d-9dd3-6c306b82adf9`, 12 documents), the agent
**RAG eval · Halvard support** (`c21fd5a9-0d80-4e20-b3cc-cc7f229f751d`,
restored to the knowledge base alone), and its two conversations — the
first question and the memory-probe rows (`da5d8b96-0ad5-460d-bab2-8c52d4c2caed`),
the runbook question (`4f327f20-db7f-4bde-a824-1c6000f5984c`). The corpus
generator and the answer key are in the session scratchpad, not the repo.

## 2026-09-14 — Handbook reorganisation: page families, subsections, the map and the rail

**Driven.** The rebuilt image, public docs routes, no sign-in. Read from the
DOM at 1400px (the rail), the pane's default 1223px, 768px and 375px; two
screenshots kept in the session, everything else read from the page.

| What                          | Read from                                   | Result                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ML guide is a family      | sidebar anchors on /docs/ml                 | ML Models followed by Training, Predictions, Serving, Trust, Operations; the overview's card grid links the same five; "In this guide · 5 sections" pills: What it is, In this guide, Tasks, Use cases, How this compares                                             |
| A sub-page knows where it is  | /docs/ml/training at 1400px                 | title "ML Models · Training"; sidebar: ML Models marked, Training `aria-current=page` and indented, the four siblings indented and quiet; six H2 ids (prepare … experiments); 15 heading anchors (`aria-label="Link to this section"`); back-to-top absent at the top |
| The rail follows the reader   | same page, jumped to `#results`             | scrollY 2239; the rail lists the six sections and, under the active "Read the results", its one subsection "What the trainer warns about" — no other section's subsections; back-to-top present (screenshot)                                                          |
| A one-section page still maps | /docs/self-hosting/kubernetes               | "In this guide · 7 headings": Kubernetes, Kubernetes in detail, EKS, GKE, AKS, OKE, After any of them; eyebrow SELF-HOSTING; sidebar family Install & deploy → Configuration, Kubernetes (current), Operations                                                        |
| The moved anchor lands        | /docs/ml/predictions#api                    | `#api` exists ("Public API"), top at 96px after load, scrollY 3300 — the API page's link followed the section                                                                                                                                                         |
| Families close elsewhere      | /docs/etl                                   | 34 sidebar links; of the two families only /docs/ml and /docs/self-hosting are present                                                                                                                                                                                |
| Tablet                        | /docs/ml/training at 768px                  | document scrollWidth 762 ≤ 768 (no sideways scroll); the sidebar collapses to the page picker showing "Training"; six pills wrap to 84px; compact "On this page (15)"                                                                                                 |
| Phone                         | /docs/ml/training at 375px, scrolled 1500px | scrollWidth 375 (no sideways scroll); pills wrap to 117px; back-to-top button at (314, 750) bottom-right; compact "On this page (15)"                                                                                                                                 |
| Search reaches a sub-page     | docs search, "EKS"                          | two results: the page "Install & deploy · Kubernetes" and its heading "Amazon EKS, step by step" (index rebuilt for 43 pages, 586 headings)                                                                                                                           |

Nothing to keep or clean up: the round created no rows.

## 2026-09-14 — Predictive-model chooser and the narrow window, ADVERSARIAL_LOG R11

**Driven.** AI Analyst → New: the dialog's new **Predictive models** section
(radio "Any model it can use (7)" / "Only these", then one checkbox per
model with its task → target and a warning mark on the drifted classifier).
Ticked only the plan classifier and created the analyst; reopened it with
the pencil; asked a question naming a model outside its list; widened it to
any model and asked again. Then the page at 1000, 768 and 375px.

| What                                | Read from                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dialog captions                     | DOM                                                        | "Only these" with nothing ticked → "No predictive models — steps are never scored — tick at least one, or choose any."; one ticked → "1 of 7 predictive models."                                                                                                                                                                                                                                                                                                                                                              |
| The choice is stored                | `ai_analysts.ml_model_names`                               | `["revenue_facts plan classifier"]` on the new analyst; `null` on the older ones (unchanged behaviour)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The choice reloads                  | Edit dialog                                                | reopened with "Only these" and the classifier ticked; the card says "1 of 7 predictive models"                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A question naming an unlisted model | DOM                                                        | the analyst stopped and asked rather than scoring with the classifier — first with the planner's own words ("What is the name of the anomalies model you are referring to?"), after the fix with the exact reason: "revenue_facts · anomalies" exists but is not enabled for this analyst — its predictive models are "revenue_facts plan classifier". Enable it under the analyst's settings (the pencil on its card), or ask with one it may use. — with "Go with the assumption" (answer from the data alone)              |
| Widened to any model, same question | DOM + `ml_predictions`                                     | row now `ml_model_names = null`, card "Any predictive model (7)"; the same question scored with "revenue_facts · anomalies" — "Scored 50 of 836 rows … Ranked by anomaly_score (highest first), top 10 of the 50 scored" (which also verifies F17 live: the SQL sampled fifty, not the requested ten), the reviewer's proposed `ORDER BY anomaly_score` refused with the note, findings list the ten orders with their scores                                                                                                 |
| Narrow window                       | container scrollWidth vs clientWidth at 1000 / 768 / 375px | 1000px: container 800/800, rail 223px, four actions visible as icons · 768px: 568/568, rail 223px, four icons · 375px: 375/375, rail hidden, "Show analysts" opens it full-width (374px) with the thread hidden; the app's own "Best on a larger screen" notice shows first, as on every page; picking an analyst closes the rail and shows the thread (verified by dispatching the card's click — the pane's pointer clicks and Enter did not reach the card in the scaled phone emulation, a harness limit, not a page one) |

Kept for review: the restricted analyst (id `0978594e-822c-41fa-a4e4-09423798b263`,
named "Lakehouse analyst" like the session one) with its threads.

## 2026-09-14 — AI Analyst × trained ML models (session), ADVERSARIAL_LOG R10

**Setup.** One analyst ("Lakehouse analyst", reasoning model
`openai/gpt-4o-mini` via OpenRouter, data = the built-in Lakehouse), created
through **AI Analyst → New**. One question per model kind, each in a fresh
analysis thread. Kept on the instance for review: the analyst and all of its
threads (the "before" threads and the "after" threads are both there, newest
last). Models in scope: a classifier bound to a feature view (`order_id`), a
regression, a clustering, an anomaly detector, a recommender and two forecast
models, all on `analytics.revenue_facts`.

### Before the fix

| #   | Question (shortened)                                                               | What happened                                                                                                                                                                                      | Verdict    |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Q1  | 15 most recent orders likely enterprise, plan classifier                           | Scored by key, badge + drift health shown; **findings table built from column totals** (`22104 enterprise 0.91` — 22104 is the sum of the ids); reviewer "corrected" the query over the same total | F1, F2     |
| Q2  | Estimate net_usd of March's top 10 with the regression model, compare to actual    | No scored step; step 2 written as SQL over the actual values; reviewer "passed" it as the model's estimate; findings show actual = "estimated"                                                     | F3         |
| Q3  | Assign the 10 largest orders to a group with the clustering model, describe groups | Scored from feature columns; reviewer fixed LIMIT 50 → 10 and re-scored; write-up "distinctions are not provided" — cluster profiles never reached it                                              | F4, F5     |
| Q4  | 10 most anomalous orders since January, anomaly model                              | 50 random rows scored; reviewer proposed `ORDER BY anomaly_score` (binder error); write-up: "the SQL query failed" over a successful step                                                          | F6, F7, F8 |
| Q5  | Monthly net_usd over the next 3 months, "use a trained forecast model if one fits" | Regression model scored 50 orders; write-up invented "month 1–3: 480.89"                                                                                                                           | F9         |
| Q6  | Score the customers with "the churn model", five most at risk                      | Clustering model substituted silently; rows carried 1 of 7 features; "top five at risk" reported                                                                                                   | F10, F11   |
| Q7  | Three recommendations each for two customers                                       | 13 duplicate rows per customer scored (cold-start); reviewer invented `item_id`; write-up "no recommendations … due to query errors"                                                               | F8, F12    |

Evidence read per question: the step's badge title and disclosure line
(DOM), the check line, the FINDINGS block, and the `ml_predictions` row
(`via = ai_analyst`, `status = succeeded`, row count).

### After the fix (rebuilt image, same analyst, same questions)

Three rebuilds: the twelve fixes, then a parser tolerance the re-run found
(F13), then three small follow-ups it found (F14–F16). Every row below was
read from the DOM of the analyst's page and from the persisted step.

| #   | What happened after                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | `SELECT DISTINCT order_id … LIMIT 15`, scored by key, ranked by probability; check passed with a sane note; findings list the three real orders the model called enterprise (1025 0.912, 1713 0.894, 1658 0.862); model notes (class meaning + two leakage warnings) on the step                                                                                                                                                                                     | F1, F2 fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q2  | The step naming the regression model is scored (feature columns, `WHERE order_id IN (…)`); findings show actual vs predicted with different numbers; caveats name r2 −0.006 as poor predictive power                                                                                                                                                                                                                                                                 | F3 fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Q3  | Scored from feature columns, ranked by distance; model notes carry "Group 0: 752 training rows (90.0%); typical row: plan free, region EMEA, net_usd 492.29 …"; the write-up describes the rows' region/plan but does not quote the profile it was given (LLM writing, not a missing input)                                                                                                                                                                          | F4, F5 fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q4  | First attempt: "no analysis steps" — the planner returned a bare `{"score": {…, "rank": …}}` (F13). After the parser tolerance: one step, 50 rows scored, "Ranked by anomaly_score (highest first), top 10 of the 50 scored", write-up says all scores are negative, so nothing is anomalous; no correction touched the model's columns                                                                                                                              | F6, F7, F8 fixed; F13 found and fixed; F14 (rows carried no order id) fixed and verified on the last image: the rows carry order_id, the findings name the ten orders with their scores, and the reviewer's proposed `ORDER BY anomaly_score` was refused in code with the note shown on the step. F17: the SQL limited its sample to the requested 10 rather than the 50-row cap, so the ranking ran over 10 rows; the scoring goal now tells the writer the platform keeps the top N after scoring — verified live in the R11 round (50 sampled, top 10 ranked). |
| Q5  | First attempt: "no analysis steps" — a bare `{"forecast": {…, "horizon": 3}}` (F13). After: a forecast step with the moving-average model — "forecast by" badge, three projected periods with widening intervals, no SQL, caveats about the short last period; the model's period is a week where the question said months (F15)                                                                                                                                     | F9 fixed; F15 found and fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q6  | The analyst stops: "No trained model named "churn" is available to this analyst; it can use … Which should it use, or should it answer without a model?" with "Go with the assumption"                                                                                                                                                                                                                                                                               | F10 fixed; F11 no longer reachable here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q6b | "Go with the assumption": the planner asked the same question again (F16). After the third rebuild it asked a third time ("Which churn model should I use?") with a nonsense assumption of its own; a plan that substitutes under an accepted assumption is now stripped of its scoring in code (unit-tested; not reachable live because the planner keeps asking rather than substituting). Residual: a smaller model may keep asking; it can no longer substitute. | F16 found and fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Q7  | `SELECT DISTINCT customer_name …` → one row per customer, both scored; the write-up explains cold_start from the model notes and calls the recommendations unreliable                                                                                                                                                                                                                                                                                                | F8, F12 fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

What the user checking this can open: **AI Analyst → Lakehouse analyst**
(analyst id `820592df-e17f-4ab3-badf-7ad1e7e6e931`) — the "before" and
"after" threads are both kept, newest last, each with its badge, disclosure
line, model notes and findings as read here.

## 2026-09-14 — ML integration program, items 1–6 and R3

Each item was implemented, unit-tested, mutation-checked, then driven in the
browser and read back from the rows before its commit. The commits carry the
full narrative; this is the index.

| Item                                        | Surface driven                                                                             | Evidence read                                                                                                       | Commit    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------- |
| 1 · model picker for the agent's ML tool    | Agent Builder (the ML Predictions picker); Playground; a scheduled headless run            | `agents.ml_model_names` after save/clear; `messages.metadata.sources = [ml_list_models]`; the tool's refusal string | `ce37ba1` |
| 2 · predict by key                          | Playground forced `ml_predict` with `keys`                                                 | `ml_predictions` row `via = agent_tool`, `features_served_from`, `keys_not_found`                                   | `5bae68f` |
| 3 · Score with model canvas node            | Swarm canvas inspector → "Score with model" → run; publish + schedule for the headless leg | `swarm_run_steps.tool_calls` (canvas), the node's output and `swarm_snapshot` (headless)                            | `9c9f561` |
| 4 · prediction as a table in the Playground | Playground Tools panel                                                                     | the SSE `tool` event's `data` block; the ok/error badge                                                             | `a8a93cd` |
| 5 · analyst scores a step                   | AI Analyst, new analyst, scored question, three rounds                                     | persisted `scored` on the step, `ml_predictions` `via = ai_analyst`, `execution_traces` raw replies                 | `40fc2df` |
| 6 · model health everywhere                 | Playground list, forced `ml_predict`, analyst badge/disclosure, four rounds                | `"health"` in the SSE event; the panel notes; persisted `scored.health`; drift score on the prediction row          | `7e662aa` |
| R3 · headless tool calls                    | Published fixture swarm + never-run schedule; observability page Timeline → step → Tools   | `swarm_run_steps.tool_calls` on the agent step and the tool node step                                               | `f2a606c` |

Findings from these rounds: R1–R9 in the Adversarial log.
