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

| Area | File | Why it matters |
| --- | --- | --- |
| Read-only SQL guard | `tests/unit/sqlSafety.test.ts` | A security boundary — everything past it executes |
| SELECT interpreter | `tests/unit/sqlInterpreter.test.ts` | The engine behind the `sql_query` agent tool |
| Cross-engine agreement | `tests/differential/differential.test.ts` | The app has more than one local SQL engine |
| Data quality checks | `tests/unit/dataQualityCore.test.ts` | Decides whether a dataset is trustworthy |
| Upload parsing | `tests/unit/datasetParse.test.ts` | Decides the shape of every uploaded dataset |

## The differential harness

The app runs local SQL through more than one engine: AlaSQL in the workbench
and on the scheduled-refresh path, and a hand-written AST interpreter behind
the `sql_query` agent tool. **The same question asked through two surfaces must
not produce two answers.**

`tests/differential/` runs a shared corpus through every engine and compares
canonicalised results. It exists for two jobs:

1. **Catch drift today.** On its first run it found three bugs in the
   interpreter: `!=` admitted NULL rows, `LIMIT n OFFSET m` paged wrongly, and
   a qualified column in a JOIN resolved to the wrong table — each silently
   returning wrong data to an AI agent.
2. **Make a future engine swap provable.** Replacing an engine (with DuckDB,
   say) means adding one adapter to `engines.ts` and watching the corpus. That
   is the difference between an evidence-based migration and a leap.

To see the differences rather than a pass/fail:

```bash
npm run test:differential
```

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
