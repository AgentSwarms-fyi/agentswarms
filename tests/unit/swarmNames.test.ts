// The names inside a swarm's graph: each node's name, and each start-form
// field's name and label on the input node.
//
// None had a rule. A node could be named "" or "   " (a blank title on the
// canvas, a nameless step in the run's timeline, "Approve step: " on its
// approval) or be any length. A start-form field could have no name, or the
// same name as another field: the run stores a field's value under its name,
// so an unnamed field's value went where no prompt could read it, and two
// fields of one name shared one value in the Run panel.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  FIELD_LABEL_MAX_LENGTH,
  FIELD_NAME_MAX_LENGTH,
  NODE_LABEL_MAX_LENGTH,
  UNTITLED_NODE_LABEL,
  cleanFieldName,
  fieldLabelToCommit,
  fieldNameProblem,
  nameDraft,
  nextFieldName,
  nodeLabelToCommit,
  repairSwarmNodes,
  shownFieldLabel,
  shownNodeLabel,
  swarmNodesProblem,
} from "@/lib/swarmNames";
import { importSwarm } from "@/lib/swarmPortable";
import { SWARM_TEMPLATES } from "@/lib/swarmTemplates";
import { NAME_MAX_LENGTH } from "@/lib/visibleName";

const read = (p: string) => readFileSync(p, "utf8");
const node = (data: Record<string, unknown>) => ({ id: "n1", position: { x: 0, y: 0 }, data });
const input = (inputFields: unknown[], label = "Input") =>
  node({ kind: "input", label, inputFields });

describe("a node's name", () => {
  it("is written only while it holds something visible", () => {
    for (const blank of ["", " ", "   ", "\t", " \n "]) expect(nodeLabelToCommit(blank)).toBeNull();
  });

  it("is written without the spaces around it, and at most 120 characters", () => {
    expect(nodeLabelToCommit("  Writer  ")).toBe("Writer");
    expect(NODE_LABEL_MAX_LENGTH).toBe(NAME_MAX_LENGTH);
    expect(Array.from(nodeLabelToCommit("🙂".repeat(130))!)).toHaveLength(120);
  });

  it("is shown as 'Untitled' when a graph saved or imported earlier has a blank one", () => {
    for (const blank of ["", "   ", undefined, null])
      expect(shownNodeLabel(blank)).toBe("Untitled");
    expect(UNTITLED_NODE_LABEL).toBe("Untitled");
    expect(shownNodeLabel("Writer")).toBe("Writer");
  });
});

describe("a start-form field's name", () => {
  it("keeps only what a variable name may hold, at most 64 characters", () => {
    expect(cleanFieldName("my field-1.x")).toBe("myfield1x");
    expect(cleanFieldName("   ")).toBe("");
    expect(cleanFieldName("f".repeat(80))).toHaveLength(FIELD_NAME_MAX_LENGTH);
    expect(FIELD_NAME_MAX_LENGTH).toBe(64);
  });

  it("is required", () => {
    expect(fieldNameProblem("", [])).toBe("A field needs a name.");
  });

  it("is unique on its node", () => {
    expect(fieldNameProblem("topic", ["topic", "tone"])).toBe(
      "Another field is already named topic.",
    );
    expect(fieldNameProblem("topic", ["tone"])).toBeNull();
  });

  it("of a new field is a field_N no field has, even after one was removed", () => {
    expect(nextFieldName([])).toBe("field_1");
    expect(nextFieldName(["field_1", "field_3"])).toBe("field_4");
    expect(nextFieldName(["field_3", "field_4"])).toBe("field_5");
  });
});

describe("a start-form field's label", () => {
  it("is empty while only spaces are typed, so the field shows its name", () => {
    expect(fieldLabelToCommit("   ")).toBe("");
    expect(shownFieldLabel({ name: "topic", label: "   " })).toBe("topic");
    expect(shownFieldLabel({ name: "topic" })).toBe("topic");
    expect(shownFieldLabel({ name: "topic", label: " Topic " })).toBe("Topic");
  });

  it("holds at most 120 characters", () => {
    expect(FIELD_LABEL_MAX_LENGTH).toBe(NAME_MAX_LENGTH);
    expect(Array.from(fieldLabelToCommit("Q".repeat(130)))).toHaveLength(120);
  });
});

describe("a name field's text while it is edited", () => {
  it("is kept while it is the name the field just wrote, trailing space and all", () => {
    expect(nameDraft("Research ", "Research")).toBe("Research ");
  });

  it("is replaced when the name was set elsewhere, such as by importing an agent", () => {
    expect(nameDraft("Writer", "Refund triage agent")).toBe("Refund triage agent");
    expect(nameDraft("", "Refund triage agent")).toBe("Refund triage agent");
  });
});

describe("a whole graph, by the database's rules", () => {
  it("passes when every node and field is named", () => {
    expect(
      swarmNodesProblem([
        node({ label: "Writer" }),
        input([{ name: "topic", label: "Topic" }, { name: "tone", label: "" }, { name: "x" }]),
      ]),
    ).toBeNull();
    expect(swarmNodesProblem([])).toBeNull();
  });

  it("fails on a blank, missing or too long node name", () => {
    expect(swarmNodesProblem([node({ label: "  " })])).toBe("A node has no name.");
    expect(swarmNodesProblem([node({ kind: "agent" })])).toBe("A node has no name.");
    expect(swarmNodesProblem([node({ label: "L".repeat(121) })])).toMatch(/longer than 120/);
    expect(swarmNodesProblem([node({ label: "🙂".repeat(120) })])).toBeNull();
  });

  it("fails on a field with no name, a bad name, a shared name or a blank label", () => {
    expect(swarmNodesProblem([input([{ name: "" }])])).toMatch(/no usable name/);
    expect(swarmNodesProblem([input([{ name: "my field" }])])).toMatch(/no usable name/);
    expect(swarmNodesProblem([input([{ name: "f".repeat(65) }])])).toMatch(/no usable name/);
    expect(swarmNodesProblem([input([{ name: "a" }, { name: "a" }])])).toMatch(/named a/);
    expect(swarmNodesProblem([input([{ name: "a", label: "   " }])])).toMatch(/label/);
  });

  it("leaves what is not a node or a field alone, as the database does", () => {
    expect(swarmNodesProblem([{ id: "x" }, "junk", 5])).toBeNull();
    expect(swarmNodesProblem([input(["oops", { name: "a" }])])).toBeNull();
  });

  it("is repaired by changing only the names that break a rule", () => {
    const fixed = repairSwarmNodes([
      node({ label: "   ", model: "m" }),
      node({ label: "L".repeat(130) }),
      node({ label: "Writer" }),
      input(
        [
          { name: "", type: "text" },
          { name: "field_1", type: "text" },
          { name: "my topic", label: "   " },
          { name: "mytopic", label: "Q".repeat(130) },
        ],
        "  ",
      ),
    ]);
    expect(fixed[0].data).toEqual({ label: "Untitled", model: "m" });
    expect(fixed[1].data.label).toHaveLength(120);
    expect(fixed[2].data).toEqual({ label: "Writer" });
    expect(fixed[3].data.label).toBe("Untitled");
    expect(fixed[3].data.inputFields).toEqual([
      { name: "field_2", type: "text" },
      { name: "field_1", type: "text" },
      { name: "mytopic" },
      { name: "mytopic_2", label: "Q".repeat(120) },
    ]);
    expect(swarmNodesProblem(fixed)).toBeNull();
  });

  it("leaves a graph that already passes exactly as it was", () => {
    const ok = [node({ label: "Writer" }), input([{ name: "topic", label: "Topic" }])];
    expect(repairSwarmNodes(ok)).toEqual(ok);
  });

  it("holds for every built-in template", () => {
    for (const t of SWARM_TEMPLATES) expect(swarmNodesProblem(t.nodes), t.id).toBeNull();
  });

  it("holds for an imported file with a blank node name", () => {
    const imported = importSwarm({
      kind: "agent-swarm",
      name: "From a file",
      nodes: [{ id: "a", kind: "agent", label: "   " }],
      edges: [],
    });
    expect(imported.nodes[0].data.label).toBe("Untitled");
  });
});

describe("the inspector", () => {
  const inspector = read("src/components/swarms/NodeInspector.tsx");
  const between = (from: string, to: string) =>
    inspector.slice(inspector.indexOf(from), inspector.indexOf(to, inspector.indexOf(from)));
  const edit = between("function useNameEdit(", "function NodeLabelField(");
  const labelField = between("function NodeLabelField(", "export function NodeInspector(");
  const fieldRow = between("function InputFieldRow(", "function SubSwarmPanel(");

  it("writes a name only from typing, and only one the rule accepts", () => {
    expect(edit).toMatch(
      /const name = toCommit\(typed\);\s*if \(name !== null && name !== value\) onCommit\(name\);/,
    );
    expect(edit.match(/onCommit\(/g)).toHaveLength(1);
  });

  it("only resets its own text on leaving, so it cannot write to another node", () => {
    expect(edit).toContain("onBlur: () => setDraft(accepted ?? value),");
    expect(edit).toContain("useEffect(() => setDraft((d) => nameDraft(d, value)), [value]);");
  });

  it("the node's Label field uses it, with the 120 limit", () => {
    expect(inspector).toMatch(
      /<Section label="Label">\s*<NodeLabelField label=\{data\.label\} onCommit=\{\(label\) => onChange\(\{ label \}\)\} \/>/,
    );
    expect(labelField).toContain("useNameEdit(label, onCommit, nodeLabelToCommit)");
    expect(labelField).toContain("maxLength={NODE_LABEL_MAX_LENGTH}");
    expect(inspector).not.toContain("onChange({ label: e.target.value })");
  });

  it("a field's name uses it, required and unique, with the 64 limit", () => {
    expect(fieldRow).toMatch(/useNameEdit\(\s*f\.name,/);
    expect(fieldRow).toContain("fieldNameProblem(typed, otherNames) === null ? typed : null");
    expect(fieldRow).toContain("cleanFieldName,");
    expect(fieldRow).toContain("maxLength={FIELD_NAME_MAX_LENGTH}");
  });

  it("a field's label is never only spaces, with the 120 limit", () => {
    expect(fieldRow).toContain("onUpdate({ label: fieldLabelToCommit(e.target.value) })");
    expect(fieldRow).toContain("maxLength={FIELD_LABEL_MAX_LENGTH}");
  });

  it("a new field gets a name no other field has", () => {
    expect(inspector).toContain('{ name: nextFieldName(fields.map((f) => f.name)), type: "text" }');
  });

  it("shows 'Untitled' for a blank name in its header", () => {
    expect(inspector).toContain(
      '<p className="text-sm font-semibold truncate">{shownNodeLabel(data.label)}</p>',
    );
  });
});

describe("the canvas and the Run panel", () => {
  const canvas = read("src/routes/_authenticated/swarms.tsx");

  it("a save repairs any name that breaks a rule, so the database never refuses it", () => {
    expect(canvas).toMatch(/const cleanNodes = repairSwarmNodes\(\s*nodes\.map\(/);
  });

  it("a node shows 'Untitled' for a blank name", () => {
    expect(canvas).toMatch(
      /title=\{shownNodeLabel\(data\.label\)\}>\s*\{shownNodeLabel\(data\.label\)\}/,
    );
  });

  it("a field shows its name when its label is blank, in the form and the 'Fill in' warning", () => {
    expect(read("src/components/swarms/RunPanel.tsx")).toContain("{shownFieldLabel(f)}");
    expect(canvas).toContain("missing.map(shownFieldLabel)");
  });
});

describe("the migration", () => {
  const sql = read("supabase/migrations/20261212000000_swarm_node_names.sql");

  it("holds the same limits as the code", () => {
    expect(sql).toContain(`char_length(n.node -> 'data' ->> 'label') > ${NODE_LABEL_MAX_LENGTH}`);
    expect(sql).toContain(`'^[A-Za-z0-9_]{1,${FIELD_NAME_MAX_LENGTH}}$'`);
    expect(sql).toContain(`char_length(f.field ->> 'label') > ${FIELD_LABEL_MAX_LENGTH}`);
    expect(sql).toMatch(/GROUP BY f\.field ->> 'name'\s*HAVING count\(\*\) > 1/);
    expect(sql).toContain("v_label := 'Untitled';");
  });

  it("repairs stored graphs and then validates, rather than adding the check NOT VALID", () => {
    expect(sql).toMatch(
      /UPDATE public\.swarms\s+SET nodes = pg_temp\.repair_swarm_nodes\(nodes\)\s+WHERE NOT public\.swarm_nodes_named\(nodes\);/,
    );
    expect(sql).toContain(
      "ADD CONSTRAINT swarms_nodes_named CHECK (public.swarm_nodes_named(nodes));",
    );
    expect(sql).not.toMatch(/NOT VALID;/);
  });

  it("can be run twice", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.swarm_nodes_named");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION pg_temp.repair_swarm_nodes");
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS swarms_nodes_named;");
  });

  it("lets the browser and the server run the check", () => {
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.swarm_nodes_named(jsonb) TO authenticated, service_role;",
    );
  });
});
