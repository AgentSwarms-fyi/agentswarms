// Somebody else has to say yes before a version serves production.
//
// Off by default, because most models do not need it and a gate nobody asked
// for is a gate people route around. When it is on, the Promote button stops
// promoting and starts asking — and the copy says so before you press it,
// rather than surprising you with a toast afterwards.
//
// The one rule the UI cannot let you configure away: you may not approve your
// own promotion. Naming only yourself is refused at save, because a gate that
// looks like a review but is not produces an audit trail that lies.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, ShieldCheck, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { mlPendingPromotions, mlSetPromotionApprovers } from "@/utils/ml.functions";

export function PromotionGate({
  token,
  modelId,
  shared,
  onChanged,
}: {
  token: string;
  modelId: string;
  shared: boolean;
  /** The versions list shows a waiting badge, so it reloads with this. */
  onChanged?: () => void;
}) {
  const listFn = useServerFn(mlPendingPromotions);
  const setFn = useServerFn(mlSetPromotionApprovers);

  const [approvers, setApprovers] = useState<string[]>([]);
  const [pending, setPending] = useState<{ version_id: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    const res = await listFn({ data: { access_token: token, model_id: modelId } });
    setApprovers(res.approvers);
    setPending(res.pending);
    setDraft(res.approvers.join(", "));
  }, [listFn, token, modelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (emails: string[]) => {
    setBusy(true);
    const res = await setFn({
      data: { access_token: token, model_id: modelId, approver_emails: emails },
    });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(emails.length ? "Promotion needs approval now" : "Promotion is ungated again");
    setEditing(false);
    void load();
    onChanged?.();
  };

  const turnOff = async () => {
    if (
      !(await confirmAsk({
        title: "Let anyone with write access promote again?",
        body: "Versions will go into production the moment an owner presses Promote, with no second signature. Approvals already recorded are kept.",
        actionLabel: "Remove the gate",
      }))
    )
      return;
    await save([]);
  };

  if (shared && !approvers.length) return null;

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="h-4 w-4" /> Who signs off a promotion
            </h3>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              {approvers.length
                ? "Promote raises a request instead of promoting. The version keeps serving whatever it serves now until one of these people agrees."
                : "Anyone with write access can put a version into production on their own. Name the people who must agree first, and Promote starts asking instead."}
            </p>
          </div>
          {!shared && !editing && (
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                {approvers.length ? "Change" : "Require approval"}
              </Button>
              {approvers.length > 0 && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={turnOff}>
                  <X className="mr-1 h-3 w-3" /> Remove
                </Button>
              )}
            </div>
          )}
        </div>

        {approvers.length > 0 && !editing && (
          <div className="flex flex-wrap gap-1.5">
            {approvers.map((a) => (
              <Badge key={a} variant="secondary" className="font-normal">
                {a}
              </Badge>
            ))}
          </div>
        )}

        {editing && (
          <div className="space-y-2">
            <Label className="text-xs">Approvers, by email</Label>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="someone@example.com, someone-else@example.com"
            />
            <p className="text-[11px] text-muted-foreground">
              Comma separated. <strong>Not you</strong> — nobody may approve their own promotion, so
              naming only yourself is refused rather than quietly accepted.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void save(
                    draft
                      .split(",")
                      .map((e) => e.trim())
                      .filter(Boolean),
                  )
                }
              >
                {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null} Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {pending.length > 0 && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-xs">
            <strong>{pending.length}</strong> promotion
            {pending.length === 1 ? " is" : "s are"} waiting on a decision. Approvers will find
            {pending.length === 1 ? " it" : " them"} under <strong>Pending approvals</strong> in the
            header.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
