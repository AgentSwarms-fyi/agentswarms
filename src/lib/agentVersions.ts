// Agent version-history helpers — the agent-side counterpart of
// src/lib/swarmVersions.ts.
//
// A version is the agent's full configuration at a point in time. Snapshots are
// best-effort: a failure here must never block the user's save.
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

const MAX_VERSIONS = 30;

export type AgentVersionKind = "auto" | "manual" | "restore";

/** The fields that make up an agent's behaviour — everything we snapshot. */
export type AgentConfigSnapshot = {
  name: string;
  description: string | null;
  system_prompt: string | null;
  llm_provider: string | null;
  llm_model: string | null;
  temperature: number | null;
  max_tokens: number | null;
  knowledge_base_id: string | null;
  n8n_webhook_url: string | null;
  tools: unknown;
};

export type AgentVersionRow = {
  id: string;
  label: string;
  kind: AgentVersionKind;
  config: AgentConfigSnapshot;
  created_at: string;
};

const FIELDS: (keyof AgentConfigSnapshot)[] = [
  "name",
  "description",
  "system_prompt",
  "llm_provider",
  "llm_model",
  "temperature",
  "max_tokens",
  "knowledge_base_id",
  "n8n_webhook_url",
  "tools",
];

/** Narrow an agent row to just the versioned configuration. */
export function toSnapshot(agent: Record<string, unknown>): AgentConfigSnapshot {
  const out = {} as Record<string, unknown>;
  for (const f of FIELDS) out[f] = agent[f] ?? null;
  return out as AgentConfigSnapshot;
}

/**
 * Sort object keys recursively, leaving arrays in place.
 *
 * Array order is meaningful and is never touched; only object keys are
 * normalised, because those are what the storage layer reorders.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) out[k] = canonical(obj[k]);
  return out;
}

/**
 * Stable fingerprint — used to skip snapshotting a save that changed nothing.
 *
 * THE KEY SORT IS THE WHOLE POINT. The previous version reasoned "key order is
 * fixed by FIELDS, so this is stable", which holds for the ten top-level
 * fields and not for `tools`, the one field whose value is a nested object.
 *
 * `config` is a jsonb column, and jsonb does not preserve key order — it
 * normalises keys by length then bytes. So the value read back from Postgres
 * and the value the form just built in memory are the same configuration in
 * two different orders, JSON.stringify produced two different strings, and the
 * no-op check never once fired. Demonstrated with the real tools shape:
 * insertion order builtInTools/activeWorkflows/toolConfigs/guardrails, jsonb
 * order guardrails/toolConfigs/builtInTools/activeWorkflows.
 *
 * The effect is not a spurious row, it is the loss of the history. Every save
 * wrote a version, MAX_VERSIONS is 30, and pruning keeps the newest — so
 * thirty no-op saves silently evicted every snapshot a user actually wanted,
 * while the code comment promised "history stays meaningful".
 */
export function configHash(cfg: AgentConfigSnapshot): string {
  return JSON.stringify(FIELDS.map((f) => canonical(cfg[f] ?? null)));
}

export async function snapshotAgentVersion(opts: {
  agentId: string;
  userId: string;
  config: AgentConfigSnapshot;
  label: string;
  kind: AgentVersionKind;
}): Promise<void> {
  // Skip a no-op save: compare against the most recent snapshot.
  const { data: latest } = await supabase
    .from("agent_versions")
    .select("config")
    .eq("agent_id", opts.agentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest?.config) {
    const prev = configHash(latest.config as unknown as AgentConfigSnapshot);
    if (prev === configHash(opts.config)) return;
  }

  const { error } = await supabase.from("agent_versions").insert({
    agent_id: opts.agentId,
    user_id: opts.userId,
    label: opts.label,
    kind: opts.kind,
    config: opts.config as unknown as Json,
  });
  if (error) {
    // Best-effort by design — never block a save. But a version history that
    // stops recording without saying so is worse than one that is absent: the
    // user keeps editing believing they can roll back. Logged like the
    // memory-config save right next to it.
    console.warn("[agent_versions] snapshot failed:", error.message);
    return;
  }

  // Prune to the most recent MAX_VERSIONS for this agent.
  const { data: ids } = await supabase
    .from("agent_versions")
    .select("id")
    .eq("agent_id", opts.agentId)
    .order("created_at", { ascending: false });
  if (ids && ids.length > MAX_VERSIONS) {
    const toDelete = ids.slice(MAX_VERSIONS).map((r) => r.id);
    if (toDelete.length) await supabase.from("agent_versions").delete().in("id", toDelete);
  }
}

/** Human-readable label for a field, used by the diff view. */
export const FIELD_LABELS: Record<keyof AgentConfigSnapshot, string> = {
  name: "Name",
  description: "Description",
  system_prompt: "System prompt",
  llm_provider: "Provider",
  llm_model: "Model",
  temperature: "Temperature",
  max_tokens: "Max tokens",
  knowledge_base_id: "Knowledge base",
  n8n_webhook_url: "n8n webhook",
  tools: "Tools, guardrails & skills",
};

export type FieldDiff = { field: keyof AgentConfigSnapshot; before: string; after: string };

/**
 * One field, as the diff view shows it.
 *
 * `typeof null === "object"`, so the previous `typeof a === "object" ?
 * JSON.stringify(a) : String(a ?? "")` sent every null field down the JSON
 * branch and rendered an unset Description as the literal text `null`. The
 * `?? ""` that was meant to prevent exactly that sat in the branch nulls never
 * reached.
 *
 * Objects are canonicalised so a key reorder — which is what a jsonb round
 * trip does — is not displayed as a change to the whole tools blob.
 */
function renderField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(canonical(value), null, 2);
  return String(value);
}

/** Field-level diff between two snapshots — only changed fields are returned. */
export function diffSnapshots(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const f of FIELDS) {
    const sa = renderField(before[f]);
    const sb = renderField(after[f]);
    if (sa !== sb) out.push({ field: f, before: sa, after: sb });
  }
  return out;
}
