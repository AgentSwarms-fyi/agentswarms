// Agent version history: browse snapshots, see exactly what changed between a
// version and the agent's current configuration, and roll back.
//
// Restoring first snapshots what it is about to replace (kind 'restore'), so a
// rollback is itself undoable — you can never lose the state you rolled back
// from by mistake.
import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { History, Loader2, RotateCcw, Save, Trash2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  diffSnapshots,
  snapshotAgentVersion,
  toSnapshot,
  FIELD_LABELS,
  type AgentConfigSnapshot,
  type AgentVersionRow,
} from "@/lib/agentVersions";

const KIND_STYLE: Record<string, string> = {
  auto: "bg-muted text-muted-foreground",
  manual: "bg-primary/10 text-primary",
  restore: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

export function AgentVersionsDialog({
  agentId,
  agentName,
  userId,
  open,
  onOpenChange,
  onRestored,
}: {
  agentId: string;
  agentName: string;
  userId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after a successful restore so the caller can refresh its list. */
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<AgentVersionRow[] | null>(null);
  const [current, setCurrent] = useState<AgentConfigSnapshot | null>(null);
  const [selected, setSelected] = useState<AgentVersionRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [{ data: rows }, { data: agent }] = await Promise.all([
      supabase
        .from("agent_versions")
        .select("id, label, kind, config, created_at")
        .eq("agent_id", agentId)
        .order("created_at", { ascending: false }),
      supabase.from("agents").select("*").eq("id", agentId).maybeSingle(),
    ]);
    const list = (rows ?? []) as unknown as AgentVersionRow[];
    setVersions(list);
    setCurrent(agent ? toSnapshot(agent as Record<string, unknown>) : null);
    setSelected((prev) =>
      prev ? (list.find((v) => v.id === prev.id) ?? null) : (list[0] ?? null),
    );
  }, [agentId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function saveNamedVersion() {
    if (!current) return;
    setBusy(true);
    try {
      await snapshotAgentVersion({
        agentId,
        userId,
        config: current,
        label: `Manual · ${new Date().toLocaleString()}`,
        kind: "manual",
      });
      await load();
      toast.success("Version saved");
    } finally {
      setBusy(false);
    }
  }

  async function restore(v: AgentVersionRow) {
    if (!current) return;
    setBusy(true);
    try {
      // Snapshot what we're replacing first, so this rollback can be undone.
      await snapshotAgentVersion({
        agentId,
        userId,
        config: current,
        label: `Before restoring "${v.label}"`,
        kind: "restore",
      });
      // `agents` columns that are NOT NULL in the schema type them as
      // `string | undefined` on update, so a null from an older snapshot has
      // to fall back rather than be written through.
      const { error } = await supabase
        .from("agents")
        .update({
          name: v.config.name,
          description: v.config.description,
          system_prompt: v.config.system_prompt,
          llm_provider: v.config.llm_provider ?? undefined,
          llm_model: v.config.llm_model ?? undefined,
          temperature: v.config.temperature ?? undefined,
          max_tokens: v.config.max_tokens ?? undefined,
          knowledge_base_id: v.config.knowledge_base_id,
          n8n_webhook_url: v.config.n8n_webhook_url,
          tools: v.config.tools as never,
        })
        .eq("id", agentId);
      if (error) throw error;
      toast.success(`Restored "${v.label}"`);
      await load();
      onRestored();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not restore this version");
    } finally {
      setBusy(false);
    }
  }

  async function removeVersion(id: string) {
    const { error } = await supabase.from("agent_versions").delete().eq("id", id);
    if (error) return toast.error("Could not delete the version");
    await load();
  }

  const diff = selected && current ? diffSnapshots(selected.config, current) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" /> Version history — {agentName}
          </DialogTitle>
          <DialogDescription>
            Every save snapshots the agent's configuration (saves that change nothing are skipped).
            Restoring first snapshots the current state, so a rollback is reversible.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4 overflow-hidden">
          {/* Version list */}
          <div className="w-64 shrink-0 space-y-2">
            <Button
              size="sm"
              variant="outline"
              className="w-full gap-1.5 text-xs"
              disabled={busy || !current}
              onClick={() => void saveNamedVersion()}
            >
              <Save className="h-3.5 w-3.5" /> Save current as version
            </Button>
            <ScrollArea className="h-[52vh] pr-2">
              {versions === null ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : versions.length === 0 ? (
                <p className="py-4 text-xs text-muted-foreground">
                  No versions yet — the next save will create one.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {versions.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setSelected(v)}
                      className={cn(
                        "w-full rounded-md border px-2.5 py-2 text-left transition",
                        selected?.id === v.id
                          ? "border-primary/50 bg-primary/5"
                          : "border-border/60 hover:bg-muted/50",
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">
                          {v.label}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn("px-1 text-[9px]", KIND_STYLE[v.kind])}
                        >
                          {v.kind}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {formatDistanceToNow(new Date(v.created_at), { addSuffix: true })}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Diff against current */}
          <div className="min-w-0 flex-1">
            {!selected ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Select a version to compare it with the current configuration.
              </p>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {diff.length === 0
                      ? "Identical to the current configuration."
                      : `${diff.length} field${diff.length === 1 ? "" : "s"} differ from current.`}
                  </p>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 text-xs"
                      disabled={busy || diff.length === 0}
                      onClick={() => void restore(selected)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Restore
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      disabled={busy}
                      onClick={() => void removeVersion(selected.id)}
                      title="Delete this version"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <ScrollArea className="h-[48vh] pr-2">
                  <div className="space-y-3">
                    {diff.map((d) => (
                      <div key={d.field} className="rounded-md border border-border/60">
                        <p className="border-b border-border/50 bg-muted/40 px-2.5 py-1.5 text-xs font-medium">
                          {FIELD_LABELS[d.field]}
                        </p>
                        <div className="grid grid-cols-2 divide-x divide-border/50">
                          <div className="p-2">
                            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                              This version
                            </p>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-amber-700 dark:text-amber-400">
                              {d.before || "—"}
                            </pre>
                          </div>
                          <div className="p-2">
                            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                              Current
                            </p>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
                              {d.after || "—"}
                            </pre>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
