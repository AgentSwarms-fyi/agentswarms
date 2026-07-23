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
      const data = await res.json().catch(() => ({}));
      if (res.ok) setSessions(data.sessions ?? []);
      else setSessions([]);
    } catch {
      setSessions([]);
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
    } finally {
      setBusy(null);
    }
  }

  // Nothing to show when the runtime is off or the user has no live kernels.
  if (!enabled || !sessions || sessions.length === 0) return null;

  return (
    <div className="mb-8 rounded-md border border-border bg-card/50 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Server className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">Running kernels</h2>
        <Badge variant="secondary" className="text-[10px]">
          {sessions.length} live
        </Badge>
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
      <ul className="space-y-1.5">
        {sessions.map((s) => (
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
