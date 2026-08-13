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
  calendarProbeSql,
  compileSemanticQuery,
  fanoutProbeSql,
  joinQualifier,
  rollupProbeSql,
  sampleValuesSql,
  type MetricAssertion,
  type SemanticModel,
  type SqlDialect,
} from "@/lib/semanticLayer";

/** Runs one read-only statement and returns its rows. */
export type ExecRows = (sql: string) => Promise<Record<string, unknown>[]>;

export type ModelIssueKind =
  | "dimension"
  | "metric"
  | "model"
  | "join"
  | "assertion"
  | "calendar"
  | "rollup";
export type ModelIssue = { kind: ModelIssueKind; name: string; error: string };
/** Non-fatal findings: things worth declaring, not things that are wrong. */
export type ModelWarning = {
  kind: "join" | "assertion" | "calendar" | "rollup";
  name: string;
  note: string;
};

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

/**
 * Measure the declared fiscal calendar table.
 *
 * The compiler already makes a dirty calendar UNABLE to multiply fact rows
 * (its join is grouped per day) — what dirt can still do is mislabel days
 * (duplicate rows: MIN wins arbitrarily), leave days unmapped (facts bucket
 * NULL), end before today (relative windows go empty), or break the sequence
 * order comparisons step along. Each is measured, none is trusted.
 */
export async function measureCalendarHealth(
  exec: ExecRows,
  model: SemanticModel,
  dialect: SqlDialect,
  /** Reference day for the coverage check; tests pin it. */
  now: Date = new Date(),
): Promise<{ issues: ModelIssue[]; warnings: ModelWarning[] }> {
  const issues: ModelIssue[] = [];
  const warnings: ModelWarning[] = [];
  const probe = calendarProbeSql(model, dialect);
  if (!probe) return { issues, warnings };
  const name = model.calendar!.table;

  let shape: Record<string, unknown>;
  try {
    shape = (await exec(probe.shapeSql))[0] ?? {};
  } catch (e) {
    issues.push({
      kind: "calendar",
      name,
      error: `Calendar table could not be measured: ${(e as Error).message}`.slice(0, 300),
    });
    return { issues, warnings };
  }
  const n = num(shape.n);
  const days = num(shape.days);
  const span = num(shape.span) + 1;
  if (n === 0) {
    issues.push({ kind: "calendar", name, error: "The calendar table is empty." });
    return { issues, warnings };
  }
  if (n > days) {
    issues.push({
      kind: "calendar",
      name,
      error:
        `${fmt(n)} rows over ${fmt(days)} distinct days — duplicate day rows. Queries keep ` +
        `exactly one mapping per day (the smallest sequence), so rows never multiply, but ` +
        `which period those days report is arbitrary until the duplicates are removed.`,
    });
  }
  if (Number.isFinite(span) && days < span) {
    warnings.push({
      kind: "calendar",
      name,
      note:
        `Covers ${fmt(days)} of the ${fmt(span)} days between ${String(shape.lo)} and ` +
        `${String(shape.hi)} — facts on the missing days bucket as NULL.`,
    });
  }
  const today = new Date(now).toISOString().slice(0, 10);
  if (String(shape.hi) < today) {
    warnings.push({
      kind: "calendar",
      name,
      note:
        `Ends ${String(shape.hi)}, before today (${today}) — relative fiscal windows ` +
        `(this_fiscal_period, fiscal_ytd…) resolve against today and will be empty.`,
    });
  }

  for (const g of probe.grains) {
    try {
      const conflicts = num(((await exec(g.conflictSql))[0] ?? {}).bad);
      if (conflicts > 0) {
        issues.push({
          kind: "calendar",
          name: g.grain,
          error:
            `${fmt(conflicts)} ${g.grain} sequence(s) map to more than one start date — ` +
            `buckets and comparisons disagree about where those periods begin.`,
        });
      }
      const misordered = num(((await exec(g.orderSql))[0] ?? {}).bad);
      if (misordered > 0) {
        issues.push({
          kind: "calendar",
          name: g.grain,
          error:
            `${fmt(misordered)} consecutive ${g.grain} sequence(s) whose start dates do not ` +
            `increase — "previous period" steps the sequence, so comparisons would pair the ` +
            `wrong periods.`,
        });
      }
    } catch (e) {
      issues.push({
        kind: "calendar",
        name: g.grain,
        error: `Grain could not be measured: ${(e as Error).message}`.slice(0, 300),
      });
    }
  }
  return { issues, warnings };
}

/**
 * Measure each declared rollup against the fact table it claims to
 * pre-aggregate: the grand total of every mapped metric, computed BOTH ways.
 *
 * The fact side compiles with rollups STRIPPED so the check can never route
 * into the thing it is checking. A disagreement does not say which side is
 * wrong — a stale rollup and a corrected fact look identical from here — so
 * the message says to refresh the rollup or fix the mapping, not which.
 * Tolerance matches assertions: |fact| × 1e-9, float-sum noise wide, a
 * definition or staleness gap narrow.
 */
export async function measureRollupHealth(
  exec: ExecRows,
  model: SemanticModel,
  dialect: SqlDialect,
): Promise<{ issues: ModelIssue[]; checked: number }> {
  const issues: ModelIssue[] = [];
  let checked = 0;
  const probes = rollupProbeSql(model, dialect);
  if (probes.length === 0) return { issues, checked };
  const factModel: SemanticModel = { ...model, rollups: undefined };

  for (const p of probes) {
    checked++;
    const name = `${p.table} · ${p.metric}`;
    try {
      const { sql } = compileSemanticQuery(
        factModel,
        { model: model.name, metrics: [p.metric], limit: 1 },
        { dialect },
      );
      const factRaw = (await exec(sql))[0]?.[p.metric];
      const rollRaw = (await exec(p.sql))[0]?.v;
      const fact = num(factRaw);
      const roll = num(rollRaw);
      if (factRaw === null || factRaw === undefined || Number.isNaN(fact)) {
        // An empty fact against an empty rollup agrees; against numbers it
        // does not.
        if (rollRaw !== null && rollRaw !== undefined && !Number.isNaN(roll)) {
          issues.push({
            kind: "rollup",
            name,
            error: `The fact table computes no value for "${p.metric}" but the rollup holds ${fmt(roll)}.`,
          });
        }
        continue;
      }
      const tol = Math.max(1e-9, Math.abs(fact) * 1e-9);
      if (Number.isNaN(roll) || Math.abs(fact - roll) > tol) {
        issues.push({
          kind: "rollup",
          name,
          error:
            `"${p.metric}" totals ${fmt(fact)} on the fact table but ${Number.isNaN(roll) ? "no value" : fmt(roll)} ` +
            `in the rollup — the rollup is stale or its mapping is wrong. Queries it answers ` +
            `disagree with the fact table by exactly this gap. Refresh the rollup table or fix ` +
            `the column mapping.`,
        });
      }
    } catch (e) {
      issues.push({
        kind: "rollup",
        name,
        error: `Rollup could not be measured: ${(e as Error).message}`.slice(0, 300),
      });
    }
  }
  return { issues, checked };
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
