// The per-agent semantic-model allow-list for metric_query.
//
// DENY BY DEFAULT: an agent gets the models it was explicitly given and
// nothing else. Enabling the tool alone does nothing.
//
// The assertion that carries the weight is that the allow-list is enforced in
// the HANDLER, not only in the catalog that shapes the prompt. The model name
// arrives in the LLM's tool arguments, so an agent can ask for a model it was
// never shown — by hallucination, or because a user told it the name. An
// allow-list that only filters what gets advertised is cosmetic, which is the
// same failure the shared-dataset column mask had before it was moved into SQL.
import { describe, expect, it } from "vitest";

import { normaliseAllowList, runMetricQuery } from "@/utils/tools/metric.server";
import type { AgentToolContext } from "@/utils/tools/registry.server";

/**
 * A context that would EXPLODE if the query were actually attempted.
 *
 * Every test here is about refusal, so reaching the database at all is itself
 * the failure. A permissive mock would let a broken allow-list pass by
 * returning plausible rows.
 */
const ctx = {
  get sb(): never {
    throw new Error("the allow-list must refuse BEFORE any database access");
  },
  userId: "11111111-1111-1111-1111-111111111111",
} as unknown as AgentToolContext;

const args = { model: "finance", metrics: ["revenue"] };

describe("normaliseAllowList", () => {
  it("treats absent and empty as NOTHING, never as everything", () => {
    // The whole design rests on this. An allow-list whose empty case meant
    // "all" would be one careless `?? []` away from opening the account up.
    expect(normaliseAllowList(undefined)).toBeNull();
    expect(normaliseAllowList(null)).toBeNull();
    expect(normaliseAllowList([])).toBeNull();
  });

  it("discards blanks and whitespace-only entries", () => {
    expect(normaliseAllowList(["", "   ", "\t"])).toBeNull();
    expect(normaliseAllowList([" finance ", ""])).toEqual(new Set(["finance"]));
  });

  it("ignores non-string entries rather than coercing them", () => {
    expect(normaliseAllowList([1, null, {}, "ok"] as unknown as string[])).toEqual(new Set(["ok"]));
  });
});

describe("runMetricQuery refuses before touching the database", () => {
  it("refuses when the agent has no models enabled", async () => {
    const out = await runMetricQuery(ctx, args, []);
    expect(out).toMatch(/no semantic models enabled/i);
    expect(out).toMatch(/Agent Builder/);
  });

  it("refuses when no allow-list was passed at all", async () => {
    const out = await runMetricQuery(ctx, args, undefined);
    expect(out).toMatch(/no semantic models enabled/i);
  });

  it("REFUSES A MODEL THE AGENT WAS NEVER SHOWN", async () => {
    // The catalog would have advertised only "marketing". The model asking for
    // "finance" anyway is exactly the case prompt-filtering cannot cover.
    const out = await runMetricQuery(ctx, { model: "finance", metrics: ["revenue"] }, [
      "marketing",
    ]);
    expect(out).toMatch(/not enabled for this agent/i);
  });

  it("names the permitted models so the agent can correct itself", async () => {
    const out = await runMetricQuery(ctx, args, ["marketing", "support"]);
    expect(out).toContain("marketing");
    expect(out).toContain("support");
  });

  it("does not reveal whether the refused model exists", async () => {
    // Refusal is about this agent's configuration, not about the account's
    // inventory — an agent should not be a way to enumerate model names.
    const out = await runMetricQuery(ctx, { model: "secret_model", metrics: ["x"] }, ["marketing"]);
    expect(out).not.toMatch(/does not exist|not found|no such model/i);
  });

  it("tolerates whitespace around the requested name", async () => {
    // "  marketing  " is allowed and must not be refused on a technicality. It
    // gets PAST the allow-list and reaches the database, which this context
    // makes throw — the tool reports that as a string rather than rejecting,
    // so seeing the database error is the proof it was permitted.
    const out = await runMetricQuery(ctx, { model: "  marketing  ", metrics: ["x"] }, [
      "marketing",
    ]);
    expect(out).toMatch(/BEFORE any database access/);
    expect(out).not.toMatch(/not enabled/i);
  });

  it("is case-SENSITIVE, matching how model names resolve elsewhere", async () => {
    const out = await runMetricQuery(ctx, { model: "Marketing", metrics: ["x"] }, ["marketing"]);
    expect(out).toMatch(/not enabled/i);
  });

  it("refuses a model id even when that model is allowed by name", async () => {
    // Fail closed. The catalog gives the agent NAMES, so an id is either a
    // hallucination or an attempt to sidestep the list; either way the answer
    // is no rather than a lookup.
    const out = await runMetricQuery(
      ctx,
      { model: "0f8b8f4e-0000-4000-8000-000000000000", metrics: ["x"] },
      ["marketing"],
    );
    expect(out).toMatch(/not enabled/i);
  });

  it("still rejects a missing model argument", async () => {
    const out = await runMetricQuery(ctx, { metrics: ["x"] }, ["marketing"]);
    expect(out).toMatch(/`model` is required/);
  });

  it("checks the allow-list before validating the rest of the arguments", async () => {
    // A disallowed model with no metrics must report the ACCESS problem, not
    // the argument problem — otherwise the error text tells an agent which
    // models exist by how the message changes.
    const out = await runMetricQuery(ctx, { model: "finance" }, ["marketing"]);
    expect(out).toMatch(/not enabled/i);
    expect(out).not.toMatch(/at least one metric/i);
  });
});
