// Configure per-viewer scoping on a dashboard embed.
//
// The thing being set up here is a shared secret between two servers, so the
// dialog's job is mostly to be clear about what the owner is taking on: the
// secret is shown once, the attribute names must match columns their widgets
// actually project, and a widget that does not project one will be WITHHELD
// from viewers rather than shown unfiltered. Each of those is a support
// ticket if it is discovered later instead of read here.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, Check, Copy, KeyRound, ShieldCheck } from "lucide-react";

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
import { Switch } from "@/components/ui/switch";
import { hostMintingSnippet } from "@/lib/embedViewerToken";
import { embedSetSignedViewer } from "@/utils/embedViewer.functions";

export type SignedViewerKey = {
  id: string;
  name: string;
  key: string;
  require_signed_viewer: boolean;
  viewer_attributes: string[];
};

export function SignedViewerDialog({
  embedKey,
  accessToken,
  onClose,
  onSaved,
}: {
  embedKey: SignedViewerKey | null;
  accessToken: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const setSignedViewer = useServerFn(embedSetSignedViewer);
  const [enabled, setEnabled] = useState(false);
  const [attrs, setAttrs] = useState("");
  const [regenerate, setRegenerate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (embedKey) {
      setEnabled(embedKey.require_signed_viewer);
      setAttrs((embedKey.viewer_attributes ?? []).join(", "));
      setRegenerate(false);
      setSecret(null);
    }
  }, [embedKey]);

  const parsed = attrs
    .split(/[,\s]+/)
    .map((a) => a.trim())
    .filter(Boolean);

  async function save() {
    if (!embedKey || !accessToken) return;
    setBusy(true);
    try {
      const res = await setSignedViewer({
        data: {
          accessToken,
          embedKeyId: embedKey.id,
          enabled,
          attributes: parsed,
          regenerate,
        },
      });
      // The secret is returned exactly once. Keep the dialog open showing it
      // — closing on save would lose the only copy that will ever exist.
      if (res.secret) setSecret(res.secret);
      else onClose();
      toast.success(enabled ? "Signed viewers required" : "Signed viewers turned off");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const snippet = embedKey
    ? hostMintingSnippet({
        origin: typeof window !== "undefined" ? window.location.origin : "",
        embedKey: embedKey.key,
        attributes: parsed.length > 0 ? parsed : ["tenant"],
      })
    : "";

  return (
    <Dialog open={embedKey !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> Signed viewers
          </DialogTitle>
          <DialogDescription>
            Serve one embedded dashboard to many customers, each seeing only their own rows. Your
            backend signs a short-lived token naming the viewer; we verify it and filter the data.
          </DialogDescription>
        </DialogHeader>

        {secret ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
                <KeyRound className="h-3.5 w-3.5" /> Copy this now — it is shown once
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                We store it encrypted and cannot show it again. Lose it and you generate a new one,
                which invalidates every token your backend has already issued.
              </p>
              <code className="mt-2 block break-all rounded border border-border/60 bg-background p-2 text-[11px]">
                {secret}
              </code>
            </div>
            <div>
              <Label className="text-xs">Mint tokens in your backend</Label>
              <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-border/60 bg-muted/40 p-3 text-[11px] leading-relaxed">
                {snippet}
              </pre>
            </div>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => {
                  void navigator.clipboard.writeText(`${secret}\n\n${snippet}`);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? (
                  <>
                    <Check className="mr-1.5 h-3.5 w-3.5" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy secret and snippet
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border border-border/60 p-3">
              <div className="pr-3">
                <p className="text-xs font-medium">Require a signed viewer</p>
                <p className="text-[11px] text-muted-foreground">
                  Without a valid token the embed is refused outright — never served the owner's
                  unfiltered view.
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Scope data by</Label>
              <Input
                value={attrs}
                onChange={(e) => setAttrs(e.target.value)}
                placeholder="tenant, region"
                className="h-9"
              />
              <p className="text-[11px] text-muted-foreground">
                Each name must match a column your widgets return, and every token must carry all of
                them — a token missing one is refused rather than shown everything. Several
                attributes narrow together: <code>tenant</code> and <code>region</code> means this
                tenant <em>in</em> this region.
              </p>
            </div>

            {enabled && (
              <div className="flex gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  A widget whose results do not include these columns cannot be limited to one
                  viewer — an aggregate like <code>sum(revenue) by month</code> already contains
                  every customer. Those widgets are <strong>withheld</strong>, with the reason shown
                  in their place. Add the column to the widget's query to bring it back.
                </p>
              </div>
            )}

            {embedKey?.require_signed_viewer && (
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={regenerate}
                  onChange={(e) => setRegenerate(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Generate a new signing secret (every token already issued stops working)
              </label>
            )}

            <Button className="w-full" onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
