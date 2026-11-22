// The owner hides personal columns from everyone a dataset is shared with
// (R521). The same server action an approved suggestion runs.
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SENSITIVE_LABEL, type SensitiveFinding } from "@/lib/sensitiveData";
import { hideColumnsFromSharesFn } from "@/utils/sensitiveData.functions";

export function HideColumnsDialog({
  open,
  onOpenChange,
  datasetId,
  datasetName,
  readable,
  grants,
  onHidden,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasetId: string;
  datasetName: string;
  /** Personal columns at least one grant can still read, with how many can. */
  readable: Array<{ finding: SensitiveFinding; readers: number }>;
  grants: number;
  onHidden: () => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Every column starts chosen each time the dialog opens; only then, so a
  // re-render while it is open never undoes what the owner unticked.
  useEffect(() => {
    if (open) setChosen(new Set(readable.map((r) => r.finding.column)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (column: string, on: boolean) =>
    setChosen((s) => {
      const next = new Set(s);
      if (on) next.add(column);
      else next.delete(column);
      return next;
    });

  const hide = async () => {
    setBusy(true);
    try {
      const res = await hideColumnsFromSharesFn({
        data: { datasetId, columns: [...chosen] },
      });
      if (!res.ok) {
        toast.error("Nothing was hidden", { description: res.error });
        return;
      }
      toast.success(`Hidden in ${datasetName}`, {
        description:
          res.changed === 0
            ? "Every grant already hid them."
            : `${res.columns.join(", ")} ${res.columns.length === 1 ? "is" : "are"} hidden from ${res.changed} grant${res.changed === 1 ? "" : "s"}.`,
      });
      onOpenChange(false);
      onHidden();
    } catch (e) {
      toast.error("Nothing was hidden", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Hide personal data from its shares</DialogTitle>
          <DialogDescription>
            The columns you choose are hidden from{" "}
            {grants === 1 ? "the grant that shares" : `all ${grants} grants that share`}{" "}
            {datasetName}. People it is shared with stop seeing them wherever they read it. You
            still see everything, and an administrator can show them again under Admin → IAM →
            Access.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2" aria-label="Columns to hide">
          {readable.map(({ finding: f, readers }) => (
            <li key={f.column} className="flex items-start gap-3 rounded-md border p-3">
              <Checkbox
                id={`hide-${f.column}`}
                checked={chosen.has(f.column)}
                onCheckedChange={(v) => toggle(f.column, v === true)}
                className="mt-0.5"
              />
              <label htmlFor={`hide-${f.column}`} className="min-w-0 flex-1 text-sm leading-5">
                <span className="font-medium">{f.column}</span>
                <span className="text-muted-foreground"> · {SENSITIVE_LABEL[f.kind]}</span>
                <span className="block text-xs text-muted-foreground">
                  {f.evidence} Readable by {readers} of {grants} grant{grants === 1 ? "" : "s"}.
                </span>
              </label>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={hide} disabled={busy || chosen.size === 0}>
            {busy ? "Hiding…" : chosen.size === 1 ? "Hide 1 column" : `Hide ${chosen.size} columns`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
