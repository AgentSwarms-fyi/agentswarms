// Session-scoped chat tools: the merge rule /api/chat applies to the
// playground's Tools-menu picks, and the display helper the menu uses to
// label tools the agent already has on permanently.
import { describe, expect, it } from "vitest";
import {
  ADHOC_SERVER_TOOLS,
  agentPermanentAdhocTools,
  DIAGRAM_SYSTEM_NOTE,
  DIAGRAM_TOOL_ID,
  mergeExtraTools,
} from "@/lib/adhocTools";

describe("mergeExtraTools", () => {
  it("unions valid extras onto the agent-derived allow-list", () => {
    expect(mergeExtraTools(["kb_search"], ["web_search"])).toEqual(["kb_search", "web_search"]);
  });

  it("returns the base untouched when no extras are sent", () => {
    expect(mergeExtraTools(["kb_search"], undefined)).toEqual(["kb_search"]);
    expect(mergeExtraTools(["kb_search"], [])).toEqual(["kb_search"]);
  });

  it("keeps undefined as undefined — 'derive from agent', not 'no tools'", () => {
    // undefined upstream means "no allow-list, use the registry defaults".
    // Turning it into [] would silently disable every tool instead.
    expect(mergeExtraTools(undefined, undefined)).toBeUndefined();
    expect(mergeExtraTools(undefined, [])).toBeUndefined();
    expect(mergeExtraTools(undefined, ["not-a-tool"])).toBeUndefined();
  });

  it("gives an agent with no tools exactly the session extras", () => {
    expect(mergeExtraTools(undefined, ["web_search", "calculator"])).toEqual([
      "web_search",
      "calculator",
    ]);
  });

  it("drops anything outside the curated ad-hoc set", () => {
    // extras are untrusted request input. kb_search/sql_query/memory need
    // agent-level scoping and must not be injectable from a chat body.
    expect(mergeExtraTools(undefined, ["sql_query", "memory_recall", "kb_search"])).toBeUndefined();
    expect(mergeExtraTools(["kb_search"], ["sql_query", "web_search"])).toEqual([
      "kb_search",
      "web_search",
    ]);
  });

  it("drops non-string junk without throwing", () => {
    expect(mergeExtraTools(["kb_search"], [42, null, {}, "weather"])).toEqual([
      "kb_search",
      "weather",
    ]);
    expect(mergeExtraTools(["kb_search"], "web_search")).toEqual(["kb_search"]);
  });

  it("does not duplicate a tool the agent already has", () => {
    expect(mergeExtraTools(["web_search"], ["web_search"])).toEqual(["web_search"]);
  });

  it("the diagram pseudo-tool never reaches the server allow-list", () => {
    // It is client-side by design (system-prompt nudge + inline rendering);
    // if it ever lands in the curated set the server would look for a tool
    // that does not exist.
    expect(mergeExtraTools(undefined, [DIAGRAM_TOOL_ID])).toBeUndefined();
    expect(ADHOC_SERVER_TOOLS.some((t) => String(t.id) === DIAGRAM_TOOL_ID)).toBe(false);
  });
});

describe("agentPermanentAdhocTools", () => {
  it("reads the agent's saved built-in toggles", () => {
    expect(
      agentPermanentAdhocTools({ builtInTools: { web_search: true, calculator: true } }),
    ).toEqual(new Set(["web_search", "calculator"]));
  });

  it("accepts the legacy web_browser spelling for web_browse", () => {
    // /api/chat honours both keys; the menu must label the same set.
    expect(agentPermanentAdhocTools({ builtInTools: { web_browser: true } })).toEqual(
      new Set(["web_browse"]),
    );
  });

  it("ignores falsy toggles and non-adhoc tools", () => {
    expect(
      agentPermanentAdhocTools({ builtInTools: { web_search: false, sql_query: true } }),
    ).toEqual(new Set());
  });

  it("handles agents with no tools config at all", () => {
    expect(agentPermanentAdhocTools(undefined)).toEqual(new Set());
    expect(agentPermanentAdhocTools(null)).toEqual(new Set());
    expect(agentPermanentAdhocTools({})).toEqual(new Set());
    expect(agentPermanentAdhocTools("junk")).toEqual(new Set());
  });
});

describe("DIAGRAM_SYSTEM_NOTE", () => {
  it("tells the model to answer in a mermaid fence", () => {
    // The renderer keys on the fence language; if the note stops saying
    // "mermaid" the diagrams stop rendering and nobody gets an error.
    expect(DIAGRAM_SYSTEM_NOTE).toMatch(/mermaid/i);
    expect(DIAGRAM_SYSTEM_NOTE).toMatch(/code block|fence/i);
  });
});
