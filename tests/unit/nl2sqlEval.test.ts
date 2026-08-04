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

describe("a superlative must have exactly one right answer", () => {
  // A `LIMIT 1` over a TIE has no deterministic answer: whichever row the
  // engine happens to sort first wins, so the reference disagrees with itself
  // between runs and the question grades the model on a coin toss.
  //
  // This is not hypothetical. `ambiguous-biggest-security-problem` asked for
  // the top technique among status='NEW' alerts, where three techniques tie at
  // 4. It passed the "reference runs and returns rows" check, and only
  // surfaced when the same measurement was run three times and gave two
  // different answers.
  const superlatives = QUESTIONS.filter(
    (q) => /\bLIMIT\s+1\b/i.test(q.referenceSql) && /\bORDER\s+BY\b/i.test(q.referenceSql),
  );

  it.each(superlatives.map((q) => [q.id, q] as const))("%s has a unique winner", async (_id, q) => {
    // Re-run the reference WITHOUT its LIMIT, then compare the top two rows on
    // the column being ordered by. Dropping only the trailing LIMIT keeps the
    // ORDER BY, which is what decides the winner.
    const unlimited = q.referenceSql.replace(/\s+LIMIT\s+1\s*$/i, "");
    const rows = (await runLocalSelect(unlimited, q.tables.map(loadTable))).rows;
    if (rows.length < 2) return; // only one candidate: nothing to tie with

    // The ordered-by column is the last one in the SELECT for every reference
    // here, but rather than parse SQL, compare on whichever values differ:
    // if EVERY column of the top two rows is equal the answer is ambiguous.
    const [first, second] = rows;
    const sameOnEvery = Object.keys(first).every(
      (k) => String(first[k] ?? "") === String(second[k] ?? ""),
    );
    expect(sameOnEvery, `${q.id}: the top two rows are identical — the winner is arbitrary`).toBe(
      false,
    );

    // And the measure itself must differ, or ORDER BY cannot separate them.
    const measure = Object.keys(first).at(-1)!;
    expect(
      String(first[measure] ?? ""),
      `${q.id}: top two tie on "${measure}" (${first[measure]}), so LIMIT 1 is a coin toss`,
    ).not.toBe(String(second[measure] ?? ""));
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

describe("the eval runner can still be loaded by the tool that runs it", () => {
  // THIS FILE ALREADY EXISTED AND DID NOT CATCH THE BREAK. The eval was
  // unrunnable for 82 commits: biAgent imported lib/sqlEngine -> lib/
  // browserDuckdb -> `import mvpWasm from "…/duckdb-mvp.wasm?url"`, a
  // Vite-only specifier. Under Node the .wasm resolved as a package and died
  // on its internal `env` import before a single question ran.
  //
  // The tests above cover the eval's QUESTIONS and its GRADING, neither of
  // which touches the runner's dependency graph — so they stayed green.
  //
  // A FIRST ATTEMPT AT THIS GUARD WAS WORTHLESS, and mutation testing is the
  // only reason that was noticed: it did `await import("@/lib/biAgent")`
  // inside vitest, restoring the exact broken import left it GREEN, because
  // VITEST IS A VITE ENVIRONMENT and resolves `?url` happily. No test running
  // under vitest can ever catch this class of bug.
  //
  // So it has to run under the same tool the eval does. `npm run eval:nl2sql`
  // is `tsx evals/nl2sql/run.ts`, and run.ts ends in `await main()` — it would
  // execute the eval and spend money — so a child `tsx` process imports the
  // runner's dependencies instead. Slow (a real process), and the only version
  // of this that tests anything.
  const RUNNER = "evals/nl2sql/run.ts";

  // Multiline-aware: run.ts imports localEngine.server across four lines, and
  // a single-line regex silently skipped it — leaving the guard checking a
  // subset of the runner's graph while looking complete.
  const specifiers = [
    ...readFileSync(RUNNER, "utf8").matchAll(/^import\s+[\s\S]*?from\s+"([^"]+)";/gm),
  ]
    .map((m) => m[1])
    .filter((s) => s.startsWith("@/"));

  it("found the runner's aliased imports", () => {
    expect(specifiers.length, "no imports parsed — the regex or the file changed").toBeGreaterThan(
      1,
    );
    expect(specifiers, "biAgent is the one that broke; it must stay covered").toContain(
      "@/lib/biAgent",
    );
  });

  it("loads every one of them under plain tsx, as the eval does", async () => {
    const { spawnSync } = await import("node:child_process");
    const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");

    // The probe goes in a FILE, at a relative path with no spaces, rather
    // than into `tsx -e`. Windows needs shell:true to launch npx at all, and
    // shell:true concatenates arguments instead of escaping them — passing a
    // multi-line program containing quotes through that is the escaping trap
    // that has cost this repo real time. A bare relative path has no
    // quoting hazard, and the repo's own path contains a space.
    // Inside the project, so tsconfig path aliases ("@/…") resolve. tsx
    // resolves them relative to the IMPORTING file, so a probe in
    // node_modules/.cache fails every @/ import for a reason that has nothing
    // to do with what is being tested — which is how the first version of this
    // "failed" while the code was fine.
    const dir = "evals";
    const probe = `${dir}/.import-probe.mts`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, specifiers.map((s) => `await import(${JSON.stringify(s)});`).join("\n"));

    try {
      const res = spawnSync("npx", ["tsx", probe], {
        encoding: "utf8",
        timeout: 120_000,
        shell: true,
      });
      const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      expect(
        res.status,
        `the eval's imports no longer load under tsx:\n${output.slice(0, 700)}`,
      ).toBe(0);
    } finally {
      rmSync(probe, { force: true });
    }
  }, 150_000);
});

describe("the window-function guidance agrees with the reference answers", () => {
  // Window scored 3/6, and all three failures were shapes the prompt said
  // nothing about. Guidance was added — and a FIRST DRAFT OF IT WAS WRONG in a
  // way that would have made the score worse: it banned combining an aggregate
  // and a window at the same SELECT level, which is legal (windows evaluate
  // after GROUP BY) and is exactly what the top-product-per-region reference
  // does. A prompt rule that contradicts an expected answer costs a whole run
  // to discover, so it is checked here instead — no token, no model call.
  const prompt = readFileSync("src/lib/biAgent.ts", "utf8");
  const questions = readFileSync("evals/nl2sql/questions.ts", "utf8");

  const windowRefs = questions
    .split(/\n {2}\{\n/)
    .filter((b) => b.includes('category: "window"'))
    .map((b) => ({
      id: (b.match(/id: "([^"]+)"/) || [])[1] ?? "?",
      sql: (b.match(/referenceSql:\s*([\s\S]*?),\n\s+category:/) || ["", ""])[1]
        .replace(/"\s*\+\s*\n?\s*"/g, "")
        .replace(/^\s*"|"\s*$/g, "")
        .replace(/\s+/g, " "),
    }));

  it("found the window references", () => {
    expect(windowRefs.length).toBeGreaterThan(3);
    expect(windowRefs.every((r) => r.sql.length > 20)).toBe(true);
  });

  it("states the rules the failures needed", () => {
    expect(prompt, "the aggregate-contains-window ban is gone").toMatch(
      /aggregate may never CONTAIN a window/,
    );
    expect(prompt, "the top-N-per-group recipe is gone").toMatch(
      /ROW_NUMBER\(\) OVER \(PARTITION BY/,
    );
    expect(prompt, "the GROUP BY window-argument rule is gone").toMatch(/SUM\(SUM\(x\)\) OVER/);
  });

  it("does not forbid what a reference answer actually does", () => {
    // The rule bans an aggregate CONTAINING a window. No reference may do that,
    // or the prompt is telling the model not to produce the expected answer.
    const violating = windowRefs.filter((r) =>
      /\b(MAX|MIN|SUM|AVG|COUNT)\s*\([^()]*\bOVER\b/i.test(r.sql),
    );
    expect(
      violating.map((v) => v.id),
      "a reference answer nests a window inside an aggregate, which the prompt forbids",
    ).toEqual([]);
  });

  it("permits a window over an aggregate, which one reference relies on", () => {
    // The specific shape the first draft would have banned.
    const sameLevel = windowRefs.filter((r) =>
      /OVER\s*\([^)]*\b(SUM|AVG|COUNT|MAX|MIN)\s*\(/i.test(r.sql),
    );
    expect(
      sameLevel.length,
      "no reference uses a window over an aggregate any more",
    ).toBeGreaterThan(0);
    expect(prompt, "the prompt must explicitly allow this").toMatch(
      /a window may reference an aggregate/i,
    );
  });
});
