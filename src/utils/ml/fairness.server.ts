// Does the model treat groups differently — and can the agent layer help?
//
// The measurement is SQL, exactly like an evaluation: one statement per
// sensitive column through the governed lakehouse chokepoint, read as the
// model's OWNER, with the arithmetic in src/lib/mlFairness.ts where it is
// checked against an independent implementation.
//
// ── THE RULE FOR THE MODEL LAYER ──────────────────────────────────────────
//
// THE PLATFORM MEASURES. THE MODEL PROPOSES AND NARRATES. A NUMBER NEVER COMES
// FROM THE LANGUAGE MODEL.
//
// Both uses below obey it, and they are useful precisely because they are the
// halves a language model is good at:
//
//   SUGGESTING WHAT TO COMPARE BY. The hard part of a fairness check is not
//   the arithmetic, it is knowing that `postcode` stands in for ethnicity and
//   `first_name` stands in for gender. Proxies are where careful people miss
//   things, and naming them from column names is exactly what a language model
//   can do. It SUGGESTS; a person ticks. Nothing is enabled automatically.
//
//   READING THE RESULT BACK IN WORDS. "0.56" is a number somebody has to
//   explain in a meeting. The narration is given the computed figures and
//   asked to put them in a sentence — it is never asked what they are.
//
// What is sent to the model for a suggestion is COLUMN NAMES, TYPES AND
// CARDINALITY. Never values. A column of ethnicities is sensitive data, and
// posting a sample of it to an inference endpoint to ask whether it is
// sensitive would be its own answer.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import { notifyUser } from "@/utils/notify.server";
import { runLakehouseStatement } from "@/utils/lakehouse/core.server";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import { internalChatText } from "@/utils/internalChat.server";
import { GATEWAY_PROVIDERS } from "@/utils/gateway/providers";
import { parseGatewayModel } from "@/utils/gateway/keys";
import {
  MAX_GROUPS,
  fairnessResult,
  fairnessVerdict,
  groupOutcomeSql,
  selectionSql,
  type MlFairnessResult,
  type MlGroupCount,
  type MlGroupOutcome,
} from "@/lib/mlFairness";
import { readOutcomeSource } from "./evaluate.server";

export type MlFairnessRow = Database["public"]["Tables"]["ml_fairness_checks"]["Row"];

/** Fairness is about a decision, and only these tasks make one. */
const CHECKABLE = new Set(["classification"]);

/** The model that assists. Env-only: it is a preference, not a capacity. */
const assistModel = () =>
  (process.env.ML_ASSIST_MODEL ?? "").trim() || "openrouter/google/gemini-3-flash-preview";

type CheckOutcome = { ok: true; checks: MlFairnessRow[] } | { ok: false; error: string };

/**
 * Measure one prediction run's output table, once per sensitive column.
 *
 * One row per column rather than an average over them: two columns are two
 * comparisons, and a mean would hide the one that matters.
 */
export async function runFairnessCheck(
  predictionId: string,
  triggeredBy: string,
  via = "ui",
): Promise<CheckOutcome> {
  const { data: prediction } = await supabaseAdmin
    .from("ml_predictions")
    .select("*")
    .eq("id", predictionId)
    .maybeSingle();
  if (!prediction) return { ok: false, error: "Prediction not found" };

  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("*")
    .eq("id", prediction.model_id)
    .maybeSingle();
  if (!model) return { ok: false, error: "Model not found" };
  if (!CHECKABLE.has(model.task)) {
    return {
      ok: false,
      error: `Fairness is about a decision; a ${model.task} model does not make one.`,
    };
  }
  const columns = (model.sensitive_columns ?? []).filter(Boolean);
  if (!columns.length) {
    return { ok: false, error: "Name the columns to compare groups by first." };
  }
  const output = prediction.output as { schema?: string; table?: string } | null;
  if (!output?.schema || !output?.table || prediction.status !== "succeeded") {
    return { ok: false, error: "Only a successful batch prediction has a table to compare." };
  }

  const scored = { schema: output.schema, table: output.table };
  const favourable = model.favourable_label?.trim() || null;
  const outcome = readOutcomeSource(model.outcome_source);
  const limits = await getPlatformResources();
  const owner = model.user_id;
  const written: MlFairnessRow[] = [];

  for (const column of columns) {
    let result: MlFairnessResult;
    try {
      const counted = await runLakehouseStatement(owner, selectionSql(scored, column, favourable), {
        auditVia: "ml.fairness",
        rowCap: MAX_GROUPS + 1,
      });
      if (counted.row_count > MAX_GROUPS) {
        return {
          ok: false,
          error: `"${column}" has more than ${MAX_GROUPS} distinct values. Compare by a column with groups in it, not by an identifier.`,
        };
      }
      const counts: MlGroupCount[] = counted.rows.map((r) => ({
        group: String(r[0] ?? ""),
        n: Number(r[1] ?? 0),
        selected: Number(r[2] ?? 0),
      }));

      let outcomes: MlGroupOutcome[] | null = null;
      if (outcome && favourable) {
        const o = await runLakehouseStatement(
          owner,
          groupOutcomeSql(scored, outcome, column, favourable),
          { auditVia: "ml.fairness", rowCap: MAX_GROUPS + 1 },
        );
        outcomes = o.rows.map((r) => ({
          group: String(r[0] ?? ""),
          tp: Number(r[1] ?? 0),
          fp: Number(r[2] ?? 0),
          fn: Number(r[3] ?? 0),
          tn: Number(r[4] ?? 0),
        }));
      }
      result = fairnessResult(column, counts, outcomes, favourable);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    const verdict = fairnessVerdict(result, limits.mlFairnessMinRatio);
    const { data: row } = await supabaseAdmin
      .from("ml_fairness_checks")
      .insert({
        model_id: model.id,
        version_id: prediction.version_id,
        prediction_id: predictionId,
        user_id: triggeredBy,
        column_name: column,
        favourable_label: favourable,
        disparate_impact: result.disparate_impact,
        equal_opportunity_gap: result.equal_opportunity_gap,
        lowest_group: result.lowest_group,
        verdict,
        groups: result.groups as unknown as Json,
      })
      .select()
      .single();
    if (row) written.push(row);

    auditEvent({
      userId: triggeredBy,
      action: verdict === "review" ? "ml.fairness.review" : "ml.fairness.check",
      resourceType: "ml_model",
      resourceId: model.id,
      resourceName: model.name,
      detail: {
        prediction_id: predictionId,
        column,
        favourable_label: favourable,
        disparate_impact: result.disparate_impact,
        equal_opportunity_gap: result.equal_opportunity_gap,
        lowest_group: result.lowest_group,
        threshold: limits.mlFairnessMinRatio,
        verdict,
        via,
      },
    });

    if (verdict === "review") {
      void notifyUser(model.user_id, {
        title: `"${model.name}": groups in ${column} came out far apart`,
        body:
          `${result.lowest_group} is selected at ${((result.disparate_impact ?? 0) * 100).toFixed(0)}% ` +
          `of the best-treated group's rate, below the ${(limits.mlFairnessMinRatio * 100).toFixed(0)}% ` +
          `line this deployment is set to. Worth a look before the next decision goes out.`,
        link: `/ml/${model.id}`,
      });
    }
  }

  return { ok: true, checks: written };
}

// ── The agent layer ────────────────────────────────────────────────────────

export type MlSensitiveSuggestion = {
  column: string;
  /** Why this one, in a sentence a person can disagree with. */
  reason: string;
  /** True when the column is not itself sensitive but stands in for one. */
  proxy: boolean;
};

/**
 * Ask a model which columns are worth comparing groups by.
 *
 * SUGGESTIONS ONLY. Nothing is written, nothing is enabled; the answer is a
 * list a person ticks. That is not timidity about automation — which
 * attributes are protected is a legal and contextual question, and a platform
 * that decided it silently would be making a compliance claim on the
 * operator's behalf.
 *
 * NAMES AND TYPES ONLY LEAVE THE DEPLOYMENT. Not values. A column of
 * ethnicities is sensitive data, and posting a sample of it to an inference
 * endpoint to ask whether it is sensitive would answer its own question.
 */
export async function suggestSensitiveColumns(
  modelId: string,
  userId: string,
): Promise<{ ok: true; suggestions: MlSensitiveSuggestion[] } | { ok: false; error: string }> {
  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("id, name, user_id, task, target_column, production_version_id")
    .eq("id", modelId)
    .maybeSingle();
  if (!model) return { ok: false, error: "Model not found" };

  const { data: version } = await supabaseAdmin
    .from("ml_model_versions")
    .select("feature_schema")
    .eq("id", model.production_version_id ?? "")
    .maybeSingle();
  const schema = (version?.feature_schema ?? []) as {
    name?: string;
    dtype?: string;
    role?: string;
    distinct?: number;
  }[];
  const columns = schema
    .filter((c) => typeof c.name === "string")
    .map(
      (c) => `${c.name} (${c.dtype ?? "unknown"}${c.distinct ? `, ${c.distinct} distinct` : ""})`,
    );
  if (!columns.length)
    return { ok: false, error: "This model has no recorded feature schema yet." };

  const target = parseGatewayModel(assistModel(), GATEWAY_PROVIDERS);
  if (!target || target.kind !== "model") {
    return { ok: false, error: `ML_ASSIST_MODEL is not a model this deployment can reach` };
  }

  const system =
    "You help an analyst audit a machine-learning model for unequal treatment between groups. " +
    "You are given COLUMN NAMES AND TYPES ONLY - never values. " +
    "Name the columns worth comparing groups by. Include two kinds: attributes that are " +
    "directly protected or sensitive (gender, age, ethnicity, disability, religion, marital " +
    "status, nationality), and PROXIES - columns that are not themselves sensitive but stand " +
    "in for one (a postcode for ethnicity or income, a first name for gender or nationality, " +
    "a school or employer for class, a date of birth for age). Proxies are the valuable half: " +
    "they are what careful people miss. " +
    'Answer with JSON only: {"suggestions":[{"column":"...","reason":"one sentence","proxy":true|false}]}. ' +
    "Suggest nothing you cannot justify from the name. An empty list is a good answer when " +
    "nothing fits. Never invent a column that is not in the list.";
  const user =
    `Model: ${model.name}\nIt predicts: ${model.target_column ?? "(none)"}\n\n` +
    `Columns:\n${columns.join("\n")}`;

  let text: string;
  try {
    const res = await internalChatText({
      userId,
      agentName: "ML fairness assistant",
      provider: target.provider,
      model: target.model,
      system,
      user,
      maxTokens: 700,
      timeoutMs: 45_000,
    });
    text = res.text;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const known = new Set(schema.map((c) => c.name));
  let parsed: { suggestions?: MlSensitiveSuggestion[] };
  try {
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    parsed = JSON.parse(json) as { suggestions?: MlSensitiveSuggestion[] };
  } catch {
    return { ok: false, error: "The assistant did not answer with a column list." };
  }
  // Anything it invented is dropped rather than shown: a suggested column that
  // does not exist would fail at save with a confusing error, and it is also
  // the clearest sign the answer was not grounded.
  const suggestions = (parsed.suggestions ?? [])
    .filter((s) => s && typeof s.column === "string" && known.has(s.column))
    .map((s) => ({
      column: s.column,
      reason: String(s.reason ?? "").slice(0, 240),
      proxy: Boolean(s.proxy),
    }))
    .slice(0, 12);

  auditEvent({
    userId,
    action: "ml.fairness.suggest",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    detail: { model: assistModel(), suggested: suggestions.map((s) => s.column) },
  });
  return { ok: true, suggestions };
}

/**
 * Read a computed check back in plain words.
 *
 * EVERY NUMBER IN THE PROMPT IS ALREADY MEASURED. The model is asked to write
 * a paragraph around figures it is given, and told in as many words not to
 * compute, estimate or add any. What it produces is stored beside the numbers
 * rather than instead of them, and the UI shows both — so a narration that
 * drifts is visibly contradicted by the table above it.
 */
export async function narrateFairnessCheck(
  checkId: string,
  userId: string,
): Promise<{ ok: true; narrative: string } | { ok: false; error: string }> {
  const { data: check } = await supabaseAdmin
    .from("ml_fairness_checks")
    .select("*")
    .eq("id", checkId)
    .maybeSingle();
  if (!check) return { ok: false, error: "Check not found" };

  const target = parseGatewayModel(assistModel(), GATEWAY_PROVIDERS);
  if (!target || target.kind !== "model") {
    return { ok: false, error: "ML_ASSIST_MODEL is not a model this deployment can reach" };
  }

  const groups = (check.groups ?? []) as {
    group: string;
    n: number;
    selection_rate: number | null;
    true_positive_rate: number | null;
  }[];
  const system =
    "You explain a fairness measurement to a non-specialist in two or three sentences. " +
    "EVERY NUMBER YOU NEED IS GIVEN TO YOU. Do not compute, estimate, round differently, " +
    "or introduce any figure that is not in the input - if something is not there, say it " +
    "was not measured. Do not say whether the model is fair or lawful; that is a judgement " +
    "about a context you cannot see. Say what the numbers show, which group is most " +
    "affected, and what a reader might look at next. Plain prose, no headings, no lists.";
  const user = JSON.stringify(
    {
      compared_by: check.column_name,
      favourable_outcome: check.favourable_label,
      selection_rate_ratio: check.disparate_impact,
      review_threshold_note: "a ratio below the deployment's threshold asks for review",
      largest_true_positive_rate_gap: check.equal_opportunity_gap,
      lowest_group: check.lowest_group,
      groups: groups.map((g) => ({
        group: g.group,
        rows: g.n,
        selection_rate: g.selection_rate,
        true_positive_rate: g.true_positive_rate,
      })),
    },
    null,
    1,
  );

  let text: string;
  try {
    const res = await internalChatText({
      userId,
      agentName: "ML fairness assistant",
      provider: target.provider,
      model: target.model,
      system,
      user,
      maxTokens: 400,
      timeoutMs: 45_000,
    });
    text = res.text.trim().slice(0, 2000);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!text) return { ok: false, error: "The assistant returned nothing." };

  await supabaseAdmin.from("ml_fairness_checks").update({ narrative: text }).eq("id", checkId);
  auditEvent({
    userId,
    action: "ml.fairness.narrate",
    resourceType: "ml_model",
    resourceId: check.model_id,
    detail: { check_id: checkId, model: assistModel() },
  });
  return { ok: true, narrative: text };
}
