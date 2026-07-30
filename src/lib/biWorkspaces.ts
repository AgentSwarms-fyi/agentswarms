// BI workspaces & folders — an optional organizational + read-sharing layer
// over dashboards. Workspaces are shared containers whose members (users or IAM
// groups) can view every dashboard placed inside; folders give a tree for
// grouping dashboards in a workspace or in the user's personal space.
//
// All access is enforced by RLS (see 20260741000000_bi_workspaces.sql): these
// helpers run under the caller's JWT, so a query only ever returns rows the
// caller may actually see.
import { supabase } from "@/integrations/supabase/client";
import {
  fetchWidgetResults,
  mergePagesResults,
  mergeWidgetResults,
  type BiDashboardRow,
} from "@/lib/biDashboards";

export type BiWorkspace = {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type BiFolder = {
  id: string;
  workspace_id: string | null;
  user_id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
};

export type BiWorkspaceMember = {
  id: string;
  workspace_id: string;
  principal_type: "user" | "group";
  principal_id: string;
  role: "viewer" | "editor" | "admin";
  created_by: string | null;
  created_at: string;
};

// ── Workspaces ────────────────────────────────────────────────────────────────

export async function listWorkspaces(): Promise<BiWorkspace[]> {
  const { data, error } = await supabase
    .from("bi_workspaces")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as BiWorkspace[];
}

export async function createWorkspace(args: {
  userId: string;
  name: string;
  description?: string | null;
}): Promise<BiWorkspace> {
  const { data, error } = await supabase
    .from("bi_workspaces")
    .insert({
      name: args.name.trim(),
      description: args.description?.trim() || null,
      created_by: args.userId,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not create the workspace");
  return data as BiWorkspace;
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("bi_workspaces").update({ name: name.trim() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteWorkspace(id: string): Promise<void> {
  const { error } = await supabase.from("bi_workspaces").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Members ───────────────────────────────────────────────────────────────────

export async function listWorkspaceMembers(workspaceId: string): Promise<BiWorkspaceMember[]> {
  const { data, error } = await supabase
    .from("bi_workspace_members")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as BiWorkspaceMember[];
}

export async function addWorkspaceMember(args: {
  workspaceId: string;
  principalType: "user" | "group";
  principalId: string;
  role?: "viewer" | "editor" | "admin";
  createdBy: string;
}): Promise<void> {
  const { error } = await supabase.from("bi_workspace_members").insert({
    workspace_id: args.workspaceId,
    principal_type: args.principalType,
    principal_id: args.principalId,
    role: args.role ?? "viewer",
    created_by: args.createdBy,
  });
  if (error) throw new Error(error.message);
}

export async function removeWorkspaceMember(id: string): Promise<void> {
  const { error } = await supabase.from("bi_workspace_members").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Folders ───────────────────────────────────────────────────────────────────

/** All folders the caller can see (personal + workspaces they belong to). */
export async function listFolders(): Promise<BiFolder[]> {
  const { data, error } = await supabase
    .from("bi_folders")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as BiFolder[];
}

export async function createFolder(args: {
  userId: string;
  name: string;
  workspaceId?: string | null;
  parentId?: string | null;
}): Promise<BiFolder> {
  const { data, error } = await supabase
    .from("bi_folders")
    .insert({
      user_id: args.userId,
      name: args.name.trim(),
      workspace_id: args.workspaceId ?? null,
      parent_id: args.parentId ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not create the folder");
  return data as BiFolder;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("bi_folders").update({ name: name.trim() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteFolder(id: string): Promise<void> {
  const { error } = await supabase.from("bi_folders").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Move a dashboard into a workspace/folder (either may be null = personal/ungrouped). */
export async function moveDashboard(
  dashboardId: string,
  target: { workspace_id: string | null; folder_id: string | null },
): Promise<void> {
  const { error } = await supabase
    .from("bi_dashboards")
    .update({ workspace_id: target.workspace_id, folder_id: target.folder_id })
    .eq("id", dashboardId);
  if (error) throw new Error(error.message);
}

// ── Dev→prod promotion ──────────────────────────────────────────────────────

export type BiPromotion = {
  id: string;
  source_dashboard_id: string;
  target_dashboard_id: string;
  target_workspace_id: string;
  promoted_by: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

/** Promotion links whose SOURCE is one of these dashboards (for a badge). */
export async function listPromotionsForSources(sourceIds: string[]): Promise<BiPromotion[]> {
  if (sourceIds.length === 0) return [];
  const { data, error } = await supabase
    .from("bi_promotions")
    .select("*")
    .in("source_dashboard_id", sourceIds);
  if (error) throw new Error(error.message);
  return (data ?? []) as BiPromotion[];
}

/**
 * Promote a dashboard's CURRENT state into a target workspace. The first
 * promotion creates a copy (owned by the promoter, placed in the workspace,
 * reset to Draft); a later promotion to the same workspace re-syncs that same
 * copy's content (keeping the prod copy's own publish state + link). Returns
 * whether a copy was created or an existing one was updated.
 */
export async function promoteDashboard(args: {
  userId: string;
  source: BiDashboardRow;
  targetWorkspaceId: string;
  note?: string;
}): Promise<"created" | "updated"> {
  const { userId, source, targetWorkspaceId, note } = args;
  // Hydrate the source's row snapshots before copying: the results store is
  // keyed by the SOURCE dashboard id, so the promoted copy cannot reach them.
  // Embedding the data in the target document once makes the copy render
  // immediately; its own first save/refresh then moves it to the store.
  let widgets = source.widgets;
  let pages = source.pages;
  try {
    const results = await fetchWidgetResults(source.id);
    if (results.length > 0) {
      widgets = mergeWidgetResults(widgets, results) as typeof widgets;
      pages = mergePagesResults(pages, results) as typeof pages;
    }
  } catch {
    /* copy whatever the document carries */
  }
  const content = {
    widgets,
    layout: source.layout,
    pages,
    filters: source.filters,
    theme: source.theme,
    ai_model: source.ai_model,
  };

  const { data: existing, error: findErr } = await supabase
    .from("bi_promotions")
    .select("*")
    .eq("source_dashboard_id", source.id)
    .eq("target_workspace_id", targetWorkspaceId)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);

  if (existing) {
    // Re-sync content only — never clobber the prod copy's publish state/link.
    const { error: upErr } = await supabase
      .from("bi_dashboards")
      .update(content)
      .eq("id", existing.target_dashboard_id);
    if (upErr) throw new Error(upErr.message);
    const { error: linkErr } = await supabase
      .from("bi_promotions")
      .update({ note: note ?? existing.note })
      .eq("id", existing.id);
    if (linkErr) throw new Error(linkErr.message);
    return "updated";
  }

  const { data: created, error: insErr } = await supabase
    .from("bi_dashboards")
    .insert({
      user_id: userId,
      name: source.name,
      description: source.description,
      ...content,
      workspace_id: targetWorkspaceId,
      folder_id: null,
      published: false,
    })
    .select("id")
    .single();
  if (insErr || !created) throw new Error(insErr?.message ?? "Could not create the promoted copy");

  const { error: linkErr } = await supabase.from("bi_promotions").insert({
    source_dashboard_id: source.id,
    target_dashboard_id: created.id,
    target_workspace_id: targetWorkspaceId,
    promoted_by: userId,
    note: note ?? null,
  });
  if (linkErr) throw new Error(linkErr.message);
  return "created";
}
