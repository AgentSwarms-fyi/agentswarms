// What each stream of a data source is doing, and how to make it start over.
//
// Incremental sync is invisible when it works, which is a problem the first
// time somebody asks why a sync returned forty rows. Two answers look
// identical from outside — "nothing changed since Tuesday" and "this has been
// broken since Tuesday" — so the high-water mark is shown rather than kept as
// an implementation detail.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { formatDistanceToNow } from "date-fns";
import { History, Loader2, RefreshCcwDot } from "lucide-react";
import { toast } from "sonner";

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
import { useAuth } from "@/hooks/use-auth";
import type { StreamState } from "@/utils/saas/types";
import { resetSaasCursor, saasStreamStates } from "@/utils/saas.functions";

export function StreamStateDialog({
  connectionId,
  connectionName,
  shared,
  open,
  onOpenChange,
}: {
  connectionId: string | null;
  connectionName: string;
  /** A grantee may look, but may not spend the owner's rate limit. */
  shared?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const statesFn = useServerFn(saasStreamStates);
  const resetFn = useServerFn(resetSaasCursor);

  const [states, setStates] = useState<StreamState[] | null>(null);
  // FOUND FROM THE UI. A failure used to land in `states = []`, which renders
  // as "no streams are selected" — a calm, wrong answer. "This source has
  // nothing selected" and "we could not read this source" are different
  // facts, and only one of them needs acting on.
  const [failed, setFailed] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !connectionId) return;
    setStates(null);
    setFailed(null);
    try {
      const res = await statesFn({ data: { access_token: token, id: connectionId } });
      setStates(res.states);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not read the sync state";
      toast.error(message);
      setFailed(message);
      setStates([]);
    }
  }, [statesFn, token, connectionId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const reset = async (stream?: string) => {
    if (!connectionId) return;
    setResetting(stream ?? "__all");
    try {
      const res = await resetFn({
        data: { access_token: token, id: connectionId, ...(stream ? { stream } : {}) },
      });
      toast.success(
        res.reset === 0
          ? "Nothing to reset — these streams are already read in full each time"
          : `${res.reset} stream${res.reset === 1 ? "" : "s"} will read from the beginning next sync`,
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reset");
    } finally {
      setResetting(null);
    }
  };

  const following = (states ?? []).filter((s) => s.mode === "incremental");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Streams in {connectionName}</DialogTitle>
          <DialogDescription>
            A stream that can be followed is read from where it got to last time. One that cannot is
            re-read in full on every sync.
          </DialogDescription>
        </DialogHeader>

        {states === null ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
            Reading sync state…
          </p>
        ) : failed ? (
          <p className="py-6 text-center text-sm text-destructive">{failed}</p>
        ) : states.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No streams are selected for this source yet.
          </p>
        ) : (
          <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
            {states.map((s) => (
              <div key={s.stream} className="rounded-md border px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{s.stream}</span>
                  <Badge
                    variant={s.mode === "incremental" ? "default" : "outline"}
                    className="text-[10px]"
                  >
                    {s.mode === "incremental" ? "Follows changes" : "Full refresh"}
                  </Badge>
                  {s.mode === "incremental" && !shared ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 gap-1 px-2 text-[10px]"
                      disabled={resetting !== null || !s.cursor}
                      onClick={() => void reset(s.stream)}
                      title={
                        s.cursor
                          ? "Forget the high-water mark and read this stream in full next sync"
                          : "Nothing to forget — this stream has not been followed yet"
                      }
                    >
                      <RefreshCcwDot className="h-3 w-3" />
                      {resetting === s.stream ? "Resetting…" : "Start over"}
                    </Button>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {s.mode === "full_refresh" ? (
                    <>Re-read in full each sync — this source offers nothing to follow.</>
                  ) : s.cursor ? (
                    <>
                      Caught up to <span className="font-mono">{s.cursor}</span>
                      {s.cursorField ? <> on {s.cursorField}</> : null}
                      {s.lastSyncedAt ? (
                        <>
                          {" · "}
                          {s.lastRowsSeen} row{s.lastRowsSeen === 1 ? "" : "s"}{" "}
                          {formatDistanceToNow(new Date(s.lastSyncedAt), { addSuffix: true })}
                        </>
                      ) : null}
                    </>
                  ) : (
                    <>Not followed yet — the first sync reads everything and sets the mark.</>
                  )}
                </p>
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <p className="text-[11px] text-muted-foreground">
            {shared
              ? "Shared source — starting over is the owner's to decide."
              : "Starting over re-reads the whole source against your API quota."}
          </p>
          <div className="flex gap-2">
            {!shared && following.some((s) => s.cursor) ? (
              <Button
                variant="outline"
                size="sm"
                disabled={resetting !== null}
                onClick={() => void reset()}
              >
                <History className="mr-1.5 h-3.5 w-3.5" />
                {resetting === "__all" ? "Resetting…" : "Start every stream over"}
              </Button>
            ) : null}
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
