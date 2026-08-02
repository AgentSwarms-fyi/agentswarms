// The per-agent SQL table allow-list on the EMBED BI widget path.
//
// /api/embed/chat is anonymous by design: a stranger on someone else's website
// types a question, and if the agent has "BI visuals" on, the owner's LLM
// writes SQL over the owner's data and rows come back in a chart. The owner's
// `sql_query` allow-list is the only thing that decides which datasets that
// can touch.
//
// IT WAS NOT APPLIED HERE. utils/embedBi.server called describeUserTables and
// runSqlQuery with no allow-list, while the chat path (registry.server) and
// the swarm path (swarmNodes.server) both passed one. An agent restricted to a
// single table would still have every dataset the owner owns described to the
// model, and could return rows from any of them to an anonymous visitor.
//
// describeUserTables did not even TAKE an allow-list parameter, which is worth
// keeping in mind: the schema string is what tells the model the tables exist.
// Restricting execution while still naming the forbidden tables is the same
// half-fix the semantic-model allow-list had — see metricAllowList.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { describeUserTables, runSqlQuery } from "@/utils/tools/sql.server";
import type { AgentToolContext } from "@/utils/tools/registry.server";

type Table = { id: string; name: string; columns: { name: string; type: string }[] };

/**
 * Supabase stand-in shaped like the calls loadUserTables makes:
 *   from("user_data_tables").select(…).not(…)
 *   from("user_data_rows").select("row").eq("table_id", id).range(a, b)
 * Every link is chainable AND awaitable, because the real builder is.
 */
function fakeDb(tables: Table[], rowsByTable: Record<string, Record<string, unknown>[]>) {
  return {
    from(table: string) {
      if (table === "user_data_tables") {
        const result = {
          data: tables.map((t) => ({ ...t, user_id: "owner", is_sample: false })),
          error: null,
        };
        const chain: Record<string, unknown> = {};
        for (const k of ["select", "not", "or", "eq", "order"]) chain[k] = () => chain;
        chain.then = (r: (v: typeof result) => unknown) => Promise.resolve(result).then(r);
        return chain;
      }
      let id = "";
      let ranged = false;
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (_c: string, v: string) => {
        id = v;
        return chain;
      };
      chain.range = () => {
        ranged = true;
        return chain;
      };
      chain.then = (r: (v: { data: unknown; error: null }) => unknown) =>
        Promise.resolve({
          // Second page must come back empty or loadUserTables loops forever.
          data: ranged ? (rowsByTable[id] ?? []).map((row) => ({ row })) : [],
          error: null,
        }).then((v) => {
          ranged = false;
          return r(v);
        });
      return chain;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const TABLES: Table[] = [
  { id: "t-public", name: "public_metrics", columns: [{ name: "n", type: "number" }] },
  { id: "t-secret", name: "employee_salaries", columns: [{ name: "salary", type: "number" }] },
];
const ROWS = {
  "t-public": [{ n: 1 }],
  "t-secret": [{ salary: 250000 }],
};

const ctx = (): AgentToolContext =>
  ({ sb: fakeDb(TABLES, ROWS), userId: "owner" }) as unknown as AgentToolContext;

describe("describeUserTables honours the allow-list", () => {
  it("names every table when unrestricted", async () => {
    const out = await describeUserTables(ctx());
    expect(out).toContain("public_metrics");
    expect(out).toContain("employee_salaries");
  });

  it("names ONLY the allowed table when restricted", async () => {
    // The schema string is the model's map of what exists. A restricted agent
    // that is still told about employee_salaries will ask for it.
    const out = await describeUserTables(ctx(), new Set(["public_metrics"]));
    expect(out).toContain("public_metrics");
    expect(out, "the forbidden table was described to the model").not.toContain(
      "employee_salaries",
    );
  });

  it("treats an empty allow-list as unrestricted, matching the chat tool", async () => {
    // Deliberate: this list is opt-in for sql_query. One surface quietly
    // applying deny-by-default while the other does not is how two paths that
    // are supposed to agree stop agreeing.
    const out = await describeUserTables(ctx(), new Set());
    expect(out).toContain("employee_salaries");
  });
});

describe("runSqlQuery honours the allow-list", () => {
  it("cannot read a table outside the list", async () => {
    const raw = await runSqlQuery(
      ctx(),
      { sql: 'SELECT * FROM "employee_salaries"' },
      new Set(["public_metrics"]),
    );
    const out = JSON.parse(raw) as { error?: string; rows?: unknown[] };
    expect(out.rows, "rows came back from a table outside the allow-list").toBeUndefined();
    expect(out.error).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain("250000");
  });

  it("still reads the allowed table", async () => {
    const raw = await runSqlQuery(
      ctx(),
      { sql: 'SELECT * FROM "public_metrics"' },
      new Set(["public_metrics"]),
    );
    const out = JSON.parse(raw) as { rows?: Record<string, unknown>[] };
    expect(out.rows).toEqual([{ n: 1 }]);
  });
});

describe("the embed widget path passes its allow-list", () => {
  // The functional tests above pass an allow-list explicitly, so they would
  // ALL still pass with the embed path wired exactly as broken as it was.
  // These assert the wiring itself — the thing that was actually wrong.
  const embedBi = readFileSync("src/utils/embedBi.server.ts", "utf8");
  const embedChat = readFileSync("src/routes/api/embed.chat.ts", "utf8");

  it("calls describeUserTables WITH an allow-list", () => {
    const calls = [...embedBi.matchAll(/describeUserTables\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c[1].split(",").length, `describeUserTables(${c[1]}) passes no allow-list`).toBe(2);
    }
  });

  it("calls runSqlQuery WITH an allow-list", () => {
    const calls = [...embedBi.matchAll(/runSqlQuery\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      // ctx, args, allowSet — the third argument is the whole point.
      expect(c[1].split(",").length, `runSqlQuery(${c[1]}) passes no allow-list`).toBe(3);
    }
  });

  it("the route hands the agent's saved list to the widget generator", () => {
    // Reading it off the agent row is what makes the allow-list real; a
    // generator that accepts the option but is never given one is decoration.
    //
    // ASSERT THE CALL, NOT THE DEFINITION. A first version matched
    // /toolConfigs\?\.sql_query\?\.table_names/ anywhere in the file — which
    // is satisfied by the body of readSqlTableNames itself. Replacing the
    // agent branch with `sqlTableNames: []` left the helper defined but
    // uncalled, and the test passed. Scoped to the agent branch and pinned to
    // the call site, that mutation now fails.
    const swarmAt = embedChat.indexOf("// swarm node");
    expect(swarmAt).toBeGreaterThan(0);
    const agentBranch = embedChat.slice(0, swarmAt);
    expect(agentBranch, "the agent branch does not read the saved allow-list").toMatch(
      /sqlTableNames: readSqlTableNames\(/,
    );

    const widgetCalls = [...embedChat.matchAll(/generateEmbedWidget\(\{([\s\S]*?)\}\)/g)];
    expect(widgetCalls.length).toBeGreaterThan(0);
    for (const c of widgetCalls) {
      expect(c[1], "a generateEmbedWidget call omits sqlTableNames").toContain("sqlTableNames");
    }
  });
});
