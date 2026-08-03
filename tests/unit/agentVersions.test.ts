// Agent version history.
//
// The de-duplication check compared a snapshot built in memory against one read
// back from a `jsonb` column, using JSON.stringify. jsonb does not preserve key
// order — it normalises keys by length then bytes — so the two strings differed
// for the same configuration and the check never fired.
//
// The damage is not a spurious row. Every save wrote a version, MAX_VERSIONS is
// 30, and pruning keeps the newest: thirty no-op saves silently evicted every
// snapshot the user actually wanted, under a comment promising "history stays
// meaningful". Version history that quietly discards versions is worse than
// none, because the user stops keeping their own copies.
import { describe, expect, it } from "vitest";

import {
  configHash,
  diffSnapshots,
  toSnapshot,
  type AgentConfigSnapshot,
} from "@/lib/agentVersions";
import { readFileSync } from "node:fs";

import { graphHash, serializeGraph } from "@/lib/swarmVersions";

const snap = (over: Partial<AgentConfigSnapshot> = {}): AgentConfigSnapshot => ({
  name: "Support Bot",
  description: "Answers billing questions",
  system_prompt: "be helpful",
  llm_provider: "openrouter",
  llm_model: "openai/gpt-4o",
  temperature: 0.7,
  max_tokens: 4096,
  knowledge_base_id: null,
  n8n_webhook_url: null,
  tools: {},
  ...over,
});

// The real shape, in the order the form's object literal declares it.
const formOrder = {
  builtInTools: { web_search: true, kb_search: true },
  activeWorkflows: {},
  toolConfigs: { web_search: { region: "eu" } },
  guardrails: { pii: true, blockedPatterns: ["a", "b"] },
};

// The same value after a jsonb round trip: keys by length, then bytes.
const jsonbOrder = {
  guardrails: { pii: true, blockedPatterns: ["a", "b"] },
  toolConfigs: { web_search: { region: "eu" } },
  builtInTools: { kb_search: true, web_search: true },
  activeWorkflows: {},
};

describe("a save that changed nothing is recognised as unchanged", () => {
  it("hashes the same configuration identically across a jsonb round trip", () => {
    expect(configHash(snap({ tools: formOrder }))).toBe(configHash(snap({ tools: jsonbOrder })));
  });

  it("still notices a real change to a nested value", () => {
    const changed = { ...formOrder, guardrails: { pii: false, blockedPatterns: ["a", "b"] } };
    expect(configHash(snap({ tools: formOrder }))).not.toBe(configHash(snap({ tools: changed })));
  });

  it("notices a tool being switched on", () => {
    const changed = {
      ...formOrder,
      builtInTools: { web_search: true, kb_search: true, sql_query: true },
    };
    expect(configHash(snap({ tools: formOrder }))).not.toBe(configHash(snap({ tools: changed })));
  });

  it("does NOT treat array order as noise", () => {
    // Key order is storage detail; array order is data. Sorting arrays too
    // would make a real edit to blockedPatterns invisible.
    const reordered = { ...formOrder, guardrails: { pii: true, blockedPatterns: ["b", "a"] } };
    expect(configHash(snap({ tools: formOrder }))).not.toBe(configHash(snap({ tools: reordered })));
  });

  it("notices every top-level field", () => {
    const base = configHash(snap());
    const changes: Partial<AgentConfigSnapshot>[] = [
      { name: "Other" },
      { description: "x" },
      { system_prompt: "different" },
      { llm_provider: "anthropic" },
      { llm_model: "gpt-4o-mini" },
      { temperature: 0.2 },
      { max_tokens: 2048 },
      { knowledge_base_id: "kb-1" },
      { n8n_webhook_url: "https://example.invalid/hook" },
    ];
    for (const c of changes) expect(configHash(snap(c)), Object.keys(c)[0]).not.toBe(base);
  });

  it("distinguishes null from empty string and from zero", () => {
    // A snapshot is an audit record; "unset" and "set to nothing" are
    // different states and must not collapse into one hash.
    expect(configHash(snap({ description: null }))).not.toBe(configHash(snap({ description: "" })));
    expect(configHash(snap({ temperature: null }))).not.toBe(configHash(snap({ temperature: 0 })));
  });
});

describe("narrowing an agent row to a snapshot", () => {
  it("keeps falsy values instead of nulling them", () => {
    // `?? null` and not `|| null`: temperature 0 and an empty prompt are real
    // settings, and coercing them to null would show a phantom change on the
    // next save.
    const out = toSnapshot({ name: "A", temperature: 0, system_prompt: "", max_tokens: 0 });
    expect(out.temperature).toBe(0);
    expect(out.system_prompt).toBe("");
    expect(out.max_tokens).toBe(0);
  });

  it("ignores columns that are not part of the versioned config", () => {
    const out = toSnapshot({ name: "A", id: "x", user_id: "u", created_at: "t" });
    expect(Object.keys(out).sort()).not.toContain("user_id");
    expect(Object.keys(out)).toHaveLength(10);
  });
});

describe("the diff shown to the user", () => {
  it("renders an unset field as empty, not as the word null", () => {
    // `typeof null === "object"`, so every null went down the JSON branch and
    // an unset Description was displayed as the literal text `null`.
    const d = diffSnapshots(snap({ description: null }), snap({ description: "now set" }));
    expect(d).toHaveLength(1);
    expect(d[0].before).toBe("");
    expect(d[0].after).toBe("now set");
  });

  it("does not report a key reorder as a change to the tools blob", () => {
    expect(diffSnapshots(snap({ tools: formOrder }), snap({ tools: jsonbOrder }))).toEqual([]);
  });

  it("reports only the fields that changed", () => {
    const d = diffSnapshots(snap(), snap({ llm_model: "gpt-4o-mini", temperature: 0.1 }));
    expect(d.map((x) => x.field).sort()).toEqual(["llm_model", "temperature"]);
  });

  it("shows a real tools change with both sides", () => {
    const changed = { ...formOrder, builtInTools: { web_search: false, kb_search: true } };
    const d = diffSnapshots(snap({ tools: formOrder }), snap({ tools: changed }));
    expect(d).toHaveLength(1);
    expect(d[0].field).toBe("tools");
    expect(d[0].before).toContain('"web_search": true');
    expect(d[0].after).toContain('"web_search": false');
  });

  it("is empty for two identical snapshots", () => {
    expect(diffSnapshots(snap(), snap())).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The swarm-side twin. agentVersions calls itself "the agent-side counterpart
// of swarmVersions", and duplicated implementations in this codebase have
// drifted apart repeatedly, so the twin gets checked whenever this file
// changes.
//
// Its hash is compared in memory against a ref, never across a jsonb round
// trip, so the key-order bug above does not apply to it. A different one did:
// React Flow writes UI state back onto the node objects, `...n` carried all of
// it into the snapshot, and the hash therefore changed when a node was merely
// SELECTED.
// ─────────────────────────────────────────────────────────────────────────────
describe("swarm snapshots ignore React Flow's UI state", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const node = (over: Record<string, unknown> = {}): any => ({
    id: "n1",
    type: "agent",
    position: { x: 10, y: 20 },
    data: { label: "Researcher", status: "idle" },
    ...over,
  });

  it("hashes the same graph identically whether or not a node is selected", () => {
    const plain = [node()];
    const clicked = [
      node({ selected: true, dragging: false, measured: { width: 180, height: 60 } }),
    ];
    expect(graphHash(clicked, [])).toBe(graphHash(plain, []));
  });

  it("still treats moving a node as a change", () => {
    // Position is a real edit to the graph, not UI noise.
    expect(graphHash([node({ position: { x: 99, y: 20 } })], [])).not.toBe(graphHash([node()], []));
  });

  it("still treats an edit to node data as a change", () => {
    expect(graphHash([node({ data: { label: "Writer" } })], [])).not.toBe(graphHash([node()], []));
  });

  it("ignores transient run state, which is what it already stripped", () => {
    const running = [node({ data: { label: "Researcher", status: "running", lastOutput: "hi" } })];
    expect(graphHash(running, [])).toBe(graphHash([node()], []));
  });

  it("keeps position and data in the snapshot it stores for restore", () => {
    const { cleanNodes } = serializeGraph([node({ selected: true })], []);
    expect(cleanNodes[0].position).toEqual({ x: 10, y: 20 });
    expect(cleanNodes[0].data.label).toBe("Researcher");
    expect("selected" in cleanNodes[0]).toBe(false);
  });
});

describe("opening a swarm is not an edit", () => {
  // lastVersionHashRef was seeded on SAVE and on restore, never on LOAD. It
  // starts null, and `hash !== null` is true for every graph, so the first Save
  // of any session snapshotted a swarm nobody had touched. With MAX_VERSIONS at
  // 30, open-and-save is enough to push out the history the feature exists for.
  //
  // The fix seeds the ref in applySwarmRow. What makes that correct is that the
  // hash of a graph as LOADED equals the hash of the same graph as HELD IN
  // STATE — and the two differ, because edges get default styling on the way
  // in. These lock that down.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const node = (id: string): any => ({
    id,
    type: "agent",
    position: { x: 0, y: 0 },
    data: { label: id, status: "idle" },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edge = (): any => ({ id: "e1", source: "a", target: "b" });

  it("ignores the edge styling applied at load time", () => {
    const styled = {
      ...edge(),
      style: { stroke: "#888", strokeWidth: 2 },
      markerEnd: { type: "arrowclosed" },
      animated: true,
    };
    expect(graphHash([node("a"), node("b")], [styled])).toBe(
      graphHash([node("a"), node("b")], [edge()]),
    );
  });

  it("still distinguishes a genuinely different edge", () => {
    const rewired = { ...edge(), target: "c" };
    expect(graphHash([node("a")], [rewired])).not.toBe(graphHash([node("a")], [edge()]));
  });

  it("keeps the handles that decide which port an edge leaves from", () => {
    const onHandle = { ...edge(), sourceHandle: "yes" };
    expect(graphHash([node("a")], [onHandle])).not.toBe(graphHash([node("a")], [edge()]));
  });

  it("seeds the hash when a swarm is loaded, not only when it is saved", () => {
    // Wiring: the property above is worth nothing if applySwarmRow never sets
    // the ref. A source assertion because the alternative is rendering a
    // 2,000-line canvas component.
    const src = readFileSync("src/routes/_authenticated/swarms.tsx", "utf8");
    const apply = src.slice(src.indexOf("const applySwarmRow"), src.indexOf("useEffect(() => {"));
    expect(apply).toContain("lastVersionHashRef.current = graphHash(");
  });
});
