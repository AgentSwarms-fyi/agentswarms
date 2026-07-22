// Version history for a saved swarm: list snapshots, capture the current graph
// as a named version, restore a past version (into the canvas), or delete one.
import { useCallback, useEffect, useState } from "react";
import type { Node, Edge } from "@xyflow/react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { snapshotSwarmVersion, type SwarmVersionKind } from "@/lib/swarmVersions";
import type { SwarmNodeData } from "@/lib/swarmRuntime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { History, RotateCcw, Trash2, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

type VersionRow = {
  id: string;
  label: string;
  kind: string;
  node_count: number;
  created_at: string;
  nodes: unknown;
  edges: unknown;
};

const KIND_LABEL: Record<string, string> = {
  auto: "autosave",
  manual: "saved",
  restore: "pre-restore",
};

export function SwarmVersionsDialog({
  swarmId,
  swarmName,
  nodes,
  edges,
  open,
  onOpenChange,
  onRestore,
}: {
  swarmId: string | null;
  swarmName: string;
  nodes: Node<SwarmNodeData>[];
  edges: Edge[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onRestore: (nodes: Node<SwarmNodeData>[], edges: Edge[]) => void | Promise<void>;
}) {
  const { user } = useAuth();
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!swarmId) return;
    setLoading(true);
    const { data } = await supabase
      .from("swarm_versions")
      .select("id, label, kind, node_count, created_at, nodes, edges")
      .eq("swarm_id", swarmId)
      .order("created_at", { ascending: false });
    setVersions((data ?? []) as VersionRow[]);
    setLoading(false);
  }, [swarmId]);

  useEffect(() => {
    if (open && swarmId) void load();
  }, [open, swarmId, load]);

  const saveVersion = async () => {
    if (!swarmId || !user) return;
    setSaving(true);
    await snapshotSwarmVersion({
      swarmId,
      userId: user.id,
      nodes,
      edges,
      label: label.trim() || `Version ${new Date().toLocaleString()}`,
      kind: "manual",
    });
    setSaving(false);
    setLabel("");
    await load();
    toast.success("Version saved");
  };

  const restore = async (v: VersionRow) => {
    const vNodes = (Array.isArray(v.nodes) ? v.nodes : []) as Node<SwarmNodeData>[];
    const vEdges = (Array.isArray(v.edges) ? v.edges : []) as Edge[];
    await onRestore(vNodes, vEdges);
    await load(); // a pre-restore safety snapshot was just added
    onOpenChange(false);
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("swarm_versions").delete().eq("id", id);
    if (error) return toast.error("Could not delete version");
    setVersions((prev) => prev.filter((v) => v.id !== id));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[82vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-primary" /> History — “{swarmName}”
          </DialogTitle>
          <DialogDescription className="text-xs">
            Snapshots are captured automatically on Save. Restore rolls the canvas back to a
            snapshot (your current graph is saved first, so it&apos;s undoable).
          </DialogDescription>
        </DialogHeader>

        {!swarmId ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            Save this swarm first to start tracking versions.
          </div>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Name this version (optional)"
                  className="h-8 text-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveVersion();
                  }}
                />
              </div>
              <Button size="sm" className="h-8" onClick={saveVersion} disabled={saving}>
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                )}
                Save version
              </Button>
            </div>

            <ScrollArea className="flex-1 -mx-1 mt-1">
              <div className="px-1 space-y-1.5">
                {loading ? (
                  <p className="text-xs text-muted-foreground py-3">Loading…</p>
                ) : versions.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-3">
                    No versions yet — Save the swarm or capture one above.
                  </p>
                ) : (
                  versions.map((v) => (
                    <div
                      key={v.id}
                      className="flex items-center gap-2 rounded-md border border-border/50 bg-card px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium truncate">{v.label}</p>
                          <Badge variant="outline" className="text-[9px] shrink-0">
                            {KIND_LABEL[v.kind] ?? v.kind}
                          </Badge>
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          {v.node_count} node{v.node_count === 1 ? "" : "s"} ·{" "}
                          {new Date(v.created_at).toLocaleString()}
                        </p>
                      </div>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm" className="h-7 text-xs shrink-0">
                            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Restore
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Restore “{v.label}”?</AlertDialogTitle>
                            <AlertDialogDescription>
                              The canvas will be replaced with this snapshot ({v.node_count} node
                              {v.node_count === 1 ? "" : "s"}). Your current graph is saved as a
                              snapshot first, so you can restore back. You&apos;ll still need to hit
                              Save to persist the change.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void restore(v)}>
                              Restore
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => void remove(v.id)}
                        title="Delete version"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
