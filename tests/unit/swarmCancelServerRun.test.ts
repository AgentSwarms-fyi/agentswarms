// A swarm run the server executes, cancelled from Recent runs (R309, sweep 10).
//
// FOUND IN R309. Recent runs offers Cancel on a running run. For a run the
// server executes - a workflow step, a schedule, the API - the cancel only
// flagged the row: nothing in executeSwarmServer read the flag, and the run
// went on through every node. Its close then wrote "success" over
// "cancelled". Driven: a three-agent swarm cancelled 2 s in ran all five
// steps, spent $0.00064 and ended "Success".
//
// The tracer's close runs for real here against an in-memory table; the
// executor's wiring is pinned by reading it, since it drives model calls,
// tools and the JS sandbox.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ tables: {} as Record<string, Record<string, unknown>[]> }));

function from(table: string) {
  const rows = () => (db.tables[table] ??= []);
  let op: "select" | "insert" | "update" = "select";
  let patch: Row = {};
  let inserting: Row[] = [];
  const filters: ((r: Row) => boolean)[] = [];
  let single: "maybe" | "one" | null = null;
  const run = async () => {
    let out: Row[];
    if (op === "insert") {
      out = inserting.map((r, i) => ({ id: `${table}-${rows().length + i + 1}`, ...r }));
      rows().push(...out);
    } else {
      out = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") for (const r of out) Object.assign(r, patch);
    }
    out = out.map((r) => ({ ...r }));
    if (single === "maybe") return { data: out[0] ?? null, error: null };
    if (single === "one") {
      return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "none" } };
    }
    return { data: out, error: null };
  };
  const b = {
    select: () => b,
    insert: (v: Row | Row[]) => ((op = "insert"), (inserting = Array.isArray(v) ? v : [v]), b),
    update: (p: Row) => ((op = "update"), (patch = p), b),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
    order: () => b,
    limit: () => b,
    maybeSingle: () => ((single = "maybe"), b),
    single: () => ((single = "one"), b),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve().then(run).then(res, rej),
  };
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from } }));

const { createServerSwarmTracer } = await import("@/utils/observability/serverTracer.server");

const exec = readFileSync("src/utils/swarmExecute.server.ts", "utf8");
const browserTracer = readFileSync("src/utils/observability/tracer.ts", "utf8");

beforeEach(() => {
  db.tables = {};
});

describe("the server run's close", () => {
  it("does not write success over a cancel, and still records what the run spent", async () => {
    const tracer = await createServerSwarmTracer({ userId: "user-1", swarmName: "r309" });
    const run = () => db.tables.swarm_runs[0];
    expect(run().status).toBe("running");
    // Recent runs' Cancel lands while the run goes on.
    Object.assign(run(), { status: "cancelled", cancel_requested: true });
    await tracer!.finish({ status: "success", finalOutput: "all three paragraphs" });
    expect(run().status).toBe("cancelled");
    expect(run().final_output ?? null).toBeNull();
    expect(run()).toHaveProperty("total_cost_usd");
    expect(run()).toHaveProperty("step_count");
  });

  it("closes a run that is still running", async () => {
    const tracer = await createServerSwarmTracer({ userId: "user-1", swarmName: "r309" });
    await tracer!.finish({ status: "success", finalOutput: "done" });
    expect(db.tables.swarm_runs[0]).toMatchObject({ status: "success", final_output: "done" });
  });
});

describe("executeSwarmServer", () => {
  it("watches its run's row and aborts when a cancel is flagged", () => {
    expect(exec).toMatch(
      /const cancelWatch =\s*runId && depth === 0\s*\?\s*setInterval\(\s*\(\) => \{[^]*?\.select\("cancel_requested"\)[^]*?if \(data\?\.cancel_requested\) \{\s*cancelled = true;\s*ac\.abort\(\);/,
    );
    expect(exec).toMatch(/if \(cancelWatch\) clearInterval\(cancelWatch\);/);
  });

  it("starts no node on a cancelled run, and closes it as cancelled", () => {
    expect(exec).toMatch(
      /if \(cancelled\) throw new Error\(CANCELLED_WHILE_RUNNING\);\s*if \(expired\(\)\) throw deadlineError\(\);/,
    );
    expect(exec).toMatch(
      /\} catch \(err\) \{\s*\/\/[^\n]*\n\s*if \(cancelled\) return await finish\("cancelled", "", CANCELLED_WHILE_RUNNING\);/,
    );
    expect(exec).toContain(
      'if (status === "cancelled") return { status: "error", output, error, runId };',
    );
  });

  it("parks only a run still running, and resumes no cancelled run", () => {
    expect(exec).toMatch(
      /\.update\(\{ status: "suspended", updated_at: new Date\(\)\.toISOString\(\) \}\)\s*\.eq\("id", runId!\)\s*\.eq\("status", "running"\);/,
    );
    expect(exec).toContain('run.status === "cancelled"');
  });
});

describe("the browser run's close", () => {
  it("lands only on a run still running, and keeps the numbers of one cancelled meanwhile", () => {
    const close = browserTracer.slice(browserTracer.indexOf("async finish(args)"));
    expect(close).toMatch(
      /\.eq\("id", runId\)\s*\.eq\("user_id", userId\)\s*\.eq\("status", "running"\)\s*\.select\("id"\);/,
    );
    expect(close).toMatch(
      /if \(!closeErr && !closed\?\.length\) \{\s*await supabase\s*\.from\("swarm_runs"\)\s*\.update\(numbers as any\)/,
    );
  });
});
