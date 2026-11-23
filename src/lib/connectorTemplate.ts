// One connector template and how it is filled in (R528). Separate from the
// list of templates (./connectorTemplates), which Vite gathers from
// src/connectors/ at build time, so scripts and the server can fill a template
// read from its file.
import { checkConnectorSpec, type ConnectorSpec } from "@/lib/connectorSpec";

export type TemplateInput = { key: string; label: string; placeholder?: string };

export type ConnectorTemplate = {
  id: string;
  label: string;
  description: string;
  checked: "live" | "reference";
  inputs: TemplateInput[];
  /** Where to get the credential, and how the API takes it. */
  credential: string;
  /** A spec whose base_url, paths, params and name may hold `{input}`. */
  spec: unknown;
};

/** What an input may hold: one path segment or host label, nothing that moves a request. */
export const INPUT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A template's spec with its inputs filled in, checked; or what is missing. */
export function applyTemplate(
  t: ConnectorTemplate,
  values: Record<string, string>,
): { ok: true; spec: ConnectorSpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const i of t.inputs) {
    const v = (values[i.key] ?? "").trim();
    if (!v) errors.push(`${i.label} is needed`);
    else if (!INPUT_VALUE.test(v)) {
      errors.push(`${i.label}: letters, digits, dots, dashes and underscores only`);
    }
  }
  if (errors.length) return { ok: false, errors };
  const fill = (s: string) =>
    s.replace(/\{([a-z_]+)\}/g, (m, k: string) =>
      t.inputs.some((i) => i.key === k) ? (values[k] ?? "").trim() : m,
    );
  // Every string in the spec, filled; `{credential}` and `{username}` are not
  // inputs and stay for the engine.
  const walk = (v: unknown): unknown =>
    typeof v === "string"
      ? fill(v)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]),
            )
          : v;
  return checkConnectorSpec(walk(t.spec));
}
