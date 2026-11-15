// What a pipeline node can reference as `{{params.x}}` (R496).
//
// Four node fields — a storage source's path, an HTTP source's URL, a filter's
// condition and a SQL step's query — resolve run parameters when the pipeline
// runs (utils/etl/codegen.ts, pyTemplate). Nothing on screen said so: the
// spelling, the `|fallback` form and where the value comes from were only in
// the compiler's comments. The editor now offers the names that exist here.
import type { TemplateToken } from "@/components/templates/TemplateInsert";
import { graphParamRefs, type EtlGraph } from "@/utils/etl/codegen";

/** A name a field can reference: the compiler's grammar, `params.<identifier>`. */
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const show = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

/**
 * The parameters a node field is offered: the pipeline's default parameters
 * (Settings), then any name its nodes already read that the defaults do not
 * set — those still resolve, from a run's own parameters or the field's
 * `|fallback`, so they are listed rather than hidden.
 */
export function etlParamTokens(
  defaults: Record<string, unknown> | null | undefined,
  graph: EtlGraph,
): TemplateToken[] {
  const out: TemplateToken[] = [];
  const declared =
    defaults && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {};
  for (const [name, v] of Object.entries(declared)) {
    // `{{params.start-date}}` can never match the compiler's pattern, so a key
    // like that is not offered — inserting it would read as a parameter and
    // reach the program as literal text.
    if (!PARAM_NAME_RE.test(name)) continue;
    out.push({
      insert: `{{params.${name}}}`,
      label: `params.${name}`,
      detail: v === null ? "Default: none" : `Default: ${show(v)}`,
      group: "Pipeline parameters",
    });
  }
  for (const [name, fallback] of graphParamRefs(graph)) {
    if (name in declared) continue;
    out.push({
      insert: `{{params.${name}}}`,
      label: `params.${name}`,
      detail:
        fallback === undefined
          ? "No default — empty unless a run sets it"
          : `No default — falls back to "${show(fallback)}" where written`,
      group: "Used in this pipeline",
    });
  }
  return out;
}

/** Shown under a menu with nothing to offer yet. */
export const ETL_PARAM_EMPTY =
  'Set default parameters in Settings, e.g. {"day": "2026-01-01"}, and they are listed here.';

/** The format, shown under every field that resolves parameters. */
export const ETL_PARAM_HINT =
  "{{params.name}} is the run's value — Run with parameters, else the pipeline's default " +
  "parameters (Settings). {{params.name|value}} uses value when neither sets it. The value goes " +
  "in as text.";

// Python keywords a pandas condition cannot use as a bare column name.
const PY_KEYWORDS = new Set([
  "and",
  "or",
  "not",
  "in",
  "is",
  "if",
  "else",
  "for",
  "lambda",
  "None",
  "True",
  "False",
]);

/**
 * The upstream columns as a filter/derive expression (pandas query syntax)
 * or a SQL step spells them: a name pandas cannot read bare goes in backticks,
 * and SQL always quotes, so a column called `order` or `Unit Price` works.
 */
export function etlColumnTokens(columns: string[], syntax: "pandas" | "sql"): TemplateToken[] {
  return columns.map((col) => ({
    insert:
      syntax === "sql"
        ? `"${col.replace(/"/g, '""')}"`
        : /^[A-Za-z_][A-Za-z0-9_]*$/.test(col) && !PY_KEYWORDS.has(col)
          ? col
          : `\`${col.replace(/`/g, "")}\``,
    label: col,
    group: "Columns",
  }));
}

/**
 * What Run with parameters opens with: the defaults, plus every name the
 * nodes read with no default and no fallback, as "" — which runs exactly as
 * leaving it out would — so the key to fill in is on screen.
 *
 * A name with a `|fallback` is NOT added: two fields may give the same name
 * different fallbacks, and pinning one value would change what the other
 * reads. The dialog lists those instead.
 */
export function runParamsDraft(
  defaults: Record<string, unknown> | null | undefined,
  reads: Map<string, string | undefined>,
): Record<string, unknown> | null {
  const base =
    defaults && typeof defaults === "object" && !Array.isArray(defaults) ? { ...defaults } : {};
  for (const [name, fallback] of reads) {
    if (!(name in base) && fallback === undefined) base[name] = "";
  }
  return Object.keys(base).length ? base : null;
}
