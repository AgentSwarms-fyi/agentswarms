// Measurement half of semantic model validation.
//
// The compiler can only enforce what a model DECLARES (fan-out refusals need
// a declared cardinality; count_distinct fixes need a declared key). This
// module checks the declarations against the DATA: it runs the COUNT probes
// from fanoutProbeSql and re-computes pinned assertions, so "declared
// many_to_one" and "revenue = 2,297,202" are measured claims, not trusted
// ones. Pure logic over an injected `exec` — semanticValidateModel passes the
// real local/warehouse runner, tests pass a DuckDB closure; nobody
// re-implements anybody.
import {
  compileSemanticQuery,
  fanoutProbeSql,
  joinQualifier,
  sampleValuesSql,
  type MetricAssertion,
  type SemanticModel,
  type SqlDialect,
} from "@/lib/semanticLayer";

/** Runs one read-only statement and returns its rows. */
export type ExecRows = (sql: string) => Promise<Record<string, unknown>[]>;

export type ModelIssueKind = "dimension" | "metric" | "model" | "join" | "assertion";
export type ModelIssue = { kind: ModelIssueKind; name: string; error: string };
/** Non-fatal findings: things worth declaring, not things that are wrong. */
export type ModelWarning = { kind: "join" | "assertion"; name: string; note: string };

/** COUNT() arrives as number, bigint or decimal-string depending on engine. */
function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v);
}

const fmt = (n: number) => n.toLocaleString("en-US");

export type JoinMeasurement = {
  /** "(source)" for the base row, else the join's qualifier. */
  name: string;
  /** Row count after joining up to and including this step. */
  rows: number;
  /** Distinct primary keys at this step, when a key is declared. */
  distinct?: number;
};

/**
 * Measure the model's grain and each join's real cardinality.
 *
 * Duplicate detection: with a declared primary key, a step where
 * COUNT(*) − COUNT(DISTINCT pk) GROWS has duplicated source rows even if an
 * INNER join simultaneously dropped others; without a key, only a growing
 * COUNT(*) is visible, which a row-dropping INNER join can mask — reported as
 * a warning rather than silently accepted.
 */
export async function measureModelHealth(
  exec: ExecRows,
  model: SemanticModel,
  dialect: SqlDialect,
): Promise<{ issues: ModelIssue[]; warnings: ModelWarning[]; measured: JoinMeasurement[] }> {
  const issues: ModelIssue[] = [];
  const warnings: ModelWarning[] = [];
  const measured: JoinMeasurement[] = [];

  const probe = fanoutProbeSql(model, dialect);
  if (!probe) return { issues, warnings, measured };

  let base: Record<string, unknown>;
  try {
    base = (await exec(probe.baseSql))[0] ?? {};
  } catch (e) {
    issues.push({
      kind: "model",
      name: "",
      error: `Could not count the source table: ${(e as Error).message}`.slice(0, 300),
    });
    return { issues, warnings, measured };
  }

  const pk = model.primaryKey?.trim();
  let prevN = num(base.n);
  let prevD = pk ? num(base.d) : undefined;
  measured.push({
    name: "(source)",
    rows: prevN,
    ...(prevD !== undefined ? { distinct: prevD } : {}),
  });

  // Grain: the declared key must actually be unique on the source.
  if (pk && prevD !== undefined && prevD < prevN) {
    issues.push({
      kind: "model",
      name: "",
      error:
        `primary_key "${pk}" is not unique on ${model.source.table}: ${fmt(prevN)} rows but ` +
        `${fmt(prevD)} distinct values. The declared grain is wrong, and every ` +
        `count_distinct built on it undercounts.`,
    });
  }

  for (const step of probe.steps) {
    const qual = joinQualifier(step.join);
    let row: Record<string, unknown>;
    try {
      row = (await exec(step.sql))[0] ?? {};
    } catch (e) {
      issues.push({
        kind: "join",
        name: qual,
        error: `Join could not be measured: ${(e as Error).message}`.slice(0, 300),
      });
      continue;
    }
    const n = num(row.n);
    const d = pk ? num(row.d) : undefined;
    measured.push({ name: qual, rows: n, ...(d !== undefined ? { distinct: d } : {}) });

    // Duplication delta at THIS step. n−d rises when source rows repeat, even
    // if an INNER join drops other rows at the same time.
    const dupBefore = prevD !== undefined ? prevN - prevD : null;
    const dupAfter = d !== undefined ? n - d : null;
    const fans = dupAfter !== null && dupBefore !== null ? dupAfter > dupBefore : n > prevN;

    const declared = step.join.cardinality;
    const declaredFanning = declared === "one_to_many" || declared === "many_to_many";

    if (fans && !declared) {
      issues.push({
        kind: "join",
        name: qual,
        error:
          `Join "${qual}" fans out in the data (${fmt(prevN)} rows → ${fmt(n)}) but declares ` +
          `no cardinality, so the compiler cannot refuse metrics that double-count across it. ` +
          `Set its cardinality to one_to_many.`,
      });
    } else if (fans && !declaredFanning) {
      issues.push({
        kind: "join",
        name: qual,
        error:
          `Join "${qual}" is declared ${declared} but MEASURES fan-out: ${fmt(prevN)} rows → ` +
          `${fmt(n)} after joining. Either the ON condition is wrong or the cardinality is — ` +
          `and SUM/AVG/COUNT over this model double-count today.`,
      });
    } else if (!fans && !declared) {
      warnings.push({
        kind: "join",
        name: qual,
        note:
          `Join "${qual}" measures 1:1 in the current data. Declare its cardinality ` +
          `(many_to_one for a lookup) so the compiler's fan-out protection is locked in ` +
          `rather than resting on today's data.`,
      });
      if (step.join.type === "inner" && !pk) {
        warnings.push({
          kind: "join",
          name: qual,
          note:
            `"${qual}" is an INNER join and no primary key is declared, so dropped rows can ` +
            `mask duplication in a bare row count. Declare the model's primary key to make ` +
            `this measurement exact.`,
        });
      }
    } else if (!fans && declaredFanning) {
      warnings.push({
        kind: "join",
        name: qual,
        note:
          `Join "${qual}" is declared ${declared} but no fan-out shows in the current data — ` +
          `fine if multi-match rows simply don't exist yet; metrics stay guarded either way.`,
      });
    }
    prevN = n;
    prevD = d;
  }

  return { issues, warnings, measured };
}

/** Most distinct values a dimension may have and still list them for agents. */
export const SAMPLE_VALUES_CAP = 8;
/** Longest stored value — longer ones mark the dimension as free-text. */
const SAMPLE_VALUE_MAX_LEN = 80;

/**
 * Sample distinct values for every CATEGORICAL dimension, from the live
 * source, through the model's own joins.
 *
 * Returns ONLY dimensions with ≤ SAMPLE_VALUES_CAP distinct values. A partial
 * list would read as a complete one in the agent catalog — `region values:
 * EMEA|AMER` with APAC missing teaches the agent that APAC does not exist,
 * which is worse than teaching it nothing. Same reasoning for a value longer
 * than SAMPLE_VALUE_MAX_LEN: that is free text, not an enum.
 *
 * A dimension whose probe FAILS is skipped silently here — the per-field
 * compile+run probes in Validate already report the failure with the right
 * kind and message; duplicating it as a sampling error would double every
 * typo.
 */
export async function sampleDimensionValues(
  exec: ExecRows,
  model: SemanticModel,
  dialect: SqlDialect,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const d of model.dimensions) {
    if (d.type !== "categorical") continue;
    try {
      const rows = await exec(sampleValuesSql(model, d.name, dialect, SAMPLE_VALUES_CAP));
      if (rows.length === 0 || rows.length > SAMPLE_VALUES_CAP) continue;
      const values = rows
        .map((r) => r.v)
        .filter((v) => v !== null && v !== undefined)
        .map((v) => String(v));
      if (values.length === 0 || values.some((v) => v.length > SAMPLE_VALUE_MAX_LEN)) continue;
      out[d.name] = values.sort((a, b) => a.localeCompare(b));
    } catch {
      /* the field probe owns this failure */
    }
  }
  return out;
}

/**
 * Re-compute each pinned assertion and compare against its expected value.
 *
 * The default tolerance is |expected| × 1e-9 — wide enough for float-sum
 * noise between engines, orders of magnitude too narrow to hide a definition
 * change. A failure does not say WHICH side moved (definition or data); the
 * message says so, because "assertion failed" being read as "code bug" when
 * the data changed is how assertions get deleted instead of re-pinned.
 */
export async function checkAssertions(
  exec: ExecRows,
  model: SemanticModel,
  assertions: MetricAssertion[],
  dialect: SqlDialect,
): Promise<{ issues: ModelIssue[]; checked: number }> {
  const issues: ModelIssue[] = [];
  let checked = 0;
  for (const a of assertions) {
    checked++;
    const name = a.label?.trim() || a.metric;
    try {
      const { sql } = compileSemanticQuery(
        model,
        { model: model.name, metrics: [a.metric], filters: a.filters ?? [], limit: 1 },
        { dialect },
      );
      const rows = await exec(sql);
      const raw = rows[0]?.[a.metric];
      const actual = num(raw);
      if (rows.length === 0 || raw === null || raw === undefined || Number.isNaN(actual)) {
        issues.push({
          kind: "assertion",
          name,
          error: `"${a.metric}" produced no value under the pinned filters (got ${JSON.stringify(raw ?? null)}).`,
        });
        continue;
      }
      const tol = a.tolerance ?? Math.max(1e-9, Math.abs(a.expected) * 1e-9);
      if (Math.abs(actual - a.expected) > tol) {
        issues.push({
          kind: "assertion",
          name,
          error:
            `"${a.metric}" expected ${fmt(a.expected)}, got ${fmt(actual)}. Either the metric's ` +
            `definition changed or the underlying data did — confirm which before re-pinning.`,
        });
      }
    } catch (e) {
      issues.push({
        kind: "assertion",
        name,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      });
    }
  }
  return { issues, checked };
}
