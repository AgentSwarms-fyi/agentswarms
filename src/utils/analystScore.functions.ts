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

async function requireUserId(accessToken: string): Promise<string> {
  const sb = userScopedClient(accessToken);
  if (!sb) throw new Error("Server is missing Supabase configuration");
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return data.user.id;
}

/** The trained models this user may score rows with, for the planner. */
export const analystScorableModels = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string }) => d)
  .handler(async ({ data }) => scorableModelsForUser(await requireUserId(data.accessToken)));

/** Score one step's rows with a named model, as this user. */
export const analystScoreRows = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; model: string; rows: Record<string, Cell>[] }) => d)
  .handler(async ({ data }): Promise<WireScoreResult> => {
    const res = await scoreRowsForAnalyst({
      userId: await requireUserId(data.accessToken),
      model: data.model,
      rows: data.rows,
    });
    if (!res.ok) return res;
    return { ok: true, columns: res.columns, rows: res.rows.map(cellRow), scored: res.scored };
  });

/** A forecast model's projected periods, as this user — the forecast step's one call. */
export const analystForecast = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; model: string }) => d)
  .handler(async ({ data }): Promise<WireScoreResult> => {
    const res = await forecastForAnalyst({
      userId: await requireUserId(data.accessToken),
      model: data.model,
    });
    if (!res.ok) return res;
    return { ok: true, columns: res.columns, rows: res.rows.map(cellRow), scored: res.scored };
  });
