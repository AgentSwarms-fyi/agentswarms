// Traces showed $0.0000 for real model spend.
//
// Measured on the live instance over a fortnight: 156 calls to
// `~anthropic/claude-haiku-latest` and 43 to `~anthropic/claude-sonnet-latest`
// — about a million tokens of real Anthropic usage — every one recorded at
// cost 0 with request_payload.pricing_missing, all of it invisible to the
// budget caps that sum cost_usd.
//
// Two independent misses, both in candidate generation, neither in the data:
//   · the gateway's `~` vendor decoration defeated every exact key
//   · "-latest" rolling aliases have no entry in tables keyed by concrete ids
//
// The fix strips the decoration, resolves aliases through an explicit map
// (MODEL_ALIASES — a reviewed pricing decision, not a fuzzy match), re-prices
// marked history on the maintenance pass, and stops the UI rendering an
// unpriced call as if it were free.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MODEL_ALIASES } from "@/utils/observability/pricing";
import { priceCall, resolvePrice } from "@/utils/observability/priceResolver";
import { classifyZeroRow, repriceRow } from "@/utils/observability/reprice.server";

const REFRESH = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
const TRACES_UI = readFileSync("src/routes/_authenticated/traces.tsx", "utf8");
const TRACE_FNS = readFileSync("src/utils/traceLog.functions.ts", "utf8");
const MIGRATION = readFileSync(
  "supabase/migrations/20260785000000_trace_reprice_index.sql",
  "utf8",
);

describe("the exact ids from the live traces now price", () => {
  it("~anthropic/claude-haiku-latest resolves at current haiku rates", () => {
    const p = resolvePrice({
      provider: "openrouter",
      model: "~anthropic/claude-haiku-latest",
      kind: "text",
    });
    expect(p).not.toBeNull();
    expect(p!.in).toBeGreaterThan(0);
    expect(p!.out).toBeGreaterThan(0);
  });

  it("~anthropic/claude-sonnet-latest resolves too", () => {
    const p = resolvePrice({
      provider: "openrouter",
      model: "~anthropic/claude-sonnet-latest",
      kind: "text",
    });
    expect(p).not.toBeNull();
    expect(p!.in).toBeGreaterThan(0);
  });

  it("the fortnight of haiku usage prices to real money, not zero", () => {
    // The measured aggregate: 475,700 in / 205,362 out across 156 calls.
    const { costUsd, priced } = priceCall({
      provider: "openrouter",
      model: "~anthropic/claude-haiku-latest",
      kind: "text",
      tokensIn: 475_700,
      tokensOut: 205_362,
    });
    expect(priced).toBe(true);
    expect(costUsd).toBeGreaterThan(1); // ≈ $1.50 at current haiku rates
  });

  it("a bare alias id (no vendor prefix) resolves via the alias map alone", () => {
    // Kills the mutant that drops alias expansion: the bundled fallback keys
    // are vendor-prefixed, so "claude-haiku-latest" without a vendor can ONLY
    // resolve through MODEL_ALIASES → the provider-qualified catalog entry.
    const p = resolvePrice({ provider: "openrouter", model: "claude-haiku-latest", kind: "text" });
    expect(p).not.toBeNull();
    expect(p!.source).toBe("catalog");
  });

  it("an alias under a provider the catalog doesn't cover resolves via bundled", () => {
    // Kills the mutant that drops the bundled entries: groq has no anthropic
    // rows in the generated catalog, so only the bundled vendor-prefixed alias
    // entry can answer here.
    const p = resolvePrice({
      provider: "groq",
      model: "anthropic/claude-haiku-latest",
      kind: "text",
    });
    expect(p).not.toBeNull();
    expect(p!.source).toBe("bundled");
  });

  it("every alias in the map points at a key some table actually has", () => {
    // An alias to a superseded or misspelled id silently prices at nothing —
    // the exact bug class this map exists to end.
    for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
      const p = resolvePrice({ provider: "openrouter", model: target, kind: "text" });
      expect(p, `alias ${alias} → ${target} resolves`).not.toBeNull();
    }
  });
});

describe("exact-key discipline survives the new candidates", () => {
  it("an unknown model still resolves to nothing, not a neighbour's rate", () => {
    expect(
      resolvePrice({ provider: "openrouter", model: "totally/made-up-model", kind: "text" }),
    ).toBeNull();
    expect(
      resolvePrice({ provider: "openrouter", model: "~vendor/nonexistent-latest", kind: "text" }),
    ).toBeNull();
  });

  it("decoration stripping touches only the ~ prefix", () => {
    // A model whose name legitimately contains a tilde elsewhere is untouched.
    const a = resolvePrice({ provider: "openrouter", model: "openai/gpt-4o-mini", kind: "text" });
    const b = resolvePrice({ provider: "openrouter", model: "~openai/gpt-4o-mini", kind: "text" });
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
  });

  it("a zero-token priced call still costs zero — those rows were never a bug", () => {
    // 85 of the measured $0 rows were error traces with no tokens; they must
    // stay $0 and unmarked, or the sweep would 'fix' correct data.
    const { costUsd, priced } = priceCall({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      kind: "text",
      tokensIn: 0,
      tokensOut: 0,
    });
    expect(priced).toBe(true);
    expect(costUsd).toBe(0);
  });
});

describe("repriceRow — the sweep's whole decision, pure", () => {
  const row = (
    payload: Record<string, unknown> | null,
    model = "~anthropic/claude-haiku-latest",
  ) => ({
    id: "t1",
    llm_provider: "openrouter",
    llm_model: model,
    tokens_in: 3157,
    tokens_out: 5726,
    request_payload: payload,
  });

  it("re-prices a marked row and swaps the marker for the price source", () => {
    const out = repriceRow(row({ pricing_missing: true, kind: "text" }));
    expect(out).not.toBeNull();
    expect(out!.cost_usd).toBeGreaterThan(0);
    const payload = out!.request_payload as Record<string, unknown>;
    expect(payload.pricing_missing).toBeUndefined();
    expect(payload.price_source).toBeTruthy();
    expect(payload.repriced_at).toBeTruthy();
  });

  it("leaves unmarked rows alone — priced history is not rewritten", () => {
    expect(repriceRow(row({ price_source: "catalog" }))).toBeNull();
    expect(repriceRow(row(null))).toBeNull();
  });

  it("leaves still-unpriceable rows marked for a later pass", () => {
    expect(repriceRow(row({ pricing_missing: true }, "totally/unknown-model"))).toBeNull();
  });
});

describe("classifyZeroRow — legacy unmarked zeros get sorted, once", () => {
  // Live measurement after phase 1 ran: 28 opus-latest and 19 gemini rows sat
  // at $0 with NO marker (older writers never stamped one), invisible to the
  // marker-driven sweep for ever.
  const row = (
    model: string,
    payload: Record<string, unknown> | null = null,
    tokens = { in: 1000, out: 500 },
  ) => ({
    id: "t2",
    llm_provider: model.startsWith("gemini") ? "gemini" : "openrouter",
    llm_model: model,
    tokens_in: tokens.in,
    tokens_out: tokens.out,
    request_payload: payload,
  });

  it("prices a resolvable legacy row (the opus/gemini case)", () => {
    for (const m of ["~anthropic/claude-opus-latest", "gemini/models/gemini-flash-latest"]) {
      const out = classifyZeroRow(row(m));
      expect(out, m).not.toBeNull();
      expect(out!.cost_usd).toBeGreaterThan(0);
      expect((out!.request_payload as Record<string, unknown>).price_source).toBeTruthy();
    }
  });

  it("prices the gemini alias under the provider the live rows actually carry", () => {
    // The 19 real rows say provider "openrouter", whose catalog section has no
    // gemini entries — the bare bundled key is the only thing that can answer.
    const p = resolvePrice({
      provider: "openrouter",
      model: "gemini/models/gemini-flash-latest",
      kind: "text",
    });
    expect(p).not.toBeNull();
    expect(p!.in).toBeGreaterThan(0);
  });

  it("marks a still-unknown model instead of leaving it invisible", () => {
    const out = classifyZeroRow(row("totally/unknown-model"));
    expect(out).not.toBeNull();
    expect(out!.cost_usd).toBeUndefined();
    expect((out!.request_payload as Record<string, unknown>).pricing_missing).toBe(true);
  });

  it("never touches zero-token rows — those $0s are true", () => {
    expect(
      classifyZeroRow(row("~anthropic/claude-opus-latest", null, { in: 0, out: 0 })),
    ).toBeNull();
  });

  it("never touches rows that already carry a verdict", () => {
    expect(classifyZeroRow(row("x", { pricing_missing: true }))).toBeNull();
    expect(classifyZeroRow(row("x", { price_source: "catalog" }))).toBeNull();
  });
});

describe("the chat gateway prices like everything else", () => {
  const CHAT = readFileSync("src/routes/api/chat.ts", "utf8");

  it("routes through the provider-aware resolver, not the small table", () => {
    expect(CHAT).toContain('import { priceCall } from "@/utils/observability/priceResolver"');
    expect(CHAT).toMatch(/estimateCost\(trace\.provider, trace\.model/);
    expect(CHAT).not.toContain("estimateTextCost(");
    // ...and the wrapper's BODY actually calls it — an import plus untouched
    // call sites can survive a gutted implementation.
    expect(CHAT).toMatch(/const priced = priceCall\(\{ provider, model, kind: "text"/);
    expect(CHAT).toContain("return priced.costUsd;");
  });

  it("stamps pricing_missing so its zeros are findable and labelled", () => {
    expect(CHAT).toContain("safePayload.pricing_missing = true");
  });
});

describe("wired end to end", () => {
  it("the sweep runs on the maintenance pass", () => {
    expect(REFRESH).toContain('import("@/utils/observability/reprice.server")');
    expect(REFRESH).toContain("repriceUnpricedTraces(force)");
  });

  it("the marker scan is indexed — it runs forever on the biggest table", () => {
    expect(MIGRATION).toMatch(/idx_execution_traces_pricing_missing/);
    expect(MIGRATION).toMatch(/WHERE request_payload ->> 'pricing_missing' = 'true'/);
  });

  it("the trace list carries the marker without dragging the whole payload", () => {
    expect(TRACE_FNS).toContain("pricing_missing:request_payload->>pricing_missing");
  });

  it("the UI labels an unpriced call instead of printing $0.0000", () => {
    expect(TRACES_UI).toContain('pricing_missing === "true"');
    // JSX formatting may split the element across lines — match structurally.
    expect(TRACES_UI).toMatch(/>\s*unpriced\s*</);
    expect(TRACES_UI).toContain("the amount is missing, not zero");
  });

  it("a turn containing unpriced rounds shows a partial total, not a clean sum", () => {
    expect(TRACES_UI).toMatch(/unpriced: isUnpriced\(t\) \|\| kids\.some\(isUnpriced\)/);
  });
});
