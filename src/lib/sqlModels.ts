// SQL models — the pure part: what a model is, what it depends on, what order
// a build runs in, and what its tests assert.
//
// NO IMPORTS. The editor, the build runner and the tests all read this, so a
// rule cannot be enforced in one place and not another — the same reason
// dataQualityCore has the same constraint.
//
// The vocabulary is dbt's on purpose. An analyst who has written a dbt project
// already knows what `ref()`, a materialization and a `not_null` test mean, and
// a project written here should be legible to someone who has never seen this
// app. What is deliberately NOT dbt: there is no Jinja, no macros, no seeds,
// no packages. A model is one SELECT that may name other models.

/** How a model's answer is stored. */
export type Materialization = "table" | "view";

export type SqlModelTestKind =
  | "not_null"
  | "unique"
  | "accepted_values"
  | "range"
  | "row_count_min";

/** `error` fails the model and skips everything downstream; `warn` only records. */
export type TestSeverity = "error" | "warn";

export type SqlModelTest = {
  kind: SqlModelTestKind;
  /** The column under test. Null only for row_count_min, which tests the table. */
  column: string | null;
  severity: TestSeverity;
  /** accepted_values */
  values?: string[];
  /** range — either bound may be omitted */
  min?: number | null;
  max?: number | null;
  /** row_count_min */
  count?: number;
};

export type SqlModel = {
  id: string;
  name: string;
  schema_name: string;
  sql: string;
  materialization: Materialization;
  tests: SqlModelTest[];
  is_active: boolean;
};

/** What one model did in a build. */
export type ModelOutcome = "built" | "failed" | "skipped";

export const TEST_LABELS: Record<SqlModelTestKind, string> = {
  not_null: "Not null",
  unique: "Unique",
  accepted_values: "Accepted values",
  range: "Numeric range",
  row_count_min: "Minimum row count",
};

/** A model name is also its table name, so it has to be a plain identifier. */
export const MODEL_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function validateModelName(name: string): string | null {
  if (!name.trim()) return "Give the model a name";
  if (!MODEL_NAME_RE.test(name)) {
    return "A model name is lower case letters, digits and underscores, starting with a letter or underscore";
  }
  return null;
}

/** Double-quote an identifier for DuckDB. */
export function qi(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

/** Single-quote a literal. */
function ql(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** The table a model materialises into. The name IS the table name, as in dbt. */
export function modelTarget(model: Pick<SqlModel, "schema_name" | "name">): string {
  return `${model.schema_name}.${model.name}`;
}

export function quotedTarget(model: Pick<SqlModel, "schema_name" | "name">): string {
  return `${qi(model.schema_name)}.${qi(model.name)}`;
}

export type RefSite = { name: string; start: number; end: number };

/**
 * Every `ref('name')` in a model's SQL, with where it sits.
 *
 * Comments are skipped, so a commented-out ref is not a dependency. That is
 * not pedantry: a dependency the build honours but the query never reads
 * imposes an order for no reason, and in a cycle it would refuse to build a
 * project that is actually fine.
 *
 * Offsets are into the ORIGINAL string, so rendering can splice precisely and
 * leave comments exactly as the author wrote them.
 */
export function extractRefs(sql: string): RefSite[] {
  const out: RefSite[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    // Comments: not code, so nothing inside them is a dependency.
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    // A string literal cannot contain a ref, but it can contain the word.
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n && sql[i] !== '"') i++;
      i++;
      continue;
    }
    // ref ( 'name' ) — as a whole word, so `preferred_ref(` is not a ref.
    if ((ch === "r" || ch === "R") && /^ref$/i.test(sql.slice(i, i + 3))) {
      const before = i === 0 ? "" : sql[i - 1];
      if (!/[A-Za-z0-9_$]/.test(before)) {
        const m = /^ref\s*\(\s*(['"])([^'"]*)\1\s*\)/i.exec(sql.slice(i));
        if (m) {
          out.push({ name: m[2], start: i, end: i + m[0].length });
          i += m[0].length;
          continue;
        }
      }
    }
    i++;
  }
  return out;
}

/** The distinct model names a model depends on, in first-seen order. */
export function refNames(sql: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of extractRefs(sql)) {
    if (!seen.has(r.name)) {
      seen.add(r.name);
      out.push(r.name);
    }
  }
  return out;
}

/**
 * Replace every ref with the physical table it names.
 *
 * `resolve` returning null means the model does not exist, which is an error
 * the caller reports by name rather than letting DuckDB complain about a
 * table nobody wrote.
 */
export function renderSql(sql: string, resolve: (name: string) => string | null): string {
  const sites = extractRefs(sql);
  if (sites.length === 0) return sql;
  let out = "";
  let cursor = 0;
  for (const site of sites) {
    const target = resolve(site.name);
    if (!target) throw new Error(`ref('${site.name}') names a model that does not exist`);
    out += sql.slice(cursor, site.start) + target;
    cursor = site.end;
  }
  return out + sql.slice(cursor);
}

export type BuildPlan<T extends SqlModel = SqlModel> = {
  /** Models in the order they must be built. */
  order: T[];
  /** name -> the names it depends on, restricted to models in the plan. */
  deps: Map<string, string[]>;
};

/**
 * The order a build runs in, and what each model waits for.
 *
 * `selected` restricts the plan to those models AND everything they depend on,
 * which is dbt's `+model`: rebuilding a fact without rebuilding the staging
 * table it reads would leave the two disagreeing.
 *
 * A cycle is refused by name rather than detected as a hang. Inactive models
 * are left out of the plan but still resolve as refs, because their table is
 * still on disk — pausing a model stops it being rebuilt, not being read.
 */
export function buildPlan<T extends SqlModel>(models: T[], selected?: string[]): BuildPlan<T> {
  const byName = new Map(models.map((m) => [m.name, m]));
  const buildable = models.filter((m) => m.is_active);
  const buildableNames = new Set(buildable.map((m) => m.name));

  const depsOf = (m: T) => refNames(m.sql).filter((r) => buildableNames.has(r));

  let wanted: Set<string>;
  if (selected && selected.length > 0) {
    wanted = new Set<string>();
    const visit = (name: string, seen: string[]): void => {
      if (wanted.has(name)) return;
      if (seen.includes(name)) {
        throw new Error(`These models depend on each other in a circle: ${cycleText(seen, name)}`);
      }
      const m = byName.get(name);
      if (!m || !m.is_active) return;
      wanted.add(name);
      for (const d of depsOf(m)) visit(d, [...seen, name]);
    };
    for (const s of selected) visit(s, []);
  } else {
    wanted = buildableNames;
  }

  const plan = buildable.filter((m) => wanted.has(m.name));
  const deps = new Map<string, string[]>();
  for (const m of plan)
    deps.set(
      m.name,
      depsOf(m).filter((d) => wanted.has(d)),
    );

  // Kahn, with a name tie-break so two runs of the same project produce the
  // same order and a diff of two build logs is readable.
  const remaining = new Map(plan.map((m) => [m.name, new Set(deps.get(m.name) ?? [])]));
  const order: T[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, d]) => d.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      throw new Error(
        `These models depend on each other in a circle: ${[...remaining.keys()].sort().join(", ")}`,
      );
    }
    for (const name of ready) {
      order.push(byName.get(name) as T);
      remaining.delete(name);
    }
    for (const d of remaining.values()) for (const name of ready) d.delete(name);
  }
  return { order, deps };
}

function cycleText(seen: string[], repeat: string): string {
  const from = seen.indexOf(repeat);
  return [...seen.slice(from), repeat].join(" → ");
}

/** Everything that depends on a model, directly or not. Used to skip a subtree. */
export function descendantsOf(deps: Map<string, string[]>, failed: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, on] of deps) {
      if (out.has(name)) continue;
      if (on.some((d) => d === failed || out.has(d))) {
        out.add(name);
        grew = true;
      }
    }
  }
  return out;
}

/** What a model's SQL must be before it is allowed anywhere near the lake. */
export function validateModelSql(sql: string): string | null {
  const body = sql.trim();
  if (!body) return "A model needs a SELECT";
  // The server re-checks this against the real classifier. This is the fast,
  // legible answer for the editor, not the security boundary.
  if (!/^(with|select)\b/i.test(body)) return "A model must be a SELECT (it may start with WITH)";
  return null;
}

export function validateTest(t: SqlModelTest): string | null {
  if (t.kind === "row_count_min") {
    if (!Number.isFinite(t.count) || (t.count ?? 0) < 0) return "Give the minimum row count";
    return null;
  }
  if (!t.column?.trim()) return `${TEST_LABELS[t.kind]} needs a column`;
  if (t.kind === "accepted_values" && (t.values ?? []).length === 0) {
    return "List at least one accepted value";
  }
  if (t.kind === "range" && t.min == null && t.max == null) {
    return "A range test needs a minimum, a maximum, or both";
  }
  return null;
}

/**
 * A test as one query returning ONE number: how many rows fail it.
 *
 * Every kind answers in the same shape so the runner has one code path and a
 * result reads the same way whatever was asserted. Zero is a pass.
 */
export function testSql(test: SqlModelTest, target: string): string {
  const col = test.column ? qi(test.column) : null;
  switch (test.kind) {
    case "not_null":
      return `SELECT count(*) FROM ${target} WHERE ${col} IS NULL`;
    case "unique":
      // Rows that share a value, not groups: "3 rows are duplicated" is what
      // someone fixing the model needs, not "1 value repeats".
      return (
        `SELECT coalesce(sum(n), 0) FROM (SELECT count(*) AS n FROM ${target} ` +
        `WHERE ${col} IS NOT NULL GROUP BY ${col} HAVING count(*) > 1)`
      );
    case "accepted_values": {
      const list = (test.values ?? []).map(ql).join(", ");
      return `SELECT count(*) FROM ${target} WHERE ${col} IS NOT NULL AND CAST(${col} AS VARCHAR) NOT IN (${list})`;
    }
    case "range": {
      const bounds: string[] = [];
      if (test.min != null) bounds.push(`${col} < ${Number(test.min)}`);
      if (test.max != null) bounds.push(`${col} > ${Number(test.max)}`);
      return `SELECT count(*) FROM ${target} WHERE ${col} IS NOT NULL AND (${bounds.join(" OR ")})`;
    }
    case "row_count_min":
      // Not a row count: the number of FAILING rows, which for a table-level
      // assertion is one or zero, so the runner never special-cases it.
      return `SELECT CASE WHEN count(*) >= ${Number(test.count ?? 0)} THEN 0 ELSE 1 END FROM ${target}`;
  }
}

/** One line saying what a test asserts, for the editor and the run log. */
export function describeTest(t: SqlModelTest): string {
  switch (t.kind) {
    case "not_null":
      return `${t.column} is never null`;
    case "unique":
      return `${t.column} has no repeated value`;
    case "accepted_values":
      return `${t.column} is one of ${(t.values ?? []).join(", ")}`;
    case "range": {
      if (t.min != null && t.max != null) return `${t.column} is between ${t.min} and ${t.max}`;
      if (t.min != null) return `${t.column} is at least ${t.min}`;
      return `${t.column} is at most ${t.max}`;
    }
    case "row_count_min":
      return `the table has at least ${t.count} rows`;
  }
}

/** A build's verdict from its models', in the order a reader cares about. */
export function buildStatus(outcomes: ModelOutcome[]): "success" | "error" | "partial" {
  if (outcomes.some((o) => o === "failed")) {
    return outcomes.some((o) => o === "built") ? "partial" : "error";
  }
  return "success";
}
