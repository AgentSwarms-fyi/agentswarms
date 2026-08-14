// What-if: re-running a governed step under different assumptions.
//
// WHY THIS SHAPE. The honest version of "what if" is not a new query written
// to match a hopeful premise — it is the SAME governed query, recompiled with
// one thing changed, so the difference between the two numbers is the effect
// of that one change and nothing else. That is only possible because the step
// is compiled from a semantic model rather than hand-written: the baseline and
// the scenario come from the identical definitions, through the identical
// compiler, under the identical row filters.
//
// A scenario can vary exactly two things, and both are already governed:
//
//   ASSUMPTIONS — the model's DECLARED parameters. `{{commission_rate}}` in a
//     metric's SQL is an assumption its author named and typed, and varying it
//     is the real thing being asked for.
//   SCOPE — the values of filters the step already has. "The same question,
//     for Enterprise only" is a different slice, not a different definition.
//
// It cannot invent a parameter, change a metric's formula, or filter on a
// field the step never selected. Those would not be the same question asked
// twice; they would be two questions with one label.
//
// AND THE RESULT IS NOT A MEASUREMENT. A scenario says what the numbers WOULD
// be if an assumption held. It is labelled, shown beside the baseline rather
// than replacing it, and never folded into the findings — the write-up
// describes what was measured, and a projection that quietly joins it is the
// exact failure this codebase keeps designing against.
import type { SemanticFilter, SemanticQuery } from "@/lib/semanticLayer";

/** A parameter as declared on the model — the only assumptions that can vary. */
export type ScenarioParameter = {
  name: string;
  type: "number" | "string";
  default: string | number;
  label?: string;
  description?: string;
};

/** One thing the user changed, kept for the label. */
export type ScenarioChange = {
  kind: "parameter" | "filter";
  /** Parameter name, or the filter's field. */
  name: string;
  from: string;
  to: string;
};

export type ScenarioPlan = {
  query: SemanticQuery;
  changes: ScenarioChange[];
};

const asText = (v: unknown): string =>
  v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v);

/**
 * What this step could be asked differently, or an empty list.
 *
 * Empty is a real answer and the UI must say it plainly: a model with no
 * declared parameters and a step with no filters has nothing a scenario could
 * vary, and offering a control that cannot change anything teaches people the
 * feature is broken rather than inapplicable.
 */
export function scenarioLevers(
  query: SemanticQuery | undefined,
  parameters: ScenarioParameter[],
): { parameters: ScenarioParameter[]; filters: SemanticFilter[] } {
  if (!query) return { parameters: [], filters: [] };
  return {
    parameters: parameters ?? [],
    // Relative-date filters are excluded: "last 30 days" has no value to edit,
    // and rewriting the window is a different question, not an assumption.
    filters: (query.filters ?? []).filter(
      (f) => f.value !== undefined && !String(f.op).startsWith("last_"),
    ),
  };
}

/**
 * Build the scenario query, or null when nothing actually changed.
 *
 * Null matters: re-running an identical query and presenting the identical
 * numbers under a "scenario" heading invites the reader to believe a change
 * was tested and made no difference — the one conclusion this must never
 * fabricate.
 */
export function buildScenario(args: {
  baseline: SemanticQuery;
  parameters: ScenarioParameter[];
  /** Parameter name → new value, as typed by the user. */
  paramOverrides?: Record<string, string>;
  /** Filter field → new value, as typed by the user. */
  filterOverrides?: Record<string, string>;
}): ScenarioPlan | null {
  const declared = new Map((args.parameters ?? []).map((p) => [p.name, p]));
  const changes: ScenarioChange[] = [];

  // ── Assumptions ──
  const params: Record<string, string | number> = { ...(args.baseline.params ?? {}) };
  for (const [name, raw] of Object.entries(args.paramOverrides ?? {})) {
    const p = declared.get(name);
    // A parameter the model does not declare cannot be varied: the compiler
    // would refuse it anyway, and refusing here names the reason.
    if (!p) continue;
    const text = String(raw ?? "").trim();
    if (text === "") continue;
    const before = asText(args.baseline.params?.[name] ?? p.default);
    if (text === before) continue;
    if (p.type === "number") {
      const n = Number(text);
      // A number parameter given a non-number is a typo, not a scenario.
      if (!Number.isFinite(n)) continue;
      params[name] = n;
      changes.push({ kind: "parameter", name, from: before, to: String(n) });
    } else {
      params[name] = text;
      changes.push({ kind: "parameter", name, from: before, to: text });
    }
  }

  // ── Scope ──
  const filters: SemanticFilter[] = (args.baseline.filters ?? []).map((f) => {
    const raw = args.filterOverrides?.[f.field];
    if (raw === undefined) return f;
    const text = String(raw).trim();
    const before = asText(f.value);
    if (text === "" || text === before) return f;
    changes.push({ kind: "filter", name: f.field, from: before, to: text });
    // `in`/`not_in` take a list; everything else takes the scalar as typed.
    const value =
      f.op === "in" || f.op === "not_in"
        ? text
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : text;
    return { ...f, value };
  });

  if (changes.length === 0) return null;

  const query: SemanticQuery = { ...args.baseline };
  if (Object.keys(params).length) query.params = params;
  if (filters.length) query.filters = filters;
  return { query, changes };
}

/** One line naming what was assumed — the label a scenario has to carry. */
export function describeScenario(changes: ScenarioChange[]): string {
  if (changes.length === 0) return "";
  const parts = changes.map((c) => `${c.name} ${c.from} → ${c.to}`);
  return `Scenario — ${parts.join(", ")}`;
}

export type MetricDelta = {
  metric: string;
  baseline: number;
  scenario: number;
  change: number;
  /** Null when the baseline is zero: percentage change from nothing is not a number. */
  pctChange: number | null;
};

/**
 * Compare the two results, in code.
 *
 * Same discipline as the driver analysis: a model asked to eyeball two tables
 * and report the difference produces a plausible number, and a plausible
 * difference reads exactly as confident as a correct one. Only single-row
 * results are compared — with dimensions in play there is a row-matching
 * problem, and matching rows wrongly is worse than not comparing.
 */
export function scenarioDelta(
  metrics: string[],
  baselineRows: Record<string, unknown>[],
  scenarioRows: Record<string, unknown>[],
): MetricDelta[] {
  if (baselineRows.length !== 1 || scenarioRows.length !== 1) return [];
  const b = baselineRows[0];
  const s = scenarioRows[0];
  const out: MetricDelta[] = [];
  for (const m of metrics) {
    const bv = Number(b?.[m]);
    const sv = Number(s?.[m]);
    if (!Number.isFinite(bv) || !Number.isFinite(sv)) continue;
    out.push({
      metric: m,
      baseline: bv,
      scenario: sv,
      change: sv - bv,
      pctChange: bv === 0 ? null : (sv - bv) / bv,
    });
  }
  return out;
}
