// The AI Analyst's scoring, reachable from the browser.
//
// The analyst's loop runs client-side; scoring cannot — the model, its
// feature view and the caller's grants live on the server. These two server
// functions are the seam: the models a plan may name, and the scoring of one
// step's rows, both under the asking user's own id. The embed runner does
// not come through here; it calls the same helpers as the analyst's owner.
//
// Rows cross the wire as primitives only (the same coercion the semantic
// query function does): a DuckDB Date or BigInt in a cell is not something a
// server function can carry, and a prediction is a string or a number.
import { createServerFn } from "@tanstack/react-start";

import type { ScoredDisclosure } from "@/lib/aiAnalyst";
import {
  forecastForAnalyst,
  scorableModelsForUser,
  scoreRowsForAnalyst,
} from "@/utils/ml/scoreRows.server";
import { userScopedClient } from "@/utils/swarmNodes.server";

export type Cell = string | number | boolean | null;

export type WireScoreResult =
  | { ok: true; columns: string[]; rows: Record<string, Cell>[]; scored: ScoredDisclosure }
  | { ok: false; error: string };

/** A row as it can travel: primitives kept, anything else stringified. */
export function cellRow(row: Record<string, unknown>): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] =
      v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean"
        ? v
        : v === undefined
          ? null
          : String(v);
  }
  return out;
}

/**
 * The analyst's predictive-model choice, read under the CALLER's own
 * session so RLS decides whether they may see the analyst at all: null
 * when it allows every model, the list otherwise. No analyst id means no
 * analyst context (every model the caller can use); an analyst the caller
 * cannot see allows nothing.
 */
async function analystAllowList(
  accessToken: string,
  analystId: string | undefined,
): Promise<string[] | null> {
  if (!analystId) return null;
  const sb = userScopedClient(accessToken);
  if (!sb) throw new Error("Server is missing Supabase configuration");
  const { data } = await sb
    .from("ai_analysts")
    .select("ml_model_names")
    .eq("id", analystId)
    .maybeSingle();
  if (!data) return [];
  return data.ml_model_names ?? null;
}

async function requireUserId(accessToken: string): Promise<string> {
  const sb = userScopedClient(accessToken);
  if (!sb) throw new Error("Server is missing Supabase configuration");
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return data.user.id;
}

/** The trained models this user may score rows with — every one, or the named analyst's choice. */
export const analystScorableModels = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; analystId?: string }) => d)
  .handler(async ({ data }) =>
    scorableModelsForUser(
      await requireUserId(data.accessToken),
      await analystAllowList(data.accessToken, data.analystId),
    ),
  );

/** Score one step's rows with a named model, as this user. */
export const analystScoreRows = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { accessToken: string; analystId?: string; model: string; rows: Record<string, Cell>[] }) =>
      d,
  )
  .handler(async ({ data }): Promise<WireScoreResult> => {
    const res = await scoreRowsForAnalyst({
      userId: await requireUserId(data.accessToken),
      model: data.model,
      rows: data.rows,
      allow: await analystAllowList(data.accessToken, data.analystId),
    });
    if (!res.ok) return res;
    return { ok: true, columns: res.columns, rows: res.rows.map(cellRow), scored: res.scored };
  });

/** A forecast model's projected periods, as this user — the forecast step's one call. */
export const analystForecast = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; analystId?: string; model: string }) => d)
  .handler(async ({ data }): Promise<WireScoreResult> => {
    const res = await forecastForAnalyst({
      userId: await requireUserId(data.accessToken),
      model: data.model,
      allow: await analystAllowList(data.accessToken, data.analystId),
    });
    if (!res.ok) return res;
    return { ok: true, columns: res.columns, rows: res.rows.map(cellRow), scored: res.scored };
  });
