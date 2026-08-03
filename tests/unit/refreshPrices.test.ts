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
  buildPriceRows,
  MAX_PER_1K,
  MIN_ROWS,
  PROVIDER_MAP,
  type Raw,
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
