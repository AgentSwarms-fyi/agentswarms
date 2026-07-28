// Publish a notebook as a callable API: mint, list and revoke its keys.
//
// The plaintext key is returned exactly once by create and is never recoverable
// afterwards — so it is shown here, prominently, with a copy button, and the
// dialog says so rather than letting someone close it and lose the key.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  nbApiKeyCreate,
  nbApiKeyRevoke,
  nbApiKeysList,
  type NbApiKeyRow,
} from "@/utils/notebookApiKeys.functions";

function CopyRow({ text, mono = true }: { text: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code
        className={`min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1.5 text-[11px] ${mono ? "font-mono" : ""}`}
      >
        {text}
      </code>
      <Button
        size="sm"
        variant="secondary"
        className="h-7 shrink-0 gap-1 text-xs"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export function PublishNotebookDialog({
  open,
  onOpenChange,
  notebookId,
  token,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  notebookId: string;
  token: string;
}) {
  const listFn = useServerFn(nbApiKeysList);
  const createFn = useServerFn(nbApiKeyCreate);
  const revokeFn = useServerFn(nbApiKeyRevoke);

  const [keys, setKeys] = useState<NbApiKeyRow[] | null>(null);
  const [name, setName] = useState("");
  const [entrypoint, setEntrypoint] = useState("entrypoint");
  const [busy, setBusy] = useState(false);
  // Held only until the dialog closes — it cannot be fetched again.
  const [fresh, setFresh] = useState<string | null>(null);

  const load = useCallback(() => {
    listFn({ data: { access_token: token, notebook_id: notebookId } }).then((res) => {
      if (!res.ok) return toast.error(res.error);
      setKeys(res.keys);
    });
  }, [listFn, notebookId, token]);

  useEffect(() => {
    if (open) {
      setFresh(null);
      load();
    }
  }, [open, load]);

  async function create() {
    if (!name.trim()) return toast.error("Give the key a name");
    setBusy(true);
    try {
      const res = await createFn({
        data: {
          access_token: token,
          notebook_id: notebookId,
          name: name.trim(),
          entrypoint: entrypoint.trim(),
        },
      });
      if (!res.ok) return toast.error(res.error);
      setFresh(res.key);
      setName("");
      load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    const res = await revokeFn({ data: { access_token: token, notebook_id: notebookId, id } });
    if (!res.ok) return toast.error(res.error);
    toast.success("Key revoked");
    load();
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-instance";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* DialogContent is a grid, and grid items default to min-width:auto — so
          the long curl line stretched the dialog instead of scrolling inside
          it. [&>*]:min-w-0 lets each section shrink; max-h keeps a dialog with
          a fresh key, the form and a key list from running off a short screen. */}
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" /> Publish as an API
          </DialogTitle>
          <DialogDescription>
            Your own systems can POST inputs to this notebook and get its return value back. It runs
            on the same governed batch kernel as a manual run.
          </DialogDescription>
        </DialogHeader>

        {fresh && (
          <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-xs font-medium">
              Copy this key now — it is stored hashed and cannot be shown again.
            </p>
            <CopyRow text={fresh} />
          </div>
        )}

        <div className="space-y-3 rounded-lg border border-border/60 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Key name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nightly summariser"
                className="h-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Entrypoint function</Label>
              <Input
                value={entrypoint}
                onChange={(e) => setEntrypoint(e.target.value)}
                placeholder="entrypoint"
                className="h-8"
              />
              <p className="text-[10px] text-muted-foreground">
                Called with the request body. Leave empty to run the notebook top to bottom.
              </p>
            </div>
          </div>
          <Button size="sm" onClick={create} disabled={busy} className="gap-1.5">
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Create key
          </Button>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">How to call it</p>
          <CopyRow
            mono={false}
            text={`curl -X POST ${origin}/api/notebook/run -H "Authorization: Bearer nbk_…" -H "Content-Type: application/json" -d '{"inputs":{"date":"2026-07-28"}}'`}
          />
          <p className="break-words text-[10px] text-muted-foreground">
            Add <code>&quot;async&quot;: true</code> to return immediately with a <code>runId</code>
            , then poll <code>/api/notebook/run/status</code>.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Keys</p>
          {keys === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : keys.length === 0 ? (
            <p className="text-xs text-muted-foreground">No keys yet.</p>
          ) : (
            <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
              {keys.map((k) => (
                <li key={k.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{k.name}</p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {k.key_prefix}… · {k.entrypoint || "whole notebook"} · {k.use_count} run
                      {k.use_count === 1 ? "" : "s"}
                      {k.last_used_at
                        ? ` · last ${new Date(k.last_used_at).toLocaleDateString()}`
                        : " · never used"}
                    </p>
                  </div>
                  {k.revoked_at ? (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      Revoked
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 gap-1 text-xs text-destructive"
                      onClick={() => revoke(k.id)}
                    >
                      <Trash2 className="h-3 w-3" /> Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
