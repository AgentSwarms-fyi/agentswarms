// Turning public price data into a table that gates spend.
//
// Every guard here exists because the failure it prevents is SILENT. A wrong
// price does not throw — it produces a plausible number that quietly moves a
// budget, and nobody looks at a figure that seems reasonable. So the rule is
// that the script refuses to write rather than write something it cannot
// justify, and each refusal is tested.
//
// The unit conversion is the one that matters most: the source quotes USD per
// TOKEN, this codebase stores per 1K. Getting that backwards is a 1000x error
// in either direction and neither direction fails loudly.
import { describe, expect, it } from "vitest";

import {
  buildOpenRouterRows,
  buildPriceRows,
  MAX_PER_1K,
  mergeSources,
  MIN_ROWS,
  PROVIDER_MAP,
  type Raw,
  type Row,
} from "../../scripts/refreshPrices";

const entry = (over: Record<string, unknown> = {}) => ({
  litellm_provider: "openai",
  input_cost_per_token: 0.0000025,
  output_cost_per_token: 0.00001,
  ...over,
});

describe("per-token becomes per-1K, exactly once", () => {
  it("multiplies by 1000 and no more", () => {
    const { rows } = buildPriceRows({ "gpt-4o": entry() } as Raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].in).toBeCloseTo(0.0025, 12);
    expect(rows[0].out).toBeCloseTo(0.01, 12);
  });

  it("would be caught if the factor were wrong in either direction", () => {
    // A 1000x error lands far outside the plausible band for a real model.
    const { rows } = buildPriceRows({ "gpt-4o": entry() } as Raw);
    expect(rows[0].in).toBeLessThan(1);
    expect(rows[0].in).toBeGreaterThan(0.0001);
  });

  it("accepts a price quoted as a string, as the source sometimes does", () => {
    const { rows } = buildPriceRows({
      m: entry({ input_cost_per_token: "0.0000025", output_cost_per_token: "0.00001" }),
    } as Raw);
    expect(rows[0].in).toBeCloseTo(0.0025, 12);
  });
});

describe("rows that cannot be justified are dropped, not guessed", () => {
  it("rejects a price above the sanity ceiling", () => {
    // The shape a units error takes: 1000x too high.
    const { rows, skipped } = buildPriceRows({
      wrong: entry({ input_cost_per_token: MAX_PER_1K }),
    } as Raw);
    expect(rows).toHaveLength(0);
    expect(skipped[0]).toMatch(/above the sanity ceiling/);
  });

  it("rejects an output price above the ceiling even when input is fine", () => {
    const { rows } = buildPriceRows({
      wrong: entry({ output_cost_per_token: 1 }),
    } as Raw);
    expect(rows).toHaveLength(0);
  });

  it("drops a row that is zero on both sides", () => {
    // Indistinguishable from a parse failure, so the resolver should report
    // the model as unpriced rather than free.
    const { rows } = buildPriceRows({
      m: entry({ input_cost_per_token: 0, output_cost_per_token: 0 }),
    } as Raw);
    expect(rows).toHaveLength(0);
  });

  it("drops a row with no usable input price", () => {
    for (const bad of [null, undefined, "abc", -1, NaN]) {
      const { rows } = buildPriceRows({ m: entry({ input_cost_per_token: bad }) } as Raw);
      expect(rows, String(bad)).toHaveLength(0);
    }
  });

  it("keeps a genuinely expensive model that is still plausible", () => {
    // The ceiling must not reject real premium pricing, or the table quietly
    // loses the models most worth capping.
    const { rows } = buildPriceRows({
      pricey: entry({ input_cost_per_token: 0.000075, output_cost_per_token: 0.0003 }),
    } as Raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].out).toBeCloseTo(0.3, 10);
  });
});

describe("only providers this app can serve", () => {
  it("keys rows as provider:model", () => {
    const { rows } = buildPriceRows({ "gpt-4o": entry() } as Raw);
    expect(rows[0].key).toBe("openai:gpt-4o");
  });

  it("maps the source's provider names onto this app's ids", () => {
    const { rows } = buildPriceRows({
      a: entry({ litellm_provider: "vertex_ai" }),
      b: entry({ litellm_provider: "azure" }),
      c: entry({ litellm_provider: "xai" }),
    } as Raw);
    expect(rows.map((r) => r.key.split(":")[0]).sort()).toEqual(["azure_openai", "grok", "vertex"]);
  });

  it("ignores providers this app cannot serve", () => {
    // Not a gap — simply not ours. Silently carrying them would inflate the
    // row count and mask a real shrink.
    const { rows } = buildPriceRows({
      x: entry({ litellm_provider: "some-provider-we-do-not-support" }),
    } as Raw);
    expect(rows).toHaveLength(0);
  });

  it("strips a vendor prefix so the key is not doubled up", () => {
    const { rows } = buildPriceRows({
      "vertex_ai/gemini-2.5-pro": entry({ litellm_provider: "vertex_ai" }),
    } as Raw);
    expect(rows[0].key).toBe("vertex:gemini-2.5-pro");
  });

  it("skips the schema's own sample row", () => {
    const { rows } = buildPriceRows({ sample_spec: entry() } as Raw);
    expect(rows).toHaveLength(0);
  });

  it("covers the providers the app actually offers", () => {
    for (const p of ["openai", "anthropic", "bedrock", "vertex", "azure_openai", "groq"]) {
      expect(Object.values(PROVIDER_MAP), p).toContain(p);
    }
  });
});

describe("the output is a reviewable diff", () => {
  it("sorts deterministically, so a diff shows price changes not reordering", () => {
    const raw = { zeta: entry(), alpha: entry(), mid: entry() } as Raw;
    const keys = buildPriceRows(raw).rows.map((r) => r.key);
    expect(keys).toEqual([...keys].sort());
  });

  it("produces the same rows for the same input", () => {
    const raw = { "gpt-4o": entry(), "gpt-4o-mini": entry() } as Raw;
    expect(buildPriceRows(raw).rows).toEqual(buildPriceRows(raw).rows);
  });
});

describe("the refusals that stop a bad write", () => {
  // These are enforced in main() against the parsed rows; asserted on the
  // source because running them means performing the fetch.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const src = require("node:fs").readFileSync("scripts/refreshPrices.ts", "utf8") as string;

  it("refuses a table below the row floor", () => {
    // A truncated response, a rate-limit page and a schema change all look
    // like "fewer rows".
    expect(MIN_ROWS).toBeGreaterThan(50);
    expect(src).toMatch(/rows\.length < MIN_ROWS[\s\S]{0,300}process\.exit\(1\)/);
  });

  it("refuses a sudden shrink against what is already committed", () => {
    expect(src).toMatch(/rows\.length < prev \* \(1 - MAX_SHRINK\)[\s\S]{0,300}process\.exit\(1\)/);
  });

  it("refuses a non-200 response and unparseable JSON", () => {
    expect(src).toMatch(/!res\.ok[\s\S]{0,200}process\.exit\(1\)/);
    expect(src).toMatch(/not valid JSON[\s\S]{0,120}process\.exit\(1\)/);
  });

  it("records provenance in the generated file", () => {
    // A price with no source and no date cannot be audited or re-checked.
    for (const field of ["source:", "fetched:", "sha256:", "rows:"]) {
      expect(src, field).toContain(field);
    }
  });

  it("offers a dry run, so the check can be made without writing", () => {
    expect(src).toContain("--dry");
    expect(src).toMatch(/if \(dry\)[\s\S]{0,200}return;/);
  });
});

describe("one key, two prices", () => {
  // 95 keys collided on the real source and TypeScript rejected the duplicate
  // literal, which is how this surfaced. Emitting valid code was the least of
  // it: some collisions carried DIFFERENT prices — 103 of them, all Azure
  // regional-versus-global tiers like 0.00275 against 0.0025.
  const dup = (id: string, provider: string, i: number, o: number) => ({
    [id]: entry({ litellm_provider: provider, input_cost_per_token: i, output_cost_per_token: o }),
  });

  it("collapses identical duplicates without comment", () => {
    // `azure/x` and `azure_ai/x` both map to azure_openai. Nothing was decided,
    // so nothing needs reporting.
    const { rows, conflicts } = buildPriceRows({
      ...dup("azure/gpt-4o", "azure", 0.0000025, 0.00001),
      ...dup("azure_ai/gpt-4o", "azure_ai", 0.0000025, 0.00001),
    } as Raw);
    expect(rows).toHaveLength(1);
    expect(conflicts).toEqual([]);
  });

  it("keeps the HIGHER price when duplicates disagree", () => {
    // Higher because this feeds a safety cap: over-estimating trips the cap
    // early, under-estimating lets spend run past it.
    const { rows } = buildPriceRows({
      ...dup("azure/gpt-4o", "azure", 0.0000025, 0.00001),
      ...dup("azure_ai/gpt-4o", "azure_ai", 0.00000275, 0.000011),
    } as Raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].in).toBeCloseTo(0.00275, 10);
    expect(rows[0].out).toBeCloseTo(0.011, 10);
  });

  it("takes the higher of EACH side independently", () => {
    // A source can be higher on input and lower on output; picking one row
    // wholesale would under-count the other half.
    const { rows } = buildPriceRows({
      ...dup("azure/m", "azure", 0.000003, 0.00001),
      ...dup("azure_ai/m", "azure_ai", 0.000002, 0.00002),
    } as Raw);
    expect(rows[0].in).toBeCloseTo(0.003, 10);
    expect(rows[0].out).toBeCloseTo(0.02, 10);
  });

  it("reports every disagreement instead of resolving it silently", () => {
    const { conflicts } = buildPriceRows({
      ...dup("azure/gpt-4o", "azure", 0.0000025, 0.00001),
      ...dup("azure_ai/gpt-4o", "azure_ai", 0.00000275, 0.000011),
    } as Raw);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("azure_openai:gpt-4o");
    expect(conflicts[0]).toMatch(/kept the higher/);
  });

  it("emits each key exactly once, so the output is valid TypeScript", () => {
    // The duplicate literal is a compile error, so this is not merely tidiness.
    const { rows } = buildPriceRows({
      ...dup("azure/a", "azure", 0.000001, 0.000002),
      ...dup("azure_ai/a", "azure_ai", 0.000003, 0.000004),
      ...dup("azure/b", "azure", 0.000001, 0.000002),
    } as Raw);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

// ── OpenRouter's own catalog ────────────────────────────────────────────────
//
// ADDED BECAUSE THE COMMUNITY SOURCE LAGS THE GATEWAY and the lag costs money.
// moonshotai/kimi-k3 ran 116 times on this instance — 75,767 in, 56,350 out —
// and recorded $0.00 on every call, because the vendored table was built from
// LiteLLM on 4 August and the model was not in it. OpenRouter was publishing
// the rate at /api/v1/models the whole time, unauthenticated. About $1.07 of
// spend that no budget cap could see.
describe("OpenRouter's catalog", () => {
  const model = (id: string, prompt: unknown, completion: unknown) => ({
    id,
    pricing: { prompt, completion },
  });

  it("converts per-token strings to per-1K numbers", () => {
    // THE UNIT TRAP, on the second source now. OpenRouter quotes per TOKEN and
    // as a STRING; this codebase stores per 1K as a number. The real kimi-k3
    // figures, so the arithmetic is checked against a rate that was actually
    // published rather than a made-up one.
    const { rows } = buildOpenRouterRows([model("moonshotai/kimi-k3", "0.000003", "0.000015")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("openrouter:kimi-k3");
    // toBeCloseTo, as the community-source tests above do: 0.000015 * 1000 is
    // 0.015000000000000001 in binary floating point. The artefact is harmless
    // at these magnitudes and is already visible throughout the committed
    // table; asserting exact equality would only be testing IEEE-754.
    expect(rows[0].in).toBeCloseTo(0.003, 12);
    expect(rows[0].out).toBeCloseTo(0.015, 12);
  });

  it("keys by the bare model id, matching how the resolver looks one up", () => {
    // priceResolver tries `openrouter:moonshotai/kimi-k3` and then
    // `openrouter:kimi-k3`. The committed table has always used the bare tail,
    // so a vendor-qualified key here would simply never be found.
    const { rows } = buildOpenRouterRows([model("qwen/qwen3-max", "0.000001", "0.000002")]);
    expect(rows[0].key).toBe("openrouter:qwen3-max");
  });

  it("strips the ~ that marks a gateway-side alias", () => {
    // The resolver strips `~` before lookup. A key that kept it could never
    // match the id the resolver is asking about — the decoration would defeat
    // the very row meant to price it.
    const { rows } = buildOpenRouterRows([
      model("~moonshotai/kimi-latest", "0.0000028", "0.000014"),
    ]);
    expect(rows[0].key).toBe("openrouter:kimi-latest");
  });

  it("refuses a rate above the sanity ceiling", () => {
    const { rows, skipped } = buildOpenRouterRows([
      model("vendor/absurd", String(MAX_PER_1K), "1"),
    ]);
    expect(rows).toHaveLength(0);
    expect(skipped[0]).toContain("above the sanity ceiling");
  });

  it("drops rows that are zero on both sides", () => {
    // Indistinguishable from a parse failure, exactly as in the community
    // path. A genuinely free route is handled by the provider reporting
    // `cost: 0` on the call itself, which is a measurement rather than an
    // absent table row.
    expect(buildOpenRouterRows([model("vendor/free", "0", "0")]).rows).toHaveLength(0);
  });

  it("ignores malformed entries instead of emitting a NaN price", () => {
    const { rows } = buildOpenRouterRows([
      model("vendor/no-price", undefined, undefined),
      { id: "vendor/no-pricing-object" },
      { pricing: { prompt: "0.000001" } }, // no id
      null,
      "not an object",
    ]);
    expect(rows).toHaveLength(0);
  });

  it("returns nothing when the response is not an array", () => {
    // A rate-limit page or a schema change arrives looking like this. It must
    // produce zero rows so the merge leaves the community table untouched,
    // never a table of garbage.
    expect(buildOpenRouterRows(undefined).rows).toHaveLength(0);
    expect(buildOpenRouterRows({ error: "rate limited" }).rows).toHaveLength(0);
  });
});

describe("merging the two sources", () => {
  const community: Row[] = [
    { key: "openrouter:kimi-k2.5", in: 0.0006, out: 0.003 },
    { key: "openai:gpt-5", in: 0.00125, out: 0.01 },
  ];

  it("adds models the community source never had", () => {
    const { rows } = mergeSources(community, [
      { key: "openrouter:kimi-k3", in: 0.003, out: 0.015 },
    ]);
    expect(rows.find((r) => r.key === "openrouter:kimi-k3")).toEqual({
      key: "openrouter:kimi-k3",
      in: 0.003,
      out: 0.015,
    });
  });

  it("lets the gateway's own rate WIN, even when it is lower", () => {
    // The one place that does not take the higher of two figures, and the
    // reason is not caution but correctness: a model served through OpenRouter
    // is billed at OpenRouter's rate, so the community row is not a competing
    // estimate of the same quantity. Taking the higher would record a number
    // nobody charges. Measured on the real refresh: 36 keys differed, some by
    // more than 50%.
    const { rows, replaced } = mergeSources(community, [
      { key: "openrouter:kimi-k2.5", in: 0.00057, out: 0.00285 },
    ]);
    expect(rows.find((r) => r.key === "openrouter:kimi-k2.5")).toEqual({
      key: "openrouter:kimi-k2.5",
      in: 0.00057,
      out: 0.00285,
    });
    expect(replaced[0]).toContain("openrouter:kimi-k2.5");
  });

  it("reports every rate it replaced rather than swapping silently", () => {
    const { replaced } = mergeSources(community, [
      { key: "openrouter:kimi-k2.5", in: 0.00057, out: 0.00285 },
    ]);
    expect(replaced).toHaveLength(1);
  });

  it("says nothing when the two agree", () => {
    const { replaced } = mergeSources(community, [
      { key: "openrouter:kimi-k2.5", in: 0.0006, out: 0.003 },
    ]);
    expect(replaced).toHaveLength(0);
  });

  it("leaves other providers' rows alone", () => {
    const { rows } = mergeSources(community, [
      { key: "openrouter:kimi-k3", in: 0.003, out: 0.015 },
    ]);
    expect(rows.find((r) => r.key === "openai:gpt-5")).toEqual(community[1]);
  });

  it("keeps the community table intact when the gateway returned nothing", () => {
    // The refresh treats OpenRouter as non-fatal, so an outage must degrade to
    // the previous behaviour rather than blanking the catalog.
    const { rows, replaced } = mergeSources(community, []);
    expect(rows).toHaveLength(2);
    expect(replaced).toHaveLength(0);
  });
});
