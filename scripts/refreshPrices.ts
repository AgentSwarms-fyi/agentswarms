#!/usr/bin/env tsx
/**
 * Vendor public model prices into the repo.
 *
 *   npm run prices:refresh          fetch, validate, write, print a summary
 *   npm run prices:refresh -- --dry  validate and report, write nothing
 *
 * PRICES ARE FETCHED HERE AND COMMITTED, NOT READ AT RUNTIME. For a number that
 * gates spend that matters more than freshness:
 *
 *   - a rate change arrives as a reviewable diff instead of appearing in a bill
 *   - `git blame` gives price history, which is what an auditor asks for
 *   - no third party can move your budgets by changing their data or going down
 *   - an air-gapped deployment is unaffected; it is just a source file
 *
 * The source is community-maintained and NOT authoritative. That is acceptable
 * for the catalog layer precisely because it is beaten by operator overrides
 * and because anything it misses stays flagged rather than silently costing
 * zero — see priceResolver.ts.
 *
 * EVERY GUARD BELOW EXISTS BECAUSE THE FAILURE IT PREVENTS IS SILENT. A wrong
 * price does not throw; it produces a plausible number that quietly moves a
 * budget. So the script refuses to write rather than write something it cannot
 * justify.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

/** Community dataset: per-model, per-provider, USD per TOKEN. */
const SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const OUT = "src/utils/observability/priceTable.generated.ts";

/**
 * Sanity bounds, USD per 1K tokens.
 *
 * The unit trap is the one that matters: the source quotes per TOKEN, this
 * codebase stores per 1K. Getting that backwards is a 1000x error in either
 * direction, and neither direction throws — it just makes every budget wrong.
 * MAX is set well above the priciest frontier model so a genuine premium rate
 * passes while a units mistake cannot.
 */
export const MAX_PER_1K = 5.0;
export const MIN_PER_1K = 0.0000001;

/**
 * Refuse to write a table smaller than this.
 *
 * A truncated response, a rate-limit page or an upstream schema change all
 * arrive as "fewer rows", and overwriting a good table with a nearly empty one
 * would silently un-price most of the catalog.
 */
export const MIN_ROWS = 100;

/** How far the row count may fall against the committed table before refusing. */
export const MAX_SHRINK = 0.2;

/** Providers this app can actually serve, mapped to the source's naming. */
export const PROVIDER_MAP: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  azure: "azure_openai",
  azure_ai: "azure_openai",
  bedrock: "bedrock",
  vertex_ai: "vertex",
  "vertex_ai-language-models": "vertex",
  gemini: "gemini",
  groq: "groq",
  openrouter: "openrouter",
  xai: "grok",
  mistral: "mistral",
  deepseek: "deepseek",
  ollama: "ollama",
};

export type Row = { key: string; in: number; out: number };
export type Raw = Record<string, Record<string, unknown>>;

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function buildPriceRows(raw: Raw): { rows: Row[]; skipped: string[]; conflicts: string[] } {
  const rows: Row[] = [];
  const skipped: string[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if (id === "sample_spec") continue;

    const litellmProvider = String(entry.litellm_provider ?? "");
    const provider = PROVIDER_MAP[litellmProvider];
    // A provider this app cannot serve is not a gap — it is simply not ours.
    if (!provider) continue;

    // Per TOKEN in the source; this codebase stores per 1K. The one conversion
    // in the file, done once, so it can be tested.
    const inPerToken = num(entry.input_cost_per_token);
    const outPerToken = num(entry.output_cost_per_token);
    if (inPerToken == null) continue;

    const inPer1k = inPerToken * 1000;
    const outPer1k = (outPerToken ?? 0) * 1000;

    if (inPer1k > MAX_PER_1K || outPer1k > MAX_PER_1K) {
      skipped.push(`${id}: above the sanity ceiling (in=${inPer1k}, out=${outPer1k})`);
      continue;
    }
    if (inPer1k > 0 && inPer1k < MIN_PER_1K) {
      skipped.push(`${id}: below the sanity floor (in=${inPer1k})`);
      continue;
    }
    // Free models are real (some hosted previews), but a row that is zero on
    // BOTH sides is indistinguishable from a parse failure, so it is dropped
    // and the resolver reports the model as unpriced instead.
    if (inPer1k === 0 && outPer1k === 0) continue;

    // The model id in the source often already carries its vendor. Strip the
    // provider prefix if present so the key is exactly `provider:model`.
    const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
    rows.push({ key: `${provider}:${bare}`.toLowerCase(), in: inPer1k, out: outPer1k });
  }

  // ── Collapse duplicate keys ────────────────────────────────────────────
  //
  // Several source ids map onto one `provider:model` key — `azure/x` and
  // `azure_ai/x` both become azure_openai, and dated snapshots collide with
  // their aliases. TypeScript rejects the duplicate literal outright, which is
  // how this surfaced, but emitting valid code is the least of it: 95 keys
  // collided and some carried DIFFERENT prices (gpt-4.1-2025-04-14 at 0.002
  // and at 0.0022 — regional Azure tiers).
  //
  // Picking one silently is precisely what a financial control must not do, so:
  //   - identical prices collapse quietly, nothing was decided
  //   - DIFFERING prices take the HIGHER of each side and are REPORTED. Higher
  //     because this feeds a safety cap: over-estimating trips the cap early,
  //     under-estimating lets spend run past it. The conflict is printed so an
  //     operator can set an exact override for their region or tier.
  const byKey = new Map<string, Row>();
  const conflicts: string[] = [];
  for (const row of rows) {
    const prev = byKey.get(row.key);
    if (!prev) {
      byKey.set(row.key, row);
      continue;
    }
    if (prev.in === row.in && prev.out === row.out) continue;
    conflicts.push(
      `${row.key}: ${prev.in}/${prev.out} vs ${row.in}/${row.out} — kept the higher of each`,
    );
    byKey.set(row.key, {
      key: row.key,
      in: Math.max(prev.in, row.in),
      out: Math.max(prev.out, row.out),
    });
  }

  // Deterministic order so a diff shows price changes, not reordering.
  const deduped = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { rows: deduped, skipped, conflicts };
}

function previousRowCount(): number {
  if (!existsSync(OUT)) return 0;
  return (readFileSync(OUT, "utf8").match(/^\s*"[^"]+": \{ in:/gm) ?? []).length;
}

function render(rows: Row[], meta: { url: string; fetchedAt: string; hash: string }): string {
  const body = rows.map((r) => `  ${JSON.stringify(r.key)}: { in: ${r.in}, out: ${r.out} },`);
  return `// GENERATED BY scripts/refreshPrices.ts — DO NOT EDIT BY HAND.
//
// Public model prices, USD per 1K tokens, keyed \`provider:model\`.
// Run \`npm run prices:refresh\` to update, then REVIEW THE DIFF: a change here
// moves budgets and spend reports, so it should be read like any other change
// to a financial control.
//
// This is the CATALOG layer. Operator overrides outrank it, the bundled table
// in pricing.ts backs it up, and anything absent from all three is reported as
// unpriced rather than free — see priceResolver.ts.
//
// The source is community-maintained and not authoritative. Verify anything
// surprising against the provider's own price sheet before relying on it.
//
//   source:     ${meta.url}
//   fetched:    ${meta.fetchedAt}
//   sha256:     ${meta.hash}
//   rows:       ${rows.length}
import type { TokenPrice } from "./pricing";

export const GENERATED_PRICE_TABLE: Record<string, TokenPrice> = {
${body.join("\n")}
};
`;
}

async function main() {
  const dry = process.argv.includes("--dry");
  process.stdout.write(`fetching ${SOURCE_URL}\n`);

  const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    console.error(`refusing to write: source returned HTTP ${res.status}`);
    process.exit(1);
  }
  const text = await res.text();
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);

  let raw: Raw;
  try {
    raw = JSON.parse(text) as Raw;
  } catch (e) {
    console.error(`refusing to write: source is not valid JSON — ${(e as Error).message}`);
    process.exit(1);
  }

  const { rows, skipped, conflicts } = buildPriceRows(raw);
  const prev = previousRowCount();

  console.log(`\nparsed ${rows.length} priced models for providers this app serves`);
  if (skipped.length) {
    console.log(`\nskipped ${skipped.length} row(s) that failed a sanity check:`);
    for (const s of skipped.slice(0, 10)) console.log(`  ${s}`);
    if (skipped.length > 10) console.log(`  …and ${skipped.length - 10} more`);
  }
  if (conflicts.length) {
    // Reported rather than resolved quietly: two different prices for one key
    // is a fact about the source, and the operator is the one who knows which
    // region or tier they are on.
    console.log(`\n${conflicts.length} key(s) carried CONFLICTING prices in the source:`);
    for (const c of conflicts.slice(0, 10)) console.log(`  ${c}`);
    if (conflicts.length > 10) console.log(`  …and ${conflicts.length - 10} more`);
    console.log("  Set an operator override wherever the exact rate matters.");
  }

  if (rows.length < MIN_ROWS) {
    console.error(
      `\nrefusing to write: ${rows.length} rows is below the floor of ${MIN_ROWS}.` +
        ` A truncated response or a schema change looks exactly like this.`,
    );
    process.exit(1);
  }
  if (prev > 0 && rows.length < prev * (1 - MAX_SHRINK)) {
    console.error(
      `\nrefusing to write: row count fell from ${prev} to ${rows.length}` +
        ` (>${MAX_SHRINK * 100}%). Re-run with --dry and check the source before forcing this.`,
    );
    process.exit(1);
  }

  const out = render(rows, { url: SOURCE_URL, fetchedAt: new Date().toISOString(), hash });
  if (dry) {
    console.log(`\n--dry: would write ${rows.length} rows to ${OUT} (previously ${prev})`);
    return;
  }
  // Format before writing. The generated file is linted like any other source
  // file, and hand-rolled emission produced long float literals that prettier
  // wanted wrapped — 12 lint errors that arrived with the first generated
  // table and had nothing to do with the prices being right. Formatting here
  // keeps the committed file clean without carving out an ignore rule.
  let formatted = out;
  try {
    const prettier = await import("prettier");
    const config = await prettier.resolveConfig(OUT);
    formatted = await prettier.format(out, { ...config, filepath: OUT });
  } catch (e) {
    console.warn(`could not format ${OUT} (${String(e)}) — run prettier --write on it`);
  }
  writeFileSync(OUT, formatted, "utf8");
  console.log(`\nwrote ${OUT} — ${rows.length} rows (previously ${prev})`);
  console.log("REVIEW THE DIFF before committing: this moves budgets.");
}

const invokedDirectly = process.argv[1]?.includes("refreshPrices");
if (invokedDirectly)
  main().catch((e) => {
    console.error(`refusing to write: ${(e as Error).message}`);
    process.exit(1);
  });
