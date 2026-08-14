// Where an answer's numbers came from.
//
// The analyst already shows its SQL, so "lineage" here is not about revealing
// a hidden query — it is about the two things the SQL alone does not tell a
// reader: which physical tables were actually touched, and what stands behind
// those tables upstream (a prep flow's inputs, a warehouse's own lineage).
//
// TABLES COME FROM THE SQL THAT RAN, NEVER FROM THE MODEL DEFINITION. A
// governed step's SQL was compiled from a semantic model, so it is tempting to
// read the model and report its source table. But models are edited, and a
// panel that describes a step using today's definition would quietly
// misdescribe a query that ran against yesterday's. The SQL is the only
// artefact that cannot have drifted from what produced the numbers. This is
// the same rule the verification fingerprint follows, for the same reason.
//
// AND A ROLLUP MEANS THE FACT TABLE WAS NOT READ. When aggregate awareness
// routes a query to a pre-aggregated table, naming the model's fact table as
// the source would be false. The routed table is in the SQL, so it is what
// gets reported — and the routing itself is called out, because "these numbers
// came from a rollup" is exactly the caveat a reader chasing a discrepancy
// needs.
import { extractTableRefs } from "@/lib/sqlRefs";
import type { AnalystStep } from "@/lib/aiAnalyst";
import type { AssetLineage, CatalogLineageEdge } from "@/lib/dataCatalog";

/**
 * Physical tables a query actually reads.
 *
 * The extraction lives in lib/sqlRefs, which every consumer asking "what did
 * this query touch?" now shares — the catalog lineage index, the
 * warehouse-query audit, the object-store query planner and this panel. Two
 * parsers drifting is how the Workbench and the catalog end up disagreeing
 * about the same query.
 */
export function sourceTablesFrom(sql: string): string[] {
  return extractTableRefs(sql ?? "");
}

/** Upstream of one table, from whatever evidence exists for it. */
export type TableOrigin = {
  table: string;
  /** Inputs a prep flow combined to produce this table. */
  derivedFrom: string[];
  /** Upstream tables the warehouse's own catalog records. */
  upstream: string[];
};

export type StepLineage = {
  /**
   * `compiled` — the SQL was generated from a governed model's definitions.
   * `written` — the model (or the user) wrote it, and no governed definition
   * vouches for the formulas in it.
   */
  basis: "compiled" | "written";
  /** The governed model, when one compiled this step. */
  model?: string;
  /** A rollup answered instead of the fact table — so the fact table was NOT read. */
  rollup?: string;
  /** Row filters / column masks applied for this viewer. */
  accessNote?: string;
  /** Hand-edited SQL: whatever it once was, it is the user's query now. */
  edited: boolean;
  /** Tables the SQL actually reads. */
  origins: TableOrigin[];
};

/**
 * What stands behind a step's numbers.
 *
 * `lineageIndex` and `catalogEdges` are passed in rather than loaded here so
 * this stays pure and the page can load them once for a whole thread.
 */
export function stepLineage(
  step: AnalystStep,
  opts?: {
    lineageIndex?: Map<string, AssetLineage>;
    catalogEdges?: CatalogLineageEdge[];
    /** Warehouse connection the step ran against, for keying the index. */
    connectionId?: string;
  },
): StepLineage {
  const tables = step.sql ? sourceTablesFrom(step.sql) : [];
  const origins = tables.map((table) => ({
    table,
    derivedFrom: derivedInputs(table, opts?.lineageIndex, opts?.connectionId),
    upstream: upstreamOf(table, opts?.catalogEdges),
  }));
  return {
    // An edited step is the user's SQL, whatever compiled the original. The
    // page already clears `governed` on edit; this does not rely on that.
    basis: step.governed && !step.edited ? "compiled" : "written",
    model: step.edited ? undefined : step.governed?.model,
    rollup: step.governed?.rollup,
    accessNote: step.governed?.accessNote,
    edited: Boolean(step.edited),
    origins,
  };
}

function derivedInputs(
  table: string,
  index?: Map<string, AssetLineage>,
  connectionId?: string,
): string[] {
  if (!index) return [];
  const keys = connectionId
    ? [`wh:${connectionId}:${table}`, `wh:${connectionId}:${table.split(".").pop()}`]
    : [];
  keys.push(`name:${table}`, `name:${table.split(".").pop()}`);
  const out = new Set<string>();
  for (const k of keys) for (const d of index.get(k)?.derivedFrom ?? []) out.add(d.toLowerCase());
  return [...out];
}

/** Match on the trailing two segments, the same key the catalog lineage uses. */
function shortKey(fqn: string): string {
  return fqn.toLowerCase().split(".").slice(-2).join(".");
}

function upstreamOf(table: string, edges?: CatalogLineageEdge[]): string[] {
  if (!edges?.length) return [];
  const key = shortKey(table);
  const out = new Set<string>();
  for (const e of edges) {
    if (shortKey(e.downstream_fqn) === key) out.add(e.upstream_fqn.toLowerCase());
  }
  return [...out];
}

/**
 * One line a reader can act on.
 *
 * Deliberately says nothing when there is nothing to say — a lineage panel
 * that always renders something teaches people to ignore it.
 */
export function describeLineage(l: StepLineage): string {
  const parts: string[] = [];
  if (l.origins.length) {
    parts.push(`Read ${l.origins.map((o) => o.table).join(", ")}`);
  }
  if (l.rollup) {
    parts.push(`answered from the rollup ${l.rollup}, not the fact table`);
  }
  if (l.basis === "compiled" && l.model) {
    parts.push(`compiled from the governed model ${l.model}`);
  }
  if (l.edited) {
    parts.push("SQL edited by hand, so no governed definition vouches for it");
  }
  if (l.accessNote) parts.push(l.accessNote);
  return parts.join(" · ");
}
