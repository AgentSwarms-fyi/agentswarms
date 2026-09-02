// One correlation key across everything a single answer touched.
//
// THE GAP THIS CLOSES. The platform already records every piece of an
// answer's lineage -- the model call (execution_traces), the data it read
// (audit_events: warehouse.query, dataset.query, data.objectstore_query), the
// approvals, the cost -- and nothing ties them together. Ask "where did this
// number come from?" and the rows exist, scattered, with no key in common.
//
// A "decision" is the top-level thing a person asks about: a chat turn, a
// swarm run, a dashboard refresh. Its id is stamped on every trace and audit
// row written while it was underway, and the decision row records the one
// fact that cannot be reconstructed later -- which lakehouse snapshot was
// current -- because DuckLake can re-run a query AT that snapshot.
//
// A passport with one silent hole is worse than none: an examiner who finds
// the hole distrusts the whole document. So the last block here COUNTS rather
// than spot-checks, and a new audit write inside a tool handler that forgets
// the id fails the build.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260848000000_decision_provenance.sql",
  "utf8",
);
const audit = readFileSync("src/utils/audit.server.ts", "utf8");
const registry = readFileSync("src/utils/tools/registry.server.ts", "utf8");
const chat = readFileSync("src/routes/api/chat.ts", "utf8");
const swarm = readFileSync("src/utils/swarmExecute.server.ts", "utf8");
const refresh = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
const decision = readFileSync("src/utils/provenance/decision.server.ts", "utf8");
const core = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");

/** Strip comments: this file's own prose names every symbol it asserts on. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("the schema", () => {
  it("adds the key to both evidence tables, indexed and nullable", () => {
    // Nullable is correct: an IAM change has nothing to correlate to.
    expect(migration).toContain(
      "ALTER TABLE public.audit_events ADD COLUMN IF NOT EXISTS decision_id uuid;",
    );
    expect(migration).toContain(
      "ALTER TABLE public.execution_traces ADD COLUMN IF NOT EXISTS decision_id uuid;",
    );
    expect(migration).toMatch(/audit_events_decision_idx[\s\S]*WHERE decision_id IS NOT NULL/);
    expect(migration).toMatch(/execution_traces_decision_idx[\s\S]*WHERE decision_id IS NOT NULL/);
  });

  it("records the lakehouse snapshot on the decision itself", () => {
    // The one fact that cannot be reconstructed afterwards.
    expect(migration).toContain("lakehouse_snapshot_id text");
    expect(migration).toMatch(/kind IN \('chat_turn', 'swarm_run', 'dashboard_refresh'\)/);
  });

  it("lets owners read and only the server write", () => {
    expect(migration).toContain("ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;");
    expect(migration).toMatch(
      /decisions_owner_read[\s\S]*FOR SELECT USING \(auth\.uid\(\) = user_id\)/,
    );
    expect(migration).not.toMatch(/decisions[\s\S]*FOR (ALL|INSERT)/);
  });
});

describe("minting", () => {
  it("adopts a natural uuid rather than inventing a second id", () => {
    // A chat turn IS its trace; a swarm run IS its run. Two ids for one thing
    // is how correlation keys drift apart.
    expect(code(decision)).toContain("args.id && UUID_RE.test(args.id) ? args.id : randomUUID()");
  });

  it("writes the row first and the snapshot second", () => {
    // Measured on a live instance: a cold lakehouse attach costs ~2s (26ms
    // warm). Waiting for it before inserting would mean the provenance row
    // appears seconds after the answer -- absent exactly when someone opens
    // the trace to look. So the row exists immediately and is upgraded to
    // reproducible after.
    const d = code(decision);
    const insertAt = d.indexOf("lakehouse_snapshot_id: null");
    const readAt = d.indexOf("await lakehouseSnapshotId()");
    expect(insertAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(-1);
    expect(insertAt, "the insert must come before the snapshot read").toBeLessThan(readAt);
    expect(d).toContain(".update({ lakehouse_snapshot_id: snapshot }");
  });

  it("captures the snapshot but never fails the answer over it", () => {
    expect(code(decision)).toContain("if (!lakehouseEnabled()) return;");
    expect(code(decision)).toMatch(/void \(async \(\) => \{/);
    expect(code(core)).toContain("export async function lakehouseSnapshotId()");
    // A missing snapshot is null, not an exception and not a fake value.
    expect(code(core)).toContain('return id.startsWith("nosnap") ? null : id;');
  });

  it("a chat turn begins a decision keyed by its trace id", () => {
    const c = code(chat);
    expect(c).toContain(
      'beginDecision({ userId, kind: "chat_turn", id: traceId, rootRef: traceId })',
    );
  });

  it("a swarm node turn adopts the run's decision instead of starting one", () => {
    // Otherwise every node inserts a decision row with the same id: a PK
    // conflict per node, and a run whose provenance is N ids rather than one.
    const c = code(chat);
    expect(c).toContain("body.decisionId && DECISION_ID_RE.test(body.decisionId)");
    expect(c).toContain("? body.decisionId");
  });

  it("a swarm run begins the decision once and hands it to every turn and tool", () => {
    const s = code(swarm);
    expect(s).toContain(
      'beginDecision({ userId: opts.userId, kind: "swarm_run", id: runId, rootRef: runId })',
    );
    expect(s).toContain("decisionId: args.runId ?? undefined");
    // Both data-tool contexts, not one.
    expect((s.match(/dataToolCtx\(opts\.userId, runId\)/g) ?? []).length).toBe(2);
  });

  it("a dashboard refresh is a decision too", () => {
    expect(code(refresh)).toContain('kind: "dashboard_refresh"');
  });
});

describe("stamping", () => {
  it("every trace row carries the decision", () => {
    expect(code(chat)).toContain("decision_id: trace.decisionId,");
  });

  it("audit events accept and write the key", () => {
    expect(code(audit)).toContain("decisionId?: string | null;");
    expect(code(audit)).toContain("decision_id: args.decisionId ?? null");
  });

  it("the tool context carries it to every tool", () => {
    const r = code(registry);
    expect(r).toContain("decisionId?: string;");
    // Chat threads it into the tool context it builds.
    expect(code(chat)).toContain("decisionId: trace.decisionId,");
  });

  it("no audit write in ANY tool module forgets it", () => {
    // COUNTED across every module a tool handler lives in, not spot-checked.
    // A data read that skips the key drops silently out of the answer's
    // provenance, and the passport then shows fewer sources than were used —
    // which is worse than showing none, because it still looks complete.
    //
    // The context variable is `c` in the registry's inline handlers and `ctx`
    // in the extracted modules, so both spellings count.
    const modules: Record<string, string> = {
      "registry.server.ts": code(registry),
      "sql.server.ts": code(readFileSync("src/utils/tools/sql.server.ts", "utf8")),
      "metric.server.ts": code(readFileSync("src/utils/tools/metric.server.ts", "utf8")),
    };
    let total = 0;
    for (const [name, src] of Object.entries(modules)) {
      for (const emit of src.match(/auditEvent\(\{[\s\S]*?\n\s*\}\);/g) ?? []) {
        total++;
        expect(emit, `${name}: an audit write omits decisionId:\n${emit}`).toMatch(
          /decisionId: (c|ctx)\.decisionId,/,
        );
      }
    }
    expect(total, "the tool layer audits its data reads").toBeGreaterThanOrEqual(3);
  });

  it("the answer's own audit row carries the decision", () => {
    // FOUND FROM THE UI. The trace showed the decision and its snapshot, and
    // the agent.chat row -- the record that the answer happened at all -- had
    // decision_id null. The most important row was the unstamped one.
    const c = code(chat);
    const block = c.slice(
      c.indexOf('action: "agent.chat"') - 300,
      c.indexOf('action: "agent.chat"') + 400,
    );
    expect(block).toContain("decisionId: trace.decisionId,");
  });

  it("automatic RAG retrieval is audited, not just the kb_search TOOL", () => {
    // FOUND FROM THE UI, and the reason unit tests alone were not enough. A
    // grounded agent does not call the kb_search tool: chat.ts retrieves
    // automatically before the model runs, so the tool's audit never fires.
    // The passport said "0 data reads" for an answer that had just searched a
    // knowledge base -- a hole that looks exactly like an honest zero.
    const c = code(chat);
    expect(c).toContain('action: "kb.search"');
    expect(c).toContain('via: "auto_rag"');
    const at = c.indexOf('via: "auto_rag"');
    expect(c.slice(at - 400, at)).toContain("decisionId: trace.decisionId,");
  });

  it("every data-reading tool leaves a trail, not just the warehouse one", () => {
    // sql_query, kb_search and metric_query each read data on the answer's
    // behalf and none of them wrote an audit row, so an answer grounded in a
    // dataset or a document reported "no data reads recorded".
    expect(code(readFileSync("src/utils/tools/sql.server.ts", "utf8"))).toContain(
      'action: "dataset.query"',
    );
    expect(code(registry)).toContain('action: "kb.search"');
    expect(code(readFileSync("src/utils/tools/metric.server.ts", "utf8"))).toContain(
      'action: "metric.query"',
    );
    expect(code(registry)).toContain('action: "warehouse.query"');
  });
});

describe("reading it back", () => {
  it("assembles traces and events by key, owner-scoped", () => {
    const d = code(decision);
    expect(d).toContain("export async function getDecisionChain(");
    expect(d).toContain('.eq("id", decisionId)');
    // Ownership on the decision row AND on each evidence table.
    expect((d.match(/\.eq\("user_id", userId\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("says honestly whether the answer can be reproduced", () => {
    // NULL snapshot = recorded, not reproducible. The passport must render
    // that distinction rather than imply replay is always possible.
    // Whitespace-tolerant: the expression is long enough for Prettier to wrap.
    expect(code(decision)).toMatch(
      /reproducible:\s*rec\.lakehouse_snapshot_id !== null\s*&&\s*!rec\.lakehouse_snapshot_id\.startsWith\("nosnap"\)/,
    );
  });
});
