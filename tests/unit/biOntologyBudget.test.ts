// "AI enrichment unavailable (openai/gpt-4o-mini did not finish within 60s)".
//
// Found by building an Ontology widget over the built-in lakehouse: 21 tables,
// default model. The AI step timed out, the widget fell back to heuristic
// labels, and the map of the data estate showed 21 entities and **0**
// relationships — which is not a map.
//
// The cause is in llmDeadline.ts, and that file's own comment names the trap:
// the deadline is `floor + maxTokens * msPerToken`, so a call that names no
// completion cap lands on the 60-second floor. `enrichOntology` named none.
// It is the largest generation in the product — a record for every entity and
// a typed triple for every relation — and it had the same clock as a one-line
// SQL step.
//
// Sizing the cap fixes both halves at once: the reply can no longer be
// truncated, and the deadline grows with the estate.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ontologyTokenBudget } from "@/lib/biOntology";
import { CLIENT_HEADROOM_MS, clientDeadlineMs, upstreamDeadlineMs } from "@/lib/llmDeadline";

describe("the completion budget for an ontology", () => {
  it("grows with the estate", () => {
    const small = ontologyTokenBudget(5, 0);
    const medium = ontologyTokenBudget(21, 0);
    const large = ontologyTokenBudget(73, 40);
    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
  });

  it("budgets for relations the AI is invited to ADD, not just detected ones", () => {
    // The prompt asks for "every new one the data supports", and the estate
    // that failed had zero detected relations — budgeting from that number
    // would have budgeted for nothing.
    expect(ontologyTokenBudget(21, 0)).toBe(ontologyTokenBudget(21, 42));
    expect(ontologyTokenBudget(21, 0)).toBeGreaterThan(3000);
  });

  it("uses the detected count once it exceeds the floor of twice the entities", () => {
    expect(ontologyTokenBudget(10, 100)).toBeGreaterThan(ontologyTokenBudget(10, 20));
  });

  it("stays inside the cap the deadline honours", () => {
    // upstreamDeadlineMs clamps maxTokens at 16000; a budget above that buys
    // no more time, so claiming one would only invite truncation elsewhere.
    expect(ontologyTokenBudget(5000, 9000)).toBe(16000);
  });
});

describe("where the budget is actually spent", () => {
  it("is passed to the enrichment call, not merely exported", () => {
    // A budget nothing sends is a budget nothing gets. Mutation-checked:
    // deleting the maxTokens line left every behavioural test above green,
    // because they all exercise the pure function and none of them look at
    // the one line that puts it on the request.
    const src = readFileSync("src/lib/biOntology.ts", "utf8");
    const at = src.indexOf("export async function enrichOntology");
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, at + 900);
    expect(call).toMatch(
      /maxTokens:\s*ontologyTokenBudget\(args\.entities\.length,\s*args\.relations\.length\)/,
    );
  });
});

describe("the clock that budget buys", () => {
  const MODEL = "openai/gpt-4o-mini";

  it("no longer leaves a 21-table estate on the 60-second floor", () => {
    // The exact case that failed.
    const before = upstreamDeadlineMs(undefined, MODEL);
    const after = upstreamDeadlineMs(ontologyTokenBudget(21, 0), MODEL);
    expect(before).toBe(60_000);
    expect(after).toBeGreaterThan(85_000);
  });

  it("scales with the estate rather than jumping to a new flat number", () => {
    const small = upstreamDeadlineMs(ontologyTokenBudget(5, 0), MODEL);
    const large = upstreamDeadlineMs(ontologyTokenBudget(73, 40), MODEL);
    expect(large).toBeGreaterThan(small);
    // A whole-estate scan is allowed real time, but not unbounded time.
    expect(large).toBeLessThanOrEqual(300_000);
  });

  it("keeps the client's clock behind the server's, so the server's error wins", () => {
    const cap = ontologyTokenBudget(21, 0);
    expect(clientDeadlineMs(cap, MODEL)).toBe(upstreamDeadlineMs(cap, MODEL) + CLIENT_HEADROOM_MS);
  });
});
