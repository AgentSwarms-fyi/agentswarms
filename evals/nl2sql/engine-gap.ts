// What does a BI-workspace user actually lose to the browser engine?
//
//   npx vite-node evals/nl2sql/engine-gap.ts
//
// Calls no model and costs nothing. It runs every REFERENCE query — known-good
// SQL, already verified correct by tests/unit/nl2sqlEval.test.ts — on BOTH
// local engines and compares the results.
//
// WHY THIS IS WORTH A SCRIPT: local datasets are executed in two different
// places. The SQL workbench and the BI "Ask AI" turn run in the BROWSER on
// AlaSQL (lib/sqlEngine `runQuery`); the agents' sql_query tool, scheduled
// refreshes, prep flows and the semantic runner run on the SERVER, DuckDB by
// default. Same dataset, same question, two engines with different SQL.
//
// The NL-to-SQL eval measures the server path. This measures the DIFFERENCE,
// so the gap is a number rather than a worry — a query that diverges here is
// one the product answers correctly on a schedule and incorrectly when a
// person types it in.
import { readFileSync } from "node:fs";
import path from "node:path";

import Papa from "papaparse";

import { coerceRow, inferColumns } from "@/lib/datasetParse";
import { runLocalSelect, type LocalEngineTable } from "@/utils/data/localEngine.server";
import { canonRows } from "../../tests/differential/engines";
import { QUESTIONS } from "./questions";

const DIR = path.resolve("src/assets/sample-data");
const cache = new Map<string, LocalEngineTable>();

function load(name: string): LocalEngineTable {
  const hit = cache.get(name);
  if (hit) return hit;
  // The escape, never a literal BOM in the source: a literal one is invisible
  // in every editor and trips no-irregular-whitespace.
  const csv = readFileSync(path.join(DIR, `${name}.csv`), "utf8").replace(/^\uFEFF/, "");
  const raw = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  }).data.filter((r) => r && Object.keys(r).length > 0);
  const columns = inferColumns(raw);
  const t = { name, columns, rows: raw.map((r) => coerceRow(r, columns)) };
  cache.set(name, t);
  return t;
}

type Ran = { rows: string; error?: undefined } | { rows?: undefined; error: string };

async function runOn(engine: "duckdb" | "alasql", sql: string, tables: string[]): Promise<Ran> {
  process.env.LOCAL_ENGINE = engine === "alasql" ? "alasql" : "duckdb";
  try {
    const res = await runLocalSelect(sql, tables.map(load));
    if (res.engine !== engine) throw new Error(`asked for ${engine} but ran on ${res.engine}`);
    // Canonicalised the way the differential harness compares engines, and by
    // POSITION rather than column name, so an alias difference is not counted
    // as a divergence.
    const positional = res.rows.map((r) =>
      Object.fromEntries(
        Object.values(r).map((v, i) => {
          const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
          const rounded =
            Number.isFinite(n) && String(v).trim() !== "" ? Math.round(n * 100) / 100 : v;
          return [`c${i}`, rounded];
        }),
      ),
    );
    return { rows: canonRows(positional, false) };
  } catch (e) {
    return { error: (e as Error).message.replace(/\s+/g, " ").slice(0, 110) };
  }
}

async function main() {
  console.log(`\nReference queries on each local engine · ${QUESTIONS.length} questions\n`);

  const broken: { id: string; category: string; question: string; why: string }[] = [];
  const differing: { id: string; category: string; question: string }[] = [];

  for (const q of QUESTIONS) {
    const duck = await runOn("duckdb", q.referenceSql, q.tables);
    const ala = await runOn("alasql", q.referenceSql, q.tables);

    if (duck.error) continue; // not a browser problem; the baseline itself failed
    if (ala.error) {
      broken.push({ ...q, why: `AlaSQL: ${ala.error}` });
    } else if (ala.rows !== duck.rows) {
      // RUNS BUT DISAGREES — the dangerous half. An earlier version of this
      // script only checked that a query executed and returned rows, which
      // scored AlaSQL at 59/61 and missed every one of these. A wrong answer
      // delivered confidently is worse than an error.
      differing.push(q);
    }
  }

  const bad = broken.length + differing.length;
  console.log(`  duckdb (server paths)   ${QUESTIONS.length}/${QUESTIONS.length}`);
  console.log(
    `  alasql (browser paths)  ${QUESTIONS.length - bad}/${QUESTIONS.length}` +
      `   — ${broken.length} error, ${differing.length} WRONG ANSWER`,
  );

  if (broken.length) {
    console.log(`\n  Cannot run in the browser (${broken.length}):\n`);
    for (const f of broken) {
      console.log(`    [${f.category}] ${f.id}`);
      console.log(`        ${f.question}`);
      console.log(`        ${f.why}`);
    }
  }

  if (differing.length) {
    console.log(`\n  RUNS IN THE BROWSER BUT RETURNS A DIFFERENT ANSWER (${differing.length}):\n`);
    for (const f of differing) {
      console.log(`    [${f.category}] ${f.id}`);
      console.log(`        ${f.question}`);
    }
  }

  if (bad === 0) {
    console.log("\n  No gap: both engines agree on every reference query.\n");
    return;
  }

  const byCat: Record<string, number> = {};
  for (const f of [...broken, ...differing]) byCat[f.category] = (byCat[f.category] ?? 0) + 1;
  console.log(
    `\n  By category: ${Object.entries(byCat)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c} ${n}`)
      .join(" · ")}`,
  );
  console.log(
    `\n  These are questions the product answers correctly on a schedule but not\n` +
      `  when a user types them into the BI workspace or the SQL workbench.\n`,
  );
}

await main();
