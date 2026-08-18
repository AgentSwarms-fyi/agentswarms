// The swarm exporters generate files a user is told to run, from a graph that
// can arrive by import — swarms.tsx accepts a dropped .swarm.json from anyone.
// The agent exporters have had this pinned since they were written
// (agentExportInjection.test.ts); the swarm path is the same threat model
// through a different door, and had no coverage at all until these landed.
//
// Two properties are pinned here:
//   1. Numbers reach the generated source as numbers. They are interpolated
//      unquoted, so a non-numeric value is arbitrary code in the output.
//   2. The portable JSON export carries no provider credential.
import { describe, expect, it } from "vitest";

import {
  buildLangGraphPythonSwarm,
  buildLangGraphTypeScriptSwarm,
} from "@/lib/swarmExportLangGraph";
import { buildStrandsPythonSwarm, buildStrandsTypeScriptSwarm } from "@/lib/swarmExportStrands";
import { buildCrewAISwarm, buildOpenAIAgentsSwarm } from "@/lib/swarmExportFrameworks";
import { exportSwarm, importSwarm, type PortableSwarm } from "@/lib/swarmPortable";

/** A one-agent swarm whose node fields the caller can poison. */
function swarm(overrides: Record<string, unknown> = {}): PortableSwarm {
  return {
    $schema: "https://agentswarms.fyi/schemas/swarm.v1.json",
    schemaVersion: "1.0.0",
    kind: "agent-swarm",
    name: "demo",
    exportedAt: "2026-01-01T00:00:00.000Z",
    exportedBy: "test",
    nodes: [
      {
        id: "n1",
        kind: "agent",
        label: "Researcher",
        position: { x: 0, y: 0 },
        provider: "openai",
        model: "gpt-4o",
        temperature: 0.5,
        systemPrompt: "You are a researcher.",
        ...overrides,
      },
    ],
    edges: [],
  } as PortableSwarm;
}

const GENERATORS = [
  { name: "LangGraph Python", build: buildLangGraphPythonSwarm },
  { name: "LangGraph TypeScript", build: buildLangGraphTypeScriptSwarm },
  { name: "Strands Python", build: buildStrandsPythonSwarm },
  { name: "Strands TypeScript", build: buildStrandsTypeScriptSwarm },
];

/**
 * Every value emitted in a `temperature=` / `temperature: ` position, as it
 * literally appears in the generated file. Reading the output back is the
 * whole point: asserting on the manifest would pass even if a generator
 * interpolated the raw field.
 */
function temperaturesIn(code: string): string[] {
  return [...code.matchAll(/temperature["']?\s*[:=]\s*([^,)}\s]+)/g)].map((m) => m[1]);
}

// Each payload closes the model constructor, adds a statement, and comments
// out the paren it left orphaned — the shapes that actually produced runnable
// injected code before safeNumber was applied here.
const PY_PAYLOAD = "0.7)\nimport os; os.system('id')\n#";
const TS_PAYLOAD = "0.7 })\nprocess.exit(1)\n//";

describe("numbers interpolated bare into swarm exports are numbers", () => {
  for (const g of GENERATORS) {
    it(`${g.name}: a non-numeric temperature cannot add a statement`, () => {
      for (const payload of [PY_PAYLOAD, TS_PAYLOAD]) {
        const out = g.build(swarm({ temperature: payload }));
        expect(out).not.toContain("os.system");
        expect(out).not.toContain("process.exit");
      }
    });

    it(`${g.name}: emits a real number in every temperature position`, () => {
      expect(temperaturesIn(g.build(swarm({ temperature: 0.35 })))).toEqual(["0.35"]);
      // Clamped to the provider-accepted range rather than passed through.
      expect(temperaturesIn(g.build(swarm({ temperature: 999 })))).toEqual(["2"]);
      expect(temperaturesIn(g.build(swarm({ temperature: -5 })))).toEqual(["0"]);
      // Not-a-number and absent both fall back; null is ABSENT, not zero.
      expect(temperaturesIn(g.build(swarm({ temperature: "hot" })))).toEqual(["0.7"]);
      expect(temperaturesIn(g.build(swarm({ temperature: null })))).toEqual(["0.7"]);
      expect(temperaturesIn(g.build(swarm({ temperature: undefined })))).toEqual(["0.7"]);
    });
  }

  it("survives the full import-a-shared-file then export-as-code path", () => {
    const hostile = {
      kind: "agent-swarm",
      name: "demo",
      nodes: [
        {
          id: "n1",
          kind: "agent",
          label: "Researcher",
          position: { x: 0, y: 0 },
          provider: "openai",
          model: "gpt-4o",
          temperature: PY_PAYLOAD,
          systemPrompt: "hi",
        },
      ],
      edges: [],
    };
    const imported = importSwarm(hostile);
    const portable = exportSwarm({ name: "demo", nodes: imported.nodes, edges: imported.edges });
    for (const g of GENERATORS) {
      expect(g.build(portable)).not.toContain("os.system");
    }
  });
});

describe("the portable swarm export carries no provider credential", () => {
  const withSecrets = {
    kind: "agent-swarm",
    name: "demo",
    nodes: [
      {
        id: "n1",
        kind: "agent",
        label: "Researcher",
        position: { x: 0, y: 0 },
        toolConfigs: {
          web_search: { provider: "brave", api_key: "sk-live-SECRET" },
          web_browse: { provider: "firecrawl", api_key: "fc-SECRET" },
          sql_table_names: ["orders"],
          mcp_server_names: ["internal"],
        },
      },
    ],
    edges: [],
  };

  function roundTrip() {
    const imported = importSwarm(withSecrets);
    return {
      imported,
      portable: exportSwarm({ name: "demo", nodes: imported.nodes, edges: imported.edges }),
    };
  }

  it("strips api_key while keeping the provider and every allow-list", () => {
    const { portable } = roundTrip();
    const json = JSON.stringify(portable);
    expect(json).not.toContain("sk-live-SECRET");
    expect(json).not.toContain("fc-SECRET");
    expect(json).not.toContain("api_key");

    const cfg = portable.nodes[0].toolConfigs!;
    // The provider NAME is not a secret and tells the recipient which key to
    // supply; the allow-lists are what bound the node's reach and must survive.
    expect(cfg.web_search).toEqual({ provider: "brave" });
    expect(cfg.web_browse).toEqual({ provider: "firecrawl" });
    expect(cfg.sql_table_names).toEqual(["orders"]);
    expect(cfg.mcp_server_names).toEqual(["internal"]);
  });

  it("redacts a copy — exporting must not wipe the key off the live canvas", () => {
    const { imported, portable } = roundTrip();
    expect(portable.nodes[0].toolConfigs?.web_search?.api_key).toBeUndefined();
    expect(imported.nodes[0].data.toolConfigs?.web_search?.api_key).toBe("sk-live-SECRET");
  });

  it("leaves a node with no tool config alone", () => {
    const portable = exportSwarm({
      name: "demo",
      nodes: importSwarm({
        kind: "agent-swarm",
        name: "demo",
        nodes: [{ id: "n1", kind: "agent", label: "R", position: { x: 0, y: 0 } }],
        edges: [],
      }).nodes,
      edges: [],
    });
    expect(portable.nodes[0].toolConfigs).toBeUndefined();
  });

  it("still omits the A2A auth header it always excluded", () => {
    const portable = exportSwarm({
      name: "demo",
      nodes: [
        {
          id: "n1",
          position: { x: 0, y: 0 },
          data: {
            kind: "agent",
            label: "R",
            a2aAuthHeader: "Bearer A2A-SECRET",
            toolConfigs: { web_search: { provider: "brave", api_key: "sk-SECRET" } },
          },
        },
      ] as never,
      edges: [],
    });
    expect(JSON.stringify(portable)).not.toContain("SECRET");
  });
});

// The third property, found while validating the first two: a swarm name or
// node label reaches a Python docstring and a JavaScript block comment, and
// nothing sanitised it. safeTitle exists for exactly this — its own comment
// records the agent-export version of the bug — but the swarm generators never
// called it, so `x"""\nimport os; os.system("id")\n"""` closed the module
// docstring and ran on import of the generated file.
//
// The payload TEXT is expected to survive as inert prose inside the header —
// that is what sanitising means here. What must not survive is its STRUCTURE:
// no extra delimiter, no extra line. Both are counted against a clean build of
// the same swarm, so the assertion cannot drift as the templates change.
describe("names and labels cannot escape a docstring or comment", () => {
  const PY_BREAKOUT = 'x"""\nimport os; os.system("id")\n"""';
  const TS_BREAKOUT = "x*/\nprocess.exit(1);\n/*";

  // Every generator, including the two agent-centric ones the temperature
  // block above does not apply to (they emit no numeric literal, but they do
  // emit a module docstring and control-flow comments).
  const ALL = [
    ...GENERATORS,
    { name: "CrewAI Python", build: buildCrewAISwarm },
    { name: "OpenAI Agents Python", build: buildOpenAIAgentsSwarm },
  ];

  /**
   * One agent plus one node of `kind`, where ONLY the control-flow node and the
   * swarm name carry the payload.
   *
   * Giving two nodes the same label would hide the bug: disambiguateLabels
   * rewrites a colliding label to an already-safe identifier, so a duplicated
   * payload sanitises itself and the test passes against unpatched code. That
   * is exactly how the first version of this test let four mutants live.
   */
  function named(kind: string, value: string): PortableSwarm {
    return {
      $schema: "s",
      schemaVersion: "1.0.0",
      kind: "agent-swarm",
      name: value,
      exportedAt: "t",
      exportedBy: "t",
      nodes: [
        {
          id: "n1",
          kind: "agent",
          label: "Researcher",
          position: { x: 0, y: 0 },
          provider: "openai",
          model: "gpt-4o",
          temperature: 0.5,
          systemPrompt: "hi",
          outputVar: "draft",
        },
        { id: "n2", kind, label: value, position: { x: 0, y: 0 }, conditionPrompt: "c" },
        { id: "n3", kind: "agent", label: "Writer", position: { x: 0, y: 0 }, model: "gpt-4o" },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3" },
      ],
    } as PortableSwarm;
  }

  const count = (s: string, needle: string) => s.split(needle).length - 1;
  const KINDS = ["condition", "loop", "approval", "evaluate", "function", "a2a_remote"];

  for (const g of ALL) {
    it(`${g.name}: a breakout name or label adds no delimiter and no line`, () => {
      for (const kind of KINDS) {
        const clean = g.build(named(kind, "Ordinary Step"));
        for (const payload of [PY_BREAKOUT, TS_BREAKOUT]) {
          const out = g.build(named(kind, payload));
          const where = `${g.name} / ${kind}`;
          // A closed docstring or block comment IS the breakout.
          expect(count(out, '"""'), where).toBe(count(clean, '"""'));
          expect(count(out, "*/"), where).toBe(count(clean, "*/"));
          // A bare newline breaks out of a `#` or `//` comment just as well.
          expect(out.split("\n").length, where).toBe(clean.split("\n").length);
        }
      }
    });
  }

  it("an upstream label is emitted as a quoted literal, not an evaluated placeholder", () => {
    const withUpstream = (label: string) =>
      ({
        $schema: "s",
        schemaVersion: "1.0.0",
        kind: "agent-swarm",
        name: "demo",
        exportedAt: "t",
        exportedBy: "t",
        nodes: [
          {
            id: "n1",
            kind: "agent",
            label,
            position: { x: 0, y: 0 },
            model: "gpt-4o",
            outputVar: "draft",
          },
          { id: "n2", kind: "agent", label: "Writer", position: { x: 0, y: 0 }, model: "gpt-4o" },
        ],
        edges: [{ id: "e1", source: "n1", target: "n2" }],
      }) as PortableSwarm;

    // Quoted: the label must reach the generated source as data. Unquoted it
    // would be a bare identifier — or worse, an expression.
    expect(buildLangGraphPythonSwarm(withUpstream("Researcher"))).toContain('+ "Researcher" +');
    expect(buildLangGraphTypeScriptSwarm(withUpstream("Researcher"))).toContain('+ "Researcher" +');

    // A Python f-string field and a TS template placeholder both EVALUATE what
    // they contain, so the label must not land inside either construct.
    const py = buildLangGraphPythonSwarm(withUpstream('{__import__("os").system("id")}'));
    expect(py).toContain('context_parts.append("--- "');
    expect(py).not.toContain("context_parts.append(f");
    const ts = buildLangGraphTypeScriptSwarm(withUpstream("${process.exit(1)}"));
    expect(ts).toContain('parts.push("--- "');
    expect(ts).not.toContain("parts.push(`");
  });

  it("keeps an ordinary name readable in the generated header", () => {
    expect(buildLangGraphPythonSwarm(swarm())).toContain("LangGraph swarm: demo");
    expect(buildStrandsPythonSwarm(swarm())).toContain("Strands swarm: demo");
    expect(buildCrewAISwarm(swarm())).toContain("CrewAI swarm: demo");
  });
});
