// Import a dbt project's models into the semantic layer.
//
// dbt writes `target/manifest.json` on every `dbt compile`/`run`/`docs
// generate`: every model, its columns, its documented descriptions, and — in
// dbt 1.6+ — its semantic models and measures. A team that already runs dbt has
// spent months writing that metadata, and asking them to retype it into a form
// is the reason "define your metrics in our UI" loses to a YAML file in git.
//
// THE RULE THIS FILE IS BUILT AROUND: an import reports what it could not take.
// A manifest is large and messy — undocumented models, ephemeral models with no
// table behind them, aggregations this layer has no equivalent for — and the
// tempting shape is to filter those out and announce a clean number. That
// number is a lie of omission: the user cannot tell "dbt has 18 models and I
// imported 12" from "dbt has 12 models". Every skip carries a reason, and the
// caller shows them.
//
// Nothing here writes. It turns a manifest into PROPOSED models, and the caller
// decides what to save — because an import that silently replaced a certified
// model would destroy exactly the definition someone had validated.

import type {
  MetricAgg,
  SemanticDimension,
  SemanticFieldType,
  SemanticMetric,
  SemanticModel,
} from "@/lib/semanticLayer";

/** Names this layer can use as SQL aliases, matching semanticLayer's IDENT_RE. */
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Something present in the manifest that did not become part of the import. */
export type DbtSkip = {
  kind: "model" | "metric" | "column";
  /** How it is named in the manifest, so the user can go and find it. */
  ref: string;
  /** Why it could not be imported, in terms the user can act on. */
  reason: string;
};

export type DbtImportResult = {
  /** What the manifest says about itself — shown so the user can confirm the
   *  file is the project and the run they meant. */
  project: {
    name?: string;
    dbtVersion?: string;
    adapter?: string;
    generatedAt?: string;
  };
  /** Totals PRESENT in the manifest, so `models.length` can be read against
   *  them. Reporting only what was imported hides the denominator. */
  counts: { models: number; metrics: number; semanticModels: number };
  /** Proposed models. Nothing is saved until the caller says so. */
  models: SemanticModel[];
  skipped: DbtSkip[];
};

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * dbt's `data_type` → this layer's field type.
 *
 * ABSENT MEANS ABSENT. `data_type` is only populated when the project has run
 * `dbt docs generate` against a live warehouse, so most manifests carry none —
 * and defaulting those to "categorical" would label every numeric column as a
 * dimension you can group by. An unset type is what the semantic editor already
 * handles; a wrong one is what nobody checks.
 */
export function dbtFieldType(dataType: string | undefined): SemanticFieldType | undefined {
  const t = dataType?.toLowerCase().trim();
  if (!t) return undefined;
  // Strip parameters, then match on the LEADING WORD. Warehouses spell these
  // with trailing modifiers — "timestamp with time zone", "timestamp(6) with
  // time zone", "double precision", "character varying" — and an anchored
  // whole-string match silently returns undefined for the most common
  // Postgres/Redshift timestamp spelling there is.
  const base = t.replace(/\([^)]*\)/g, " ").trim();
  const head = base.split(/\s+/)[0] ?? "";

  if (/^(bool|boolean|bit)$/.test(head)) return "boolean";
  if (
    /^(date|datetime|time|timestamp|timestamptz|timestampltz|timestamp_ntz|timestamp_tz|timestamp_ltz)$/.test(
      head,
    )
  )
    return "time";
  if (
    /^(int|int2|int4|int8|integer|bigint|smallint|tinyint|numeric|decimal|float|float4|float8|double|real|number|money|byteint)$/.test(
      head,
    )
  )
    return "number";
  if (
    /^(varchar|char|character|string|text|nvarchar|nchar|uuid|json|jsonb|variant|object)$/.test(
      head,
    )
  )
    return "categorical";
  // A type we do not recognise (arrays, structs, geography). Unset rather than
  // guessed — see above.
  return undefined;
}

/**
 * Aggregations dbt can express → aggregations this layer can compile.
 *
 * Returns null for the ones with no equivalent, and the caller reports the
 * metric as skipped BY NAME. Silently coercing `percentile` to `avg` would
 * produce a governed metric that is confidently the wrong number — the exact
 * failure the semantic layer exists to prevent.
 */
export function dbtAggToMetricAgg(agg: string | undefined): MetricAgg | null {
  switch (agg?.toLowerCase().trim()) {
    case "sum":
      return "sum";
    case "avg":
    case "average":
      return "avg";
    case "count":
      return "count";
    case "count_distinct":
    case "distinct_count":
      return "count_distinct";
    case "min":
      return "min";
    case "max":
      return "max";
    default:
      return null;
  }
}

/**
 * The FROM target for a dbt node.
 *
 * Built from database/schema/alias rather than from `relation_name`, which dbt
 * has already quoted for its own adapter (`"prod"."analytics"."orders"` on
 * Snowflake, backticks on BigQuery). Those quotes are the wrong ones for
 * whichever dialect this model ends up compiling to, and assertTableRef would
 * reject them anyway.
 */
export function dbtRelation(node: Json): string | null {
  const alias = str(node.alias) ?? str(node.name);
  if (!alias || !IDENT_RE.test(alias)) return null;

  const schema = str(node.schema);
  const database = str(node.database);
  const usable = (p: string | undefined): p is string => !!p && IDENT_RE.test(p);

  // QUALIFICATION MUST BE A CONTIGUOUS SUFFIX. Dropping an unusable database
  // and keeping `schema.table` is fine — it resolves in the session's current
  // database, which is where dbt put it. Dropping an unusable SCHEMA and
  // keeping `database.table` is not: a two-part reference reads as
  // schema.table on every dialect here, so `prod.orders` would silently point
  // at a table in a schema called "prod". Filtering the parts independently
  // produces exactly that, which is why this walks inwards instead.
  if (!usable(schema)) return alias;
  if (!usable(database)) return `${schema}.${alias}`;
  return `${database}.${schema}.${alias}`;
}

/** Lightdash-style `meta.metrics` — the shape a Lightdash user already has. */
function metricsFromMeta(
  meta: Json | null,
  columnSql: string | undefined,
  ref: string,
  out: SemanticMetric[],
  skipped: DbtSkip[],
): void {
  const metrics = obj(meta?.metrics);
  if (!metrics) return;
  for (const [name, rawDef] of Object.entries(metrics)) {
    const def = obj(rawDef) ?? {};
    if (!IDENT_RE.test(name)) {
      skipped.push({
        kind: "metric",
        ref: `${ref}.${name}`,
        reason: "Metric name is not a valid identifier (letters, digits, underscore).",
      });
      continue;
    }
    const type = str(def.type);
    const agg = dbtAggToMetricAgg(type);
    if (!agg) {
      skipped.push({
        kind: "metric",
        ref: `${ref}.${name}`,
        reason: `Aggregation "${type ?? "unset"}" has no equivalent here — define it as a custom metric instead.`,
      });
      continue;
    }
    const sql = str(def.sql) ?? columnSql;
    if (agg !== "count" && !sql) {
      skipped.push({
        kind: "metric",
        ref: `${ref}.${name}`,
        reason: `${agg} needs a column or expression, and the metric declares none.`,
      });
      continue;
    }
    out.push({
      name,
      label: str(def.label),
      description: str(def.description),
      agg,
      ...(sql ? { sql } : {}),
      ...(Array.isArray(def.filters) && def.filters.length
        ? // dbt filters are structured ({field, operator, value}); this layer
          // wants a boolean SQL fragment. Rather than translate operators —
          // and get one subtly wrong — the metric imports UNFILTERED and the
          // filter is reported, so nobody inherits a silently wider number.
          {}
        : {}),
    });
    if (Array.isArray(def.filters) && def.filters.length) {
      skipped.push({
        kind: "metric",
        ref: `${ref}.${name}`,
        reason:
          "Imported WITHOUT its dbt filters — re-add them as filters on the metric, or the number will be wider than dbt's.",
      });
    }
  }
}

/**
 * Turn a parsed manifest into proposed semantic models.
 *
 * `connectionId` is the warehouse connection these tables live in: a dbt model
 * is a table in the project's target warehouse, so importing it against the
 * wrong connection would produce models that compile and then fail to run.
 */
export function parseDbtManifest(raw: unknown, opts: { connectionId: string }): DbtImportResult {
  const root = obj(raw);
  const nodes = obj(root?.nodes);
  if (!root || !nodes) {
    // Being specific about WHAT was expected turns "invalid file" into
    // something the user can fix — usually they picked run_results.json or
    // catalog.json, which sit in the same directory.
    throw new Error(
      "That file has no `nodes` object, so it is not a dbt manifest. Look for target/manifest.json (not run_results.json or catalog.json).",
    );
  }

  const metadata = obj(root.metadata) ?? {};
  const skipped: DbtSkip[] = [];
  const models: SemanticModel[] = [];

  const semanticModels = obj(root.semantic_models) ?? {};
  const metricNodes = obj(root.metrics) ?? {};

  // MetricFlow measures, keyed by the model they belong to, so a model can
  // pick up the measures dbt already declared for it.
  const measuresByModel = new Map<string, SemanticMetric[]>();
  for (const [uid, rawSm] of Object.entries(semanticModels)) {
    const sm = obj(rawSm);
    if (!sm) continue;
    // `model` is a ref string: "ref('orders')".
    const target = str(sm.model)?.match(/ref\(\s*['"]([^'"]+)['"]\s*\)/)?.[1];
    if (!target) {
      skipped.push({
        kind: "metric",
        ref: str(sm.name) ?? uid,
        reason:
          "Semantic model does not name a dbt model with ref(), so its measures cannot be placed.",
      });
      continue;
    }
    const list = measuresByModel.get(target) ?? [];
    for (const rawMeasure of Array.isArray(sm.measures) ? sm.measures : []) {
      const m = obj(rawMeasure);
      const name = str(m?.name);
      if (!name || !IDENT_RE.test(name)) {
        skipped.push({
          kind: "metric",
          ref: `${str(sm.name) ?? uid}.${name ?? "(unnamed)"}`,
          reason: "Measure name is missing or not a valid identifier.",
        });
        continue;
      }
      const agg = dbtAggToMetricAgg(str(m?.agg));
      if (!agg) {
        skipped.push({
          kind: "metric",
          ref: `${str(sm.name) ?? uid}.${name}`,
          reason: `Aggregation "${str(m?.agg) ?? "unset"}" has no equivalent here — define it as a custom metric instead.`,
        });
        continue;
      }
      const expr = str(m?.expr) ?? name;
      list.push({
        name,
        label: str(m?.label),
        description: str(m?.description),
        agg,
        ...(agg === "count" && !str(m?.expr) ? {} : { sql: expr }),
      });
    }
    measuresByModel.set(target, list);
  }

  let modelCount = 0;
  for (const [uid, rawNode] of Object.entries(nodes)) {
    const node = obj(rawNode);
    if (!node) continue;
    const rt = str(node.resource_type);
    // Seeds are real tables too; tests, snapshots, analyses and operations
    // are not things you build metrics on.
    if (rt !== "model" && rt !== "seed") continue;
    modelCount++;

    const name = str(node.name) ?? uid;
    const config = obj(node.config) ?? {};
    const materialized = str(config.materialized) ?? str(node.materialized);

    // AN EPHEMERAL MODEL HAS NO TABLE. dbt inlines it as a CTE at compile
    // time, so a semantic model pointed at it would compile here and fail in
    // the warehouse with "relation does not exist" — the worst kind of import,
    // one that looks successful.
    if (materialized === "ephemeral") {
      skipped.push({
        kind: "model",
        ref: name,
        reason: "Materialized as ephemeral, so dbt never creates a table for it.",
      });
      continue;
    }

    if (!IDENT_RE.test(name)) {
      skipped.push({
        kind: "model",
        ref: name,
        reason: "Model name is not a valid identifier (letters, digits, underscore).",
      });
      continue;
    }

    const relation = dbtRelation(node);
    if (!relation) {
      skipped.push({
        kind: "model",
        ref: name,
        reason: "Could not build a safe table reference from its database/schema/alias.",
      });
      continue;
    }

    const columns = obj(node.columns) ?? {};
    const dimensions: SemanticDimension[] = [];
    const metrics: SemanticMetric[] = [...(measuresByModel.get(name) ?? [])];
    let primaryKey: string | undefined;

    for (const [colKey, rawCol] of Object.entries(columns)) {
      const col = obj(rawCol) ?? {};
      const colName = str(col.name) ?? colKey;
      if (!IDENT_RE.test(colName)) {
        skipped.push({
          kind: "column",
          ref: `${name}.${colName}`,
          reason: "Column name needs quoting, which this layer's field names do not allow.",
        });
        continue;
      }
      const meta = obj(col.meta);
      // A column marked as the grain feeds fan-out refusal, which is the whole
      // reason to know it — so it is worth reading from either convention.
      if (meta?.primary_key === true || obj(meta?.dimension)?.primary_key === true) {
        primaryKey = colName;
      }
      dimensions.push({
        name: colName,
        ...(str(obj(meta?.dimension)?.label) ? { label: str(obj(meta?.dimension)?.label) } : {}),
        ...(str(col.description) ? { description: str(col.description) } : {}),
        sql: colName,
        ...((): { type?: SemanticFieldType } => {
          const t = dbtFieldType(str(col.data_type));
          return t ? { type: t } : {};
        })(),
      });
      metricsFromMeta(meta, colName, name, metrics, skipped);
    }

    // Model-level metrics (Lightdash allows them outside a column).
    metricsFromMeta(obj(node.meta), undefined, name, metrics, skipped);

    const modelMeta = obj(node.meta);
    const declaredPk = str(modelMeta?.primary_key);
    if (declaredPk && IDENT_RE.test(declaredPk)) primaryKey = declaredPk;

    // A MODEL WITH NO DOCUMENTED COLUMNS IS NOT AN IMPORT, IT IS AN EMPTY
    // SHELL. dbt only lists columns that appear in schema.yml, so an
    // undocumented project yields models with nothing in them. Importing those
    // would fill the semantic layer with entries that cannot answer anything,
    // and the count would say it worked.
    if (dimensions.length === 0) {
      skipped.push({
        kind: "model",
        ref: name,
        reason:
          "No documented columns in the manifest — describe them in schema.yml and re-run dbt.",
      });
      continue;
    }

    models.push({
      name,
      ...(str(node.description) ? { description: str(node.description) } : {}),
      source: { kind: "warehouse", connectionId: opts.connectionId, table: relation },
      ...(primaryKey ? { primaryKey } : {}),
      dimensions,
      metrics,
      // Imported models start as drafts, always. Certification means "the
      // validation pipeline ran clean against the live source", and nothing
      // has run yet.
      status: "draft",
    });
  }

  // dbt's pre-1.6 `metrics:` nodes are a different shape entirely (they
  // reference a model and carry their own filters). Reported rather than
  // parsed, so a user on an older project is told why their metrics are
  // missing instead of concluding the import lost them.
  for (const [uid, rawMetric] of Object.entries(metricNodes)) {
    const m = obj(rawMetric);
    if (!m) continue;
    // MetricFlow-era metrics reference measures that are already imported.
    if (str(m.type) || obj(m.type_params)) continue;
    skipped.push({
      kind: "metric",
      ref: str(m.name) ?? uid,
      reason:
        "Legacy dbt metric (pre-1.6). Re-declare it as a MetricFlow measure, or add it by hand.",
    });
  }

  return {
    project: {
      name: str(root.project_name) ?? str(metadata.project_name),
      dbtVersion: str(metadata.dbt_version),
      adapter: str(metadata.adapter_type),
      generatedAt: str(metadata.generated_at),
    },
    counts: {
      models: modelCount,
      metrics: Object.keys(metricNodes).length,
      semanticModels: Object.keys(semanticModels).length,
    },
    models,
    skipped,
  };
}

/**
 * One line summarising an import, for a toast or a header.
 *
 * States the denominator whenever anything was skipped. "Imported 12 models"
 * reads as completeness; "12 of 18" is the same fact without the implication.
 */
export function describeImport(result: DbtImportResult): string {
  const got = result.models.length;
  const total = result.counts.models;
  const head =
    got === total
      ? `${got} model${got === 1 ? "" : "s"}`
      : `${got} of ${total} model${total === 1 ? "" : "s"}`;
  const metrics = result.models.reduce((n, m) => n + m.metrics.length, 0);
  const parts = [head, `${metrics} metric${metrics === 1 ? "" : "s"}`];
  if (result.skipped.length)
    parts.push(`${result.skipped.length} item${result.skipped.length === 1 ? "" : "s"} skipped`);
  return parts.join(" · ");
}

/**
 * Names that already exist in the semantic layer.
 *
 * An import must never quietly replace a model someone certified, so the
 * caller marks these and defaults them to "skip". Returned as a set of names
 * rather than resolved here, because what to do about a collision is the
 * user's call, not this module's.
 */
export function collidingNames(result: DbtImportResult, existing: string[]): Set<string> {
  const have = new Set(existing.map((n) => n.toLowerCase()));
  return new Set(result.models.map((m) => m.name).filter((n) => have.has(n.toLowerCase())));
}
