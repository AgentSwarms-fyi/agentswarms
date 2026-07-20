// Identity & Access Management console (superadmin-only).
// Users · Groups · Access (model rules + resource shares) · Settings.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import {
  Ban,
  Check,
  Copy,
  Database as DatabaseIcon,
  BookOpen,
  KeyRound,
  Plus,
  RefreshCw,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users as UsersIcon,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { useAuth } from "@/hooks/use-auth";
import { invalidateIamState, useIsSuperadmin } from "@/hooks/use-iam";
import { PROVIDER_LABELS, type ProviderId } from "@/utils/providers/types";
import {
  iamAddGroupMember,
  iamCreateGrant,
  iamCreateGroup,
  iamCreateUser,
  iamDeleteGrant,
  iamDeleteGroup,
  iamDeleteUser,
  iamGetSettings,
  iamGrantSuperadmin,
  iamListGrantableResources,
  iamListGrants,
  iamListGroups,
  iamListModelRules,
  iamListUsers,
  iamRemoveGroupMember,
  iamRevokeSuperadmin,
  iamSetModelRules,
  iamSetUserBan,
  iamUpdateGroup,
  iamUpdateSettings,
  type IamGrantRow,
  type IamGroupRow,
  type IamModelRuleRow,
  type IamResourceOption,
  type IamUserRow,
} from "@/utils/iam.functions";

export const Route = createFileRoute("/_authenticated/admin/iam")({
  component: AdminIamPage,
});

function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => alphabet[b % alphabet.length])
    .join("");
}

function AdminIamPage() {
  const { user, session } = useAuth();
  const isSuperadmin = useIsSuperadmin();
  const token = session?.access_token;

  const listUsers = useServerFn(iamListUsers);
  const listGroups = useServerFn(iamListGroups);
  const listRules = useServerFn(iamListModelRules);
  const listGrants = useServerFn(iamListGrants);
  const listResources = useServerFn(iamListGrantableResources);
  const getSettings = useServerFn(iamGetSettings);

  const [users, setUsers] = useState<IamUserRow[] | null>(null);
  const [groups, setGroups] = useState<IamGroupRow[] | null>(null);
  const [rules, setRules] = useState<IamModelRuleRow[] | null>(null);
  const [grants, setGrants] = useState<IamGrantRow[] | null>(null);
  const [resources, setResources] = useState<IamResourceOption[] | null>(null);
  const [allowSignup, setAllowSignup] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    if (!token) return;
    setError(null);
    Promise.all([
      listUsers({ data: { access_token: token } }),
      listGroups({ data: { access_token: token } }),
      listRules({ data: { access_token: token } }),
      listGrants({ data: { access_token: token } }),
      listResources({ data: { access_token: token } }),
      getSettings({ data: { access_token: token } }),
    ])
      .then(([u, g, r, gr, res, st]) => {
        if (!u.ok) return setError(u.error);
        if (!g.ok) return setError(g.error);
        if (!r.ok) return setError(r.error);
        if (!gr.ok) return setError(gr.error);
        if (!res.ok) return setError(res.error);
        if (!st.ok) return setError(st.error);
        setUsers(u.users);
        setGroups(g.groups);
        setRules(r.rules);
        setGrants(gr.grants);
        setResources(res.resources);
        setAllowSignup(st.allow_public_signup);
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [token, listUsers, listGroups, listRules, listGrants, listResources, getSettings]);

  useEffect(() => {
    if (!isSuperadmin || !token) return;
    reload();
  }, [isSuperadmin, token, reload]);

  const userById = useMemo(() => new Map((users ?? []).map((u) => [u.user_id, u])), [users]);
  const groupById = useMemo(() => new Map((groups ?? []).map((g) => [g.id, g])), [groups]);

  if (!user) return null;

  if (!isSuperadmin) {
    return (
      <div className="p-6">
        <Card className="max-w-lg mx-auto mt-12 border-destructive/40">
          <CardContent className="p-8 text-center">
            <ShieldAlert className="h-10 w-10 text-destructive mx-auto mb-3" />
            <h2 className="text-lg font-semibold mb-1">Restricted area</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Identity &amp; Access Management is only available to superadmins.
            </p>
            <Link to="/dashboard" className="text-sm text-primary hover:underline">
              Go back to dashboard
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading || !users || !groups || !rules || !grants || !resources) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-9 w-96" />
        <Skeleton className="h-72 w-full" />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Shield className="h-6 w-6 text-primary" /> Identity &amp; Access Management
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Provision users, organize groups, and control access to models, knowledge bases, and
            data tables.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reload} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users" className="gap-1.5">
            <UsersIcon className="h-3.5 w-3.5" /> Users
          </TabsTrigger>
          <TabsTrigger value="groups" className="gap-1.5">
            <UsersIcon className="h-3.5 w-3.5" /> Groups
          </TabsTrigger>
          <TabsTrigger value="access" className="gap-1.5">
            <KeyRound className="h-3.5 w-3.5" /> Access
          </TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" /> Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="mt-4">
          <UsersTab token={token!} selfId={user.id} users={users} groups={groups} reload={reload} />
        </TabsContent>
        <TabsContent value="groups" className="mt-4">
          <GroupsTab token={token!} users={users} groups={groups} reload={reload} />
        </TabsContent>
        <TabsContent value="access" className="mt-4">
          <AccessTab
            token={token!}
            users={users}
            groups={groups}
            rules={rules}
            grants={grants}
            resources={resources}
            userById={userById}
            groupById={groupById}
            reload={reload}
          />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab
            token={token!}
            users={users}
            allowSignup={allowSignup ?? true}
            setAllowSignup={setAllowSignup}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Users tab ───────────────────────────────────────────────────────────────

function UsersTab({
  token,
  selfId,
  users,
  groups,
  reload,
}: {
  token: string;
  selfId: string;
  users: IamUserRow[];
  groups: IamGroupRow[];
  reload: () => void;
}) {
  const createUser = useServerFn(iamCreateUser);
  const setBan = useServerFn(iamSetUserBan);
  const deleteUser = useServerFn(iamDeleteUser);
  const grantSuper = useServerFn(iamGrantSuperadmin);
  const revokeSuper = useServerFn(iamRevokeSuperadmin);
  const addMember = useServerFn(iamAddGroupMember);
  const removeMember = useServerFn(iamRemoveGroupMember);

  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [mode, setMode] = useState<"invite" | "password">("invite");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [groupsFor, setGroupsFor] = useState<IamUserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IamUserRow | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        (u.email ?? "").toLowerCase().includes(q) ||
        (u.display_name ?? "").toLowerCase().includes(q),
    );
  }, [users, search]);

  const submitAdd = async () => {
    if (!email.trim()) return toast.error("Email is required");
    if (mode === "password" && password.length < 8)
      return toast.error("Password must be at least 8 characters");
    setBusy(true);
    try {
      const res = await createUser({
        data: {
          access_token: token,
          email: email.trim(),
          display_name: displayName.trim() || undefined,
          password: mode === "password" ? password : undefined,
        },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(
        res.invited ? `Invitation sent to ${email.trim()}` : `Account created for ${email.trim()}`,
      );
      setAddOpen(false);
      setEmail("");
      setDisplayName("");
      setPassword("");
      reload();
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    const res = await fn();
    if (!res.ok) return toast.error(res.error ?? "Action failed");
    toast.success(okMsg);
    invalidateIamState();
    reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          placeholder="Search by email or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Button size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
          <UserPlus className="h-3.5 w-3.5" /> Add user
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Groups</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((u) => (
                <TableRow key={u.user_id}>
                  <TableCell>
                    <div className="font-medium">{u.email ?? "—"}</div>
                    {u.display_name ? (
                      <div className="text-xs text-muted-foreground">{u.display_name}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {u.group_ids.length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        u.group_ids.map((gid) => (
                          <Badge key={gid} variant="secondary" className="text-[10px]">
                            {groups.find((g) => g.id === gid)?.name ?? "?"}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {u.is_superadmin ? (
                        <Badge className="gap-1 bg-primary/15 text-primary border-primary/30 text-[10px]">
                          <ShieldCheck className="h-3 w-3" /> Superadmin
                        </Badge>
                      ) : null}
                      {u.banned ? (
                        <Badge variant="destructive" className="text-[10px]">
                          Banned
                        </Badge>
                      ) : null}
                      {u.invite_pending ? (
                        <Badge variant="outline" className="text-[10px]">
                          Invite pending
                        </Badge>
                      ) : null}
                      {!u.is_superadmin && !u.banned && !u.invite_pending ? (
                        <span className="text-xs text-muted-foreground">Active</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {u.last_sign_in_at
                      ? formatDistanceToNow(new Date(u.last_sign_in_at), { addSuffix: true })
                      : "never"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {u.created_at ? format(new Date(u.created_at), "d MMM yyyy") : "—"}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                          ⋯
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuItem onClick={() => setGroupsFor(u)}>
                          Manage groups
                        </DropdownMenuItem>
                        {u.is_superadmin ? (
                          <DropdownMenuItem
                            onClick={() =>
                              act(
                                () =>
                                  revokeSuper({
                                    data: { access_token: token, user_id: u.user_id },
                                  }),
                                "Superadmin revoked",
                              )
                            }
                          >
                            Revoke superadmin
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={() =>
                              act(
                                () =>
                                  grantSuper({
                                    data: { access_token: token, user_id: u.user_id },
                                  }),
                                "Superadmin granted",
                              )
                            }
                          >
                            Make superadmin
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        {u.user_id !== selfId ? (
                          <>
                            <DropdownMenuItem
                              onClick={() =>
                                act(
                                  () =>
                                    setBan({
                                      data: {
                                        access_token: token,
                                        user_id: u.user_id,
                                        banned: !u.banned,
                                      },
                                    }),
                                  u.banned ? "User unbanned" : "User banned",
                                )
                              }
                            >
                              <Ban className="h-3.5 w-3.5 mr-2" />
                              {u.banned ? "Unban user" : "Ban user"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => setDeleteTarget(u)}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete user
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Add user dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>
              Invite by email (they set their own password) or create the account with a temporary
              password you share with them.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={mode === "invite" ? "default" : "outline"}
                onClick={() => setMode("invite")}
              >
                Invite by email
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "password" ? "default" : "outline"}
                onClick={() => setMode("password")}
              >
                Set a password
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="iam-email">Email</Label>
              <Input
                id="iam-email"
                type="email"
                placeholder="person@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="iam-name">Display name (optional)</Label>
              <Input
                id="iam-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            {mode === "password" ? (
              <div className="space-y-2">
                <Label htmlFor="iam-pass">Temporary password</Label>
                <div className="flex gap-2">
                  <Input
                    id="iam-pass"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setPassword(generatePassword());
                      setCopied(false);
                    }}
                  >
                    Generate
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!password}
                    onClick={() => {
                      void navigator.clipboard.writeText(password);
                      setCopied(true);
                    }}
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Share this with the user out of band — it is not emailed.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                The invitation email is sent by your Supabase project's auth mailer.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitAdd} disabled={busy}>
              {mode === "invite" ? "Send invite" : "Create account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage groups dialog */}
      <Dialog open={!!groupsFor} onOpenChange={(o) => !o && setGroupsFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Groups for {groupsFor?.email}</DialogTitle>
            <DialogDescription>Toggle membership; changes apply immediately.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No groups yet — create one in the Groups tab.
              </p>
            ) : (
              groups.map((g) => {
                const member = groupsFor?.group_ids.includes(g.id) ?? false;
                return (
                  <label key={g.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={member}
                      onCheckedChange={async (checked) => {
                        if (!groupsFor) return;
                        const fn = checked ? addMember : removeMember;
                        const res = await fn({
                          data: {
                            access_token: token,
                            group_id: g.id,
                            user_id: groupsFor.user_id,
                          },
                        });
                        if (!res.ok) return toast.error(res.error);
                        setGroupsFor({
                          ...groupsFor,
                          group_ids: checked
                            ? [...groupsFor.group_ids, g.id]
                            : groupsFor.group_ids.filter((id) => id !== g.id),
                        });
                        invalidateIamState();
                        reload();
                      }}
                    />
                    {g.name}
                  </label>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the account and everything it owns (agents, swarms, knowledge
              bases, data tables, traces). This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (!deleteTarget) return;
                void act(
                  () =>
                    deleteUser({ data: { access_token: token, user_id: deleteTarget.user_id } }),
                  "User deleted",
                );
                setDeleteTarget(null);
              }}
            >
              Delete user
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Groups tab ──────────────────────────────────────────────────────────────

function GroupsTab({
  token,
  users,
  groups,
  reload,
}: {
  token: string;
  users: IamUserRow[];
  groups: IamGroupRow[];
  reload: () => void;
}) {
  const createGroup = useServerFn(iamCreateGroup);
  const updateGroup = useServerFn(iamUpdateGroup);
  const deleteGroup = useServerFn(iamDeleteGroup);
  const addMember = useServerFn(iamAddGroupMember);
  const removeMember = useServerFn(iamRemoveGroupMember);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [openGroup, setOpenGroup] = useState<IamGroupRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [addUserId, setAddUserId] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Keep the sheet in sync with reloaded data.
  useEffect(() => {
    if (!openGroup) return;
    const fresh = groups.find((g) => g.id === openGroup.id);
    if (fresh && fresh !== openGroup) setOpenGroup(fresh);
  }, [groups, openGroup]);

  const openSheet = (g: IamGroupRow) => {
    setOpenGroup(g);
    setEditName(g.name);
    setEditDesc(g.description ?? "");
    setAddUserId("");
  };

  const nonMembers = useMemo(
    () => users.filter((u) => !(openGroup?.member_user_ids ?? []).includes(u.user_id)),
    [users, openGroup],
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> Create group
        </Button>
      </div>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No groups yet. Groups let you manage model access and resource shares for many users at
            once.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <Card
              key={g.id}
              className="cursor-pointer transition hover:border-primary/40"
              onClick={() => openSheet(g)}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{g.name}</CardTitle>
                {g.description ? <CardDescription>{g.description}</CardDescription> : null}
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  {g.member_user_ids.length} member{g.member_user_ids.length === 1 ? "" : "s"}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create group */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create group</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="eng" />
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!name.trim()) return toast.error("Name is required");
                const res = await createGroup({
                  data: {
                    access_token: token,
                    name: name.trim(),
                    description: description.trim() || undefined,
                  },
                });
                if (!res.ok) return toast.error(res.error);
                toast.success("Group created");
                setCreateOpen(false);
                setName("");
                setDescription("");
                reload();
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Group detail sheet */}
      <Sheet open={!!openGroup} onOpenChange={(o) => !o && setOpenGroup(null)}>
        <SheetContent className="sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{openGroup?.name}</SheetTitle>
            <SheetDescription>Manage this group's details and members.</SheetDescription>
          </SheetHeader>
          {openGroup ? (
            <div className="mt-6 space-y-6">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                <Label>Description</Label>
                <Textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} rows={2} />
                <Button
                  size="sm"
                  onClick={async () => {
                    const res = await updateGroup({
                      data: {
                        access_token: token,
                        group_id: openGroup.id,
                        name: editName.trim(),
                        description: editDesc.trim() || undefined,
                      },
                    });
                    if (!res.ok) return toast.error(res.error);
                    toast.success("Group updated");
                    reload();
                  }}
                >
                  Save changes
                </Button>
              </div>

              <div className="space-y-2">
                <Label>Members ({openGroup.member_user_ids.length})</Label>
                <div className="space-y-1.5">
                  {openGroup.member_user_ids.map((uid) => {
                    const u = users.find((x) => x.user_id === uid);
                    return (
                      <div
                        key={uid}
                        className="flex items-center justify-between rounded-md border border-border/60 px-3 py-1.5 text-sm"
                      >
                        <span className="truncate">{u?.email ?? uid}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                          onClick={async () => {
                            const res = await removeMember({
                              data: {
                                access_token: token,
                                group_id: openGroup.id,
                                user_id: uid,
                              },
                            });
                            if (!res.ok) return toast.error(res.error);
                            invalidateIamState();
                            reload();
                          }}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-2">
                  <Select value={addUserId} onValueChange={setAddUserId}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Add a member…" />
                    </SelectTrigger>
                    <SelectContent>
                      {nonMembers.map((u) => (
                        <SelectItem key={u.user_id} value={u.user_id}>
                          {u.email ?? u.user_id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    disabled={!addUserId}
                    onClick={async () => {
                      const res = await addMember({
                        data: {
                          access_token: token,
                          group_id: openGroup.id,
                          user_id: addUserId,
                        },
                      });
                      if (!res.ok) return toast.error(res.error);
                      setAddUserId("");
                      invalidateIamState();
                      reload();
                    }}
                  >
                    Add
                  </Button>
                </div>
              </div>

              <div className="border-t border-border/60 pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete group
                </Button>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group "{openGroup?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Members keep their accounts; any model rules and resource shares attached to this
              group are removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!openGroup) return;
                const res = await deleteGroup({
                  data: { access_token: token, group_id: openGroup.id },
                });
                if (!res.ok) return toast.error(res.error);
                toast.success("Group deleted");
                setConfirmDelete(false);
                setOpenGroup(null);
                invalidateIamState();
                reload();
              }}
            >
              Delete group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Access tab ──────────────────────────────────────────────────────────────

const PROVIDER_IDS = Object.keys(PROVIDER_LABELS) as ProviderId[];

function AccessTab({
  token,
  users,
  groups,
  rules,
  grants,
  resources,
  userById,
  groupById,
  reload,
}: {
  token: string;
  users: IamUserRow[];
  groups: IamGroupRow[];
  rules: IamModelRuleRow[];
  grants: IamGrantRow[];
  resources: IamResourceOption[];
  userById: Map<string, IamUserRow>;
  groupById: Map<string, IamGroupRow>;
  reload: () => void;
}) {
  const setRulesFn = useServerFn(iamSetModelRules);
  const createGrant = useServerFn(iamCreateGrant);
  const deleteGrant = useServerFn(iamDeleteGrant);

  // Model rules editor state
  const [principalType, setPrincipalType] = useState<"group" | "user">("group");
  const [principalId, setPrincipalId] = useState("");
  const [draft, setDraft] = useState<{ provider: string; model_pattern: string }[]>([]);
  const [newProvider, setNewProvider] = useState<string>("openrouter");
  const [newPattern, setNewPattern] = useState("*");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!principalId) {
      setDraft([]);
      setDirty(false);
      return;
    }
    setDraft(
      rules
        .filter((r) => r.principal_type === principalType && r.principal_id === principalId)
        .map((r) => ({ provider: r.provider, model_pattern: r.model_pattern })),
    );
    setDirty(false);
  }, [principalType, principalId, rules]);

  // Share builder state
  const [shareResourceKey, setShareResourceKey] = useState("");
  const [sharePrincipalType, setSharePrincipalType] = useState<"group" | "user">("group");
  const [sharePrincipalId, setSharePrincipalId] = useState("");

  const principalName = (type: string, id: string) =>
    type === "group"
      ? (groupById.get(id)?.name ?? "deleted group")
      : (userById.get(id)?.email ?? "deleted user");

  return (
    <div className="space-y-6">
      {/* Model access */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Model access</CardTitle>
          <CardDescription>
            By default everyone can use every model. Add rules to a user or group to restrict them
            to an allow-list — their allowed set is the union of their own rules and all their
            groups' rules. Patterns: <code className="text-xs">*</code> (all models of a provider),{" "}
            <code className="text-xs">openai/*</code> (prefix), or an exact model id.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Select
              value={principalType}
              onValueChange={(v) => {
                setPrincipalType(v as "group" | "user");
                setPrincipalId("");
              }}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="group">Group</SelectItem>
                <SelectItem value="user">User</SelectItem>
              </SelectContent>
            </Select>
            <Select value={principalId} onValueChange={setPrincipalId}>
              <SelectTrigger className="w-64">
                <SelectValue
                  placeholder={principalType === "group" ? "Pick a group…" : "Pick a user…"}
                />
              </SelectTrigger>
              <SelectContent>
                {principalType === "group"
                  ? groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))
                  : users.map((u) => (
                      <SelectItem key={u.user_id} value={u.user_id}>
                        {u.email ?? u.user_id}
                      </SelectItem>
                    ))}
              </SelectContent>
            </Select>
          </div>

          {principalId ? (
            <>
              {draft.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No rules — this {principalType} is unrestricted (unless rules apply from
                  elsewhere).
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {draft.map((r, i) => (
                    <Badge key={`${r.provider}-${r.model_pattern}-${i}`} variant="secondary">
                      {PROVIDER_LABELS[r.provider as ProviderId] ?? r.provider} ·{" "}
                      <span className="font-mono ml-1">{r.model_pattern}</span>
                      <button
                        type="button"
                        className="ml-1.5 hover:text-destructive"
                        onClick={() => {
                          setDraft(draft.filter((_, j) => j !== i));
                          setDirty(true);
                        }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Select value={newProvider} onValueChange={setNewProvider}>
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_IDS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {PROVIDER_LABELS[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="w-56 font-mono"
                  value={newPattern}
                  onChange={(e) => setNewPattern(e.target.value)}
                  placeholder="* or openai/gpt-4o-mini"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (!newPattern.trim()) return;
                    setDraft([
                      ...draft,
                      { provider: newProvider, model_pattern: newPattern.trim() },
                    ]);
                    setNewPattern("*");
                    setDirty(true);
                  }}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add rule
                </Button>
              </div>

              <Button
                size="sm"
                disabled={!dirty}
                onClick={async () => {
                  const res = await setRulesFn({
                    data: {
                      access_token: token,
                      principal_type: principalType,
                      principal_id: principalId,
                      rules: draft,
                    },
                  });
                  if (!res.ok) return toast.error(res.error);
                  toast.success("Model rules saved");
                  invalidateIamState();
                  reload();
                }}
              >
                Save rules
              </Button>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* Resource shares */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Knowledge base &amp; data table shares</CardTitle>
          <CardDescription>
            Grant read-only access to any user's knowledge base or SQL data table. Recipients (and
            their agents) can search and query the resource but cannot modify it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Select value={shareResourceKey} onValueChange={setShareResourceKey}>
              <SelectTrigger className="w-72">
                <SelectValue placeholder="Pick a resource…" />
              </SelectTrigger>
              <SelectContent>
                {resources.map((r) => (
                  <SelectItem
                    key={`${r.resource_type}:${r.id}`}
                    value={`${r.resource_type}:${r.id}`}
                  >
                    {r.resource_type === "knowledge_base" ? "📚 " : "🗃 "}
                    {r.name}
                    {r.owner_user_id
                      ? ` — ${userById.get(r.owner_user_id)?.email ?? "unknown owner"}`
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={sharePrincipalType}
              onValueChange={(v) => {
                setSharePrincipalType(v as "group" | "user");
                setSharePrincipalId("");
              }}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="group">Group</SelectItem>
                <SelectItem value="user">User</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sharePrincipalId} onValueChange={setSharePrincipalId}>
              <SelectTrigger className="w-56">
                <SelectValue
                  placeholder={sharePrincipalType === "group" ? "Pick a group…" : "Pick a user…"}
                />
              </SelectTrigger>
              <SelectContent>
                {sharePrincipalType === "group"
                  ? groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))
                  : users.map((u) => (
                      <SelectItem key={u.user_id} value={u.user_id}>
                        {u.email ?? u.user_id}
                      </SelectItem>
                    ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={!shareResourceKey || !sharePrincipalId}
              onClick={async () => {
                const [resource_type, resource_id] = shareResourceKey.split(":") as [
                  "knowledge_base" | "data_table",
                  string,
                ];
                const res = await createGrant({
                  data: {
                    access_token: token,
                    resource_type,
                    resource_id,
                    principal_type: sharePrincipalType,
                    principal_id: sharePrincipalId,
                  },
                });
                if (!res.ok) return toast.error(res.error);
                toast.success("Share created");
                setShareResourceKey("");
                setSharePrincipalId("");
                reload();
              }}
            >
              Share
            </Button>
          </div>

          {grants.length === 0 ? (
            <p className="text-sm text-muted-foreground">No shares yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resource</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Shared with</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {g.resource_type === "knowledge_base" ? (
                          <BookOpen className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <DatabaseIcon className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className={g.resource_name ? "" : "italic text-muted-foreground"}>
                          {g.resource_name ?? "(deleted)"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {g.resource_owner_id
                        ? (userById.get(g.resource_owner_id)?.email ?? "—")
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px]">
                        {g.principal_type === "group" ? "group" : "user"} ·{" "}
                        {principalName(g.principal_type, g.principal_id)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={async () => {
                          const res = await deleteGrant({
                            data: { access_token: token, grant_id: g.id },
                          });
                          if (!res.ok) return toast.error(res.error);
                          toast.success("Share revoked");
                          reload();
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Settings tab ────────────────────────────────────────────────────────────

function SettingsTab({
  token,
  users,
  allowSignup,
  setAllowSignup,
}: {
  token: string;
  users: IamUserRow[];
  allowSignup: boolean;
  setAllowSignup: (v: boolean) => void;
}) {
  const updateSettings = useServerFn(iamUpdateSettings);
  const superadmins = users.filter((u) => u.is_superadmin);

  return (
    <div className="space-y-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Public signup</CardTitle>
          <CardDescription>
            When disabled, only invited or admin-created users can register — new self-service
            signups (including OAuth) are rejected at the database level.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={allowSignup}
              onCheckedChange={async (checked) => {
                const res = await updateSettings({
                  data: { access_token: token, allow_public_signup: checked },
                });
                if (!res.ok) return toast.error(res.error);
                setAllowSignup(checked);
                toast.success(checked ? "Public signup enabled" : "Instance is now invite-only");
              }}
            />
            Allow anyone to sign up
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Superadmins</CardTitle>
          <CardDescription>
            Manage superadmins from the Users tab. The account matching the{" "}
            <code className="text-xs">ADMIN_EMAIL</code> environment variable is always a superadmin
            and cannot be demoted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {superadmins.map((u) => (
            <div key={u.user_id} className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-primary" />
              {u.email}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
