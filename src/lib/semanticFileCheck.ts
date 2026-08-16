// Check exported semantic models WITHOUT a database or a warehouse.
//
// This is what makes a semantic change reviewable in a pull request. Git export
// already writes each model as JSON; this reads those files back and finds the
// mistakes that are decidable from the definition alone — a hierarchy naming a
// dimension that does not exist, a derived metric referencing a metric that was
// deleted, a `{{param}}` nobody declared. Those are exactly the errors that
// otherwise surface as a refusal at query time, in front of whoever asked the
// question rather than in front of whoever made the change.
//
// TWO RULES SHAPE THIS FILE.
//
// It COLLECTS rather than throws. The app's save path throws on the first
// problem, which is right for a form — you fix one field and try again. A CI
// check that reports one error per run is a check nobody runs twice.
//
// It only claims what it can decide OFFLINE. Whether `revenue` really is unique
// per order, whether a join actually fans out, whether the source table still
// has that column — none of that is knowable without the warehouse, and this
// says so rather than passing silently and implying it checked. `Validate` in
// the app remains the thing that measures.

import {
  isValidFieldName,
  type SemanticDimension,
  type SemanticMetric,
  type SemanticModel,
} from "@/lib/semanticLayer";

export type CheckSeverity = "error" | "warning";

export type CheckProblem = {
  severity: CheckSeverity;
  /** The file this came from, so CI output points somewhere. */
  file: string;
  /** Model name when known — a file can fail before that is readable. */
  model?: string;
  message: string;
};

export type CheckReport = {
  /** Files that parsed into a model, whether or not they had problems. */
  checked: number;
  /** Files skipped because they are not semantic models (dashboards, etc). */
  skipped: number;
  problems: CheckProblem[];
  /** No errors. Warnings do not fail a build. */
  ok: boolean;
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** `{{name}}` references in a trusted SQL fragment. */
export function paramRefsIn(sql: string): string[] {
  return [...sql.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((m) => m[1]);
}

/**
 * `{metric}` references inside a derived metric's formula.
 *
 * The lookarounds are load-bearing: `{{uplift}}` is a PARAMETER, and a naive
 * `\{(\w+)\}` matches its inner braces. That would report a correctly declared
 * parameter as a missing metric — a CI failure on code that is right, which is
 * the one kind of false positive that gets a check switched off.
 */
export function metricRefsIn(sql: string): string[] {
  return [...sql.matchAll(/(?<!\{)\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}(?!\})/g)].map((m) => m[1]);
}

/**
 * Everything decidable about one model from its definition alone.
 *
 * `file` is carried through only so the report can name it.
 */
export function checkSemanticModel(model: SemanticModel, file: string): CheckProblem[] {
  const out: CheckProblem[] = [];
  const name = model.name;
  const err = (message: string) => out.push({ severity: "error", file, model: name, message });
  const warn = (message: string) => out.push({ severity: "warning", file, model: name, message });

  if (!name || !isValidFieldName(name)) {
    err(`Model name ${JSON.stringify(name ?? "")} must be letters, digits and underscore.`);
  }

  const dims: SemanticDimension[] = arr(model.dimensions) as SemanticDimension[];
  const metrics: SemanticMetric[] = arr(model.metrics) as SemanticMetric[];

  if (dims.length === 0 && metrics.length === 0) {
    err("Model has no dimensions and no metrics, so no query can name anything on it.");
  }

  // Field names: valid, and unique ACROSS both lists. A dimension and a metric
  // sharing a name compile to the same SQL alias and one silently wins.
  const seen = new Set<string>();
  for (const f of [...dims, ...metrics]) {
    const fname = str(f?.name);
    if (!fname || !isValidFieldName(fname)) {
      err(`Field name ${JSON.stringify(fname ?? "")} must be letters, digits and underscore.`);
      continue;
    }
    if (seen.has(fname))
      err(`Duplicate field name "${fname}" — a dimension and a metric cannot share one.`);
    seen.add(fname);
  }

  const dimNames = new Set(dims.map((d) => str(d?.name)).filter((n): n is string => !!n));
  const metricNames = new Set(metrics.map((m) => str(m?.name)).filter((n): n is string => !!n));

  // Metrics that need an expression and do not have one.
  for (const m of metrics) {
    const mname = str(m?.name) ?? "(unnamed)";
    const agg = str(m?.agg);
    const sql = str(m?.sql);
    if (!agg) {
      err(`Metric "${mname}" has no aggregation.`);
      continue;
    }
    if ((agg === "custom" || agg === "derived") && !sql) {
      err(`Metric "${mname}" is ${agg} but declares no expression.`);
    }
    if (agg !== "count" && agg !== "custom" && agg !== "derived" && !sql) {
      err(`Metric "${mname}" (${agg}) needs a column or expression to aggregate.`);
    }
    // A derived metric's {refs} must resolve to metrics on THIS model — the
    // compiler substitutes each with that metric's own aggregate, so a dangling
    // ref is a query that refuses at run time.
    if (agg === "derived" && sql) {
      for (const ref of metricRefsIn(sql)) {
        if (!metricNames.has(ref)) {
          err(
            `Derived metric "${mname}" references {${ref}}, which is not a metric on this model.`,
          );
        }
        if (ref === mname) err(`Derived metric "${mname}" references itself.`);
      }
      if (metricRefsIn(sql).length === 0) {
        warn(`Derived metric "${mname}" references no other metric — did you mean agg "custom"?`);
      }
    }
  }

  // Hierarchies must name real dimensions, in order, without repeats.
  for (const h of arr(model.hierarchies) as Array<{ name?: string; levels?: unknown }>) {
    const hname = str(h?.name) ?? "(unnamed)";
    const levels = arr(h?.levels)
      .map((l) => str(l))
      .filter((l): l is string => !!l);
    if (levels.length < 2) err(`Hierarchy "${hname}" needs at least two levels.`);
    const dup = levels.find((l, i) => levels.indexOf(l) !== i);
    if (dup) err(`Hierarchy "${hname}" repeats level "${dup}".`);
    for (const lvl of levels) {
      if (!dimNames.has(lvl)) {
        err(`Hierarchy "${hname}" references "${lvl}", which is not a dimension on this model.`);
      }
    }
  }

  // Rollups must map onto fields that exist, or a query routed to one asks the
  // summary table for a column nobody declared.
  for (const r of arr(model.rollups) as Array<Json>) {
    const rname = str(r?.name) ?? str(r?.table) ?? "(unnamed)";
    if (!str(r?.table)) err(`Rollup "${rname}" names no table.`);
    for (const rd of arr(r?.dimensions) as Array<Json>) {
      const d = str(rd?.dimension);
      if (d && !dimNames.has(d)) {
        err(`Rollup "${rname}" maps dimension "${d}", which is not on this model.`);
      }
    }
    for (const rm of arr(r?.metrics) as Array<Json>) {
      const m = str(rm?.metric);
      if (m && !metricNames.has(m)) {
        err(`Rollup "${rname}" maps metric "${m}", which is not on this model.`);
      }
    }
  }

  // Parameters: every {{ref}} in an authored fragment must be declared, or the
  // compiler REFUSES the query rather than guessing a value.
  const declaredParams = new Set(
    (arr(model.parameters) as Array<Json>).map((p) => str(p?.name)).filter((n): n is string => !!n),
  );
  const fragments: Array<{ where: string; sql: string }> = [];
  for (const d of dims)
    if (str(d?.sql)) fragments.push({ where: `dimension "${d.name}"`, sql: d.sql });
  for (const m of metrics) {
    if (str(m?.sql)) fragments.push({ where: `metric "${m.name}"`, sql: m.sql! });
    for (const f of arr(m?.filters)) {
      const fs = str(f);
      if (fs) fragments.push({ where: `filter on metric "${m.name}"`, sql: fs });
    }
  }
  for (const j of arr(model.joins) as Array<Json>) {
    const on = str(j?.on);
    if (on) fragments.push({ where: `join on ${str(j?.table) ?? "(unnamed table)"}`, sql: on });
  }
  for (const { where, sql } of fragments) {
    for (const ref of paramRefsIn(sql)) {
      if (!declaredParams.has(ref)) {
        err(`${where} uses {{${ref}}}, which is not a declared parameter on this model.`);
      }
    }
  }
  // A declared parameter with no default is REQUIRED — every query must supply
  // it. Worth flagging, because it is usually an oversight rather than intent.
  for (const p of arr(model.parameters) as Array<Json>) {
    const pname = str(p?.name);
    if (pname && p?.default === undefined) {
      warn(`Parameter "${pname}" has no default, so every query must supply it.`);
    }
  }

  // Joins need something to join on.
  for (const j of arr(model.joins) as Array<Json>) {
    const t = str(j?.table);
    if (!t) err("A join names no table.");
    if (!str(j?.on)) err(`Join on "${t ?? "(unnamed)"}" has no ON condition.`);
    if (!str(j?.cardinality)) {
      // NOT an error: models saved before cardinality existed compile exactly
      // as before, and Validate measures the real cardinality either way. But
      // an undeclared fanning join is how a total silently inflates, so a
      // reviewer should see it.
      warn(
        `Join on "${t ?? "(unnamed)"}" declares no cardinality — Validate measures it, but a fanning join is not refused until it does.`,
      );
    }
  }

  // Two sources of truth for the same fiscal year would disagree quietly.
  if (model.calendar && model.fiscalYearStartMonth !== undefined) {
    err(
      "Model declares both a fiscal calendar table and fiscalYearStartMonth — they cannot both define the fiscal year.",
    );
  }

  if (!model.primaryKey) {
    warn(
      "No primary key declared, so fan-out refusals cannot name the count_distinct that would fix them.",
    );
  }

  return out;
}

/**
 * Read one exported file.
 *
 * Returns `null` for a file that is not a semantic model — the export writes
 * dashboards and notebooks into the same tree, and treating those as broken
 * models would make the check cry wolf.
 */
export function readSemanticFile(
  file: string,
  content: string,
): { model: SemanticModel | null; problems: CheckProblem[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return {
      model: null,
      problems: [{ severity: "error", file, message: `Not valid JSON: ${(e as Error).message}` }],
    };
  }
  const doc = obj(parsed);
  if (!doc) {
    return { model: null, problems: [{ severity: "error", file, message: "Not a JSON object." }] };
  }
  // `kind` is what the exporter stamps. A file without it is something else in
  // the repo, not a broken model.
  if (doc.kind !== "semantic_model") return { model: null, problems: [] };

  return { model: normaliseExportedModel(doc), problems: [] };
}

/**
 * An exported file is a DATABASE ROW, not a SemanticModel.
 *
 * The exporter spreads the row and strips three housekeeping columns, so the
 * top level is snake_case — `primary_key`, `fiscal_year_start_month`,
 * `source_kind`/`source_table` — while the in-app type is camelCase. The nested
 * JSONB (dimensions, metrics, joins, parameters, hierarchies, rollups) is
 * authored shape and identical in both.
 *
 * FOUND BY RUNNING THE CLI, not by the unit tests: those built fixtures from
 * the camelCase type, so every one of them passed while a real exported file
 * silently read `primaryKey: undefined` and warned about a key that was right
 * there in the file. Converting once, here at the boundary, is why the checks
 * below can keep speaking one shape.
 */
export function normaliseExportedModel(doc: Json): SemanticModel {
  const sourceKind = str(doc.source_kind);
  const table = str(doc.source_table) ?? "";
  return {
    ...(doc as unknown as SemanticModel),
    name: str(doc.name) ?? "",
    primaryKey: str(doc.primary_key) ?? (doc as { primaryKey?: string }).primaryKey,
    fiscalYearStartMonth:
      typeof doc.fiscal_year_start_month === "number"
        ? doc.fiscal_year_start_month
        : (doc as { fiscalYearStartMonth?: number }).fiscalYearStartMonth,
    source:
      sourceKind === "warehouse"
        ? { kind: "warehouse", connectionId: str(doc.connection_id) ?? "", table }
        : sourceKind === "data_table"
          ? { kind: "data_table", table }
          : ((doc as unknown as SemanticModel).source ?? { kind: "data_table", table }),
  };
}

/** Check a whole exported tree. */
export function checkSemanticFiles(files: Array<{ path: string; content: string }>): CheckReport {
  const problems: CheckProblem[] = [];
  let checked = 0;
  let skipped = 0;
  /** name → first file that declared it, for the duplicate check. */
  const byName = new Map<string, string>();

  for (const f of files) {
    const { model, problems: readProblems } = readSemanticFile(f.path, f.content);
    problems.push(...readProblems);
    if (!model) {
      if (readProblems.length === 0) skipped++;
      continue;
    }
    checked++;
    problems.push(...checkSemanticModel(model, f.path));

    // TWO FILES DECLARING ONE MODEL NAME. Whichever is applied last wins, and
    // nothing at query time reveals which definition answered. Only findable
    // across the tree, which is why it lives here rather than in the per-model
    // check.
    const nm = model.name;
    if (nm) {
      const first = byName.get(nm.toLowerCase());
      if (first) {
        problems.push({
          severity: "error",
          file: f.path,
          model: nm,
          message: `Model name "${nm}" is also declared in ${first} — one of them will silently win.`,
        });
      } else {
        byName.set(nm.toLowerCase(), f.path);
      }
    }
  }

  return {
    checked,
    skipped,
    problems,
    ok: !problems.some((p) => p.severity === "error"),
  };
}

/**
 * The report as CI output.
 *
 * Says what it checked AND what it cannot check. A green check that implied the
 * definitions were verified against the warehouse would be the most expensive
 * kind of false confidence this codebase can produce.
 */
export function formatCheckReport(report: CheckReport): string {
  const lines: string[] = [];
  const errors = report.problems.filter((p) => p.severity === "error");
  const warnings = report.problems.filter((p) => p.severity === "warning");

  for (const p of report.problems) {
    const where = p.model ? `${p.file} [${p.model}]` : p.file;
    lines.push(`${p.severity === "error" ? "error" : "warn "}  ${where}: ${p.message}`);
  }
  if (report.problems.length) lines.push("");

  lines.push(
    `${report.checked} semantic model${report.checked === 1 ? "" : "s"} checked` +
      (report.skipped
        ? `, ${report.skipped} non-model file${report.skipped === 1 ? "" : "s"} skipped`
        : "") +
      ` — ${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
  );
  lines.push(
    "Structure only: names, references, parameters. Whether a join really fans out, " +
      "whether a key is unique, and whether the source columns still exist need the " +
      "warehouse — run Validate in the app for those.",
  );
  return lines.join("\n");
}
