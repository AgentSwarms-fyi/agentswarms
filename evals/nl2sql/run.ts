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

import { buildSqlPrompt } from "@/lib/biAgent";
import { coerceRow, inferColumns, type ColumnDef } from "@/lib/datasetParse";
import { runLocalSelect, type LocalEngineTable } from "@/utils/data/localEngine.server";
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
        t.columns.map((c: ColumnDef) => `  - ${c.name}: ${c.type}`).join("\n"),
    )
    .join("\n\n");
}

async function generate(q: EvalQuestion, schema: string): Promise<string> {
  const { systemPrompt, userPrompt } = buildSqlPrompt({
    question: q.question,
    // The eval scores SQL generation, so the plan is fixed rather than being a
    // second model call whose variance would be attributed to the wrong stage.
    plan: { intent: q.question, tables: q.tables, steps: [] } as never,
    schema,
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

async function runOne(q: EvalQuestion): Promise<Verdict> {
  const tables = tablesFor(q.tables);
  const expected = await runLocalSelect(q.referenceSql, tables);

  let candidateSql: string;
  try {
    candidateSql = await generate(q, describeTables(tables));
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
  console.log(
    `\nNL→SQL evaluation · ${set.length} questions · ${BASE}${MODEL ? ` · ${MODEL}` : ""}\n`,
  );

  const results: { q: EvalQuestion; verdict: Verdict }[] = [];
  for (const q of set) {
    const verdict = await runOne(q);
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
  console.log(
    "\nA score is only comparable against another run with the SAME question set,\n" +
      "model and prompt. Record all three alongside the number.\n",
  );
}

await main();
