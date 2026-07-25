// Admin dialog to manage BI workspaces and their membership. Gated to
// superadmins by the caller (and by RLS: only the workspace creator or a
// superadmin can edit membership). The user/group pickers reuse the IAM admin
// listing server functions, which themselves require superadmin.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Users2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { iamListGroups, iamListUsers } from "@/utils/iam.functions";
import {
  addWorkspaceMember,
  createWorkspace,
  deleteWorkspace,
  listWorkspaceMembers,
  removeWorkspaceMember,
  type BiWorkspace,
  type BiWorkspaceMember,
} from "@/lib/biWorkspaces";

export function BiWorkspaceManager({
  open,
  onClose,
  workspaces,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  workspaces: BiWorkspace[];
  onChanged: () => void;
}) {
  const { user, session } = useAuth();
  const token = session?.access_token;
  const listUsers = useServerFn(iamListUsers);
  const listGroups = useServerFn(iamListGroups);

  const [users, setUsers] = useState<{ user_id: string; email: string | null }[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<BiWorkspaceMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [addType, setAddType] = useState<"user" | "group">("user");
  const [addPrincipal, setAddPrincipal] = useState<string>("");

  // Load the user + group directories once the dialog opens.
  useEffect(() => {
    if (!open || !token) return;
    void (async () => {
      try {
        const [u, g] = await Promise.all([
          listUsers({ data: { access_token: token } }),
          listGroups({ data: { access_token: token } }),
        ]);
        if (u.ok) setUsers(u.users.map((x) => ({ user_id: x.user_id, email: x.email })));
        if (g.ok) setGroups(g.groups.map((x) => ({ id: x.id, name: x.name })));
      } catch (e) {
        toast.error((e as Error).message);
      }
    })();
  }, [open, token, listUsers, listGroups]);

  const loadMembers = useCallback((wid: string) => {
    setMembersLoading(true);
    listWorkspaceMembers(wid)
      .then(setMembers)
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setMembersLoading(false));
  }, []);

  useEffect(() => {
    if (selectedId) loadMembers(selectedId);
    else setMembers([]);
  }, [selectedId, loadMembers]);

  const emailById = useMemo(() => new Map(users.map((u) => [u.user_id, u.email])), [users]);
  const groupNameById = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

  async function create() {
    if (!user?.id || !newName.trim()) return;
    setCreating(true);
    try {
      const ws = await createWorkspace({ userId: user.id, name: newName });
      setNewName("");
      onChanged();
      setSelectedId(ws.id);
      toast.success("Workspace created");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function removeWorkspace(w: BiWorkspace) {
    if (!window.confirm(`Delete workspace "${w.name}"? Dashboards inside become personal again.`))
      return;
    try {
      await deleteWorkspace(w.id);
      if (selectedId === w.id) setSelectedId(null);
      onChanged();
      toast.success("Workspace deleted");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function addMember() {
    if (!selectedId || !addPrincipal || !user?.id) return;
    try {
      await addWorkspaceMember({
        workspaceId: selectedId,
        principalType: addType,
        principalId: addPrincipal,
        createdBy: user.id,
      });
      setAddPrincipal("");
      loadMembers(selectedId);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function dropMember(m: BiWorkspaceMember) {
    try {
      await removeWorkspaceMember(m.id);
      if (selectedId) loadMembers(selectedId);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const memberedIds = new Set(members.map((m) => m.principal_id));
  const principalOptions =
    addType === "user"
      ? users
          .filter((u) => !memberedIds.has(u.user_id))
          .map((u) => ({ id: u.user_id, label: u.email ?? u.user_id }))
      : groups.filter((g) => !memberedIds.has(g.id)).map((g) => ({ id: g.id, label: g.name }));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users2 className="h-4 w-4 text-primary" /> Workspaces
          </DialogTitle>
          <DialogDescription>
            Shared containers for dashboards. Every member (a user or an IAM group) can view the
            dashboards placed in a workspace; only each dashboard&apos;s owner can edit it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[1fr_1.2fr]">
          {/* Workspaces list + create */}
          <div className="space-y-2">
            <div className="flex gap-1.5">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New workspace name"
                className="h-8 text-sm"
                onKeyDown={(e) => e.key === "Enter" && void create()}
              />
              <Button
                size="sm"
                className="h-8 gap-1"
                onClick={() => void create()}
                disabled={creating}
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <div className="max-h-80 space-y-1 overflow-y-auto rounded-md border border-border/60 p-1">
              {workspaces.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  No workspaces yet.
                </p>
              ) : (
                workspaces.map((w) => (
                  <div
                    key={w.id}
                    className={`flex items-center justify-between rounded px-2 py-1.5 text-sm ${
                      selectedId === w.id ? "bg-accent" : "hover:bg-muted/60"
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left"
                      onClick={() => setSelectedId(w.id)}
                    >
                      {w.name}
                    </button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => void removeWorkspace(w)}
                      title="Delete workspace"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Members of the selected workspace */}
          <div className="space-y-2">
            {!selectedId ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                Select a workspace to manage its members.
              </p>
            ) : (
              <>
                <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Members
                </Label>
                <div className="flex gap-1.5">
                  <Select value={addType} onValueChange={(v) => setAddType(v as "user" | "group")}>
                    <SelectTrigger className="h-8 w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">User</SelectItem>
                      <SelectItem value="group">Group</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={addPrincipal} onValueChange={setAddPrincipal}>
                    <SelectTrigger className="h-8 flex-1 text-xs">
                      <SelectValue placeholder={`Add a ${addType}…`} />
                    </SelectTrigger>
                    <SelectContent>
                      {principalOptions.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          None available
                        </div>
                      ) : (
                        principalOptions.map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.label}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="h-8 gap-1"
                    onClick={() => void addMember()}
                    disabled={!addPrincipal}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border/60 p-1">
                  {membersLoading ? (
                    <div className="flex justify-center py-6">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : members.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                      No members yet — add users or groups above.
                    </p>
                  ) : (
                    members.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted/60"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[10px] uppercase text-muted-foreground">
                            {m.principal_type}
                          </span>
                          {m.principal_type === "user"
                            ? (emailById.get(m.principal_id) ?? m.principal_id)
                            : (groupNameById.get(m.principal_id) ?? m.principal_id)}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => void dropMember(m)}
                          title="Remove member"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
