// Plain helpers of the report designer (R508), kept apart from its
// components so the component file only exports components.
import type { TemplateToken } from "@/components/templates/TemplateInsert";
import type { BiWidget } from "@/lib/biDashboards";
import { PARAM_NAME, paramNamesIn, type BiParamConfig, type BiParamValues } from "@/lib/biParams";
import { RESERVED_TOKEN_NAMES, type ReportBlock } from "@/lib/biReports";

/** A parameter name's problem, or null. */
export function paramNameProblem(name: string, others: BiParamConfig[]): string | null {
  if (!PARAM_NAME.test(name)) return "Lower-case letters, digits and _, starting with a letter";
  if (RESERVED_TOKEN_NAMES.includes(name)) return `{{${name}}} is filled by the report itself`;
  if (others.some((p) => p.name === name)) return "Another parameter has this name";
  return null;
}

/** The tokens a report's parameters offer to an insert menu. */
export function paramTokens(params: BiParamConfig[]): TemplateToken[] {
  return params.map((p) => ({ insert: `{{${p.name}}}`, label: p.name, detail: p.label }));
}

/** A new block's own query, before it has run. */
export function newQueryWidget(title: string): BiWidget {
  return {
    id: `w_${Math.random().toString(36).slice(2, 10)}`,
    kind: "chart",
    title,
    source: { kind: "local" },
    sql: "",
    chart: { type: "table" },
    columns: [],
    rows: [],
  };
}

/**
 * The values of the parameters a query reads: what a block records after it
 * runs, so the designer can tell later whether its rows are for the values
 * now chosen. Parameters the query does not read are left out, so changing
 * one of those never asks for a run.
 */
export function valuesRead(
  sql: string | undefined,
  params: BiParamConfig[],
  values: BiParamValues,
): BiParamValues {
  const names = new Set(paramNamesIn(sql));
  const out: BiParamValues = {};
  for (const p of params) if (names.has(p.name)) out[p.name] = values[p.name] ?? p.default;
  return out;
}

/**
 * Whether a block's rows may be for other values than these: it has a query
 * that reads a parameter, and it has not run with the values now chosen.
 * Compared name by name, since a saved block's keys come back in jsonb order.
 */
export function blockNeedsRun(
  block: ReportBlock,
  params: BiParamConfig[],
  values: BiParamValues,
): boolean {
  if (!("widget" in block) || !block.widget.sql?.trim()) return false;
  const want = valuesRead(block.widget.sql, params, values);
  const names = Object.keys(want);
  if (!names.length) return false;
  const had = block.ranWith;
  if (!had) return true;
  return names.some((n) => had[n] !== want[n]);
}
