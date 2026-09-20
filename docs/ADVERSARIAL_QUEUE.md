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
| **Semantic layer**     | ⬜ next  |            |                                                                                                              |
| ML predictions         | ⬜       |            |                                                                                                              |

## Sweeps after this one

### Next: the remaining hand-rolled pagers

R43 took the three that WRITE. These nine read by offset against PostgREST and
still end on a short page, which is only the end when the server returns
everything it is asked for. None of them persists, so each is a figure or a list
rather than a table — but the same three questions apply to every one: does it
keep the page's error, does it order by a unique column, and what does it claim
when it stops early?

R44 took the three of these that could not disclose a short read. What is
left:

| Site                              | What it feeds                           | Still wrong                       |
| --------------------------------- | --------------------------------------- | --------------------------------- |
| `src/routes/api/audit.export.ts`  | the audit export, i.e. evidence         | short page closes, no error line  |
| `src/lib/sqlEngine.ts`            | rows a local SQL query reads            | PARALLEL pages, error → stop      |
| `src/lib/traceWindow.ts`          | `pageTraces` — written by this campaign | short page ends the read          |
| `src/utils/audit.functions.ts`    | the user list behind audit attribution  | Auth admin API, error folded in   |
| `src/utils/bi/quality.server.ts`  | data-quality checks                     | skips, but `capped` catches it    |
| `src/utils/etl/service.server.ts` | ETL reads                               | skips, but `truncated` catches it |

`audit.export` is the one to take first. It already emits an `_export_error`
line so a consumer can tell a truncated export from a complete one, and the
short-page close is the ONE path that ends the stream without emitting it — a
silently truncated audit export, indistinguishable from a full one, which is
the worst property evidence can have.

The five under `src/utils/saas/*` and `kb/confluence.server.ts` are NOT in this
class: they page third-party APIs, which honour their own page sizes and have
their own pagination contracts.

Queued, in the order the evidence supports. Each is a class already seen at
least twice, not a hypothetical.

1. **A failed read rendered as absence.** "No results", "none connected", "0
   items" shown when the read threw. Pass 1 found this in eight modules, each
   fixed locally — the sweep asks whether the NEXT eight have it too.
2. **A badge that outlives what it vouched for.** Verified/priced/fresh/healthy
   stamped once and never revisited. R24 and R26 are the BI instances.
3. **A cause named that the evidence cannot support.** R31's freshness test, and
   Prompt Compare crowning the model that failed fastest.
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
- Read `GATE EXIT` from the shell. The background-task notification reports the
  wrapper's status, not npm's; three times now it has said 0 over a red gate.
