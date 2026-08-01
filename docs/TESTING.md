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

| Area                    | File                                        | Why it matters                                        |
| ----------------------- | ------------------------------------------- | ----------------------------------------------------- |
| Read-only SQL guard     | `tests/unit/sqlSafety.test.ts`              | A security boundary — everything past it executes     |
| Local SQL semantics     | `tests/unit/localEngine.test.ts`            | What any engine must get right (NULLs, paging, joins) |
| Cross-engine agreement  | `tests/differential/duckdb.test.ts`         | AlaSQL and DuckDB must answer the same question alike |
| Dialect routing         | `tests/differential/dialectRouting.test.ts` | Compiled SQL must run on the engine that receives it  |
| DuckDB type boundary    | `tests/unit/duckdbEngine.test.ts`           | BigInt, DECIMAL, identifier quoting, isolation        |
| Parquet mirror          | `tests/unit/parquetMirror.test.ts`          | The cache must answer identically to the rows         |
| Data quality checks     | `tests/unit/dataQualityCore.test.ts`        | Decides whether a dataset is trustworthy              |
| Upload parsing          | `tests/unit/datasetParse.test.ts`           | Decides the shape of every uploaded dataset           |
| NL→SQL eval harness     | `tests/unit/nl2sqlEval.test.ts`             | Keeps the eval itself honest, without a model call    |
| Request limiting        | `tests/unit/rateLimit.test.ts`              | Enforces the documented governance ceilings           |
| Dashboard pages         | `tests/unit/biDashboardPages.test.ts`       | A widget must land where the dashboard reads it       |
| **End-to-end journeys** | `tests/journey/`                            | The seams between units — where the real bugs were    |

## Journey tests

```bash
npx vitest run tests/journey
```

Unit tests check a function. Journey tests check the SEAMS between functions,
which is where every defect that reached a user actually lived: a semantic model
that would not compile for the configured engine, a widget written to a mirror
nothing reads, a chart that survived a reload but rendered empty. Each unit
involved was correct and tested.

`tests/journey/semanticToDashboard.test.ts` chains the REAL production functions
in the order the product calls them — compile the metric, run it on the
configured engine, build the widget, place it on a page, strip it for storage,
read it back, merge the stored results — and asserts on what the user would see.
Both engines are driven through `runLocalSelect` via `LOCAL_ENGINE`, so engine
selection is under test too.

**Nothing in here may re-implement production logic.** If a step needs a helper
buried in a component or a route handler, extract it. A copy passes while the
product breaks, which is precisely how these bugs survived.

A journey test is only worth its runtime if it FAILS for the original reason.
These were verified by mutation: reintroducing the quoting bug fails 4 of them,
reintroducing the mirror-only write fails 8. Do the same when you add one.

## Mutation-check anything that guards a boundary

A test that guards security or determinism should be broken ON PURPOSE once,
before you trust it. Passing proves nothing about what a test would catch, and
these are exactly the tests nobody notices are hollow — an access check that
cannot fail looks identical to one that works.

The record so far, each verified rather than assumed:

| Reintroduced defect                           | Tests that fail |
| --------------------------------------------- | --------------- |
| Dialect-locked semantic fragments             | 4 journey       |
| "Add to dashboard" writing only the mirror    | 8 journey       |
| A cosmetic column mask (values left in rows)  | 2 ACL           |
| Unknown viewer failing OPEN instead of closed | 3 ACL           |
| A duplicate migration version                 | 1 migration     |

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

`tests/differential/duckdb.test.ts` measures DuckDB against AlaSQL. It runs
**every** corpus query and matches on all but four, each recorded in
`DUCKDB_DIFFERENCES` with a reason — NULL ordering (DuckDB is NULLS LAST, as
PostgreSQL is) and summing a numeric column that holds strings.

Anything **not** in that list must match. A new divergence fails the test, so
promoting DuckDB to the default is a decision made against a written list of
what changes rather than a hope that nothing does.

Enable it with `LOCAL_ENGINE=duckdb` (see [DEPLOYMENT.md](./DEPLOYMENT.md)).

Entries in `DUCKDB_DIFFERENCES` are asserted to **still** differ — if you fix
one, the test fails and you must update the record. That is deliberate: an
undocumented behaviour change in a query engine is exactly what this suite
exists to prevent.

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

| Date       | Model                                       | Question set     | Execution accuracy        |
| ---------- | ------------------------------------------- | ---------------- | ------------------------- |
| 2026-07-31 | `anthropic/claude-haiku-4.5` via OpenRouter | 23 questions, v1 | 78.3% (18/23), 1 run      |
| 2026-07-31 | same, after the result-shape prompt fix     | 23 questions, v1 | **82.6% (19/23), 3 runs** |

**The v1 numbers above are not comparable to what follows.** The set is now 45
questions (v2) across seven bundled datasets, instead of concentrating twelve
of twenty-four on `saas_sales`.

| Date       | Model                                       | Question set       | Execution accuracy                     |
| ---------- | ------------------------------------------- | ------------------ | -------------------------------------- |
| 2026-08-01 | `anthropic/claude-haiku-4.5` via OpenRouter | 45 questions, v2   | **84.4% (38/45)**, 1 run               |
| 2026-08-01 | same, after value linking                   | 45 questions, v2   | **86.7% (39/45)**, **3 runs (strict)** |
| 2026-08-01 | same, one ambiguous question corrected      | 45 questions, v2.1 | **88.9% (40/45)**, **3 runs (strict)** |

By category: aggregate 6/6, grouping 9/9, date 4/4, lookup 3/3, ambiguity 1/1,
ranking 7/10, filter 6/9, ratio 2/3. **This is a single pass — treat it as
provisional until someone runs `EVAL_REPEATS=3`**, which scores a question as
passing only if every attempt passes.

The first v2 pass scored 80.0%, and reading the failures found two defects in
the QUESTIONS rather than in the model: "which countries got more than half
their electricity from renewables?" and "which franchise had the most wins in a
single season?" both admit more than one correct output shape, while their
reference queries demanded a particular one. Questions with two right answers
were reworded to name the columns they want — which is this file's existing
standard ("a question you cannot answer unambiguously in SQL does not belong in
a score"), not a concession to a failing case. The grader was NOT touched.

**The remaining failures are real, and they cluster.** `filter` and `ranking`
hold seven of the nine. Two returned zero rows because the model invented a
literal — `fraud_flag` is `Y`/`N` and `status` is `BENIGN`, both plainly listed
in the schema block it was given. That is the same weakness v1 recorded, now
reproduced on data it had never seen, which is the strongest evidence yet that
it is a property of the pipeline rather than of one dataset. Literal fidelity
was addressed by VALUE LINKING rather than by prompt wording, because the
wording was already there and could not have worked: the prompt said "match
string literals exactly as they appear in the schema" while the schema block
listed only column names and types. No literal ever appeared in it, so on a
column like `fraud_flag` the model was being asked to copy something it had
never been shown.

`inferColumns` now records every distinct value of a string column that has few
enough of them, and `describeColumn` renders them — `fraud_flag string
values=[N|Y]`. The eval calls that same production renderer rather than
formatting columns itself, so it cannot drift into scoring a prompt the app
never sends.

Effect, single pass: **filter 6/9 → 8/9** and **ratio 2/3 → 3/3**, the two
categories holding the literal-guessing failures. `aggregate` and `ambiguity`
each dropped by one question, which on a single pass is most likely sampling
noise — `EVAL_REPEATS=3` has since been run, and returns the SAME 39/45 — but as a
STRICT score, where a question counts only if it passed all three attempts.
Same number, much stronger claim.

It also inverts the guess above: surviving three passes says the `aggregate`
and `ambiguity` dips are REAL, not sampling noise. Value linking bought
`filter` and `ratio` at a small cost elsewhere rather than being free.

The repeats earned their cost in composition rather than total —
`health-infant-mortality-worst` passed on one pass and fails across three.

**Known defect in the question set.** That question ("Which country had the
highest infant mortality in 2019?") is the third instance of an ambiguity two
others were already corrected for: it admits a one-column answer (`Nigeria`)
while its reference demands country AND value. The model is right and the
question is wrong. It has since been corrected AND re-measured in one
step, which is the only way to change a question set without leaving this table
describing something that no longer exists.

**88.9% (40/45), v2.1, three runs strict.** `ranking` 7/10 -> 8/10 and every
other category byte-identical — only the corrected question moved, which is the
evidence that the edit did what it claimed and nothing else.

Be clear about what that 2.2 points is: **the product did not improve, the
measurement got less wrong.** A question with two correct answers was grading
the model on a coin toss. Fixing a question after watching it fail is
uncomfortably close to tuning to the score, and what makes it defensible is
that the defect is in the QUESTION rather than the grader, that two identical
defects were corrected before this result was ever seen, and that the grader
itself remains untouched. If the only justification had been "this case failed
and I wanted it to pass", it should have stayed.

The v1 per-category breakdown was: aggregate 4/4, grouping 4/4, date 3/3,
ratio 2/2, lookup 2/2, ranking 2/4, filter 1/3, ambiguity 1/1. Ranking and
filter were the weak spots, so v2 deliberately adds more of both — a score that
avoids what a model is bad at is not a measurement.

**Run it more than once.** Model sampling makes a single pass noisy — during
this baseline a category went 4/4 → 3/4 → 4/4 with no code change at all, which
looked exactly like a regression. `EVAL_REPEATS=3` scores a question as passing
only if it passed _every_ attempt, so flakiness shows up as a failure rather
than as luck. The 82.6% above is the strict three-run figure and is the number
to compare against.

The first run showed roughly half the misses were "right analysis, wrong result
shape" — extra columns nobody asked for, or a superlative answered with a full
ranking. Three lines were added to the SQL prompt in response (project only
what was asked, `LIMIT 1` for superlatives, match literals exactly), which is
what took the score up. That loop — measure, read the failure mode, change the
prompt, re-measure — is the entire reason this exists.

The four remaining failures:

- **filter (2)** — genuinely wrong SQL. One counted 2,098 rows where the answer
  is 4,219; the other filtered two string values and matched nothing. Literal
  values read out of the schema are the weak spot, and the prompt fix did not
  move them.
- **ranking (2)** — one returns an empty result; one returns the right rows and
  values with the columns in a different order, which the grader counts as
  wrong. That second one is arguably over-strict, and it is left alone
  deliberately: tuning the grader because a case you want to pass is failing is
  how an eval stops meaning anything.

Haiku was chosen to keep a run cheap enough to repeat often; a larger model
would very likely score higher.

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
deliberately, against a throwaway project:

```bash
npm run test:integration
```

They need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Without them the
suite **skips cleanly** rather than failing, so running it on a machine with no
project configured is a no-op.

`--dir tests/integration` does NOT work, which is why there is a dedicated
config: the default config excludes that directory, and `--dir` narrows the
search without lifting the exclude, so the run exits "No test files found".

**The audit hash chain is verified here and only here.** Each audit event
hashes its content plus its predecessor's hash, so an edit or a deletion breaks
every link after it. `audit_chain_verify()` lets the database check its own
chain, which is the weaker half of the guarantee — whoever can rewrite rows can
usually re-run the trigger. The property that matters is that the NDJSON
archive shipped off the box can be verified by a DIFFERENT implementation, and
`src/lib/auditChain.ts` is it.

One trap makes that module necessary rather than optional: the trigger hashes
`detail::text`, Postgres's JSONB rendering, which orders object keys by LENGTH
then bytewise and puts a space after `:` and `,`. `JSON.stringify` produces
neither, so the obvious verifier reports a perfectly intact trail as entirely
tampered with — destroying trust in the evidence rather than in an attacker.
The unit tests cannot catch drift there, because they would agree with a wrong
implementation; only the integration test, which recomputes hashes the trigger
actually wrote, can. **Run it after touching `jsonbText`.**

These tests are strictly READ-ONLY against the trail. Inserting events would
pollute it, and deleting them afterwards would leave a sequence gap that makes
the chain look tampered with from then on — the suite must not break the
guarantee it checks.

What they cover today: the cross-instance rate limiter and concurrency leases —
specifically that a configured ceiling holds across INDEPENDENT callers (the
guarantee that was broken when those limits were counted per process), and that
an expired lease frees its slot so a crashed instance self-heals. Those are
properties of the SQL, and no amount of mocking can demonstrate them.

## CI

`.github/workflows/ci.yml` runs typecheck, tests and a production build on
every push and pull request. No secrets are used; the build gets placeholder
`VITE_*` values, which is enough to prove the bundle compiles.

**Lint gates.** The ~3,400-violation formatting backlog that once made it
permanently red has been cleared with `npm run format`, so `npm run lint`
reports **0 errors** and CI fails on any new one.

362 warnings remain, almost all `@typescript-eslint/no-explicit-any` at untyped
external boundaries — LLM provider responses, the MCP protocol, AlaSQL's UMD
surface, Supabase `Json`. That rule is deliberately a **warning** rather than an
error: replacing those with `unknown` plus narrowing is worth doing and is its
own project, and a permanently-red required check is one everybody learns to
ignore. Treat the count as tracked debt — it should go down, never up.
