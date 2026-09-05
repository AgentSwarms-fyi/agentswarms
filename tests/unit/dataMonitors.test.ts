// Data monitors: standing checks on tables with learned baselines and
// incidents. What is pinned here is the pure half - how each check is asked
// and judged, with a failing case beside every passing one - and the wiring
// that makes a monitor governed: audited definitions, alerts and
// resolutions, a sweep shared with the other schedulers, an agent tool that
// re-derives its scope from the run's owner, and docs that say the same.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  MONITOR_KINDS,
  ageMinutes,
  baselineOf,
  buildMonitorSql,
  defaultMonitorName,
  evaluateMonitor,
  isAnomalous,
  quoteIdent,
  schemaDiff,
  validateMonitorConfig,
} from "@/utils/dataMonitors/core";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

describe("what a check asks the table", () => {
  it("quotes identifiers so a hostile column name cannot escape", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
    const sql = buildMonitorSql("freshness", { column: 'x"; DROP TABLE t; --' }, "s", "t");
    expect(sql).toBe('SELECT max("x""; DROP TABLE t; --") AS value FROM "s"."t"');
  });

  it("builds one portable statement per kind", () => {
    expect(buildMonitorSql("volume", {}, "analytics", "revenue_facts")).toBe(
      'SELECT count(*) AS value FROM "analytics"."revenue_facts"',
    );
    expect(buildMonitorSql("nulls", { column: "plan" }, "a", "t")).toContain(
      'sum(CASE WHEN "plan" IS NULL THEN 1 ELSE 0 END) / nullif(count(*), 0)',
    );
    expect(buildMonitorSql("uniqueness", { columns: ["order_id", "line"] }, "a", "t")).toBe(
      'SELECT (SELECT count(*) FROM "a"."t") - (SELECT count(*) FROM (SELECT DISTINCT "order_id", "line" FROM "a"."t") AS d) AS value',
    );
    expect(buildMonitorSql("custom_sql", { sql: "select 1 ; " }, "a", "t")).toBe("select 1");
    expect(buildMonitorSql("schema", {}, "it's", "t")).toContain("table_schema = 'it''s'");
    expect(buildMonitorSql("schema", {}, "a", "t")).not.toMatch(/date_diff|now\(\)/); // portable
  });

  it("refuses a configuration that cannot run, and says what to fix", () => {
    expect(validateMonitorConfig("freshness", { column: "ts", max_age_minutes: 60 })).toBeNull();
    expect(validateMonitorConfig("freshness", { max_age_minutes: 60 })).toContain(
      "timestamp column",
    );
    expect(validateMonitorConfig("freshness", { column: "ts", max_age_minutes: 0 })).toContain(
      "maximum age",
    );
    expect(validateMonitorConfig("volume", { anomaly: true })).toBeNull();
    expect(validateMonitorConfig("volume", {})).toContain("bounds, or anomaly");
    expect(validateMonitorConfig("volume", { min_rows: 10, max_rows: 5 })).toContain(
      "above maximum",
    );
    expect(validateMonitorConfig("nulls", { column: "c", max_null_pct: 5 })).toBeNull();
    expect(validateMonitorConfig("nulls", { column: "c", max_null_pct: 101 })).toContain(
      "between 0 and 100",
    );
    expect(validateMonitorConfig("uniqueness", { columns: [] })).toContain("at least one column");
    expect(validateMonitorConfig("custom_sql", { sql: "DELETE FROM t", max: 0 })).toContain(
      "SELECT",
    );
    expect(validateMonitorConfig("custom_sql", { sql: "select 1; select 2", max: 0 })).toContain(
      "one statement",
    );
    expect(validateMonitorConfig("custom_sql", { sql: "select 1" })).toContain(
      "minimum, a maximum",
    );
    expect(
      validateMonitorConfig("custom_sql", { sql: "with x as (select 1) select * from x", max: 0 }),
    ).toBeNull();
    expect(validateMonitorConfig("schema", {})).toBeNull();
    expect([...MONITOR_KINDS]).toEqual([
      "freshness",
      "volume",
      "schema",
      "nulls",
      "uniqueness",
      "custom_sql",
    ]);
  });
});

describe("how an answer is judged", () => {
  it("freshness: age against the limit, and an empty column is an alert", () => {
    const ok = evaluateMonitor({
      kind: "freshness",
      config: { column: "ts", max_age_minutes: 120 },
      value: 30,
      latest: "2026-09-06T00:00:00Z",
    });
    expect(ok.status).toBe("ok");
    expect(ok.message).toContain("30 min old");
    const late = evaluateMonitor({
      kind: "freshness",
      config: { column: "ts", max_age_minutes: 120 },
      value: 121,
    });
    expect(late.status).toBe("alert");
    expect(late.message).toContain("limit is 2.0 h");
    expect(
      evaluateMonitor({
        kind: "freshness",
        config: { column: "ts", max_age_minutes: 120 },
        value: null,
      }).status,
    ).toBe("alert");
    expect(ageMinutes("2020-01-01T00:00:00Z", new Date("2020-01-01T01:30:00Z"))).toBe(90);
    expect(ageMinutes("not a date")).toBeNull();
    expect(ageMinutes(null)).toBeNull();
  });

  it("volume: bounds first, then the learned baseline on the judged value", () => {
    const b = baselineOf([100, 110, 90, 105, 95], 3);
    expect(b).not.toBeNull();
    expect(b?.n).toBe(5);
    expect(baselineOf([1, 2, 3, 4], 3)).toBeNull(); // four runs is not a history
    expect(evaluateMonitor({ kind: "volume", config: { min_rows: 1000 }, value: 900 }).status).toBe(
      "alert",
    );
    expect(
      evaluateMonitor({ kind: "volume", config: { max_rows: 1000 }, value: 1001 }).message,
    ).toContain("above the maximum");
    // delta mode judges rows added since the last run
    const spike = evaluateMonitor({
      kind: "volume",
      config: { mode: "delta", anomaly: true },
      value: 5000,
      previousValue: 1000,
      baseline: b,
    });
    expect(spike.status).toBe("alert");
    expect(spike.message).toContain("4,000 rows added since the last run");
    const usual = evaluateMonitor({
      kind: "volume",
      config: { mode: "delta", anomaly: true },
      value: 1100,
      previousValue: 1000,
      baseline: b,
    });
    expect(usual.status).toBe("ok");
    expect(usual.message).toBe("1,100 rows, +100 since the last run.");
    // anomaly off: the same spike passes
    expect(
      evaluateMonitor({
        kind: "volume",
        config: { mode: "delta", anomaly: false },
        value: 5000,
        previousValue: 1000,
        baseline: b,
      }).status,
    ).toBe("ok");
    // total mode judges the count itself
    expect(
      evaluateMonitor({
        kind: "volume",
        config: { mode: "total", anomaly: true },
        value: 100,
        baseline: b,
      }).status,
    ).toBe("ok");
    expect(
      evaluateMonitor({
        kind: "volume",
        config: { mode: "total", anomaly: true },
        value: 10,
        baseline: b,
      }).status,
    ).toBe("alert");
  });

  it("anomaly: three sigma, a flat history flags any change, jitter is floored", () => {
    const b = { mean: 100, std: 10, n: 7, sigma: 3 };
    expect(isAnomalous(129, b)).toBe(false);
    expect(isAnomalous(131, b)).toBe(true);
    expect(isAnomalous(69, b)).toBe(true);
    expect(isAnomalous(500, null)).toBe(false);
    const flat = { mean: 1000, std: 0, n: 7, sigma: 3 };
    expect(isAnomalous(1000, flat)).toBe(false);
    expect(isAnomalous(1020, flat)).toBe(false); // within the 1% floor x 3
    expect(isAnomalous(1031, flat)).toBe(true);
  });

  it("nulls, uniqueness and custom SQL: limits with a failing case each", () => {
    expect(
      evaluateMonitor({ kind: "nulls", config: { column: "c", max_null_pct: 5 }, value: 4.9 })
        .status,
    ).toBe("ok");
    expect(
      evaluateMonitor({ kind: "nulls", config: { column: "c", max_null_pct: 5 }, value: 5.1 })
        .message,
    ).toContain("5.1% of c is null; the limit is 5%");
    expect(
      evaluateMonitor({ kind: "uniqueness", config: { columns: ["id"] }, value: 0 }).message,
    ).toBe("No duplicates on (id).");
    expect(
      evaluateMonitor({ kind: "uniqueness", config: { columns: ["id"] }, value: 1 }).message,
    ).toBe("1 duplicate row on (id).");
    expect(
      evaluateMonitor({ kind: "custom_sql", config: { sql: "x", max: 0 }, value: 0 }).status,
    ).toBe("ok");
    expect(
      evaluateMonitor({ kind: "custom_sql", config: { sql: "x", max: 0 }, value: 3 }).status,
    ).toBe("alert");
    expect(
      evaluateMonitor({ kind: "custom_sql", config: { sql: "x", min: 1 }, value: 0 }).message,
    ).toContain("below the minimum");
    expect(
      evaluateMonitor({ kind: "custom_sql", config: { sql: "x", max: 0 }, value: null }).status,
    ).toBe("alert");
  });

  it("schema: the first run is the baseline, and every kind of change is named", () => {
    const cols = [
      { name: "id", type: "BIGINT" },
      { name: "amount", type: "DOUBLE" },
    ];
    const first = evaluateMonitor({
      kind: "schema",
      config: {},
      value: 2,
      columns: cols,
      previousColumns: null,
    });
    expect(first.status).toBe("ok");
    expect(first.message).toContain("baseline");
    const same = evaluateMonitor({
      kind: "schema",
      config: {},
      value: 2,
      columns: cols,
      previousColumns: cols,
    });
    expect(same.status).toBe("ok");
    const changed = evaluateMonitor({
      kind: "schema",
      config: {},
      value: 2,
      columns: [
        { name: "id", type: "VARCHAR" },
        { name: "region", type: "VARCHAR" },
      ],
      previousColumns: cols,
    });
    expect(changed.status).toBe("alert");
    expect(changed.message).toBe(
      "Schema changed: added region; removed amount; retyped id (BIGINT → VARCHAR).",
    );
    expect(schemaDiff(null, cols)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("names a monitor from what it watches", () => {
    expect(defaultMonitorName("freshness", "orders", { max_age_minutes: 60 })).toBe(
      "orders · fresh within 60 min",
    );
    expect(defaultMonitorName("uniqueness", "orders", { columns: ["id", "line"] })).toBe(
      "orders · unique (id, line)",
    );
  });
});

describe("a monitor is governed like everything else", () => {
  it("the tables carry owner policies, a definition-only audit trigger and one open incident per monitor", () => {
    const sql = rd("supabase/migrations/20260864000000_data_monitors.sql");
    for (const t of ["data_monitors", "data_monitor_runs", "data_incidents"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${t}`);
      expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("EXECUTE FUNCTION public.audit_row_change('data_monitor')");
    expect(sql).toMatch(/AFTER INSERT OR DELETE OR UPDATE OF\s+name, source_kind/);
    expect(sql).not.toMatch(/UPDATE OF[^;]*last_status/);
    expect(sql).toContain("data_incidents_one_open_idx");
    expect(sql).toContain("WHERE status <> 'resolved'");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS data_monitors_per_sweep integer");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS data_monitor_anomaly_sigma double precision");
  });

  it("the runner audits alerts and resolutions, notifies once each way, and never fails the sweep", () => {
    const run = rd("src/utils/dataMonitors/run.server.ts");
    expect(run).toContain('action: "data.monitor.alert"');
    expect(run).toContain('action: "data.incident.resolved"');
    expect(run).toContain('auditVia: "data_monitor"');
    expect(run).toContain("useCache: false");
    expect(run).toContain('resolved_by: "run"');
    expect(run).toContain("title: `Recovered: ${m.name}`");
    expect((run.match(/await notifyUser\(/g) ?? []).length).toBe(2);
    expect(run).toContain('claim.select("id")');
    expect(run).toContain("if (!won?.length) continue;");
  });

  it("a lakehouse schema check reads the governed catalog listing, not information_schema", () => {
    // The per-user statement guard refuses information_schema (it is not a
    // user schema), so the check would error on every run if it went through
    // runLakehouseStatement. The listing does the same access check first.
    const run = rd("src/utils/dataMonitors/run.server.ts");
    expect(run).toContain('if (m.source_kind === "lakehouse" && kind === "schema") {');
    expect(run).toContain("await listLakehouseTablesForUser(m.user_id)");
    expect(run).toContain("t.schema === m.schema_name && t.table === m.table_name");
    const lakehouseSchema = run.indexOf(
      'if (m.source_kind === "lakehouse" && kind === "schema") {',
    );
    const statement = run.indexOf("await runLakehouseStatement(m.user_id, sql, {");
    expect(lakehouseSchema).toBeGreaterThan(0);
    expect(lakehouseSchema).toBeLessThan(statement);
    expect(rd("src/utils/dataMonitors.functions.ts").replace(/\s+/g, " ")).toContain(
      'action: data.action === "acknowledge" ? "data.incident.acknowledged" : "data.incident.resolved"',
    );
  });

  it("the sweep runs due monitors after the ML schedules, and the defaults are settings first", () => {
    expect(rd("src/utils/etl/schedule.server.ts")).toContain("m.processDueDataMonitors(force)");
    const cfg = rd("src/utils/notebookRuntime/config.server.ts");
    expect(cfg).toContain('envInt("DATA_MONITORS_PER_SWEEP")');
    expect(cfg).toContain('envNum("DATA_MONITOR_ANOMALY_SIGMA")');
    expect(rd("src/components/admin/RuntimeTab.tsx")).toContain(
      'set("data_monitors_per_sweep", n)',
    );
  });

  it("agents get a data_health tool that re-derives its scope from the run's owner", () => {
    const registry = rd("src/utils/tools/registry.server.ts");
    expect(registry).toContain('"data_health",');
    expect(registry).toContain('if (allows("data_health")) {');
    expect(registry).toContain("ctx.scopeUserId ?? ctx.userId");
    expect(rd("src/utils/tools/agentToggles.ts")).toContain(
      'if (t.data_health) out.push("data_health");',
    );
    expect(rd("src/components/agents/AgentForm.tsx")).toContain('id: "data_health",');
    const chat = rd("src/routes/api/chat.ts");
    const block = chat.slice(
      chat.indexOf("const HEADLESS_AGENT_TOOL_ALLOW = new Set<ToolableId>(["),
      chat.indexOf("]);", chat.indexOf("const HEADLESS_AGENT_TOOL_ALLOW")),
    );
    expect(block).toContain('"data_health"');
  });

  it("the page, the nav and the docs exist and agree", () => {
    expect(existsSync(path.join(REPO, "src/routes/_authenticated/data-monitors.tsx"))).toBe(true);
    expect(rd("src/lib/appNav.ts")).toContain('url: "/data-monitors"');
    expect(rd("src/components/docs/DocsShell.tsx")).toContain('to: "/docs/data-monitors"');
    for (const f of ["docs/DATA_MONITORS.md", "src/routes/docs.data-monitors.tsx"]) {
      const doc = rd(f).replace(/\s+/g, " ");
      for (const phrase of [
        "Freshness",
        "learned",
        "five",
        "Acknowledge",
        "data.monitor.alert",
        "DATA_MONITORS_PER_SWEEP",
        "Data health",
      ]) {
        expect(doc, `${f}: ${phrase}`).toContain(phrase);
      }
    }
    expect(rd("README.md")).toContain("./docs/DATA_MONITORS.md");
    expect(rd(".env.example")).toContain("DATA_MONITOR_ANOMALY_SIGMA=");
    expect(rd("docs/SCALE_AND_LIMITS.md")).toContain("`DATA_MONITORS_PER_SWEEP`");
  });
});
