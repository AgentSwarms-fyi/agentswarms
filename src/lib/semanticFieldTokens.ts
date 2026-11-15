// What a semantic model's dimension or metric SQL can reference (R496).
//
// The Fields tab's SQL expressions took three spellings from memory: a source
// column ("Order Date"), a declared parameter ({{min_amount}}) and, in a
// derived metric's formula, another metric ({revenue}). A typo in any of them
// surfaced only at Validate, or as a refused query. The field's menu now lists
// the ones that exist on this model, spelled the way the compiler reads them.
import type { TemplateToken } from "@/components/templates/TemplateInsert";
import type { MetricAgg, SemanticParameter } from "@/lib/semanticLayer";

/** The compiler's name grammar for parameters and metrics. */
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type SemanticFragmentKind = "dimension" | "metric" | "derived";

export function semanticFragmentTokens({
  kind,
  columns,
  parameters,
  metrics,
  self,
}: {
  kind: SemanticFragmentKind;
  /** The source's columns, when known. */
  columns: Array<{ name: string; type?: string }>;
  parameters: SemanticParameter[];
  /** The model's metrics: a derived formula's operands. */
  metrics: Array<{ name: string; agg: MetricAgg; label?: string }>;
  /** The metric being edited, which its own formula cannot reference. */
  self?: string;
}): TemplateToken[] {
  const out: TemplateToken[] = [];
  if (kind === "derived") {
    for (const m of metrics) {
      if (!NAME_RE.test(m.name) || m.name === self) continue;
      out.push({
        insert: `{${m.name}}`,
        label: m.name,
        detail: m.label ? `${m.agg} · ${m.label}` : m.agg,
        group: "Metrics",
      });
    }
  } else {
    for (const c of columns) {
      out.push({
        // Double quotes, as "+ from column" writes them: the compiler re-quotes
        // for the target engine (normaliseIdentQuotes), so one spelling serves
        // every dialect. A name holding a double quote goes in backticks — the
        // re-quoter ends an identifier at the first matching quote, so `"a""b"`
        // would split in two, while `a"b` in backticks comes out escaped.
        insert: c.name.includes('"') ? `\`${c.name}\`` : `"${c.name}"`,
        label: c.name,
        detail: c.type || undefined,
        group: "Columns",
      });
    }
  }
  for (const p of parameters) {
    if (!NAME_RE.test(p.name)) continue;
    const def = p.default === undefined || p.default === "" ? "no default" : `default ${p.default}`;
    out.push({
      insert: `{{${p.name}}}`,
      label: p.name,
      detail: p.description ? `${p.type}, ${def} · ${p.description}` : `${p.type}, ${def}`,
      group: "Parameters",
    });
  }
  return out;
}
