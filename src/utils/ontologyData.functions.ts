// Server functions behind Data & BI -> Enterprise Ontology: the data.
//
// Exploring objects, one object and what it links to, the neighbourhood graph,
// metrics, the binding preview and profile, and rule runs. Every query is
// compiled from the model (src/lib/ontology/compile.ts) and run through the
// governed lakehouse path AS THE CALLER (src/utils/ontology/run.server.ts):
// their schema grants, the tables' tag policies and row filters, and their
// ontology share's own property masks and row filters all apply, and each
// statement lands in their Lakehouse history and the audit log marked
// `ontology:<what>`.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import {
  isFail,
  loadOntology,
  ontologyLimits,
  resolveCaller,
  type Fail,
  type OntologyAccess,
} from "@/utils/ontology/access.server";
import {
  friendlyLakehouseError,
  runCount,
  runRows,
  type Cell,
  type ObjectRow,
} from "@/utils/ontology/run.server";
import {
  compileGetObject,
  compileLinked,
  compileMetric,
  compileObjectSet,
  compileRule,
  CompileError,
  FILTER_OPS,
  impliedRules,
  isMasked,
  propertySql,
  TIME_GRAINS,
  typedLiteral,
  type ColumnMeta,
  type CompileOpts,
  type Scalar,
} from "@/lib/ontology/compile";
import { compileExpr, quoteIdent, sqlString } from "@/lib/ontology/expr";
import {
  allProperties,
  baseTypeOf,
  findObjectType,
  findProperty,
  linkReading,
  linksOf,
  TABLE_REF,
  titleOf,
  type ObjectType,
  type OntologyRule,
  type OntologySpec,
} from "@/lib/ontology/spec";

const token = z.string().min(1);
const id = z.string().uuid();
const scalar = z.union([z.string().max(1000), z.number(), z.boolean()]);
const filter = z.object({
  property: z.string().min(1).max(64),
  op: z.enum(FILTER_OPS),
  value: z.union([scalar, z.array(scalar).max(1000), z.null()]).optional(),
});
const step = z.object({
  link: z.string().min(1).max(64),
  direction: z.enum(["forward", "inverse"]),
});
const keySchema = z.record(z.string().max(64), scalar);

async function access(
  accessToken: string,
  ontologyId: string,
  need: "read" | "own" = "read",
): Promise<{ userId: string; a: OntologyAccess; opts: CompileOpts } | Fail> {
  const caller = await resolveCaller(accessToken);
  if (!caller.ok) return caller;
  const a = await loadOntology(caller.userId, ontologyId, need);
  if (isFail(a)) return a;
  const { maxRows } = await ontologyLimits();
  return {
    userId: caller.userId,
    a,
    opts: { seeRestricted: a.role === "owner", maxRows, ...(a.policy ? { policy: a.policy } : {}) },
  };
}

function failFrom(e: unknown): Fail {
  if (e instanceof CompileError) return { ok: false, error: e.message };
  return { ok: false, error: friendlyLakehouseError(e) };
}

// ── Object sets ─────────────────────────────────────────────────────────────

export type ObjectSetResult = {
  ok: true;
  objectType: string;
  columns: ColumnMeta[];
  rows: ObjectRow[];
  total: number | null;
  truncated: boolean;
  duration_ms: number;
  sql: string;
};

export const ontologyObjects = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        query: z.object({
          objectType: z.string().min(1).max(64),
          filters: z.array(filter).max(20).optional(),
          search: z.string().max(200).optional(),
          path: z.array(step).max(4).optional(),
          targetFilters: z.array(filter).max(20).optional(),
          properties: z.array(z.string().max(64)).max(200).optional(),
          orderBy: z
            .object({ property: z.string().max(64), direction: z.enum(["asc", "desc"]) })
            .optional(),
          limit: z.number().int().min(1).max(100_000).optional(),
          offset: z.number().int().min(0).max(10_000_000).optional(),
        }),
        count: z.boolean().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<ObjectSetResult | Fail> => {
    const ctx = await access(data.access_token, data.id);
    if (isFail(ctx)) return ctx;
    try {
      const c = compileObjectSet(ctx.a.spec, data.query, ctx.opts);
      const [res, total] = await Promise.all([
        runRows(ctx.userId, c.sql, c.columns, {
          rowCap: ctx.opts.maxRows ?? 5000,
          via: "ontology:explore",
        }),
        data.count && c.countSql
          ? runCount(ctx.userId, c.countSql, "ontology:explore")
          : Promise.resolve(null),
      ]);
      const end = data.query.path?.length
        ? (c.columns[0]?.objectType ?? data.query.objectType)
        : data.query.objectType;
      return {
        ok: true,
        objectType: end,
        columns: c.columns,
        rows: res.rows,
        total,
        truncated: res.truncated,
        duration_ms: res.durationMs,
        sql: c.sql,
      };
    } catch (e) {
      return failFrom(e);
    }
  });

// ── One object, its links, its rules, its actions ───────────────────────────

export type LinkGroup = {
  link: string;
  reading: string;
  direction: "forward" | "inverse";
  label: string;
  objectType: string;
  total: number;
  objects: { key: Record<string, Cell>; title: string }[];
  error?: string;
};

export type ObjectView = {
  ok: true;
  objectType: string;
  object: ObjectRow;
  columns: ColumnMeta[];
  title: string;
  links: LinkGroup[];
  /** Rules this object breaks right now (predicate, range, pattern, allowed values, required). */
  broken: { id: string; name: string; severity: string; statement: string }[];
  /** Action types available on this type, for the object's action bar. */
  actions: { name: string; label: string; kind: string; requiresApproval: boolean }[];
  /** Metrics of this type evaluated for this one object (e.g. its line revenue). */
  metrics: { name: string; label: string; value: Cell; format?: string }[];
};

function titleFor(t: ObjectType, row: ObjectRow): string {
  const tp = t.titleProperty;
  const v = tp ? row[tp] : null;
  if (v !== null && v !== undefined && v !== "") return String(v);
  return t.primaryKey.map((k) => String(row[k] ?? "")).join(" · ") || titleOf(t);
}

function keyOf(t: ObjectType, row: ObjectRow): Record<string, Cell> {
  return Object.fromEntries(t.primaryKey.map((k) => [k, row[k]]));
}

/** Rules a single object can be checked against cheaply (one row, no grouping). */
function rowRuleCondition(spec: OntologySpec, t: ObjectType, r: OntologyRule): string | null {
  const prop = (n: string) => propertySql(spec, t, n, "t0");
  switch (r.kind) {
    case "required":
      return r.property ? `${prop(r.property)} IS NULL` : null;
    case "predicate":
      return r.predicate ? `NOT COALESCE((${compileExpr(r.predicate, prop)}), TRUE)` : null;
    case "range": {
      if (!r.property) return null;
      const p = prop(r.property);
      const parts = [
        ...(r.min !== undefined ? [`${p} < ${r.min}`] : []),
        ...(r.max !== undefined ? [`${p} > ${r.max}`] : []),
      ];
      return parts.length ? `(${p} IS NOT NULL AND (${parts.join(" OR ")}))` : null;
    }
    case "pattern":
      return r.property && r.pattern
        ? `(${prop(r.property)} IS NOT NULL AND NOT regexp_full_match(CAST(${prop(r.property)} AS VARCHAR), ${sqlString(r.pattern)}))`
        : null;
    case "allowed_values":
      return r.property && r.values?.length
        ? `(${prop(r.property)} IS NOT NULL AND CAST(${prop(r.property)} AS VARCHAR) NOT IN (${r.values.map(sqlString).join(", ")}))`
        : null;
    default:
      return null;
  }
}

export const ontologyObject = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({ access_token: token, id, objectType: z.string().min(1).max(64), key: keySchema })
      .parse(input),
  )
  .handler(async ({ data }): Promise<ObjectView | Fail> => {
    const ctx = await access(data.access_token, data.id);
    if (isFail(ctx)) return ctx;
    const { spec } = ctx.a;
    const t = findObjectType(spec, data.objectType);
    if (!t) return { ok: false, error: `Unknown object type ${data.objectType}` };
    try {
      const c = compileGetObject(spec, t.name, data.key as Record<string, Scalar>, ctx.opts);
      const got = await runRows(ctx.userId, c.sql, c.columns, {
        rowCap: 2,
        via: "ontology:object",
      });
      if (!got.rows.length)
        return {
          ok: false,
          error: `No ${titleOf(t)} has that key (or it is outside what you can see)`,
        };
      if (got.rows.length > 1) {
        return {
          ok: false,
          error: `Two ${titleOf(t)} objects share that key — check the type's key in the model`,
        };
      }
      const object = got.rows[0];

      // Links: a count and the first objects, per link, side by side.
      const links: LinkGroup[] = await Promise.all(
        linksOf(spec, t.name).map(async ({ link, direction, other }) => {
          const reading = linkReading(link, direction);
          const ot = findObjectType(spec, other)!;
          const label =
            direction === "forward"
              ? (link.label ?? reading.replace(/_/g, " "))
              : (link.inverseLabel ?? reading.replace(/_/g, " "));
          try {
            const lc = compileLinked(
              spec,
              t.name,
              data.key as Record<string, Scalar>,
              { link: reading, direction },
              { ...ctx.opts, limit: 12 },
            );
            const [rows, total] = await Promise.all([
              runRows(ctx.userId, lc.sql, lc.columns, { rowCap: 12, via: "ontology:object" }),
              lc.countSql
                ? runCount(ctx.userId, lc.countSql, "ontology:object")
                : Promise.resolve(0),
            ]);
            return {
              link: link.name,
              reading,
              direction,
              label,
              objectType: ot.name,
              total,
              objects: rows.rows.map((r) => ({ key: keyOf(ot, r), title: titleFor(ot, r) })),
            };
          } catch (e) {
            return {
              link: link.name,
              reading,
              direction,
              label,
              objectType: ot.name,
              total: 0,
              objects: [],
              error: failFrom(e).error,
            };
          }
        }),
      );

      // Rules this one object breaks: one query, a column per checkable rule.
      const rules = [...spec.rules.filter((r) => r.enabled), ...impliedRules(spec)].filter(
        (r) => r.objectType.toLowerCase() === t.name.toLowerCase(),
      );
      const checks = rules
        .map((r) => ({
          r,
          cond: (() => {
            try {
              return rowRuleCondition(spec, t, r);
            } catch {
              return null;
            }
          })(),
        }))
        .filter((x): x is { r: OntologyRule; cond: string } => !!x.cond);
      let broken: ObjectView["broken"] = [];
      if (checks.length) {
        const where = t.primaryKey
          .map((k) => {
            const base = baseTypeOf(spec, findProperty(spec, t, k)!.type) ?? "string";
            return `${propertySql(spec, t, k, "t0")} = ${typedLiteral(base, data.key[k] as Scalar)}`;
          })
          .join(" AND ");
        const sql = `SELECT ${checks.map((x, i) => `COALESCE(${x.cond}, FALSE) AS ${quoteIdent(`r${i}`)}`).join(", ")} FROM ${t.source!.table} AS t0 WHERE ${where} LIMIT 1`;
        try {
          const res = await runRows(ctx.userId, sql, null, { rowCap: 1, via: "ontology:object" });
          const row = res.rows[0] ?? {};
          broken = checks
            .filter((_, i) => row[`r${i}`] === true)
            .map(({ r }) => ({
              id: r.id,
              name: r.name,
              severity: r.severity,
              statement: r.statement,
            }));
        } catch {
          broken = [];
        }
      }

      // This object's own metrics (an Order's revenue is its total; a
      // Customer's comes through links and is shown on their orders' group).
      const metrics: ObjectView["metrics"] = [];
      for (const m of t.metrics.slice(0, 6)) {
        try {
          const mc = compileMetric(
            spec,
            {
              objectType: t.name,
              metric: m.name,
              filters: t.primaryKey.map((k) => ({
                property: k,
                op: "eq" as const,
                value: data.key[k] as Scalar,
              })),
            },
            ctx.opts,
          );
          const r = await runRows(ctx.userId, mc.sql, mc.columns, {
            rowCap: 1,
            via: "ontology:object",
          });
          metrics.push({
            name: m.name,
            label: m.label ?? m.name,
            value: r.rows[0]?.[m.name] ?? null,
            format: m.format,
          });
        } catch {
          /* a metric over a hidden property is simply not shown */
        }
      }

      return {
        ok: true,
        objectType: t.name,
        object,
        columns: c.columns,
        title: titleFor(t, object),
        links,
        broken,
        actions: spec.actionTypes
          .filter((x) => x.objectType.toLowerCase() === t.name.toLowerCase() && x.kind !== "create")
          .map((x) => ({
            name: x.name,
            label: x.label ?? x.name,
            kind: x.kind,
            requiresApproval: x.requiresApproval,
          })),
        metrics,
      };
    } catch (e) {
      return failFrom(e);
    }
  });

// ── The neighbourhood graph ─────────────────────────────────────────────────

export type GraphNode = {
  id: string;
  objectType: string;
  key: Record<string, Cell>;
  title: string;
  depth: number;
};
export type GraphEdge = { from: string; to: string; link: string; label: string };

export const ontologyNeighborhood = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        objectType: z.string().min(1).max(64),
        key: keySchema,
        depth: z.number().int().min(1).max(2).default(1),
        perLink: z.number().int().min(1).max(25).default(8),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; nodes: GraphNode[]; edges: GraphEdge[]; capped: boolean } | Fail> => {
      const ctx = await access(data.access_token, data.id);
      if (isFail(ctx)) return ctx;
      const { spec } = ctx.a;
      const start = findObjectType(spec, data.objectType);
      if (!start) return { ok: false, error: `Unknown object type ${data.objectType}` };
      const nid = (type: string, key: Record<string, unknown>) => `${type}:${JSON.stringify(key)}`;
      const nodes = new Map<string, GraphNode>();
      const edges = new Map<string, GraphEdge>();
      let capped = false;
      const MAX_NODES = 120;
      try {
        const c = compileGetObject(spec, start.name, data.key as Record<string, Scalar>, ctx.opts);
        const got = await runRows(ctx.userId, c.sql, c.columns, {
          rowCap: 1,
          via: "ontology:graph",
        });
        if (!got.rows.length) return { ok: false, error: "That object was not found" };
        const root = {
          id: nid(start.name, keyOf(start, got.rows[0])),
          objectType: start.name,
          key: keyOf(start, got.rows[0]),
          title: titleFor(start, got.rows[0]),
          depth: 0,
        };
        nodes.set(root.id, root);
        let frontier = [root];
        for (let d = 1; d <= data.depth; d++) {
          const next: GraphNode[] = [];
          for (const n of frontier) {
            const t = findObjectType(spec, n.objectType)!;
            for (const { link, direction, other } of linksOf(spec, t.name)) {
              if (nodes.size >= MAX_NODES) {
                capped = true;
                break;
              }
              const ot = findObjectType(spec, other);
              if (!ot?.source) continue;
              const reading = linkReading(link, direction);
              try {
                const lc = compileLinked(
                  spec,
                  t.name,
                  n.key as Record<string, Scalar>,
                  { link: reading, direction },
                  { ...ctx.opts, limit: data.perLink },
                );
                const rows = await runRows(ctx.userId, lc.sql, lc.columns, {
                  rowCap: data.perLink,
                  via: "ontology:graph",
                });
                if (rows.rows.length >= data.perLink) capped = true;
                for (const r of rows.rows) {
                  const key = keyOf(ot, r);
                  const id2 = nid(ot.name, key);
                  if (!nodes.has(id2)) {
                    const node = {
                      id: id2,
                      objectType: ot.name,
                      key,
                      title: titleFor(ot, r),
                      depth: d,
                    };
                    nodes.set(id2, node);
                    next.push(node);
                  }
                  const [from, to] = direction === "forward" ? [n.id, id2] : [id2, n.id];
                  edges.set(`${from}|${link.name}|${to}`, {
                    from,
                    to,
                    link: link.name,
                    label: link.label ?? link.name.replace(/_/g, " "),
                  });
                }
              } catch {
                /* a link the caller cannot follow (masked key, missing table) is skipped */
              }
            }
          }
          frontier = next;
        }
        return { ok: true, nodes: [...nodes.values()], edges: [...edges.values()], capped };
      } catch (e) {
        return failFrom(e);
      }
    },
  );

// ── Metrics ─────────────────────────────────────────────────────────────────

export const ontologyMetric = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        query: z.object({
          objectType: z.string().min(1).max(64),
          metric: z.string().min(1).max(64),
          groupBy: z
            .array(
              z.object({
                property: z.string().min(1).max(64),
                path: z.array(step).max(4).optional(),
                grain: z.enum(TIME_GRAINS).optional(),
              }),
            )
            .max(4)
            .optional(),
          filters: z.array(filter).max(20).optional(),
          order: z.enum(["metric_desc", "metric_asc", "group_asc"]).optional(),
          limit: z.number().int().min(1).max(5000).optional(),
        }),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | {
          ok: true;
          columns: ColumnMeta[];
          rows: ObjectRow[];
          sql: string;
          duration_ms: number;
          certified: boolean;
        }
      | Fail
    > => {
      const ctx = await access(data.access_token, data.id);
      if (isFail(ctx)) return ctx;
      try {
        const c = compileMetric(ctx.a.spec, data.query, ctx.opts);
        const r = await runRows(ctx.userId, c.sql, c.columns, {
          rowCap: ctx.opts.maxRows ?? 5000,
          via: "ontology:metric",
        });
        const t = findObjectType(ctx.a.spec, data.query.objectType);
        const certified = !!t?.metrics.find((m) => m.name === data.query.metric)?.certified;
        return {
          ok: true,
          columns: c.columns,
          rows: r.rows,
          sql: c.sql,
          duration_ms: r.durationMs,
          certified,
        };
      } catch (e) {
        return failFrom(e);
      }
    },
  );

// ── Binding: preview a table, profile a model ───────────────────────────────

export const ontologyPreviewTable = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        table: z.string().regex(TABLE_REF),
        filter: z.string().max(2000).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; columns: string[]; rows: ObjectRow[]; total: number } | Fail> => {
      // Owner only: previewing is part of editing the binding.
      const ctx = await access(data.access_token, data.id, "own");
      if (isFail(ctx)) return ctx;
      try {
        const where = data.filter
          ? ` WHERE ${compileExpr(data.filter, (col) => `t0.${quoteIdent(col)}`)}`
          : "";
        const [rows, total] = await Promise.all([
          runRows(ctx.userId, `SELECT * FROM ${data.table} AS t0${where} LIMIT 20`, null, {
            rowCap: 20,
            via: "ontology:preview",
          }),
          runCount(
            ctx.userId,
            `SELECT count(*) FROM ${data.table} AS t0${where}`,
            "ontology:preview",
          ),
        ]);
        return { ok: true, columns: Object.keys(rows.rows[0] ?? {}), rows: rows.rows, total };
      } catch (e) {
        return failFrom(e);
      }
    },
  );

export type TypeProfile = {
  objectType: string;
  rows: number | null;
  distinctKeys: number | null;
  keyUnique: boolean | null;
  nullRates: Record<string, number>;
  error?: string;
};

export type LinkProfile = {
  from: string;
  link: string;
  to: string;
  /** Share of `from` objects whose key-side value finds a target, 0–1. */
  matchRate: number | null;
  checked: number | null;
  error?: string;
};

/** How the model fits the data: row counts, key uniqueness, nulls, link match rates. */
export const ontologyProfile = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: token, id }).parse(input))
  .handler(
    async ({ data }): Promise<{ ok: true; types: TypeProfile[]; links: LinkProfile[] } | Fail> => {
      const ctx = await access(data.access_token, data.id);
      if (isFail(ctx)) return ctx;
      const { spec } = ctx.a;
      const types = await Promise.all(
        spec.objectTypes
          .filter((t) => t.source)
          .map(async (t): Promise<TypeProfile> => {
            try {
              const props = allProperties(spec, t)
                .filter((p) => !isMasked(spec, t, p.name, ctx.opts))
                .slice(0, 60);
              const where = t.source!.filter
                ? ` WHERE ${compileExpr(t.source!.filter, (col) => `t0.${quoteIdent(col)}`)}`
                : "";
              const keyExpr = t.primaryKey.length
                ? `count(DISTINCT (${t.primaryKey.map((k) => propertySql(spec, t, k, "t0")).join(", ")}))`
                : "NULL";
              const nulls = props.map(
                (p, i) =>
                  `count(*) FILTER (WHERE ${propertySql(spec, t, p.name, "t0")} IS NULL) AS ${quoteIdent(`n${i}`)}`,
              );
              const sql = `SELECT count(*) AS rows, ${keyExpr} AS keys${nulls.length ? `, ${nulls.join(", ")}` : ""} FROM ${t.source!.table} AS t0${where}`;
              const r = await runRows(ctx.userId, sql, null, {
                rowCap: 1,
                via: "ontology:profile",
              });
              const row = r.rows[0] ?? {};
              const rows = Number(row.rows ?? 0);
              const keys = row.keys === null || row.keys === undefined ? null : Number(row.keys);
              return {
                objectType: t.name,
                rows,
                distinctKeys: keys,
                keyUnique: keys === null ? null : keys === rows,
                nullRates: Object.fromEntries(
                  props.map((p, i) => [p.name, rows ? Number(row[`n${i}`] ?? 0) / rows : 0]),
                ),
              };
            } catch (e) {
              return {
                objectType: t.name,
                rows: null,
                distinctKeys: null,
                keyUnique: null,
                nullRates: {},
                error: failFrom(e).error,
              };
            }
          }),
      );
      const links = await Promise.all(
        spec.linkTypes.map(async (l): Promise<LinkProfile> => {
          const from = findObjectType(spec, l.from);
          const to = findObjectType(spec, l.to);
          if (!from?.source || !to?.source)
            return { from: l.from, link: l.name, to: l.to, matchRate: null, checked: null };
          try {
            // Checked: `from` objects whose side of the join is filled in.
            const checkedSet = compileObjectSet(
              spec,
              {
                objectType: from.name,
                filters: l.join.fromProperties.map((p) => ({
                  property: p,
                  op: "not_null" as const,
                })),
                limit: 1,
              },
              ctx.opts,
            );
            // Matched: walk back from the targets — the distinct `from` objects
            // some target links to.
            const matchedSet = compileObjectSet(
              spec,
              {
                objectType: to.name,
                path: [{ link: linkReading(l, "inverse"), direction: "inverse" }],
                limit: 1,
              },
              ctx.opts,
            );
            const [checked, matched] = await Promise.all([
              runCount(ctx.userId, checkedSet.countSql!, "ontology:profile"),
              runCount(ctx.userId, matchedSet.countSql!, "ontology:profile"),
            ]);
            return {
              from: l.from,
              link: l.name,
              to: l.to,
              matchRate: checked ? Math.min(1, matched / checked) : null,
              checked,
            };
          } catch (e) {
            return {
              from: l.from,
              link: l.name,
              to: l.to,
              matchRate: null,
              checked: null,
              error: failFrom(e).error,
            };
          }
        }),
      );
      return { ok: true, types, links };
    },
  );

// ── Rules ───────────────────────────────────────────────────────────────────

export type RuleResult = {
  id: string;
  name: string;
  statement: string;
  objectType: string;
  kind: string;
  severity: string;
  implied: boolean;
  checked: number | null;
  violations: number | null;
  sample: ObjectRow[];
  error?: string;
  ms: number;
};

export type RuleRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  revision: number;
  rules_run: number;
  passed: number;
  failed: number;
  errored: number;
  results: RuleResult[];
};

/** Run every enabled rule (and the ones the model implies) against the data. Owner only. */
export const ontologyRunRules = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        /** Run just these rule ids (all when absent). */
        only: z.array(z.string().max(64)).max(500).optional(),
        include_implied: z.boolean().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; run: RuleRun } | Fail> => {
    const ctx = await access(data.access_token, data.id, "own");
    if (isFail(ctx)) return ctx;
    const { spec, row } = ctx.a;
    const startedAt = new Date().toISOString();
    const all = [
      ...spec.rules.filter((r) => r.enabled).map((r) => ({ r, implied: false })),
      ...(data.include_implied ? impliedRules(spec).map((r) => ({ r, implied: true })) : []),
    ].filter(({ r }) => !data.only || data.only.includes(r.id));
    const results: RuleResult[] = [];
    // A few at a time: each is a scan, and a model can have hundreds.
    const queue = [...all];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { r, implied } = next;
        const t0 = Date.now();
        try {
          const t = findObjectType(spec, r.objectType);
          if (!t?.source) throw new CompileError(`${r.objectType} has no table`);
          const c = compileRule(spec, r, { ...ctx.opts, sample: 10 });
          const counts = await runRows(ctx.userId, c.checkSql, null, {
            rowCap: 1,
            via: "ontology:rule",
          });
          const violations = Number(counts.rows[0]?.violations ?? 0);
          const sample = violations
            ? (await runRows(ctx.userId, c.sampleSql, null, { rowCap: 10, via: "ontology:rule" }))
                .rows
            : [];
          results.push({
            id: r.id,
            name: r.name,
            statement: r.statement,
            objectType: r.objectType,
            kind: r.kind,
            severity: r.severity,
            implied,
            checked: Number(counts.rows[0]?.checked ?? 0),
            violations,
            sample,
            ms: Date.now() - t0,
          });
        } catch (e) {
          results.push({
            id: r.id,
            name: r.name,
            statement: r.statement,
            objectType: r.objectType,
            kind: r.kind,
            severity: r.severity,
            implied,
            checked: null,
            violations: null,
            sample: [],
            error: failFrom(e).error,
            ms: Date.now() - t0,
          });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const order = new Map(all.map(({ r }, i) => [r.id, i]));
    results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const passed = results.filter((x) => x.violations === 0).length;
    const failed = results.filter((x) => (x.violations ?? 0) > 0).length;
    const errored = results.filter((x) => x.error).length;
    const finishedAt = new Date().toISOString();
    const { data: saved, error } = await supabaseAdmin
      .from("ontology_rule_runs")
      .insert({
        ontology_id: row.id,
        user_id: ctx.userId,
        revision: row.revision,
        results: results as unknown as Json,
        rules_run: results.length,
        passed,
        failed,
        errored,
        started_at: startedAt,
        finished_at: finishedAt,
      })
      .select("id")
      .single();
    if (error || !saved) return { ok: false, error: error?.message ?? "Could not record the run" };
    await supabaseAdmin
      .from("ontologies")
      .update({
        health: {
          passed,
          failed,
          errored,
          ran_at: finishedAt,
          run_id: saved.id,
        } as unknown as Json,
      })
      .eq("id", row.id);
    auditEvent({
      userId: ctx.userId,
      action: "ontology.rules.run",
      resourceType: "ontology",
      resourceId: row.id,
      resourceName: row.name,
      detail: { run_id: saved.id, rules: results.length, passed, failed, errored },
    });
    return {
      ok: true,
      run: {
        id: saved.id,
        started_at: startedAt,
        finished_at: finishedAt,
        revision: row.revision,
        rules_run: results.length,
        passed,
        failed,
        errored,
        results,
      },
    };
  });

export const ontologyRuleRuns = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({ access_token: token, id, limit: z.number().int().min(1).max(50).default(20) })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; runs: RuleRun[] } | Fail> => {
    const ctx = await access(data.access_token, data.id);
    if (isFail(ctx)) return ctx;
    const { data: rows, error } = await supabaseAdmin
      .from("ontology_rule_runs")
      .select("id, started_at, finished_at, revision, rules_run, passed, failed, errored, results")
      .eq("ontology_id", data.id)
      .order("started_at", { ascending: false })
      .limit(data.limit);
    if (error) return { ok: false, error: error.message };
    const masked = (r: RuleResult): RuleResult => {
      // A grantee reads the run, but not sample values their share hides.
      if (ctx.a.role === "owner") return r;
      const t = findObjectType(ctx.a.spec, r.objectType);
      if (!t) return { ...r, sample: [] };
      return {
        ...r,
        sample: r.sample.map((s) =>
          Object.fromEntries(
            Object.entries(s).map(([k, v]) => {
              try {
                return [k, isMasked(ctx.a.spec, t, k, ctx.opts) ? null : v];
              } catch {
                return [k, null];
              }
            }),
          ),
        ),
      };
    };
    return {
      ok: true,
      runs: (rows ?? []).map((r) => ({
        id: r.id,
        started_at: r.started_at,
        finished_at: r.finished_at,
        revision: r.revision,
        rules_run: r.rules_run,
        passed: r.passed,
        failed: r.failed,
        errored: r.errored,
        results: ((r.results as unknown as RuleResult[]) ?? []).map(masked),
      })),
    };
  });
