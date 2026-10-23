// A cost below a millionth of a dollar keeps its digits (R318).
//
// FOUND IN R202, fixed in R318. execution_traces.cost_usd was NUMERIC(10,6),
// so a call priced at $0.0000046 was stored as $0.000005, and every total over
// such calls carried that rounding; the run and evaluation tables were
// NUMERIC(12,6). A later migration makes each unconstrained `numeric`. Agent
// Chat's whole-turn total was rounded the same way in code.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = "supabase/migrations";
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const sql = (f: string) => readFileSync(`${DIR}/${f}`, "utf8");

/** Every money column a migration declares with six decimal places, by table. */
function sixPlaceColumns(): { file: string; table: string; column: string }[] {
  const out: { file: string; table: string; column: string }[] = [];
  for (const file of files) {
    const text = sql(file);
    const tables = [
      ...text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.(\w+) \(([\s\S]*?)\n\);/gi),
    ];
    for (const [, table, body] of tables) {
      for (const [, column] of body.matchAll(
        /^\s*(\w*(?:cost|usd)\w*)\s+numeric\s*\(\s*\d+\s*,\s*6\s*\)/gim,
      )) {
        out.push({ file, table, column });
      }
    }
  }
  return out;
}

describe("money columns", () => {
  const declared = sixPlaceColumns();

  it("the sweep finds the five it was written for", () => {
    expect(declared.map((d) => `${d.table}.${d.column}`).sort()).toEqual([
      "eval_results.cost_usd",
      "eval_runs.total_cost_usd",
      "execution_traces.cost_usd",
      "swarm_run_steps.cost_usd",
      "swarm_runs.total_cost_usd",
    ]);
  });

  it("each is made unconstrained numeric by a later migration", () => {
    for (const d of declared) {
      const later = files
        .filter((f) => f > d.file)
        .map(sql)
        .join("\n");
      const alter = `ALTER TABLE public.${d.table} ALTER COLUMN ${d.column} TYPE numeric;`;
      expect(later.includes(alter), `no later migration has: ${alter}`).toBe(true);
    }
  });
});

describe("Agent Chat's whole-turn total", () => {
  const chat = readFileSync("src/routes/api/chat.ts", "utf8");

  it("keeps significant digits rather than six places", () => {
    const at = chat.indexOf("safePayload.turn_cost_usd = Number(");
    expect(at).toBeGreaterThan(0);
    const expr = chat.slice(at, chat.indexOf(");", at));
    expect(expr).toContain(".toPrecision(12)");
    expect(expr).not.toContain(".toFixed(");
  });

  it("which is the difference between a call's price and a figure no call cost", () => {
    const call = 0.0000046;
    expect(Number(call.toFixed(6))).toBe(0.000005);
    expect(Number(call.toPrecision(12))).toBe(0.0000046);
    // And it still clears the noise of a float sum.
    expect(Number((0.1 + 0.2).toPrecision(12))).toBe(0.3);
  });
});
