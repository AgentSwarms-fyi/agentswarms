// Every switch in the node inspector has to do something.
//
// A config field the builder writes and nothing reads is the worst kind of bug
// in a builder: the user sets it, watches it persist, reloads and sees it still
// set, and reasonably concludes it took effect. Nothing fails. The swarm just
// behaves as though the setting were never there.
//
// Nothing is broken today — 59 of the 62 fields on SwarmNodeData are bound by
// the inspector and every one is read. This exists because that is precisely
// the property that decays: a field is added to the type and the UI in one
// change, and wired into the executor in a second change that never lands.
//
// HOW THE QUESTION IS ASKED MATTERS, and two earlier versions of this file got
// it wrong in opposite directions:
//
//   - counting bare name occurrences treated a DECLARATION as a use, so
//     deleting the line that reads `d.retryDelayMs` changed nothing while
//     `retryDelayMs?: number | null;` sat two lines above it. Every mutation
//     survived.
//   - stripping "declaration-looking" lines first then reported reranker,
//     a2aSkillId, httpTimeoutMs and retrieveTopK as dead. All four are read;
//     a type member and an object-literal property are the same shape, so the
//     filter deleted real uses.
//
// A property ACCESS carries a leading dot. A type member never does. That is
// the whole distinction, and it is not a heuristic.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const RUNTIME = "src/lib/swarmRuntime.ts";
const INSPECTOR = "src/components/swarms/NodeInspector.tsx";

/**
 * Everything that can act on a node's configuration.
 *
 * COMPLETENESS MATTERS: the first run of this analysis listed four files and
 * reported retryDelayMs and inputFields as dead settings. Both are read, just
 * not by anything on that list. An incomplete consumer set does not
 * under-report — it invents findings.
 */
const CONSUMERS = [
  RUNTIME,
  "src/lib/swarmGraph.ts",
  "src/lib/swarmPortable.ts",
  "src/lib/swarmExportTools.ts",
  "src/lib/swarmExportLangGraph.ts",
  "src/lib/swarmExportStrands.ts",
  "src/lib/swarmExportFrameworks.ts",
  "src/utils/swarmExecute.server.ts",
  "src/utils/swarmNodes.server.ts",
  "src/components/swarms/RunPanel.tsx",
  "src/components/swarms/SwarmChatDialog.tsx",
  "src/routes/embed.swarm.$key.tsx",
  "src/routes/_authenticated/swarms.tsx",
];

/**
 * Written by something other than the inspector, so having no control is
 * correct: `status` is live run state, `avatar` and `agentId` are set when a
 * saved agent is linked to a node.
 */
const NOT_USER_EDITED = new Set(["status", "avatar", "agentId"]);

const runtime = readFileSync(RUNTIME, "utf8");
const inspector = readFileSync(INSPECTOR, "utf8");
const consumers = CONSUMERS.map((f) => readFileSync(f, "utf8")).join("\n");

const typeStart = runtime.indexOf("export type SwarmNodeData = {");
const typeBody = runtime.slice(typeStart, runtime.indexOf("\n};", typeStart));
const declared = [...typeBody.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);

/** Fields the inspector binds a control to. */
const bound = new Set([...inspector.matchAll(/\bdata\.(\w+)/g)].map((m) => m[1]));

/** Read as a property — `node.data.foo`, `d.foo` — rather than merely declared. */
const isRead = (field: string) => new RegExp(`\\.${field}\\b`).test(consumers);

describe("the analysis is looking at something", () => {
  // Without these the suite passes vacuously on an empty field list.
  it("finds the node type and its fields", () => {
    expect(typeStart).toBeGreaterThan(-1);
    expect(declared.length).toBeGreaterThan(40);
    expect(declared).toEqual(expect.arrayContaining(["systemPrompt", "maxIters", "httpUrl"]));
  });

  it("finds the controls the inspector binds", () => {
    expect(declared.filter((f) => bound.has(f)).length).toBeGreaterThan(40);
  });
});

describe("no setting is offered that nothing reads", () => {
  it("has a real read for every field the inspector binds", () => {
    const dead = declared.filter((f) => bound.has(f) && !isRead(f));
    expect(dead, `editable in the builder, read by nothing: ${dead.join(", ")}`).toEqual([]);
  });

  it("exposes every field the runtime honours, so none is JSON-only", () => {
    const hidden = declared.filter((f) => !bound.has(f) && !NOT_USER_EDITED.has(f) && isRead(f));
    expect(hidden, `honoured but unreachable in the UI: ${hidden.join(", ")}`).toEqual([]);
  });

  it("names the fields deliberately left out rather than filtering them quietly", () => {
    for (const f of NOT_USER_EDITED) {
      expect(declared, `${f} is exempted but no longer declared`).toContain(f);
    }
  });
});
