// BI workspaces & folders — an optional organizational + read-sharing layer
// over dashboards. Workspaces are shared containers whose members (users or IAM
// groups) can view every dashboard placed inside; folders give a tree for
// grouping dashboards in a workspace or in the user's personal space.
//
// All access is enforced by RLS (see 20260741000000_bi_workspaces.sql): these
// helpers run under the caller's JWT, so a query only ever returns rows the
// caller may actually see.
import { supabase } from "@/integrations/supabase/client";

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
