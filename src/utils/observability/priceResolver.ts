// Where a model's price comes from, and how much of that answer to trust.
//
// THE OLD LOOKUP IGNORED THE PROVIDER ENTIRELY. execution_traces records
// llm_provider on every row, and the price table was keyed by model alone, so
// claude-3.5-sonnet cost the same whether it ran on Bedrock, on Anthropic
// direct, or through OpenRouter's margin. Those are three different numbers,
// and for a 12-provider app that is wrong before any question of where the
// figures come from.
//
// RESOLUTION ORDER — first hit wins, and each step is more specific about THIS
// deployment than the one after it:
//
//   1. operator override   an admin's negotiated rate. Committed-use and EA
//                          discounts are not list price and no public source
//                          can know yours, so nothing may outrank this.
//   2. synced catalog      vendored public price data (scripts/refreshPrices).
//                          Reviewed in git, not fetched at runtime.
//   3. bundled table       the defaults that ship with the app, so an
//                          air-gapped deployment still prices its calls.
//   4. self-hosted         Ollama / vLLM run on your own hardware: a KNOWN
//                          zero, which is not the same as an unknown one.
//   5. unknown            → null. The caller marks the trace, and the spend
//                          figure can say it is incomplete.
//
// Step 5 is the one that keeps the rest honest. An unpriced model used to cost
// 0, and 0 is indistinguishable from cheap once it reaches a budget:
// getBudgetDecision sums cost_usd, so those calls never accumulated and the cap
// never fired. Returning null instead of 0 makes the difference expressible.
import {
  EMBED_COST_TABLE,
  IMAGE_COST_TABLE,
  MODEL_ALIASES,
  TEXT_COST_TABLE,
  type TokenPrice,
} from "./pricing";
import { GENERATED_PRICE_TABLE } from "./priceTable.generated";

export type PriceKind = "text" | "embedding" | "image";

/** Which layer answered. Recorded on the trace so a figure can be audited. */
export type PriceSource = "override" | "catalog" | "bundled" | "self-hosted";

export type ResolvedPrice = {
  /** USD per 1K input tokens (per image for image models). */
  in: number;
  /** USD per 1K output tokens. Always 0 for embeddings and images. */
  out: number;
  source: PriceSource;
};

/**
 * Providers that run on hardware the operator already pays for.
 *
 * Their marginal cost per call is genuinely zero, and saying so is different
 * from failing to find a price: one is a fact worth reporting, the other is a
 * gap worth flagging. Collapsing them would either litter the traces with false
 * "pricing missing" markers or hide real gaps behind a plausible zero.
 */
const SELF_HOSTED = new Set(["ollama", "vllm", "local"]);

/**
 * Prices an operator set by hand, keyed `provider:model`.
 *
 * NOTHING POPULATES THIS IN PRODUCTION. This comment used to say it was
 * "populated from the database at startup / on refresh", which was never true:
 * there is no overrides table, no loader, and no admin surface for one. The
 * layer itself works and is covered by tests — it is the highest-priority entry
 * in the resolution chain — but in a running instance the map is always empty,
 * so every price comes from the vendored catalog or the bundled fallback.
 *
 * Wiring it up means a table, a loader that calls setPriceOverrides after the
 * database is reachable, and somewhere for an operator to type a number. Until
 * then, an operator whose negotiated rate differs from the public sheet cannot
 * correct it, and the docs deliberately promise no such thing.
 *
 * Held in a module-level map because resolvePrice runs on EVERY call and must
 * never touch the network or the database on that path.
 */
let overrides = new Map<string, TokenPrice>();

/**
 * Vendored public price data, keyed the same way.
 *
 * Seeded from the generated table at module load rather than by a startup call,
 * so there is no "forgot to initialise" state in which every model silently
 * reverts to the small bundled set. Committed to the repo and refreshed
 * deliberately — see scripts/refreshPrices.ts for why prices live in git
 * rather than being fetched at runtime.
 */
let catalog = new Map<string, TokenPrice>(Object.entries(GENERATED_PRICE_TABLE));

/**
 * Replace the operator overrides.
 *
 * Currently called only by tests — see the note on `overrides`. Kept because
 * the precedence chain it sits at the top of is real and tested, and because
 * deleting it would mean rebuilding the same seam the day someone adds the
 * table.
 */
export function setPriceOverrides(rows: Record<string, TokenPrice>): void {
  overrides = new Map(Object.entries(rows));
}

/** Replace the synced catalog. Call once at startup with the generated table. */
export function setPriceCatalog(rows: Record<string, TokenPrice>): void {
  catalog = new Map(Object.entries(rows));
}

/** Normalise for lookup: trim and lower-case, since ids arrive in both cases. */
function norm(s: string | undefined | null): string {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Strip gateway decoration from a model id before lookup.
 *
 * Custom OpenAI-compatible gateways prefix vendor segments with `~`
 * (`~anthropic/claude-haiku-latest`) to mark ids they alias-resolve
 * themselves. The decoration carries no pricing information, but it defeated
 * every exact-key candidate, so each such call priced to nothing. Only the
 * `~` is removed — the id is otherwise untouched, keeping the exact-key
 * discipline intact.
 */
function stripGatewayDecoration(model: string): string {
  return model.replace(/(^|\/)~/g, "$1");
}

/**
 * The keys to try, most specific first.
 *
 * `provider:model` distinguishes the same model served by different backends —
 * the whole point of being provider-aware. The bare model id is the fallback,
 * and matches how the bundled tables have always been keyed. The vendor-less
 * tail is last and exists for one real case: EMBED_COST_TABLE is keyed
 * `text-embedding-3-small` while the knowledge page names
 * `openai/text-embedding-3-small`, so the same run priced at zero or not
 * depending on which caller reached it.
 *
 * Order matters and looseness is bounded: every candidate is an EXACT key, so a
 * model nobody has priced still resolves to nothing rather than borrowing a
 * neighbour's rate.
 */
function candidates(provider: string, model: string): string[] {
  const p = norm(provider);
  const m = stripGatewayDecoration(norm(model));
  if (!m) return [];
  const tail = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : "";
  // Rolling aliases ("claude-haiku-latest") resolve to the concrete id whose
  // price applies today — an explicit, git-reviewed map, not a fuzzy match.
  // The alias's own keys are still tried FIRST, so a table that one day
  // carries a real entry for the alias outranks the mapping.
  const aliased = MODEL_ALIASES[tail || m];
  const keys = [
    // Both provider-qualified spellings, because the model id may or may not
    // carry its vendor. refreshPrices STRIPS the vendor when it builds keys
    // (`bedrock:claude-3.5-sonnet`), while a caller usually passes the full id
    // (`anthropic/claude-3.5-sonnet`) — so trying only `provider:model` meant
    // a generated provider rate could never match, and the vendor-agnostic
    // fallback won instead. Caught by a test written for the ordering.
    p ? `${p}:${m}` : "",
    p && tail ? `${p}:${tail}` : "",
    m,
    tail,
    ...(aliased ? [p ? `${p}:${aliased}` : "", aliased] : []),
  ].filter(Boolean);
  return [...new Set(keys)];
}

function tableFor(kind: PriceKind): Record<string, TokenPrice> {
  if (kind === "text") return TEXT_COST_TABLE;
  // Embeddings and images are single-rate; present them as TokenPrice so every
  // layer shares one shape and callers do not branch on kind to read a price.
  const flat = kind === "embedding" ? EMBED_COST_TABLE : IMAGE_COST_TABLE;
  const out: Record<string, TokenPrice> = {};
  for (const [k, v] of Object.entries(flat)) out[k] = { in: v, out: 0 };
  return out;
}

/**
 * Resolve a price, or null when nothing knows one.
 *
 * NULL IS A REAL ANSWER, distinct from a price of zero. The caller records the
 * difference on the trace, which is what lets a spend report say "incomplete"
 * rather than quietly under-counting.
 */
export function resolvePrice(args: {
  provider: string | null | undefined;
  model: string;
  kind: PriceKind;
}): ResolvedPrice | null {
  const provider = norm(args.provider);
  const keys = candidates(provider, args.model);
  if (keys.length === 0) return null;

  for (const key of keys) {
    const hit = overrides.get(key);
    if (hit) return { in: hit.in, out: hit.out, source: "override" };
  }
  for (const key of keys) {
    const hit = catalog.get(key);
    if (hit) return { in: hit.in, out: hit.out, source: "catalog" };
  }

  // The bundled tables are keyed by model id only, so provider-qualified
  // candidates simply will not match them — which is correct, not a gap.
  const bundled = tableFor(args.kind);
  for (const key of keys) {
    const hit = bundled[key];
    if (hit) return { in: hit.in, out: hit.out, source: "bundled" };
  }

  // Checked LAST so a real price for a self-hosted gateway still wins: an
  // operator running vLLM behind a metered proxy can price it, and only the
  // ones nobody priced fall through to a known zero.
  if (SELF_HOSTED.has(provider)) return { in: 0, out: 0, source: "self-hosted" };

  return null;
}

/**
 * Cost of one call, and whether the figure can be trusted.
 *
 * `priced: false` means the amount is 0 because nothing knew the rate — not
 * because the call was free.
 */
export function priceCall(args: {
  provider: string | null | undefined;
  model: string;
  kind: PriceKind;
  tokensIn: number;
  tokensOut: number;
  /** Image models bill per image, not per token. */
  imageCount?: number;
}): { costUsd: number; priced: boolean; source: PriceSource | null } {
  const p = resolvePrice(args);
  if (!p) return { costUsd: 0, priced: false, source: null };
  if (args.kind === "image") {
    return { costUsd: p.in * Math.max(0, args.imageCount ?? 1), priced: true, source: p.source };
  }
  const tokensIn = Math.max(0, args.tokensIn || 0);
  const tokensOut = Math.max(0, args.tokensOut || 0);
  return {
    costUsd: (tokensIn / 1000) * p.in + (tokensOut / 1000) * p.out,
    priced: true,
    source: p.source,
  };
}
