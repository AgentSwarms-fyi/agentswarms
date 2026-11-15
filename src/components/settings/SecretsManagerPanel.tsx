// Secrets Manager, extracted from /secrets so Settings → API Keys can host
// the exact same create/edit/delete controls inline instead of linking out.
// Store credentials once, reference them anywhere a connection form accepts
// a value: {{secret:NAME}}. Values are encrypted server-side and write-only
// — they can be replaced but never viewed. Sharing is superadmin-controlled
// from /admin/iam → Access; where a shared secret may be SENT is the owner's
// call, made here as its allowed hosts (R419).
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { useCallback, useEffect, useState } from "react";
import { listClaim } from "@/lib/listClaim";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { format } from "date-fns";
import { Check, Copy, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  deleteSecret,
  listSecrets,
  updateSecret,
  type SecretSummary,
} from "@/utils/secrets.functions";
import { reportFailure } from "@/lib/silentFailureNet";
import { hostLines, parseAllowedHosts, sharedUseNote } from "@/lib/secretHosts";
import { AllowedHostsField, CreateSecretDialog } from "@/components/secrets/CreateSecretDialog";
import { refreshSecretList } from "@/hooks/use-secret-list";

/** The Secrets table's "Can be sent to" cell. */
function HostsCell({ hosts, mine }: { hosts: string[]; mine: boolean }) {
  if (hosts.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {mine ? "Only you" : "Nowhere yet: ask its owner"}
      </span>
    );
  }
  const shown = hosts.slice(0, 2);
  return (
    <span className="font-mono text-[11px]" title={sharedUseNote(hosts)}>
      {shown.join(", ")}
      {hosts.length > shown.length ? (
        <span className="text-muted-foreground"> +{hosts.length - shown.length} more</span>
      ) : null}
    </span>
  );
}

export function SecretsManagerPanel() {
  const { session } = useAuth();
  const token = session?.access_token;

  const listFn = useServerFn(listSecrets);
  const updateFn = useServerFn(updateSecret);
  const deleteFn = useServerFn(deleteSecret);

  const [secrets, setSecrets] = useState<SecretSummary[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editTarget, setEditTarget] = useState<SecretSummary | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editHosts, setEditHosts] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Why the list could not be read, or null. Held in state rather than only
  // raised in a toast: the toast is the one element guaranteed to be gone by
  // the time somebody reads the page, and what it leaves behind is an empty
  // table that says the account has no secrets.
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!token) return;
    setLoadError(null);
    listFn({ data: { access_token: token } })
      .then((res) => {
        if (res.ok) {
          setSecrets(res.secrets);
          setMe(res.me);
        } else {
          toast.error(res.error);
          setLoadError(res.error);
          setSecrets([]);
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : "Could not reach the server";
        toast.error(msg);
        setLoadError(msg);
        setSecrets([]);
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

  const submitEdit = async () => {
    if (!token || !editTarget) return;
    const allowed = parseAllowedHosts(hostLines(editHosts));
    if (!allowed.ok) return toast.error(allowed.error);
    setBusy(true);
    try {
      const res = await updateFn({
        data: {
          access_token: token,
          secret_id: editTarget.id,
          description: editDescription,
          value: editValue || undefined,
          allowed_hosts: allowed.hosts,
        },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(editValue ? "Secret value replaced" : "Secret updated");
      setEditTarget(null);
      setEditValue("");
      reload();
      // Its allowed hosts are what the pickers warn by.
      void refreshSecretList();
    } catch (e) {
      reportFailure("update the secret", e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: SecretSummary) => {
    if (!token) return;
    if (
      !(await confirmAsk({
        title: `Delete secret ${s.name}? Anything referencing it will stop working.`,
      }))
    )
      return;
    const res = await deleteFn({ data: { access_token: token, secret_id: s.id } });
    if (!res.ok) return toast.error(res.error);
    toast.success("Secret deleted");
    reload();
    void refreshSecretList();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs text-muted-foreground">
          Store credentials once, then pick them by name from the key fields of connection forms —
          warehouse connections, provider API keys, swarm HTTP headers — which also offer{" "}
          <span className="font-medium">New secret</span> in place. A field stores the reference{" "}
          <code className="text-[11px]">{"{{secret:NAME}}"}</code>, never the value. Values are
          encrypted, resolved server-side at use time, and can never be viewed again. A secret
          shared with a colleague goes only to the hosts you allow.
        </p>
        <Button size="sm" className="shrink-0 gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> New secret
        </Button>
      </div>

      {secrets === null && !loadError ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : listClaim({
          loaded: secrets !== null,
          error: loadError,
          count: secrets?.length ?? 0,
        }).message === "error" ? (
        <div role="alert" className="py-6 text-center text-sm">
          <p className="text-warning">Your secrets could not be loaded — {loadError}.</p>
          <p className="mt-1 text-muted-foreground">
            Any secrets you have saved are still there; this just cannot list them right now.
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => reload()}>
            Try again
          </Button>
        </div>
      ) : secrets!.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
          No secrets yet. Create one here, or with New secret in any key field&apos;s list, then
          pick it by name.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Can be sent to</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {secrets!.map((s) => {
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
                    <TableCell className="max-w-56">
                      <HostsCell hosts={s.allowed_hosts ?? []} mine={mine} />
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
                            title="Replace value / edit description and allowed hosts"
                            onClick={() => {
                              setEditTarget(s);
                              setEditDescription(s.description ?? "");
                              setEditHosts((s.allowed_hosts ?? []).join("\n"));
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
        </div>
      )}

      {/* Create: the same form a secret picker opens in place (R493). */}
      <CreateSecretDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          reload();
          // Every secret picker on the page lists it too.
          void refreshSecretList();
        }}
      />

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
            <AllowedHostsField value={editHosts} onChange={setEditHosts} />
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
