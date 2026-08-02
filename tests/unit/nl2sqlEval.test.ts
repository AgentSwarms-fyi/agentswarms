// The evaluation harness itself, checked without spending a model call.
//
// Everything here is the part of the eval that can be wrong silently. A
// reference query that does not run makes its question permanently
// ungradeable; a grader that accepts anything reports a flattering number
// forever. Both would be worse than having no eval, because they would look
// like evidence.
//
// The model call is deliberately NOT exercised — it costs money and needs a
// key. `npm run eval:nl2sql` is the deliberate, operator-run path.
import { readFileSync } from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import { describe, expect, it } from "vitest";

import { coerceRow, inferColumns } from "@/lib/datasetParse";
import { runLocalSelect, type LocalEngineTable } from "@/utils/data/localEngine.server";
import { grade, summarize } from "../../evals/nl2sql/grade";
import { CATEGORIES, QUESTIONS } from "../../evals/nl2sql/questions";

const SAMPLE_DIR = path.resolve("src/assets/sample-data");
const cache = new Map<string, LocalEngineTable>();

function loadTable(name: string): LocalEngineTable {
  const hit = cache.get(name);
  if (hit) return hit;
  // Sample CSVs are UTF-8 with a BOM; left in place it becomes part of the
  // first column's name and every query against it fails.
  const csv = readFileSync(path.join(SAMPLE_DIR, `${name}.csv`), "utf8").replace(/^\uFEFF/, "");
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });
  const raw = parsed.data.filter((r) => r && Object.keys(r).length > 0);
  const columns = inferColumns(raw);
  const table = { name, columns, rows: raw.map((r) => coerceRow(r, columns)) };
  cache.set(name, table);
  return table;
}

describe("every reference query is answerable", () => {
  it.each(QUESTIONS.map((q) => [q.id, q] as const))("%s", async (_id, q) => {
    const tables = q.tables.map(loadTable);
    const res = await runLocalSelect(q.referenceSql, tables);
    // A reference that errors or returns nothing cannot grade anything — the
    // question would silently score every model as wrong, or as right.
    expect(res.rows.length, `"${q.question}" produced no rows`).toBeGreaterThan(0);

    // A single row of nothing but nulls is the shape an aggregate takes when
    // it silently found no data — SUM over a column the engine read as text,
    // say. It passes the row-count check above while being just as
    // ungradeable, because a broken candidate returns the same thing.
    if (res.rows.length === 1) {
      const values = Object.values(res.rows[0]);
      expect(
        values.length > 0 && values.every((v) => v === null || v === undefined),
        `"${q.question}" returns one row of all nulls — the aggregate found nothing`,
      ).toBe(false);
    }
  });
});

describe("the question set is coherent", () => {
  it("has unique ids", () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names only sample tables that exist", () => {
    for (const q of QUESTIONS) {
      for (const t of q.tables) {
        expect(() => loadTable(t), `${q.id} references a missing sample: ${t}`).not.toThrow();
      }
    }
  });

  it("every reference query is read-only", () => {
    // The eval must never be a way to mutate anything.
    for (const q of QUESTIONS) expect(q.referenceSql).toMatch(/^\s*(SELECT|WITH)\b/i);
  });

  it("covers every declared category", () => {
    for (const c of CATEGORIES) {
      expect(QUESTIONS.some((q) => q.category === c)).toBe(true);
    }
  });

  it("marks ranking questions as ordered", () => {
    // A ranking graded unordered would pass a query that returns the right
    // five customers in the wrong order — which is the wrong answer.
    for (const q of QUESTIONS.filter((x) => x.category === "ranking")) {
      expect(q.ordered, `${q.id} is a ranking but not marked ordered`).toBe(true);
    }
  });

  it("only claims a question is ordered when its reference actually sorts", () => {
    // The converse of the rule above, and the one that bites: `ordered: true`
    // grades row order as part of the answer, so if the reference has no ORDER
    // BY then the "correct" order is whatever the engine happened to emit.
    // The candidate is then graded against an accident.
    for (const q of QUESTIONS.filter((x) => x.ordered)) {
      expect(
        /order\s+by/i.test(q.referenceSql),
        `${q.id} is graded on row order but its reference has no ORDER BY`,
      ).toBe(true);
    }
  });

  it("keeps covering the operations a BI tool is actually asked for", () => {
    // FLOORS, not exact counts — the set should grow.
    //
    // These exist because the set had drifted to zero joins and zero window
    // functions without anyone noticing: it was authored against AlaSQL, which
    // supported neither, so the shape of the engine silently became the shape
    // of the measurement. An accuracy number that excludes joins is not an
    // accuracy number for a BI product.
    const count = (c: string) => QUESTIONS.filter((q) => q.category === c).length;
    expect(
      QUESTIONS.filter((q) => q.tables.length > 1).length,
      "no multi-table questions",
    ).toBeGreaterThanOrEqual(5);
    expect(count("join"), "no join questions").toBeGreaterThanOrEqual(5);
    expect(count("window"), "no window/CTE questions").toBeGreaterThanOrEqual(5);
    expect(count("ambiguity"), "too few ambiguous questions").toBeGreaterThanOrEqual(3);
  });

  it("is not mostly single-value answers", () => {
    // A set dominated by scalars flatters the score: one number is the easiest
    // thing to match by luck, and it tests almost nothing about shaping a
    // result. Kept as a ratio so the set can grow without re-tuning it.
    const scalarish = QUESTIONS.filter((q) => /LIMIT 1\b/i.test(q.referenceSql)).length;
    expect(scalarish / QUESTIONS.length, "over half the questions are LIMIT 1").toBeLessThan(0.5);
  });
});

describe("the grader", () => {
  const rows = [
    { region: "EMEA", total: 100 },
    { region: "APAC", total: 50 },
  ];

  it("passes an identical result", () => {
    expect(grade({ expected: rows, actual: rows, ordered: false }).outcome).toBe("pass");
  });

  it("ignores column aliases", () => {
    // "AS total" vs "AS total_sales" is the same answer.
    const renamed = rows.map((r) => ({ region: r.region, total_sales: r.total }));
    expect(grade({ expected: rows, actual: renamed, ordered: false }).outcome).toBe("pass");
  });

  it("ignores row order when order is not part of the question", () => {
    expect(grade({ expected: rows, actual: [...rows].reverse(), ordered: false }).outcome).toBe(
      "pass",
    );
  });

  it("enforces row order for rankings", () => {
    expect(grade({ expected: rows, actual: [...rows].reverse(), ordered: true }).outcome).toBe(
      "wrong",
    );
  });

  it("treats a numeric string as the number", () => {
    const stringy = rows.map((r) => ({ region: r.region, total: String(r.total) }));
    expect(grade({ expected: rows, actual: stringy, ordered: false }).outcome).toBe("pass");
  });

  it("fails a genuinely different number", () => {
    const wrong = [
      { region: "EMEA", total: 101 },
      { region: "APAC", total: 50 },
    ];
    expect(grade({ expected: rows, actual: wrong, ordered: false }).outcome).toBe("wrong");
  });

  it("fails a missing row", () => {
    expect(grade({ expected: rows, actual: [rows[0]], ordered: false }).outcome).toBe("wrong");
  });

  it("distinguishes a refusal from an engine error", () => {
    expect(
      grade({ expected: rows, actual: { error: "no such column: regoin" }, ordered: false })
        .outcome,
    ).toBe("refused");
    expect(
      grade({ expected: rows, actual: { error: "connection reset" }, ordered: false }).outcome,
    ).toBe("error");
  });
});

describe("the summary", () => {
  it("computes accuracy and a per-category breakdown", () => {
    const s = summarize([
      { category: "aggregate", verdict: { outcome: "pass" } },
      { category: "aggregate", verdict: { outcome: "wrong", expected: "a", actual: "b" } },
      { category: "ranking", verdict: { outcome: "pass" } },
      { category: "ranking", verdict: { outcome: "error", error: "x" } },
    ]);
    expect(s.total).toBe(4);
    expect(s.passed).toBe(2);
    expect(s.accuracy).toBeCloseTo(0.5, 6);
    expect(s.byCategory.aggregate).toEqual({ total: 2, passed: 1 });
    expect(s.byCategory.ranking).toEqual({ total: 2, passed: 1 });
  });

  it("reports zero accuracy rather than dividing by zero", () => {
    expect(summarize([]).accuracy).toBe(0);
  });
});
