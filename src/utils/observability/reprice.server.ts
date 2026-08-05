// Re-price traces that were recorded before their model had a known rate.
//
// A call whose model no price table knew is stored at cost 0 with
// request_payload.pricing_missing = true — honest at write time, wrong for
// ever after if nothing revisits it. And things do change: an alias mapping
// lands (claude-haiku-latest), a price refresh adds a model, an operator's
// gateway id gets a table entry. On this instance, 199 such traces carried
// ~1M tokens of real Anthropic spend that budgets summed as $0.
//
// So the maintenance pass sweeps the marker and re-runs the SAME resolver
// every live call uses (priceCall — no second pricing implementation). Rows
// that now resolve get their cost written and the marker replaced with the
// price source + a repriced_at stamp; rows that still resolve to nothing keep
// the marker and are retried on later passes — that retry is the point, not a
// leak. The partial index in 20260785000000 makes the converged state (no
// marked rows) cost one index probe.
//
// Deliberately NOT notified per row: budget alert checks run on every new
// call, so corrected history surfaces in the totals the next time anything
// runs. Deleting money-was-spent evidence quietly would be the bug; adding it
// back loudly per historical row would be noise.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { priceCall, type PriceKind } from "./priceResolver";

const MIN_PROCESS_INTERVAL_MS = 10 * 60_000;
const BATCH_SIZE = 200;
const MAX_BATCHES_PER_PASS = 5;

let lastProcessed = 0;
let processing = false;

type TraceRow = {
  id: string;
  llm_provider: string | null;
  llm_model: string;
  tokens_in: number | null;
  tokens_out: number | null;
  request_payload: Record<string, unknown> | null;
};

/** Re-price one row's payload. Pure — returns null when nothing changed. */
export function repriceRow(row: TraceRow): { cost_usd: number; request_payload: unknown } | null {
  const payload = (row.request_payload ?? {}) as Record<string, unknown>;
  if (payload.pricing_missing !== true && payload.pricing_missing !== "true") return null;
  const kind = (payload.kind as PriceKind) || "text";
  const priced = priceCall({
    provider: row.llm_provider,
    model: row.llm_model,
    kind,
    tokensIn: row.tokens_in ?? 0,
    tokensOut: row.tokens_out ?? 0,
    imageCount: typeof payload.image_count === "number" ? payload.image_count : undefined,
  });
  if (!priced.priced) return null;
  const { pricing_missing: _dropped, ...rest } = payload;
  return {
    cost_usd: priced.costUsd,
    request_payload: {
      ...rest,
      price_source: priced.source,
      repriced_at: new Date().toISOString(),
    },
  };
}

/**
 * Classify one legacy zero-cost row that predates the pricing_missing marker
 * (or came from a writer that didn't stamp it). Pure.
 *
 *   resolves now  → real cost + price_source, exactly like repriceRow
 *   still unknown → gains the pricing_missing marker, which is not cosmetic:
 *                   it moves the row into the indexed phase-1 pool for future
 *                   retries and makes the traces UI say "unpriced" instead of
 *                   presenting $0.0000 as a real amount.
 *
 * Only rows with recorded tokens qualify — a zero-token error row costs $0
 * truthfully and must stay untouched.
 */
export function classifyZeroRow(
  row: TraceRow,
): { cost_usd?: number; request_payload: unknown } | null {
  const payload = (row.request_payload ?? {}) as Record<string, unknown>;
  if (payload.pricing_missing !== undefined) return null;
  if (payload.price_source !== undefined) return null;
  if ((row.tokens_in ?? 0) <= 0 && (row.tokens_out ?? 0) <= 0) return null;
  const kind = (payload.kind as PriceKind) || "text";
  const priced = priceCall({
    provider: row.llm_provider,
    model: row.llm_model,
    kind,
    tokensIn: row.tokens_in ?? 0,
    tokensOut: row.tokens_out ?? 0,
    imageCount: typeof payload.image_count === "number" ? payload.image_count : undefined,
  });
  if (priced.priced) {
    return {
      cost_usd: priced.costUsd,
      request_payload: {
        ...payload,
        price_source: priced.source,
        repriced_at: new Date().toISOString(),
      },
    };
  }
  return { request_payload: { ...payload, pricing_missing: true } };
}

/** How far back the legacy-zero classification looks. */
const CLASSIFY_WINDOW_DAYS = 90;

/** Sweep marked traces once per interval; returns rows re-priced. */
export async function repriceUnpricedTraces(force = false): Promise<number> {
  const now = Date.now();
  if (processing) return 0;
  if (!force && now - lastProcessed < MIN_PROCESS_INTERVAL_MS) return 0;
  processing = true;
  lastProcessed = now;

  let repriced = 0;
  try {
    for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch++) {
      const { data: rows, error } = await supabaseAdmin
        .from("execution_traces")
        .select("id, llm_provider, llm_model, tokens_in, tokens_out, request_payload")
        .eq("request_payload->>pricing_missing", "true")
        .order("created_at", { ascending: true })
        .limit(BATCH_SIZE);
      if (error) throw new Error(error.message);
      if (!rows || rows.length === 0) break;

      let changedInBatch = 0;
      for (const row of rows as TraceRow[]) {
        const update = repriceRow(row);
        if (!update) continue;
        const { error: upErr } = await supabaseAdmin
          .from("execution_traces")
          .update({
            cost_usd: update.cost_usd,
            request_payload: update.request_payload as never,
          })
          .eq("id", row.id);
        if (upErr) throw new Error(upErr.message);
        changedInBatch++;
        repriced++;
      }
      // Everything left in this batch still has no price — later batches are
      // the same rows again (the marker filter re-matches them), so stop.
      if (changedInBatch === 0) break;
      if (rows.length < BATCH_SIZE) break;
    }

    // Phase 2: legacy zero-cost rows with tokens but NO marker at all —
    // written before the marker existed, or by a writer that didn't stamp it
    // (the chat gateway, until it did). Every touched row gains either a
    // price_source or the pricing_missing marker, so the filter below stops
    // matching it and the phase converges to an empty scan.
    const windowStart = new Date(Date.now() - CLASSIFY_WINDOW_DAYS * 86400000).toISOString();
    for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch++) {
      const { data: rows, error } = await supabaseAdmin
        .from("execution_traces")
        .select("id, llm_provider, llm_model, tokens_in, tokens_out, request_payload")
        .eq("cost_usd", 0)
        .gt("tokens_in", 0)
        .is("request_payload->>pricing_missing", null)
        .is("request_payload->>price_source", null)
        .gte("created_at", windowStart)
        .order("created_at", { ascending: false })
        .limit(BATCH_SIZE);
      if (error) throw new Error(error.message);
      if (!rows || rows.length === 0) break;

      let changedInBatch = 0;
      for (const row of rows as TraceRow[]) {
        const update = classifyZeroRow(row);
        if (!update) continue;
        const { error: upErr } = await supabaseAdmin
          .from("execution_traces")
          .update({
            ...(update.cost_usd !== undefined ? { cost_usd: update.cost_usd } : {}),
            request_payload: update.request_payload as never,
          })
          .eq("id", row.id);
        if (upErr) throw new Error(upErr.message);
        changedInBatch++;
        if (update.cost_usd !== undefined) repriced++;
      }
      if (changedInBatch === 0) break;
      if (rows.length < BATCH_SIZE) break;
    }
    return repriced;
  } finally {
    processing = false;
  }
}
