// A turn runs with its agent's configuration, or it does not run.
//
// FOUND IN R234, while sweeping the "a failed read that fails open" class. The
// chat route read the agent row with `const { data: a } = await …`, dropping
// the error under a comment that said the trace label is non-critical — true
// when the label was all it fetched, and not true since the tool allow-lists
// and the guardrails moved onto the same row. A read that failed left the
// defaults standing, and both defaults are the permissive end: the registry's
// whole tool set, and every filter off.
//
// PROVED IN THE UI before it was fixed, on a real agent ("R234 guardrail
// probe") whose input filtering blocked the pattern `r234-forbidden-token`:
//
//   POST /api/chat with its agentId  -> 422, "Input was blocked by a
//                                       prompt-injection guardrail."
//   delete the agent, send the SAME message
//                                    -> 200, and the model answered.
//
// The delete dialog's own words are "API calls that reference it will stop
// working". They did not stop; they carried on without the guardrails the
// agent was deleted with. See docs/UI_TEST_RESULTS.md.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AGENT_NOT_FOUND_MESSAGE,
  AGENT_UNREADABLE_MESSAGE,
  EMBED_CONFIG_UNREADABLE,
  agentConfigRefusal,
  failedRead,
} from "@/utils/agents/agentConfigGate";
import { DEFAULT_GUARDRAILS } from "@/utils/guardrails";
import { enabledToolsFromToggles } from "@/utils/tools/agentToggles";

const CHAT = readFileSync("src/routes/api/chat.ts", "utf8");
const EMBED_CHAT = readFileSync("src/routes/api/embed.chat.ts", "utf8");

describe("the premise: what running without the agent's row actually means", () => {
  // If either of these ever stops being true, the refusals below are arguing
  // for something else and this file should be re-read rather than re-passed.
  it("no toggles means the registry's default set, not an empty one", () => {
    expect(enabledToolsFromToggles({})).toBeUndefined();
    expect(enabledToolsFromToggles(undefined)).toBeUndefined();
    // And a toggle record that says no is an answer, not an absence.
    expect(enabledToolsFromToggles({ web_search: false })).toBeUndefined();
    expect(enabledToolsFromToggles({ web_search: true })).toEqual(["web_search"]);
  });

  it("no guardrails means every filter off", () => {
    expect(DEFAULT_GUARDRAILS.enableInputFilters).toBe(false);
    expect(DEFAULT_GUARDRAILS.enableOutputFilters).toBe(false);
    expect(DEFAULT_GUARDRAILS.blockPII).toBe(false);
    expect(DEFAULT_GUARDRAILS.piiMode).toBe("off");
    expect(DEFAULT_GUARDRAILS.contentSafetyLevel).toBe("off");
    expect(DEFAULT_GUARDRAILS.blockedPatterns).toBe("");
    expect(DEFAULT_GUARDRAILS.topicRestrictions).toBe("");
  });
});

describe("agentConfigRefusal", () => {
  it("refuses when the read failed", () => {
    expect(agentConfigRefusal({ data: null, error: { message: "timeout" } })).toMatchObject({
      code: "agent_unreadable",
      status: 503,
    });
  });

  it("refuses when a row came back WITH an error — the error wins", () => {
    // PostgREST can hand back both. Reading the row anyway is how a partial or
    // stale answer would get treated as the agent's configuration.
    expect(
      agentConfigRefusal({ data: { name: "Support" }, error: { message: "timeout" } }),
    ).toMatchObject({ code: "agent_unreadable", status: 503 });
  });

  it("refuses a read that threw, whatever it threw", () => {
    // A client that throws carries no `error` field, and `undefined` as the
    // cause would read back as "no error" — which is this whole round.
    for (const cause of [new Error("socket hang up"), undefined, null, "", 0]) {
      expect(agentConfigRefusal(failedRead(cause)), String(cause)).toMatchObject({
        code: "agent_unreadable",
        status: 503,
      });
    }
  });

  it("refuses when there was no client to ask with", () => {
    expect(agentConfigRefusal(null)).toMatchObject({ code: "agent_unreadable", status: 503 });
  });

  it("refuses a missing row as not found, which is a different thing to say", () => {
    expect(agentConfigRefusal({ data: null, error: null })).toMatchObject({
      code: "agent_not_found",
      status: 404,
    });
  });

  it("lets a real row through", () => {
    expect(agentConfigRefusal({ data: { name: "Support", tools: {} }, error: null })).toBeNull();
  });

  it("says why, and what the reader can do", () => {
    // A refusal a user cannot act on is a 500 with better manners.
    for (const m of [AGENT_UNREADABLE_MESSAGE, AGENT_NOT_FOUND_MESSAGE, EMBED_CONFIG_UNREADABLE]) {
      expect(m).toMatch(/guardrail|configuration/i);
      expect(m.length).toBeGreaterThan(60);
    }
    expect(AGENT_UNREADABLE_MESSAGE).toMatch(/try again/i);
    expect(AGENT_NOT_FOUND_MESSAGE).toMatch(/deleted/i);
    // The embed must not claim the thing is gone when it could not be asked.
    expect(EMBED_CONFIG_UNREADABLE).not.toMatch(/no longer exists/i);
  });
});

describe("the routes express their refusal through it", () => {
  it("the chat route's agent read goes through the gate", () => {
    const block = CHAT.slice(CHAT.indexOf("if (body.agentId && authToken)"));
    const head = block.slice(0, 1400);
    expect(head).toContain("agentConfigRefusal(read)");
    expect(head).toContain("status: refusal.status");
    // The shape that caused this: a destructure that keeps data and drops error.
    expect(head).not.toMatch(/const \{ data: a \}/);
    // And the stale permission slip is gone with it.
    expect(CHAT).not.toContain("ignore — trace label is non-critical");
  });

  it("a throw from the read is a failed read, not a silent default", () => {
    const block = CHAT.slice(CHAT.indexOf("if (body.agentId && authToken)")).slice(0, 1400);
    const catchAt = block.indexOf("} catch");
    expect(catchAt).toBeGreaterThan(-1);
    // Through the same helper the test above exercises, so the catch cannot
    // quietly build a read that looks like a successful empty one.
    expect(block.slice(catchAt, catchAt + 160)).toContain("failedRead(");
  });

  it("every read in the embed's config resolver keeps its error", () => {
    const fn = EMBED_CHAT.slice(
      EMBED_CHAT.indexOf("async function resolveConfig"),
      EMBED_CHAT.indexOf("async function resolveConfig") + 6000,
    );
    const reads = [...fn.matchAll(/const \{ data: (\w+)(, error: (\w+))? \}/g)];
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const m of reads) expect(m[3], `read of ${m[1]} drops its error`).toBeTruthy();
    // Each captured error has to be acted on, not merely named.
    for (const m of reads) {
      expect(fn, `error of ${m[1]} is never checked`).toContain(`if (${m[3]})`);
    }
  });

  it("the embed says 'no longer exists' only about a read that succeeded", () => {
    // The 404 is still right for a row that is genuinely absent or belongs to
    // someone else; it was only ever wrong as the answer to a failed read.
    // The claim as the route makes it, not the phrase as a comment mentions it.
    const claims = [...EMBED_CHAT.matchAll(/error: "The embedded \w+ no longer exists\."/g)];
    expect(claims.length).toBeGreaterThanOrEqual(2);
    for (const claim of claims) {
      // Everything between the read this claim is about and the claim itself.
      const readAt = EMBED_CHAT.lastIndexOf("await supabaseAdmin", claim.index);
      expect(readAt, "a claim with no read before it").toBeGreaterThan(-1);
      const between = EMBED_CHAT.slice(readAt, claim.index);
      expect(between, "a 503 for the unreadable case comes first").toContain(
        "EMBED_CONFIG_UNREADABLE",
      );
    }
  });
});
