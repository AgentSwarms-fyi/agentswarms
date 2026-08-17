// "Running kernels" — lets a user see their live server-runtime sessions and
// stop them. Without this there was no way to free a concurrency slot from the
// UI: a kernel left running (or one that died with its row still marked live)
// would block new sessions with "you already have the maximum of N".
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw, Server, Square } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { kernelPanelState } from "@/lib/kernelPanelState";

type Session = {
  id: string;
  kind: string;
  status: string;
  notebook_id: string | null;
  notebook_title: string | null;
  started_at: string | null;
  created_at: string;
};

export function RunningKernels({ enabled }: { enabled: boolean }) {
  const { session } = useAuth();
  const token = session?.access_token;
  const [sessions, setSessions] = useState<Session[] | null>(null);
  /**
   * Why the list could not be read.
   *
   * MEASURED: a 503 from /api/notebook/runtime used to set `sessions` to `[]`,
   * and the render below hides the whole panel on an empty list — so an
   * unreachable runtime looked EXACTLY like "you have no kernels running".
   * That is the one situation this panel exists for: you were refused a new
   * kernel with "you already have the maximum of N", you came here to free a
   * slot, and the page told you there was nothing to free. Worse, the Refresh
   * button lives inside the hidden panel, so there was no way to retry either.
   */
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!token || !enabled) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/notebook/runtime", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "list" }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        sessions?: Session[];
        error?: string;
        message?: string;
      };
      if (res.ok) {
        setSessions(data.sessions ?? []);
        setError(null);
      } else {
        // Keep whatever was last known rather than replacing it with an empty
        // list: a stale list is at least true of some moment, and "" is not.
        setError(data.message || data.error || `The runtime replied ${res.status}.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The runtime could not be reached.");
    } finally {
      setRefreshing(false);
    }
  }, [token, enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  async function stop(id: string) {
    if (!token) return;
    setBusy(id);
    try {
      const res = await fetch("/api/notebook/runtime", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "stop", sessionId: id }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        return toast.error(d.message || d.error || "Failed to stop the kernel");
      }
      toast.success("Kernel stopped");
      await load();
    } catch (e) {
      // Without this the throw escaped as an unhandled rejection: the spinner
      // stopped (finally still ran) and NOTHING was said, so a failed stop was
      // indistinguishable from one that worked until the list failed to change.
      toast.error(e instanceof Error ? e.message : "Failed to stop the kernel");
    } finally {
      setBusy(null);
    }
  }

  // Whether this panel may say anything, and what — see lib/kernelPanelState.
  const panel = kernelPanelState({ enabled, sessions, error });
  if (!panel.visible) return null;

  return (
    <div className="mb-8 rounded-md border border-border bg-card/50 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Server className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">Running kernels</h2>
        {/* The count is only a fact when the runtime answered. While it is
            unreachable, "0 live" would be the very claim this cannot make. */}
        {panel.liveCount === null ? (
          <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive">
            unknown
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px]">
            {panel.liveCount} live
          </Badge>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 gap-1 text-xs"
          onClick={() => void load()}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Server kernels keep running until they idle out. Stop one to free a slot if you hit the
        per-user limit.
      </p>
      {panel.showError && (
        // Says which question is unanswered, not just that something broke.
        // "You may still have kernels running" is the part that matters when
        // the reason you are here is being told you are at the limit.
        <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          Could not read your running kernels — {error} You may still have kernels running; this
          list is not proof that you do not.
        </p>
      )}
      <ul className="space-y-1.5">
        {(sessions ?? []).map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center gap-2 rounded border border-border/50 px-2.5 py-2 text-sm"
          >
            <Badge
              variant="outline"
              className={
                s.status === "ready" || s.status === "running"
                  ? "border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-400"
                  : "text-[10px]"
              }
            >
              {s.status}
            </Badge>
            {s.kind === "batch" && (
              <Badge variant="secondary" className="text-[10px]">
                batch
              </Badge>
            )}
            <span className="min-w-0 truncate">
              {s.notebook_title ?? <span className="text-muted-foreground">Scratch session</span>}
            </span>
            <span className="text-[11px] text-muted-foreground">
              started {new Date(s.started_at ?? s.created_at).toLocaleTimeString()}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-7 gap-1 text-xs"
              onClick={() => void stop(s.id)}
              disabled={busy === s.id}
            >
              {busy === s.id ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Square className="h-3 w-3" />
              )}
              Stop
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
