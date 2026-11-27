// The names inside a swarm's graph: each node's name, and each start-form
// field's name and label on the input node.
//
// None of them had a rule. The inspector wrote whatever its fields held, so a
// node could be named "" or "   " (a blank title on the canvas, a nameless
// step in the run's timeline, "Approve step: " on its approval) or be any
// length; and a start-form field could have no name, or the same name as
// another field. A field's value is stored in the run under its name, so an
// unnamed field's value went where no prompt could read it, and two fields of
// one name shared a single value in the Run panel.
//
// The rules live here once. The inspector applies them as you type, a save
// repairs anything older that breaks them (repairSwarmNodes), and the database
// holds the same rules (migration 20261212000000_swarm_node_names.sql), since
// the browser writes a swarm's graph straight to its row.
import { clampName, hasVisibleName, NAME_MAX_LENGTH, nameLength } from "@/lib/visibleName";

/** The longest a node's name may be: the limit every other name has. */
export const NODE_LABEL_MAX_LENGTH = NAME_MAX_LENGTH;
/** The longest a start-form field's name may be (it is a variable name). */
export const FIELD_NAME_MAX_LENGTH = 64;
/** The longest a start-form field's label may be. */
export const FIELD_LABEL_MAX_LENGTH = NAME_MAX_LENGTH;

/** What a node with no name is shown as, and saved as. */
export const UNTITLED_NODE_LABEL = "Untitled";

// ── A node's name ────────────────────────────────────────────────────────────

/**
 * What the Label field writes to the node for the text it holds: the name
 * without the spaces around it, cut to the limit, or null (write nothing)
 * while it is blank.
 */
export function nodeLabelToCommit(typed: string): string | null {
  return hasVisibleName(typed) ? clampName(typed.trim()) : null;
}

/** A node's name as the canvas and the inspector show it. */
export function shownNodeLabel(label: unknown): string {
  return hasVisibleName(label) ? label : UNTITLED_NODE_LABEL;
}

// ── A start-form field ───────────────────────────────────────────────────────

/** A field's name as typed, kept to what a variable name may hold. */
export function cleanFieldName(typed: string): string {
  return typed.replace(/[^A-Za-z0-9_]/g, "").slice(0, FIELD_NAME_MAX_LENGTH);
}

/**
 * Why a field cannot have this name, or null when it can. `others` are the
 * names of the node's other fields.
 */
export function fieldNameProblem(name: string, others: readonly string[]): string | null {
  if (name === "") return "A field needs a name.";
  if (others.includes(name)) return `Another field is already named ${name}.`;
  return null;
}

/** The first `field_N` none of the node's fields has, for a new field. */
export function nextFieldName(names: readonly string[]): string {
  const taken = new Set(names);
  let n = names.length + 1;
  while (taken.has(`field_${n}`)) n++;
  return `field_${n}`;
}

/**
 * What a field's label holds for the text typed: the text, cut to the limit,
 * or "" while it is only spaces (a field with no label shows its name).
 */
export function fieldLabelToCommit(typed: string): string {
  return hasVisibleName(typed) ? clampName(typed) : "";
}

/** A field's label as the Run panel shows it: its label, or else its name. */
export function shownFieldLabel(field: { name: string; label?: unknown }): string {
  return hasVisibleName(field.label) ? field.label.trim() : field.name;
}

// ── An edit in progress ──────────────────────────────────────────────────────

/**
 * A name field's text after the name it edits changed. Kept while it is the
 * name the field itself just wrote (it may still end in the space being
 * typed); replaced when the name was set elsewhere, such as by importing an
 * agent into the node.
 */
export function nameDraft(draft: string, value: string): string {
  return draft.trim() === value ? draft : value;
}

// ── The whole graph: the same rules the database holds ──────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const FIELD_NAME_RE = new RegExp(`^[A-Za-z0-9_]{1,${FIELD_NAME_MAX_LENGTH}}$`);

/**
 * Why a graph's names cannot be stored, as a sentence, or null when they can.
 * The same rules as the database's swarm_nodes_named(): a node whose `data` is
 * an object has a name of 1 to 120 characters with something visible in it;
 * a start-form field (an object in its `inputFields`) has a name of letters,
 * digits and _, at most 64, that no other field of its node has, and a label
 * that is absent, empty, or 1 to 120 characters with something visible in it.
 * What is not an object is not a node or a field the app can show; it is left
 * alone, here and in the database.
 */
export function swarmNodesProblem(nodes: unknown): string | null {
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    const data = isObj(node) ? node.data : undefined;
    if (!isObj(data)) continue;
    if (!hasVisibleName(data.label)) return "A node has no name.";
    if (nameLength(data.label) > NODE_LABEL_MAX_LENGTH) {
      return `A node's name is longer than ${NODE_LABEL_MAX_LENGTH} characters.`;
    }
    if (!Array.isArray(data.inputFields)) continue;
    const seen = new Set<string>();
    for (const field of data.inputFields) {
      if (!isObj(field)) continue;
      const name = field.name;
      if (typeof name !== "string" || !FIELD_NAME_RE.test(name)) {
        return `A start-form field of "${data.label}" has no usable name.`;
      }
      if (seen.has(name)) return `Two start-form fields of "${data.label}" are named ${name}.`;
      seen.add(name);
      const label = field.label;
      if (label == null || label === "") continue;
      if (!hasVisibleName(label) || nameLength(label) > FIELD_LABEL_MAX_LENGTH) {
        return `The start-form field ${name} has a blank or too long label.`;
      }
    }
  }
  return null;
}

/**
 * The graph with every name that breaks a rule repaired, and nothing else
 * changed: a blank node name becomes "Untitled", a long one is cut; a field's
 * name is cleaned, and given `field_N` when nothing is left or `<name>_2` when
 * another field has it; a blank field label is dropped, a long one cut. What a
 * save writes, so an older graph (a restored version, an imported file) is
 * stored, not refused. The migration repairs stored rows the same way.
 */
export function repairSwarmNodes<T>(nodes: T[]): T[] {
  return nodes.map((node) => {
    if (!isObj(node) || !isObj(node.data)) return node;
    const data: Obj = { ...node.data };
    const label = hasVisibleName(data.label) ? clampName(data.label) : "";
    data.label = hasVisibleName(label) ? label : UNTITLED_NODE_LABEL;
    if (Array.isArray(data.inputFields)) data.inputFields = repairFields(data.inputFields);
    return { ...node, data } as T;
  });
}

function repairFields(fields: unknown[]): unknown[] {
  const names = fields.map((f) =>
    isObj(f) && typeof f.name === "string" ? cleanFieldName(f.name) : "",
  );
  const taken = new Set<string>();
  return fields.map((f, i) => {
    if (!isObj(f)) return f;
    let name = names[i];
    if (name === "" || taken.has(name)) {
      const base = name === "" ? "field" : name.slice(0, FIELD_NAME_MAX_LENGTH - 4);
      let n = name === "" ? i + 1 : 2;
      while (taken.has(`${base}_${n}`) || names.includes(`${base}_${n}`)) n++;
      name = `${base}_${n}`;
    }
    taken.add(name);
    const out: Obj = { ...f, name };
    if (out.label != null && out.label !== "") {
      const label = hasVisibleName(out.label) ? clampName(out.label) : "";
      if (hasVisibleName(label)) out.label = label;
      else delete out.label;
    }
    return out;
  });
}
