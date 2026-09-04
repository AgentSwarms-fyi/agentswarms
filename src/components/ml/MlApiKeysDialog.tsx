// Publish a model as an API: mint, list and revoke its keys.
//
// The plaintext key is returned exactly once by create and is never
// recoverable afterwards, so it is shown here, prominently, with a copy
// button, and the dialog says so rather than letting someone close it and
// lose the key. Same arrangement as a notebook's publish dialog.
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { listClaim } from "@/lib/listClaim";
import { ML_KEY_SCOPES, type MlKeyScope } from "@/utils/mlApiKeys";
import {
  mlApiKeyCreate,
  mlApiKeyRevoke,
  mlApiKeysList,
  type MlApiKeyRow,
} from "@/utils/mlApiKeys.functions";

const SCOPE_BLURB: Record<MlKeyScope, string> = {
  predict: "score rows, start batch runs",
  train: "train a version, register an external one",
  read: "list the model, poll jobs and runs",
};

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

export function MlApiKeysDialog({
  open,
  onOpenChange,
  modelId,
  token,
  exampleRow,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  modelId: string;
  token: string;
  /** A row shaped like the feature schema, for the curl example. */
  exampleRow: Record<string, unknown>;
}) {
  const listFn = useServerFn(mlApiKeysList);
  const createFn = useServerFn(mlApiKeyCreate);
  const revokeFn = useServerFn(mlApiKeyRevoke);

  const [keys, setKeys] = useState<MlApiKeyRow[] | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<MlKeyScope>>(new Set(["predict", "read"]));
  const [busy, setBusy] = useState(false);
  // Held only until the dialog closes — it cannot be fetched again.
  const [fresh, setFresh] = useState<string | null>(null);

  const load = useCallback(() => {
    listFn({ data: { access_token: token, model_id: modelId } }).then((res) => {
      if (!res.ok) {
        setKeysError(res.error);
        return toast.error(res.error);
      }
      setKeysError(null);
      setKeys(res.keys);
    });
  }, [listFn, modelId, token]);

  useEffect(() => {
    if (open) {
      setFresh(null);
      load();
    }
  }, [open, load]);

  const keysClaim = listClaim({
    loaded: keys !== null,
    error: keysError,
    count: keys?.length ?? 0,
  });

  async function create() {
    if (!name.trim()) return toast.error("Give the key a name");
    if (!scopes.size) return toast.error("Pick at least one scope");
    setBusy(true);
    try {
      const res = await createFn({
        data: { access_token: token, model_id: modelId, name: name.trim(), scopes: [...scopes] },
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
    const res = await revokeFn({ data: { access_token: token, model_id: modelId, id } });
    if (!res.ok) return toast.error(res.error);
    toast.success("Key revoked");
    load();
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-instance";
  const example = JSON.stringify({ rows: [exampleRow] });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" /> Publish as an API
          </DialogTitle>
          <DialogDescription>
            Your own systems can score rows, start batch runs and train new versions of this model
            over HTTPS. Every call runs on the same service as the app, with the same limits and
            audit trail, and is attributed to its key.
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
                placeholder="Checkout service"
                className="h-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Scopes</Label>
              <div className="space-y-1">
                {ML_KEY_SCOPES.map((s) => (
                  <label key={s} className="flex cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={scopes.has(s)}
                      onChange={(e) =>
                        setScopes((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(s);
                          else next.delete(s);
                          return next;
                        })
                      }
                    />
                    <span className="font-mono">{s}</span>
                    <span className="text-muted-foreground">· {SCOPE_BLURB[s]}</span>
                  </label>
                ))}
              </div>
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
            text={`curl -X POST ${origin}/api/ml/predict -H "Authorization: Bearer mlk_…" -H "Content-Type: application/json" -d '${example}'`}
          />
          <p className="break-words text-[10px] text-muted-foreground">
            <code>/api/ml/predict/batch</code> scores a lakehouse table, <code>/api/ml/train</code>{" "}
            starts a version, <code>/api/ml/models</code> lists what the key can see. The ML Models
            guide documents every endpoint.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Keys</p>
          {keysClaim.message === "error" ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              Could not list this model&apos;s keys — {keysError} Any keys that exist are still
              active; this is not a list of none.
            </p>
          ) : keys === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : keysClaim.message === "empty" ? (
            <p className="text-xs text-muted-foreground">No keys yet.</p>
          ) : (
            <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
              {keys.map((k) => (
                <li key={k.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{k.name}</p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {k.key_prefix}… · {k.scopes.join(", ")} · {k.use_count} call
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
