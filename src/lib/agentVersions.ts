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

/** Stable fingerprint — used to skip snapshotting a save that changed nothing. */
export function configHash(cfg: AgentConfigSnapshot): string {
  // Key order is fixed by FIELDS, so this is stable across calls.
  return JSON.stringify(FIELDS.map((f) => cfg[f] ?? null));
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
  if (error) return; // versioning is best-effort; never block a save

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

/** Field-level diff between two snapshots — only changed fields are returned. */
export function diffSnapshots(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const f of FIELDS) {
    const a = before[f] ?? null;
    const b = after[f] ?? null;
    const sa = typeof a === "object" ? JSON.stringify(a, null, 2) : String(a ?? "");
    const sb = typeof b === "object" ? JSON.stringify(b, null, 2) : String(b ?? "");
    if (sa !== sb) out.push({ field: f, before: sa, after: sb });
  }
  return out;
}
