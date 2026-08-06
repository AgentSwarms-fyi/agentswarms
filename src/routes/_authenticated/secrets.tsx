// Secrets Manager. Store credentials once, reference them anywhere a
// connection form accepts a value: {{secret:NAME}}. Values are encrypted
// server-side and write-only — they can be replaced but never viewed.
// Sharing is superadmin-controlled from /admin/iam → Access.
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { format } from "date-fns";
import { Check, Copy, KeyRound, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import {
  createSecret,
  deleteSecret,
  listSecrets,
  updateSecret,
  type SecretSummary,
} from "@/utils/secrets.functions";

export const Route = createFileRoute("/_authenticated/secrets")({
  head: () => ({
    meta: [{ title: "Secrets — AgentSwarms" }],
  }),
  component: SecretsPage,
});

function SecretsPage() {
  const { session } = useAuth();
  const token = session?.access_token;

  const listFn = useServerFn(listSecrets);
  const createFn = useServerFn(createSecret);
  const updateFn = useServerFn(updateSecret);
  const deleteFn = useServerFn(deleteSecret);

  const [secrets, setSecrets] = useState<SecretSummary[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [editTarget, setEditTarget] = useState<SecretSummary | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!token) return;
    listFn({ data: { access_token: token } }).then((res) => {
      if (res.ok) {
        setSecrets(res.secrets);
        setMe(res.me);
      } else {
        toast.error(res.error);
        setSecrets([]);
      }
    });
  }, [token, listFn]);

  useEffect(() => {
    reload();
  }, [reload]);

  const copyRef = (s: SecretSummary) => {
    void navigator.clipboard.writeText(`{{secret:${s.name}}}`);
    setCopiedId(s.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const submitCreate = async () => {
    if (!token) return;
    if (!name.trim()) return toast.error("Name is required");
    if (!value) return toast.error("Value is required");
    setBusy(true);
    try {
      const res = await createFn({
        data: {
          access_token: token,
          name: name.trim(),
          description: description.trim() || undefined,
          value,
        },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(`Secret created — reference it as {{secret:${name.trim()}}}`);
      setCreateOpen(false);
      setName("");
      setDescription("");
      setValue("");
      reload();
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async () => {
    if (!token || !editTarget) return;
    setBusy(true);
    try {
      const res = await updateFn({
        data: {
          access_token: token,
          secret_id: editTarget.id,
          description: editDescription,
          value: editValue || undefined,
        },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(editValue ? "Secret value replaced" : "Secret updated");
      setEditTarget(null);
      setEditValue("");
      reload();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: SecretSummary) => {
    if (!token) return;
    if (!window.confirm(`Delete secret ${s.name}? Anything referencing it will stop working.`))
      return;
    const res = await deleteFn({ data: { access_token: token, secret_id: s.id } });
    if (!res.ok) return toast.error(res.error);
    toast.success("Secret deleted");
    reload();
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Integrations
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight flex items-center gap-2">
            <KeyRound className="h-7 w-7 text-primary" /> Secrets
          </h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Store credentials once and reference them anywhere a connection form accepts a value —
            warehouse connections, provider API keys — as{" "}
            <code className="text-xs">{"{{secret:NAME}}"}</code>. Values are encrypted, resolved
            server-side at use time, and can never be viewed again.
          </p>
        </div>
        <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> New secret
        </Button>
      </div>

      <Card className="border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your secrets</CardTitle>
          <CardDescription>
            Sharing with other users or groups is managed by superadmins under Admin → IAM → Access.
            Shared secrets are usable in references but never readable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {secrets === null ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : secrets.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No secrets yet. Create one, then paste its reference into a warehouse connection or
              provider key field.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {secrets.map((s) => {
                  const mine = s.user_id === me;
                  return (
                    <TableRow key={s.id}>
                      <TableCell>
                        <button
                          type="button"
                          className="group inline-flex items-center gap-1.5 font-mono text-sm"
                          title="Copy reference"
                          onClick={() => copyRef(s)}
                        >
                          {`{{secret:${s.name}}}`}
                          {copiedId === s.id ? (
                            <Check className="h-3 w-3 text-emerald-500" />
                          ) : (
                            <Copy className="h-3 w-3 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-sm text-muted-foreground">
                        {s.description ?? "—"}
                      </TableCell>
                      <TableCell>
                        {mine ? (
                          <Badge variant="secondary" className="text-[10px]">
                            Yours
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            Shared with you
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(new Date(s.updated_at), "d MMM yyyy")}
                      </TableCell>
                      <TableCell>
                        {mine ? (
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0"
                              title="Replace value / edit description"
                              onClick={() => {
                                setEditTarget(s);
                                setEditDescription(s.description ?? "");
                                setEditValue("");
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                              title="Delete"
                              onClick={() => void remove(s)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New secret</DialogTitle>
            <DialogDescription>
              The value is encrypted on save and can be replaced later, but never viewed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="SNOWFLAKE_PROD_TOKEN"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Letters, digits, underscores. Referenced as{" "}
                <code>{`{{secret:${name.trim() || "NAME"}}}`}</code>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Description (optional)</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Value</Label>
              <Textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                rows={3}
                className="font-mono text-xs"
                placeholder="The API key / token / password to store"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitCreate} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create secret"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit / replace value */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit {editTarget?.name}</DialogTitle>
            <DialogDescription>
              Leave the value empty to keep the current one (it cannot be shown).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>New value (optional)</Label>
              <Textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                rows={3}
                className="font-mono text-xs"
                placeholder="••••••••  (unchanged if left empty)"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button onClick={submitEdit} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
