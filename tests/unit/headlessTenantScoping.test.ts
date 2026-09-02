// The agent tool layer must scope to the owner when RLS is not doing it.
//
// THE HOLE THESE WERE WRITTEN FOR. There are two ways `ctx.sb` reaches a tool:
//
//   interactive — anon-key client carrying the user's JWT. RLS
//                 (`auth.uid() = user_id`) scopes every read, so the queries
//                 correctly carry no filter of their own.
//   headless    — deployed swarms, schedules and API-key runs have no JWT, so
//                 `ctx.sb` is the SERVICE-ROLE client and RLS is OFF. The only
//                 tenant boundary is `ctx.scopeUserId`.
//
// kb_search and sql_query threaded scopeUserId through. Six other reads did
// not, and on the headless path each returned rows belonging to any tenant:
//
//   mcp_servers (by name)   the row carries auth_token — and `mcp_call_tool` is
//                           in HEADLESS_SAFE_TOOLS, so a swarm owned by one
//                           tenant could resolve and CALL another tenant's MCP
//                           server as them. A server name is a weak secret:
//                           "github" or "jira" is a guess, not a search.
//   integrations/firecrawl  reached by web_search and web_browse, both also
//                           headless-safe — an arbitrary tenant's Firecrawl key,
//                           and their credits.
//   integrations/n8n        config holds the endpoint and API token.
//   data_warehouse_connections, mcp_servers (list), user_data_tables
//                           names, providers and column schemas, listed into
//                           the tool description.
//
// The queries were not wrong for the path they were written on. They were wrong
// for the other one.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const registry = readFileSync("src/utils/tools/registry.server.ts", "utf8");
const sql = readFileSync("src/utils/tools/sql.server.ts", "utf8");
const swarm = readFileSync("src/utils/swarmExecute.server.ts", "utf8");

/** Strip comments — this file's own prose names every symbol it asserts on. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("the headless path really does disable RLS", () => {
  it("uses the service-role client with scopeUserId set", () => {
    // If this stopped being true the guards below would be belt-and-braces
    // rather than the boundary, and should be re-reasoned rather than kept.
    expect(code(swarm)).toContain("sb: supabaseAdmin as never, scopeUserId: userId");
  });

  it("still lets a swarm call MCP tools headlessly", () => {
    // The reason mcp_servers scoping matters at all.
    expect(code(swarm)).toContain('"mcp_call_tool"');
  });

  it("still lets a swarm search the web headlessly", () => {
    // The reason the Firecrawl integration read matters.
    expect(code(swarm)).toContain('"web_search"');
    expect(code(swarm)).toContain('"web_browse"');
  });
});

describe("ownership-only tables are scoped to the owner", () => {
  const c = code(registry);

  it("has one guard rather than six open-coded filters", () => {
    expect(c).toContain("function ownedBy<");
    expect(c).toContain('.eq("user_id", ctx.scopeUserId)');
    // A no-op on the RLS path, where the filter would be redundant.
    expect(c).toContain("if (!ctx.scopeUserId) return q;");
  });

  it("scopes the MCP server lookup — the privilege path", () => {
    const block = c.slice(c.indexOf("async function loadMcpServer"));
    expect(block.slice(0, 400)).toContain("ownedBy(");
    // Resolving by name alone is the bug.
    expect(block.slice(0, 400)).toContain('.eq("name", name)');
  });

  it("scopes every remaining ownership-only read", () => {
    for (const table of ["mcp_servers", "data_warehouse_connections", "integrations"]) {
      expect(c, `${table} is read somewhere`).toContain(`.from("${table}")`);
    }
    // Each read either goes through the guard or carries its own user filter.
    // Counted rather than spot-checked so a new unscoped read shows up here.
    const reads =
      c.match(/\.from\("(mcp_servers|data_warehouse_connections|integrations)"\)/g) ?? [];
    const guarded = (c.match(/ownedBy\(/g) ?? []).length;
    const selfScoped = (c.match(/\.eq\("user_id", ctx\.userId\)/g) ?? []).length;
    expect(reads.length).toBeGreaterThan(0);
    expect(guarded + selfScoped).toBeGreaterThanOrEqual(reads.length);
  });
});

describe("shared tables keep their sharing", () => {
  it("uses the sql_query visibility rule, not a naive user_id filter", () => {
    // user_data_tables is visible as own + public samples + IAM-granted.
    // Narrowing it to user_id would be "secure" and would also hide sample and
    // shared datasets the agent is entitled to query — a security fix that
    // silently removes a feature.
    expect(code(sql)).toContain("export async function scopeToVisibleTables");
    expect(code(sql)).toContain("is_sample.eq.true");
    expect(code(sql)).toContain('resolveGrantedResourceIds(ctx.sb, ctx.scopeUserId, "data_table")');
  });

  it("the tool description and the data path share one definition", () => {
    // Two copies of a visibility rule is how they drift, and the description is
    // the copy nobody tests.
    expect(code(registry)).toContain("scopeToVisibleTables(ctx, dtBase)");
    expect(code(sql)).toContain("scopeToVisibleTables(ctx, base)");
  });

  it("refuses rather than falls open when the scope is unusable", () => {
    // A malformed scopeUserId must not degrade to "no filter".
    expect(code(sql)).toContain("if (!UUID_RE.test(ctx.scopeUserId)) return null;");
  });

  it("still hides in-flight upload staging rows", () => {
    expect(code(registry)).toContain('.not("name", "like", "__upload_%")');
  });
});

describe("agent data access is governed and recorded", () => {
  const c = code(registry);
  const uiPath = code(readFileSync("src/routes/api/warehouse/query.ts", "utf8"));

  it("bills the agent's warehouse query to a tenant", () => {
    // The governor reads `userId ? gateFor(userId) : null`, so omitting it does
    // not merely skip a limit — it removes the per-user gate entirely. An agent
    // looping over rows could then consume the whole global budget while every
    // interactive user queued behind it.
    const block = c.slice(c.indexOf('handlers.set("warehouse_query"'));
    expect(block.slice(0, 900)).toContain("executeWarehouseQuery(conn.config, sqlText, 200, {");
    expect(block.slice(0, 900)).toContain("userId: c.userId");
  });

  it("records it, like the UI path already did", () => {
    // Automated queries are the ones nobody watches happen, so they are the
    // ones that most need a trail. This path had none.
    expect(uiPath, "the UI path is the precedent").toContain('action: "warehouse.query"');
    const block = c.slice(c.indexOf('handlers.set("warehouse_query"'));
    expect(block.slice(0, 900)).toContain('action: "warehouse.query"');
    expect(block.slice(0, 900)).toContain('via: "agent_tool"');
  });

  it("says which agent ran it", () => {
    // Otherwise the row says a user queried a warehouse and cannot say what
    // was acting for them.
    const block = c.slice(c.indexOf('handlers.set("warehouse_query"'));
    expect(block.slice(0, 900)).toContain("agent_id: c.agentId ?? null");
  });
});
