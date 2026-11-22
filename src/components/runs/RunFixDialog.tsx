// Why a run failed and, when the platform knows one, the change that fixes it
// (R525). The diagnosis is read when the dialog opens; the change is made only
// when its owner presses Apply, and the server checks it again first.
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FixTarget, FixVerdict } from "@/lib/runFixes";
import { applyRunFixFn, diagnoseRunFn } from "@/utils/runFixes.functions";

type State =
  { state: "reading" } | { state: "error"; message: string } | { state: "ok"; verdict: FixVerdict };

export function RunFixDialog({
  open,
  onOpenChange,
  target,
  name,
  onAskAssistant,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: FixTarget;
  name: string;
  onAskAssistant: () => void;
}) {
  const [s, setS] = useState<State>({ state: "reading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setS({ state: "reading" });
    diagnoseRunFn({ data: { target } })
      .then((r) => {
        if (!alive) return;
        setS(r.ok ? { state: "ok", verdict: r.verdict } : { state: "error", message: r.error });
      })
      .catch((e: unknown) => alive && setS({ state: "error", message: (e as Error).message }));
    return () => {
      alive = false;
    };
  }, [open, target.type, target.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const proposal = s.state === "ok" ? s.verdict.proposal : null;

  const apply = async () => {
    if (!proposal) return;
    setBusy(true);
    try {
      const res = await applyRunFixFn({ data: { target: proposal.target, fix: proposal.fix } });
      if (!res.ok) {
        toast.error("Nothing was changed", { description: res.error });
        return;
      }
      toast.success("Changed", { description: res.message });
      onOpenChange(false);
    } catch (e) {
      toast.error("Nothing was changed", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fix {name}</DialogTitle>
          <DialogDescription>
            {s.state === "reading"
              ? "Reading its recent runs…"
              : s.state === "error"
                ? `It could not be read: ${s.message}`
                : s.verdict.diagnosis}
          </DialogDescription>
        </DialogHeader>
        {proposal && (
          <section aria-label="Suggested fix" className="space-y-1 rounded-md border p-3 text-sm">
            <p className="font-medium">{proposal.title}</p>
            <p className="leading-6 text-muted-foreground">{proposal.why}</p>
            <p className="text-xs text-muted-foreground">{proposal.evidence}</p>
          </section>
        )}
        {s.state === "ok" && !proposal && (
          <p className="text-sm text-muted-foreground">
            There is no change to suggest for this one.
          </p>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          {!proposal && s.state !== "reading" && (
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                onAskAssistant();
              }}
            >
              Ask the assistant
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {proposal ? "Cancel" : "Close"}
          </Button>
          {proposal && (
            <Button onClick={apply} disabled={busy}>
              {busy ? "Changing…" : proposal.fix.fix === "pause" ? "Pause it" : "Apply"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
