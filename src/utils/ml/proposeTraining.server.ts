// Models proposed in chat (R527): an agent files a proposal, its owner trains
// it with a yes in the approvals inbox.
//
// The rules R521 and R525 set: ONE implementation of the change (here, the
// wizard's own create-and-train path); AUTHORITY IS THE OWNER, never the
// approval row they can write; and the proposal is checked again against the
// table as it is when approved, not as it was when an agent suggested it.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  checkAgainstColumns,
  describeProposal,
  ML_TRAIN_ACTION,
  parseProposal,
  proposalFromPayload,
  sameModelName,
  type MlTrainProposal,
} from "@/lib/mlProposals";
import { auditEvent } from "@/utils/audit.server";
import { qualifiedTable } from "@/utils/dataMonitors/core";
import {
  accessibleSchemas,
  lakehouseEnabled,
  runLakehouseStatement,
} from "@/utils/lakehouse/core.server";
import { lakehouseTableColumns } from "@/utils/lakehouse/tableColumns.server";
import { createModelAndTrain } from "./create.server";

type Fail = { ok: false; error: string };

/** The most values a series column may hold: the wizard offers category columns only. */
export const SERIES_MAX_VALUES = 200;

/** A proposal checked against the table as `userId` may read it now. */
export async function checkTrainingProposal(
  userId: string,
  proposal: MlTrainProposal,
): Promise<{ ok: true; proposal: MlTrainProposal } | Fail> {
  if (!lakehouseEnabled()) {
    return {
      ok: false,
      error: "The lakehouse is not set up here, so there is nothing to train on.",
    };
  }
  const { schema, table } = proposal.source;
  const rel = `${schema}.${table}`;
  const allowed = new Set((await accessibleSchemas(userId)).map((s) => s.name));
  const columns = allowed.has(schema)
    ? await lakehouseTableColumns(userId, schema, table, "ml_proposal")
    : null;
  if (!columns) {
    return {
      ok: false,
      error: `${rel} could not be read. Check the name (schema.table) and that the table is yours or shared with you.`,
    };
  }
  const checked = checkAgainstColumns(proposal, columns);
  if (!checked.ok) return checked;
  const p = checked.proposal;

  // A series column one forecast per value of: a category, not an identifier
  // (R526 found ids offered as series in the wizard).
  if (p.series_column) {
    try {
      const res = await runLakehouseStatement(
        userId,
        `SELECT approx_count_distinct("${p.series_column.replace(/"/g, '""')}") AS n FROM ${qualifiedTable(schema, table)}`,
        { rowCap: 1, timeoutMs: 30_000, auditVia: "ml_proposal" },
      );
      const n = Number(res.rows[0]?.[0] ?? 0);
      if (n > SERIES_MAX_VALUES) {
        return {
          ok: false,
          error: `"${p.series_column}" has about ${n} different values: one forecast each is not a category split. Pick a column with a few values, such as a region.`,
        };
      }
    } catch {
      // Unreadable now: the trainer still forecasts only the largest series.
    }
  }

  const { data: taken } = await supabaseAdmin
    .from("ml_models")
    .select("id")
    .eq("user_id", userId)
    .ilike(
      "name",
      p.name.replace(/[\\%_]/g, (c) => `\\${c}`),
    )
    .limit(1);
  if (taken?.length) {
    return {
      ok: false,
      error: `You already have a model called "${p.name}". Pick another name, or retrain that one from its page.`,
    };
  }
  return { ok: true, proposal: p };
}

export type ProposalFiled = {
  ok: true;
  approvalId: string;
  title: string;
  lines: string[];
  /** The same model was already waiting for an answer; nothing new was filed. */
  alreadyWaiting: boolean;
};

/**
 * File a proposal from an agent's tool call. Nothing trains: it waits in the
 * owner's approvals inbox.
 */
export async function proposeTraining(
  ownerId: string,
  args: unknown,
  via: { agentName: string },
): Promise<ProposalFiled | Fail> {
  const parsed = parseProposal(args);
  if (!parsed.ok) return parsed;
  const checked = await checkTrainingProposal(ownerId, parsed.proposal);
  if (!checked.ok) return checked;
  const p = checked.proposal;
  const { title, lines } = describeProposal(p);

  const { data: waiting } = await supabaseAdmin
    .from("approvals")
    .select("id, payload")
    .eq("user_id", ownerId)
    .eq("action_type", ML_TRAIN_ACTION)
    .eq("status", "pending");
  const same = (waiting ?? []).find((r) => {
    const prior = proposalFromPayload(r.payload);
    return prior && sameModelName(prior.name, p.name);
  });
  if (same) return { ok: true, approvalId: same.id, title, lines, alreadyWaiting: true };

  const { data: row, error } = await supabaseAdmin
    .from("approvals")
    .insert({
      user_id: ownerId,
      agent_name: via.agentName.slice(0, 120) || "Chat",
      action_type: ML_TRAIN_ACTION,
      action_title: title,
      description: lines.join(" "),
      risk_level: "low",
      payload: { proposal: p, link: "/ml" } as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "The proposal was not saved" };
  auditEvent({
    userId: ownerId,
    action: "ml.train.proposed",
    resourceType: "ml_model",
    resourceName: p.name,
    decisionId: row.id,
    detail: {
      approval_id: row.id,
      task: p.task,
      table: `${p.source.schema}.${p.source.table}`,
      target: p.target_column ?? null,
      agent: via.agentName,
    },
  });
  return { ok: true, approvalId: row.id, title, lines, alreadyWaiting: false };
}

/**
 * Train a proposal its owner approved: once, as the owner, through the
 * wizard's own path, after checking it against the table as it is now.
 */
export async function applyApprovedTraining(
  approvalId: string,
  callerId: string,
): Promise<{ ok: true; modelId: string; message: string } | (Fail & { modelId?: string })> {
  const { data: approval } = await supabaseAdmin
    .from("approvals")
    .select("id, user_id, action_type, status, payload")
    .eq("id", approvalId)
    .maybeSingle();
  if (!approval || approval.user_id !== callerId) return { ok: false, error: "Approval not found" };
  if (approval.action_type !== ML_TRAIN_ACTION) {
    return { ok: false, error: "That approval is not a proposed model" };
  }
  if (approval.status !== "approved") return { ok: false, error: `It was ${approval.status}` };
  const proposal = proposalFromPayload(approval.payload);
  if (!proposal) return { ok: false, error: "That approval does not hold a model to train" };

  const { data: claimed } = await supabaseAdmin
    .from("approvals")
    .update({ resumed_at: new Date().toISOString() })
    .eq("id", approvalId)
    .is("resumed_at", null)
    .select("id");
  if (!claimed?.length) return { ok: false, error: "It has already been carried out" };
  const release = () =>
    supabaseAdmin.from("approvals").update({ resumed_at: null }).eq("id", approvalId);

  const checked = await checkTrainingProposal(callerId, proposal);
  if (!checked.ok) {
    await release();
    return checked;
  }
  const p = checked.proposal;
  const made = await createModelAndTrain(
    callerId,
    {
      name: p.name,
      task: p.task,
      source: p.source,
      target_column: p.target_column,
      time_column: p.time_column,
      series_column: p.series_column,
      period: p.period,
      horizon: p.horizon,
      user_column: p.user_column,
      item_column: p.item_column,
      rating_column: p.rating_column,
      n_clusters: p.n_clusters,
      feature_columns: p.feature_columns,
    },
    { trigger: "approval" },
  );
  if (!made.ok) {
    // Nothing made: pressing again may still carry it out. A model that was
    // made but did not start training stays made, and is retrained from its page.
    if (!made.model_id) await release();
    return made.model_id
      ? {
          ok: false,
          modelId: made.model_id,
          error: `"${p.name}" was made, but its training did not start: ${made.error}`,
        }
      : { ok: false, error: made.error };
  }
  auditEvent({
    userId: callerId,
    action: "ml.train.approved",
    resourceType: "ml_model",
    resourceId: made.model_id,
    resourceName: p.name,
    decisionId: approvalId,
    detail: { approval_id: approvalId, job_id: made.job_id },
  });
  return {
    ok: true,
    modelId: made.model_id,
    message: `"${p.name}" is training on ${p.source.schema}.${p.source.table}. Its page shows the progress.`,
  };
}
