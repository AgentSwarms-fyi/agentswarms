// Custom components: reusable, user-authored transform nodes.
//
// A component is a name, a declared parameter schema and a snippet of
// sandboxed JavaScript. Dropping one on the canvas creates an ordinary
// `function` node carrying a SNAPSHOT of the component's code and params, plus
// the component id and the version it was copied from.
//
// Snapshot, not live link — deliberately:
//   • a swarm keeps running the code it was tested with, so editing a
//     component cannot silently change a swarm that already works;
//   • an exported or shared swarm carries everything it needs;
//   • "the library has a newer version" is surfaced, and adopting it is an
//     explicit act (componentOutdated below drives that).
//
// PURE module — no Supabase, no DOM — so the rules below are unit-testable and
// shared by the palette, the inspector and the runtime.

export type ComponentParamType = "text" | "number" | "boolean" | "select";

export type ComponentParam = {
  name: string;
  label?: string;
  type: ComponentParamType;
  options?: string[];
  default?: string;
  required?: boolean;
};

export type SwarmComponent = {
  id: string;
  name: string;
  description: string;
  category: string;
  params: ComponentParam[];
  code: string;
  version: number;
  updated_at?: string;
};

/** What a component-bound node stores on its node data. */
export type ComponentBinding = {
  componentId: string;
  componentName: string;
  componentVersion: number;
  /** Snapshot of the component's code at bind (or last update) time. */
  functionCode: string;
  /** Snapshot of the declared schema, so the form renders without a fetch. */
  componentParams: ComponentParam[];
  /** The values the user set for THIS node. */
  componentValues: Record<string, string>;
};

export const COMPONENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/;
export const PARAM_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const COMPONENT_MAX_CODE_CHARS = 20_000;

export function validateComponent(c: {
  name: string;
  code: string;
  params: ComponentParam[];
}): string | null {
  if (!COMPONENT_NAME_RE.test(c.name.trim()))
    return "Name must start with a letter or digit and use only letters, digits, spaces, _ or -.";
  if (!c.code.trim()) return "The component needs some code.";
  if (c.code.length > COMPONENT_MAX_CODE_CHARS)
    return `Code is ${c.code.length} characters — the limit is ${COMPONENT_MAX_CODE_CHARS}.`;
  const seen = new Set<string>();
  for (const p of c.params) {
    if (!PARAM_NAME_RE.test(p.name))
      return `Parameter "${p.name}": names must be a valid identifier (letters, digits, _; not starting with a digit).`;
    if (seen.has(p.name)) return `Parameter "${p.name}" is declared twice.`;
    seen.add(p.name);
    if (p.type === "select" && (!p.options || p.options.length === 0))
      return `Parameter "${p.name}": a select needs at least one option.`;
  }
  return null;
}

/** Values a fresh node starts with: each param's default, else empty. */
export function defaultValues(params: ComponentParam[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) out[p.name] = p.default ?? (p.type === "boolean" ? "false" : "");
  return out;
}

/**
 * Coerce the string-keyed form values into the types the snippet expects.
 * Flow state is strings everywhere, but a component that declared `limit` as a
 * number should receive a number rather than "5" — otherwise every component
 * author writes the same Number(...) boilerplate, and half of them forget.
 */
export function coerceParams(
  params: ComponentParam[],
  values: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    const raw = values[p.name] ?? p.default ?? "";
    if (p.type === "number") {
      const n = Number(raw);
      out[p.name] = Number.isFinite(n) ? n : null;
    } else if (p.type === "boolean") {
      out[p.name] = raw === "true" || raw === "1" || raw === "yes";
    } else {
      out[p.name] = raw;
    }
  }
  return out;
}

/** Required params with no value — checked before a run, not during one. */
export function missingRequired(
  params: ComponentParam[],
  values: Record<string, string>,
): string[] {
  return params
    .filter((p) => p.required && !(values[p.name] ?? p.default ?? "").trim())
    .map((p) => p.name);
}

/** True when the library has moved past the version this node snapshotted. */
export function componentOutdated(
  binding: { componentId?: string; componentVersion?: number },
  library: Pick<SwarmComponent, "id" | "version">[],
): boolean {
  if (!binding.componentId) return false;
  const lib = library.find((c) => c.id === binding.componentId);
  if (!lib) return false;
  return lib.version > (binding.componentVersion ?? 0);
}

/** The node-data patch that binds (or re-binds) a node to a component. */
export function bindingFor(
  c: SwarmComponent,
  keepValues?: Record<string, string>,
): ComponentBinding & { label: string } {
  const values = { ...defaultValues(c.params) };
  // Preserve values the user already set for params that still exist — an
  // update to the library must not silently reset a configured node.
  if (keepValues) {
    for (const p of c.params) {
      if (keepValues[p.name] !== undefined) values[p.name] = keepValues[p.name];
    }
  }
  return {
    label: c.name,
    componentId: c.id,
    componentName: c.name,
    componentVersion: c.version,
    functionCode: c.code,
    componentParams: c.params,
    componentValues: values,
  };
}

export const STARTER_CODE = `// ctx.input  — the value flowing into this node
// ctx.vars   — the swarm's flow state
// ctx.params — this node's configured parameters
const text = String(ctx.input ?? "");
return text.slice(0, ctx.params.limit ?? 100);`;
