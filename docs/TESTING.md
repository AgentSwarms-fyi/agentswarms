# Testing

> Part of the [AgentSwarms docs](../README.md#documentation).

```bash
npm run test
```

Runs the whole suite (Vitest, Node environment). No database, no network, no
credentials — it is safe to run anywhere and safe for a fork to run in CI.

```bash
npm run test:watch
```

## What is covered

| Area                   | File                                      | Why it matters                                    |
| ---------------------- | ----------------------------------------- | ------------------------------------------------- |
| Read-only SQL guard    | `tests/unit/sqlSafety.test.ts`            | A security boundary — everything past it executes |
| SELECT interpreter     | `tests/unit/sqlInterpreter.test.ts`       | The engine behind the `sql_query` agent tool      |
| Cross-engine agreement | `tests/differential/differential.test.ts` | The app has more than one local SQL engine        |
| Data quality checks    | `tests/unit/dataQualityCore.test.ts`      | Decides whether a dataset is trustworthy          |
| Upload parsing         | `tests/unit/datasetParse.test.ts`         | Decides the shape of every uploaded dataset       |

## The differential harness

Every server-side local query now goes through one entry point
(`utils/data/localEngine.server`), which runs either AlaSQL (default) or DuckDB
(`LOCAL_ENGINE=duckdb`). **The same question asked through two surfaces must
not produce two answers** — that is what this suite enforces.

It used to be worse: three engines, including a hand-written AST interpreter
behind the `sql_query` agent tool. That interpreter is gone.

`tests/differential/` runs a shared corpus through every engine and compares
canonicalised results. It exists for two jobs:

1. **Catch drift today.** On its first run it found three bugs in the
   interpreter: `!=` admitted NULL rows, `LIMIT n OFFSET m` paged wrongly, and
   a qualified column in a JOIN resolved to the wrong table — each silently
   returning wrong data to an AI agent. Those assertions live on in
   `tests/unit/localEngine.test.ts`, now aimed at whichever engine is active.
2. **Make a future engine swap provable.** Replacing an engine (with DuckDB,
   say) means adding one adapter to `engines.ts` and watching the corpus. That
   is the difference between an evidence-based migration and a leap.

To see the differences rather than a pass/fail:

```bash
npm run test:differential
```

### DuckDB, the candidate engine

`tests/differential/duckdb.test.ts` measures DuckDB against both incumbents.
It runs **every** corpus query and matches on all but five, each recorded in
`DUCKDB_DIFFERENCES` with a reason. All five are cases where DuckDB follows
PostgreSQL/standard SQL and the existing engines do not — NULL ordering
(DuckDB is NULLS LAST), `SUM` over an all-NULL group (NULL, not 0), and
summing a numeric column that holds strings.

Anything **not** in that list must match. A new divergence fails the test, so
promoting DuckDB to the default is a decision made against a written list of
what changes rather than a hope that nothing does.

Enable it with `LOCAL_ENGINE=duckdb` (see [DEPLOYMENT.md](./DEPLOYMENT.md)).

### Known divergences

`EXPECTED_DIVERGENCE` in `differential.test.ts` records the differences that
exist today, each with a reason. Entries there are asserted to **still**
differ — if you fix one, the test fails and you must update the record. That is
deliberate: an undocumented behaviour change in a query engine is exactly what
this suite exists to prevent.

### Adding to the corpus

Add the shape to `tests/differential/corpus.ts` with a note saying which part
of the product emits it. Keep the corpus **synthetic**: statements in the
`sql_query_history` table are real user queries and may embed customer
identifiers, so they are never committed.

Two aliases to avoid — `total` and `value` are reserved words in AlaSQL and
fail to parse, which is a real (if minor) product divergence rather than a
corpus problem.

## NL-to-SQL evaluation

"AI-powered BI" is a measurable claim. This measures it.

```bash
npm run eval:nl2sql
```

It asks the BI analyst a fixed set of plain-English questions, runs the SQL it
generates against the bundled sample data, and compares the RESULT to a
reference query's result. Output is an execution-accuracy percentage with a
per-category breakdown, so a regression can be located rather than just felt.

**It costs money and never runs in CI.** It calls a real model through your own
`/api/bi` endpoint, so it needs a running app and a token:

| Variable            | Meaning                                           |
| ------------------- | ------------------------------------------------- |
| `EVAL_BASE_URL`     | The running app (default `http://localhost:8080`) |
| `EVAL_ACCESS_TOKEN` | A Supabase access token for a signed-in user      |
| `EVAL_MODEL`        | Optional `provider::model` choice                 |
| `EVAL_ONLY`         | Run one question id, or one category              |

### Baseline

| Date       | Model                                       | Question set     | Execution accuracy |
| ---------- | ------------------------------------------- | ---------------- | ------------------ |
| 2026-07-31 | `anthropic/claude-haiku-4.5` via OpenRouter | 23 questions, v1 | **78.3% (18/23)**  |

Per category: aggregate 4/4, grouping 4/4, date 3/3, ratio 2/2, lookup 2/2,
ranking 2/4, filter 1/3, ambiguity 0/1.

The five failures, and what they say:

- **filter (2)** — genuinely wrong SQL. One counted 2,098 rows where the answer
  is 4,219; the other filtered two string values and matched nothing. Literal
  values that must be read exactly out of the schema are the weak spot.
- **ranking (2)** — one returned an empty result; one returned the right five
  rows with five columns where the reference has three.
- **ambiguity (1)** — right ordering, but extra columns and no `LIMIT 1`.

So roughly half the misses are "right analysis, wrong result shape". That is a
prompt problem, not a reasoning problem, and it is the first thing to attack.
A bigger model would likely score higher; Haiku was chosen to keep the run
cheap enough to repeat often.

### How it grades

**Execution accuracy, not SQL text.** Many statements answer a question
correctly, so string comparison would score paraphrases as failures and push
the prompt toward imitating one author's style instead of being right. Column
aliases and column order are ignored; values are not. Row order matters only
for questions marked `ordered` — a ranking returned in the wrong order is the
wrong answer.

Failures are separated into _wrong answer_, _engine error_ and _refused_,
because those need different fixes.

### Adding questions

Add to `evals/nl2sql/questions.ts` with a reference query and a note saying
what the question would catch if it broke. Writing the reference is the
discipline that keeps this honest: a question you cannot answer unambiguously
in SQL does not belong in a score.

Avoid aliasing to `total` or `value` in reference queries — both are reserved
words in AlaSQL, the default engine.

`tests/unit/nl2sqlEval.test.ts` checks the harness itself on every push (that
every reference query still runs, and that the grader accepts and rejects the
right things) without spending a model call.

## Integration tests

Tests that need a real Supabase project live under `tests/integration/` and are
**excluded from the default run** (see `vitest.config.ts`). CI must never be
able to write to a database, and a fork must be able to run the suite. Run them
deliberately, against a throwaway project, with a filled-in `.env`:

```bash
npx vitest run --dir tests/integration
```

## CI

`.github/workflows/ci.yml` runs typecheck, tests and a production build on
every push and pull request. No secrets are used; the build gets placeholder
`VITE_*` values, which is enough to prove the bundle compiles.

**Lint is currently advisory, not blocking.** `npm run lint` reports ~3,400
pre-existing `prettier/prettier` violations — formatting debt from before the
linter was wired up, not new problems. A permanently red required check teaches
people to ignore CI, and deleting the step would be worse. Clear it with:

```bash
npm run format
```

That is a mechanical change reviewable as formatting-only. Once it lands, move
the lint step into the `verify` job so it gates merges.
