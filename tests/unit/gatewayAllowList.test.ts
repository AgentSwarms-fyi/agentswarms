import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { honorAllowList } from "@/utils/gateway/allowList";

// R247. A gateway key's agent and semantic-model lists are allow-lists where
// EMPTY MEANS EVERYTHING. The server used to filter what was asked for down to
// what was permitted and store the result, so a list that filtered to nothing
// was stored as "all". Driven on 2026-10-04: a key ticked for one agent, the
// agent deleted from another tab, Create — "Key created", "Agents: all".

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";

describe("honorAllowList", () => {
  it("keeps a list that is wholly permitted, once each", () => {
    expect(honorAllowList([A, B, A], new Set([A, B, C]), "agent")).toEqual({
      ok: true,
      ids: [A, B],
    });
  });

  it("lets an empty request stay empty: choosing none is choosing all, on purpose", () => {
    expect(honorAllowList([], new Set([A]), "agent")).toEqual({ ok: true, ids: [] });
  });

  // The round's case. Filtering this one used to store [], which is "all".
  it("refuses when nothing asked for survives, and says what the key would have reached", () => {
    const r = honorAllowList([A], new Set([B]), "agent");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/^The agent picked for this key no longer exists or is not yours/);
    expect(r.error).toMatch(/nothing was saved/);
    expect(r.error).toMatch(/every agent you have/);
  });

  it("refuses a partial list too, rather than save less than was picked without saying so", () => {
    const r = honorAllowList([A, B], new Set([A]), "semantic model");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/^1 of the 2 semantic models picked/);
    expect(r.error).toMatch(/less than you picked/);
    // Not the widening sentence: that would be untrue here.
    expect(r.error).not.toMatch(/every semantic model/);
  });

  it("refuses when an empty permitted set meets a non-empty request — what a failed read looked like", () => {
    const r = honorAllowList([A, B], new Set(), "agent");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/^All 2 agents picked/);
  });
});

describe("the gateway key functions go through it", () => {
  const src = readFileSync("src/utils/gatewayKeys.functions.ts", "utf8");
  const create = src.slice(
    src.indexOf("export const gatewayKeyCreate"),
    src.indexOf("export const gatewayKeyUpdate"),
  );
  const update = src.slice(
    src.indexOf("export const gatewayKeyUpdate"),
    src.indexOf("export const gatewayCacheList"),
  );

  it("checks both lists on create, and stores only what the check returned", () => {
    expect(create).toContain("checkAgentIds(caller.userId");
    expect(create).toContain("checkSemanticModelIds(caller.userId");
    expect(create).toMatch(/if \(!agents\.ok\) return agents;/);
    expect(create).toMatch(/if \(!semantic\.ok\) return semantic;/);
    expect(create).toContain("agent_ids: agents.ids,");
    expect(create).toContain("semantic_model_ids: semantic.ids,");
  });

  it("checks the semantic-model list on edit too", () => {
    expect(update).toContain("checkSemanticModelIds(caller.userId");
    expect(update).toMatch(/if \(!semantic\.ok\) return semantic;/);
    expect(update).toContain("patch.semantic_model_ids = semantic.ids;");
  });

  it("reads the owner's agents with their error, not without it", () => {
    const fn = src.slice(src.indexOf("async function checkAgentIds"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/const \{ data: own, error \} = await supabaseAdmin/);
    expect(body).toMatch(/if \(error\) \{\s*return \{\s*ok: false,/);
  });
});
