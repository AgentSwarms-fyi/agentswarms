// What keeps the query log whole (R531): every path that runs a query for
// somebody records it, every caller says what its query was for, and nobody
// but the server can write the table.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const MIGRATION = rd("supabase/migrations/20261127000000_query_log.sql");

/** Every call of `fn` in src, with the text from the call to its closing `);`. */
function callsOf(fn: string): { at: string; text: string }[] {
  const files = execSync(`git grep -l "${fn}(" -- src`, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const out: { at: string; text: string }[] = [];
  for (const f of files) {
    const src = rd(f);
    let i = src.indexOf(`${fn}(`);
    while (i !== -1) {
      const before = src.slice(Math.max(0, i - 30), i);
      if (!/function\s+$/.test(before)) {
        const end = src.indexOf(");", i);
        const line = src.slice(0, i).split("\n").length;
        out.push({ at: `${f}:${line}`, text: src.slice(i, end === -1 ? i + 400 : end + 2) });
      }
      i = src.indexOf(`${fn}(`, i + fn.length);
    }
  }
  return out;
}

describe("every query run for somebody says what it was for", () => {
  it("every warehouse call that names a person also says why", () => {
    const calls = callsOf("executeWarehouseQuery");
    expect(calls.length).toBeGreaterThan(15);
    for (const c of calls) {
      if (!/userId/.test(c.text)) continue; // housekeeping: nobody's history
      expect(c.text, c.at).toMatch(/log:\s*\{\s*via:\s*"[a-z_]+"/);
    }
    // A search of the whole source tree: on a cold disk it has taken 38 s.
  }, 60_000);

  it("every run on the server's local engine says why", () => {
    const calls = callsOf("runLocalSqlForUser");
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) expect(c.text, c.at).toMatch(/\{\s*via:\s*"[a-z_]+"\s*\}/);
  }, 60_000);
});

describe("every path that runs a query records it", () => {
  it.each([
    ["the warehouse seam", "src/utils/warehouse/drivers.server.ts"],
    ["the lakehouse runner", "src/utils/lakehouse/core.server.ts"],
    ["the Spark lakehouse runner", "src/utils/lakehouse/sparkQuery.server.ts"],
    ["the server's local engine", "src/utils/bi/refresh.server.ts"],
    ["the object-store reader", "src/routes/api/objectstore/query.ts"],
    ["the agent's SQL tool", "src/utils/tools/sql.server.ts"],
    ["the workbench's browser runs", "src/utils/queryLog.functions.ts"],
  ])("%s", (_name, file) => {
    expect(rd(file)).toContain("recordQueryRun(");
  });

  it("records a lakehouse query once: the seam leaves it to the lakehouse", () => {
    const seam = rd("src/utils/warehouse/drivers.server.ts");
    expect(seam).toMatch(/if \(!opts\.userId \|\| config\.provider === "lakehouse"\) return;/);
  });

  it("does not count an answer served from the lakehouse cache as a query", () => {
    const core = rd("src/utils/lakehouse/core.server.ts");
    const record = core.slice(
      core.indexOf("const record = ("),
      core.indexOf("auditEvent({", core.indexOf("const record = (")),
    );
    expect(record).toMatch(/if \(!extra\?\.cached\) \{\s*recordQueryRun\(/);
  });

  it("the workbench tells the server what it ran in the browser, and finds an object-store run again", () => {
    const page = rd("src/routes/_authenticated/data-sql.tsx");
    expect(page).toMatch(/if \(source === "local"\) \{\s*void recordBrowserFn\(/);
    // "storage:<id>" does not fit sql_query_history's uuid column.
    expect(page).toContain('connectionId: source === "local" || bucket ? null : source');
  });
});

describe("nobody but the server writes it", () => {
  it("has row-level security, an owner's SELECT, and no client write policy", () => {
    expect(MIGRATION).toContain("ALTER TABLE public.query_log ENABLE ROW LEVEL SECURITY");
    expect(MIGRATION).toMatch(/FOR SELECT\s+USING \(auth\.uid\(\) = user_id\)/);
    expect(MIGRATION).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)\b/);
    // And says so on apply.
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'query_log must have no client write policy/);
  });

  it("adds up only the caller's own rows", () => {
    const fn = MIGRATION.slice(
      MIGRATION.indexOf("CREATE OR REPLACE FUNCTION public.query_log_summary"),
    );
    expect(fn).toContain("SECURITY INVOKER");
    expect(fn).toContain("WHERE q.user_id = auth.uid()");
    expect(MIGRATION).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.query_log_summary\(timestamptz\) FROM anon/,
    );
  });

  it("writes with the service role, and never fails the query it records", () => {
    const writer = rd("src/utils/queryLog/record.server.ts");
    expect(writer).toContain('supabaseAdmin.from("query_log").insert(');
    expect(writer).toMatch(/if \(!run\.userId\) return;/);
    expect(writer).toMatch(/\} catch \(e\) \{\s*console\.warn/);
  });

  it("is kept to the trace retention window", () => {
    expect(rd("src/utils/observability/retention.server.ts")).toContain(
      'await purgeOlderThan("query_log", cutoff);',
    );
  });
});
