// Trusting the provider's own figure for what a call cost.
//
// THE GAP THIS CLOSES, measured on this instance: 116 calls to
// moonshotai/kimi-k3 carrying 75,767 input and 56,350 output tokens, every one
// recorded at $0.00. Nothing was broken — the model simply was not in the
// vendored catalog, which had been built from a community JSON eleven days
// earlier, before the model existed. OpenRouter reported the real figure on
// every one of those calls; the app read `prompt_tokens` and `completion_tokens`
// out of the usage block and dropped `cost` on the floor.
//
// A table can only price models somebody remembered to add. The provider
// computed the number against the account being billed, so it is right for a
// model released this morning — which is the only approach that survives a
// gateway fronting 400+ models and adding more weekly.
import { describe, expect, it } from "vitest";

import {
  MAX_REPORTED_COST_USD,
  providerReportedCost,
  reportsPerCallCost,
  usageReportingBody,
} from "@/utils/observability/providerCost";

describe("reading the reported cost", () => {
  it("reads a numeric cost", () => {
    expect(
      providerReportedCost({ prompt_tokens: 294, completion_tokens: 310, cost: 0.00123 }),
    ).toBe(0.00123);
  });

  it("reads a stringified cost", () => {
    // OpenRouter sends a number; several OpenAI-compatible gateways stringify
    // their numerics, and a table lookup would silently take over if we only
    // accepted one spelling.
    expect(providerReportedCost({ cost: "0.0042" })).toBe(0.0042);
  });

  it("treats a reported zero as a real measurement, not a missing value", () => {
    // THE POINT OF RETURNING number|null. `openrouter/free` genuinely charges
    // nothing — 122 traces of it here. A table cannot tell that apart from a
    // model nobody priced; a provider saying `cost: 0` can. Collapsing the two
    // would either flag every free call as unpriced or hide real gaps behind a
    // plausible zero.
    expect(providerReportedCost({ cost: 0 })).toBe(0);
    expect(providerReportedCost({ cost: "0" })).toBe(0);
  });

  it("returns null when no cost was reported", () => {
    expect(providerReportedCost({ prompt_tokens: 10, completion_tokens: 20 })).toBeNull();
  });

  it("returns null for a missing or non-object usage block", () => {
    expect(providerReportedCost(null)).toBeNull();
    expect(providerReportedCost(undefined)).toBeNull();
  });
});

describe("refusing figures that would poison a billing column", () => {
  it("rejects a non-numeric cost rather than coercing it", () => {
    // Number("") is 0 and Number("abc") is NaN. A NaN reaching cost_usd makes
    // every SUM downstream NaN, including the one the budget cap compares
    // against — so the whole month's spend becomes unreadable from one bad
    // field.
    expect(providerReportedCost({ cost: "" })).toBeNull();
    expect(providerReportedCost({ cost: "not a number" })).toBeNull();
    expect(providerReportedCost({ cost: {} })).toBeNull();
    expect(providerReportedCost({ cost: NaN })).toBeNull();
    expect(providerReportedCost({ cost: Infinity })).toBeNull();
  });

  it("rejects a negative cost instead of clamping it to zero", () => {
    // A credit or refund is not what this call cost. Clamping would record a
    // fabricated 0 as though it had been measured, which is exactly the kind
    // of confident-but-invented number this whole path exists to avoid.
    expect(providerReportedCost({ cost: -1 })).toBeNull();
    expect(providerReportedCost({ cost: -0.0001 })).toBeNull();
  });

  it("rejects an absurd figure so a units error cannot bill someone", () => {
    // Nothing here is validated by a human before it hits a budget cap. A
    // single completion costing more than the ceiling is far likelier to be a
    // per-token/per-million mix-up than a real charge; falling back to the
    // table is the behaviour that already exists.
    expect(providerReportedCost({ cost: MAX_REPORTED_COST_USD + 1 })).toBeNull();
    expect(providerReportedCost({ cost: 1_000_000 })).toBeNull();
    // The boundary itself is allowed — a genuinely large batch should pass.
    expect(providerReportedCost({ cost: MAX_REPORTED_COST_USD })).toBe(MAX_REPORTED_COST_USD);
  });

  it("ignores upstream_inference_cost, which is not what the account pays", () => {
    // OpenRouter reports the underlying provider's charge separately, BEFORE
    // its own margin. Reading it would under-count every call by the markup.
    expect(providerReportedCost({ cost_details: { upstream_inference_cost: 0.005 } })).toBeNull();
  });
});

describe("only asking providers that can answer", () => {
  it("asks OpenRouter for usage accounting", () => {
    expect(usageReportingBody("https://openrouter.ai/api/v1")).toEqual({
      usage: { include: true },
    });
    expect(reportsPerCallCost("https://openrouter.ai/api/v1")).toBe(true);
  });

  it("adds nothing to any other provider's request body", () => {
    // `usage: {include:true}` is an OpenRouter extension and OpenAI 400s on
    // unrecognised body arguments. Sending it everywhere would break working
    // providers in order to ask a question they do not understand — so the
    // spread must be empty, not merely harmless.
    expect(usageReportingBody("https://api.openai.com/v1")).toEqual({});
    expect(usageReportingBody("http://localhost:11434/v1")).toEqual({});
    expect(usageReportingBody(undefined)).toEqual({});
    expect(usageReportingBody("")).toEqual({});
  });

  it("matches an operator's own host pointed at OpenRouter", () => {
    // A "provider" here may be any OpenAI-compatible base URL the operator
    // configured, so the match is on the resolved URL rather than a provider
    // label they chose.
    expect(reportsPerCallCost("https://OPENROUTER.AI/api/v1")).toBe(true);
    expect(reportsPerCallCost("https://gw.internal.example.com/openrouter.ai/v1")).toBe(true);
  });
});
