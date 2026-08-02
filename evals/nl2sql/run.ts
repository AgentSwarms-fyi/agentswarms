// NL-to-SQL evaluation runner.
//
//   npm run eval:nl2sql
//
// Scores how often the BI analyst turns a plain-English question into SQL that
// returns the RIGHT ANSWER. "AI-powered BI" is a measurable claim; until this
// existed, nobody could say whether the number was 95% or 40%.
//
// What it needs, all operator-supplied and none of it in CI:
//   EVAL_BASE_URL     the running app        (default http://localhost:8080)
//   EVAL_ACCESS_TOKEN a Supabase access token for a signed-in user
//   EVAL_MODEL        optional "provider::model" choice
//
// It calls a real model, so it costs real money. That is why it is a script
// you run deliberately and never a test that runs on push.
//
// Sample data is read from the CSVs in src/assets/sample-data, so the eval
// needs no database and is byte-identical on every machine. The score moves
// when the PROMPT or the MODEL changes — which is the entire point.

import { readFileSync } from "node:fs";
import path from "node:path";

import Papa from "papaparse";

import { buildSqlPrompt, describeColumn } from "@/lib/biAgent";
import { coerceRow, inferColumns, type ColumnDef } from "@/lib/datasetParse";
import {
  localEngineName,
  runLocalSelect,
  type LocalEngineTable,
} from "@/utils/data/localEngine.server";
import { parseModelChoice } from "@/utils/providers/modelChoice";
import { grade, summarize, type Verdict } from "./grade";
import { QUESTIONS, type EvalQuestion } from "./questions";

const BASE = process.env.EVAL_BASE_URL ?? "http://localhost:8080";
const TOKEN = process.env.EVAL_ACCESS_TOKEN ?? "";
const MODEL = process.env.EVAL_MODEL;
const ONLY = process.env.EVAL_ONLY;

const SAMPLE_DIR = path.resolve("src/assets/sample-data");

/** Load one sample CSV as a table, using the app's own inference. */
function loadTable(name: string): LocalEngineTable {
  // Sample CSVs carry a UTF-8 BOM; left in place it becomes part of the first
  // column's name and every query against that column fails.
  const csv = readFileSync(path.join(SAMPLE_DIR, `${name}.csv`), "utf8").replace(/^\uFEFF/, "");
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });
  const raw = parsed.data.filter((r) => r && Object.keys(r).length > 0);
  const columns = inferColumns(raw);
  return { name, columns, rows: raw.map((r) => coerceRow(r, columns)) };
}

const tableCache = new Map<string, LocalEngineTable>();
function tablesFor(names: string[]): LocalEngineTable[] {
  return names.map((n) => {
    let t = tableCache.get(n);
    if (!t) {
      t = loadTable(n);
      tableCache.set(n, t);
    }
    return t;
  });
}

/** The schema block the app shows the model, rendered from the same tables. */
function describeTables(tables: LocalEngineTable[]): string {
  return tables
    .map(
      (t) =>
        `TABLE ${t.name} (${t.rows.length} rows)\n` +
        // The PRODUCTION renderer, not a copy: the eval must describe columns
        // exactly as the app does, or it scores a prompt nobody ever sends.
        t.columns.map((c: ColumnDef) => `  - ${describeColumn(c)}`).join("\n"),
    )
    .join("\n\n");
}

async function generate(q: EvalQuestion, schema: string, engine: string): Promise<string> {
  const { systemPrompt, userPrompt } = buildSqlPrompt({
    question: q.question,
    // The eval scores SQL generation, so the plan is fixed rather than being a
    // second model call whose variance would be attributed to the wrong stage.
    plan: { intent: q.question, tables: q.tables, steps: [] } as never,
    schema,
    // THE PROMPT MUST NAME THE ENGINE THAT WILL EXECUTE. This runner grades by
    // running the SQL through runLocalSelect — the SERVER engine, DuckDB by
    // default — while the prompt's default describes the in-browser AlaSQL that
    // runs the local path in the app.
    //
    // Left unset, every question needing a quoted identifier failed on
    // `SELECT COUNT(*) FROM \`saas_sales\`` before the model had a chance to be
    // wrong about anything, and the score measured a pairing the product never
    // runs. Found the first time this was executed against DuckDB.
    localEngine: engine === "duckdb" ? "duckdb" : "alasql",
  });
  // The endpoint takes provider and model as separate fields; handing it the
  // encoded "provider::model" choice is a 400.
  const choice = parseModelChoice(MODEL);
  const res = await fetch(`${BASE}/api/bi`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      stage: "sql",
      systemPrompt,
      userPrompt,
      ...(choice ? { provider: choice.provider, model: choice.model } : {}),
    }),
  });
  const body = (await res.json()) as { result?: { sql?: string }; error?: string };
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  const sql = body.result?.sql;
  if (!sql) throw new Error("the model returned no SQL");
  return sql;
}

async function runOne(q: EvalQuestion, engine: string): Promise<Verdict> {
  const tables = tablesFor(q.tables);
  const expected = await runLocalSelect(q.referenceSql, tables);

  let candidateSql: string;
  try {
    candidateSql = await generate(q, describeTables(tables), engine);
  } catch (e) {
    return { outcome: "error", error: `generation failed: ${(e as Error).message}` };
  }

  try {
    const actual = await runLocalSelect(candidateSql, tables);
    return grade({ expected: expected.rows, actual: actual.rows, ordered: Boolean(q.ordered) });
  } catch (e) {
    return grade({
      expected: expected.rows,
      actual: { error: (e as Error).message },
      ordered: Boolean(q.ordered),
    });
  }
}

async function main() {
  if (!TOKEN) {
    console.error(
      "EVAL_ACCESS_TOKEN is required — sign in to the app and copy the Supabase access token.\n" +
        "This runner calls a real model through your own /api/bi endpoint.",
    );
    process.exit(2);
  }

  const set = ONLY ? QUESTIONS.filter((q) => q.id === ONLY || q.category === ONLY) : QUESTIONS;

  // Model sampling makes a single pass noisy: the same question can pass on one
  // run and error on the next with no code change at all. That was observed —
  // a category went 4/4 to 3/4 and back to 4/4 with nothing altered. Averaging
  // repeats is the difference between a measurement and an anecdote.
  const repeats = Math.max(1, Number(process.env.EVAL_REPEATS ?? 1) || 1);
  // Resolved once, up front: it decides both what executes the SQL and what
  // the prompt tells the model about quoting. Those two must agree.
  const engine = await localEngineName();
  console.log(
    `\nNL→SQL evaluation · ${set.length} questions${repeats > 1 ? ` x${repeats}` : ""} · ${BASE}${MODEL ? ` · ${MODEL}` : ""} · engine=${engine}\n`,
  );

  const results: { q: EvalQuestion; verdict: Verdict }[] = [];
  const passesPerQuestion = new Map<string, number>();
  for (const q of set) {
    let verdict: Verdict = { outcome: "error", error: "not run" };
    let passes = 0;
    for (let i = 0; i < repeats; i++) {
      const v = await runOne(q, engine);
      if (v.outcome === "pass") passes++;
      // Keep a failing verdict to report; a pass is only shown if every
      // attempt passed, so flakiness is visible rather than averaged away.
      if (i === 0 || (verdict.outcome === "pass" && v.outcome !== "pass")) verdict = v;
    }
    passesPerQuestion.set(q.id, passes);
    if (repeats > 1 && passes > 0 && passes < repeats) {
      verdict = {
        outcome: "wrong",
        expected: `${repeats} passes`,
        actual: `${passes} passes (flaky)`,
      };
    } else if (passes === repeats) {
      verdict = { outcome: "pass" };
    }
    results.push({ q, verdict });
    const mark =
      verdict.outcome === "pass"
        ? "PASS "
        : verdict.outcome === "wrong"
          ? "WRONG"
          : verdict.outcome === "refused"
            ? "REFUS"
            : "ERROR";
    console.log(`  ${mark} [${q.category}] ${q.id} — ${q.question}`);
    if (verdict.outcome === "wrong") {
      console.log(
        `        expected: ${verdict.expected.split("\n").slice(0, 2).join(" ;; ").slice(0, 130)}`,
      );
      console.log(
        `        got     : ${verdict.actual.split("\n").slice(0, 2).join(" ;; ").slice(0, 130)}`,
      );
    } else if (verdict.outcome !== "pass") {
      console.log(`        ${verdict.error.slice(0, 150)}`);
    }
  }

  const s = summarize(results.map((r) => ({ category: r.q.category, verdict: r.verdict })));
  console.log(`\n${"─".repeat(62)}`);
  console.log(
    `Execution accuracy: ${(s.accuracy * 100).toFixed(1)}%  (${s.passed}/${s.total})\n` +
      `  wrong answer ${s.wrong} · engine error ${s.errored} · refused ${s.refused}`,
  );
  console.log("\nBy category:");
  for (const [cat, v] of Object.entries(s.byCategory).sort()) {
    console.log(`  ${cat.padEnd(12)} ${v.passed}/${v.total}`);
  }
  // The ENGINE belongs next to the number. Both the reference query and the
  // model's query execute on whatever LOCAL_ENGINE selects, so the same
  // question set and model can score differently on two engines — DuckDB has
  // window functions, CTEs and subqueries that AlaSQL lacks, and AlaSQL cannot
  // parse `AS total` at all. A score recorded without its engine is not
  // comparable to anything, and the default changed once already.
  console.log(
    `\nA score is only comparable against another run with the SAME question set,\n` +
      `model, prompt AND engine. This run: engine=${engine}, ` +
      `questions=${QUESTIONS.length}, repeats=${repeats}.\n`,
  );
}

await main();
