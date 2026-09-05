// The model card of a version, assembled from the registry rows: shown as
// Markdown with copy and download, never edited by hand.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, Copy, Download, FileText, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { mlModelCard } from "@/utils/mlOps.functions";

export function ModelCardDialog({
  open,
  onOpenChange,
  token,
  modelId,
  modelName,
  versionId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  token: string;
  modelId: string;
  modelName: string;
  versionId?: string;
}) {
  const cardFn = useServerFn(mlModelCard);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !token) return;
    setMarkdown(null);
    setError(null);
    cardFn({
      data: {
        access_token: token,
        model_id: modelId,
        version_id: versionId,
        origin: typeof window !== "undefined" ? window.location.origin : undefined,
      },
    })
      .then((r) => {
        if (!r.ok) return setError(r.error);
        setMarkdown(r.markdown);
        setVersion(r.version);
      })
      .catch((e) => setError((e as Error).message));
  }, [open, token, modelId, versionId, cardFn]);

  const fileName = `${modelName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v${version ?? "x"}-model-card.md`;

  function download() {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" /> Model card
            {version ? (
              <span className="text-sm font-normal text-muted-foreground">v{version}</span>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            What this version is, what it learned from, how it does, what it relies on and how it is
            governed — assembled from the registry, so it cannot drift from what shipped.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="rounded-md bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : markdown === null ? (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Assembling…
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(markdown);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                  toast.success("Model card copied as Markdown");
                }}
              >
                {copied ? (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                )}
                Copy Markdown
              </Button>
              <Button size="sm" variant="outline" onClick={download}>
                <Download className="mr-1.5 h-3.5 w-3.5" /> Download {fileName}
              </Button>
            </div>
            <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 font-mono text-[11px] leading-relaxed">
              {markdown}
            </pre>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
