// Public iframe embed: multi-agent task (swarm) at /embed/swarm/<key>.
// The visitor describes a task; the swarm's sanitized graph (labels +
// wiring only — no prompts, tools or KB config) orchestrates client-side,
// while every node call goes through /api/embed/chat where the server
// loads the real node config from the owner's stored swarm.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import { CheckCircle2, ChevronDown, Loader2, Network, Play, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { EmbedErrorCard, EmbedFooter } from "@/routes/embed.agent.$key";
import { resolveEmbed, getParentOrigin, type EmbedResolve } from "@/lib/embedClient";
import {
  runSwarm,
  setSwarmEmbedTransport,
  type SwarmNodeData,
  type SwarmRunEvent,
} from "@/lib/swarmRuntime";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/embed/swarm/$key")({
  head: () => ({ meta: [{ title: "Run task — AgentSwarms embed" }] }),
  validateSearch: (s: Record<string, unknown>) => ({
    preview: s.preview === "1" || s.preview === 1 ? ("1" as const) : undefined,
  }),
  component: EmbedSwarmPage,
});

type NodeState = {
  status: "idle" | "running" | "done" | "error" | "skipped";
  output: string;
  error?: string;
};

function EmbedSwarmPage() {
  const { key } = Route.useParams();
  const { preview } = Route.useSearch();
  const isPreview = preview === "1";
  const [cfg, setCfg] = useState<Extract<EmbedResolve, { type: "swarm" }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeState>>({});
  const [finalOutput, setFinalOutput] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    resolveEmbed(key, isPreview).then((r) => {
      if (!r.ok) setError(r.error);
      else if (r.data.type !== "swarm") setError("This embed key is not for a swarm.");
      else setCfg(r.data);
    });
    return () => setSwarmEmbedTransport(null);
  }, [key, isPreview]);

  const nodes = (cfg?.nodes ?? []) as unknown as Node<SwarmNodeData>[];
  const orderedIds = nodes.map((n) => n.id);

  function patchNode(id: string, patch: Partial<NodeState>) {
    setNodeStates((prev) => {
      const cur: NodeState = prev[id] ?? { status: "idle", output: "" };
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }

  async function run() {
    const input = task.trim();
    if (!input || running || !cfg) return;
    setRunning(true);
    setFinalOutput(null);
    setRunError(null);
    setNodeStates({});
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSwarmEmbedTransport({ key, parentOrigin: getParentOrigin() ?? undefined });
    try {
      await runSwarm(nodes, (cfg.edges ?? []) as unknown as Edge[], {
        initialInput: input,
        signal: ctrl.signal,
        onEvent: (e: SwarmRunEvent) => {
          switch (e.type) {
            case "node_start":
              patchNode(e.nodeId, { status: "running", output: "" });
              break;
            case "node_token":
              setNodeStates((prev) => {
                const cur = prev[e.nodeId] ?? { status: "running" as const, output: "" };
                return { ...prev, [e.nodeId]: { ...cur, output: cur.output + e.token } };
              });
              break;
            case "node_done":
              patchNode(e.nodeId, { status: "done", output: e.output });
              break;
            case "node_skipped":
              patchNode(e.nodeId, { status: "skipped" });
              break;
            case "node_error":
              patchNode(e.nodeId, { status: "error", error: e.error });
              break;
            case "run_done":
              setFinalOutput(e.finalOutput);
              break;
            case "run_error":
              setRunError(e.error);
              break;
            default:
              break;
          }
        },
      });
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setSwarmEmbedTransport(null);
      setRunning(false);
    }
  }

  if (error) return <EmbedErrorCard error={error} />;
  if (!cfg) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const agentNodes = nodes.filter((n) => {
    const k = (n.data as { kind?: string }).kind;
    return k !== "input" && k !== "output";
  });

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-full bg-primary/10 text-primary">
          <Network className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">{cfg.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {cfg.description || `Multi-agent task · ${agentNodes.length} steps`}
          </p>
        </div>
        {isPreview && (
          <span className="ml-auto rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
            Preview
          </span>
        )}
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div className="space-y-2">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
            placeholder="Describe the task for this multi-agent workflow…"
            className="w-full resize-none rounded-lg border border-border bg-background p-3 text-sm focus:border-primary focus:outline-none"
            disabled={running}
          />
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">
              {agentNodes.length} agents collaborate on your task.
            </p>
            {running ? (
              <Button size="sm" variant="outline" onClick={() => abortRef.current?.abort()}>
                Stop
              </Button>
            ) : (
              <Button size="sm" onClick={() => void run()} disabled={!task.trim()}>
                <Play className="mr-1 h-3.5 w-3.5" /> Run task
              </Button>
            )}
          </div>
        </div>

        {Object.keys(nodeStates).length > 0 && (
          <div className="space-y-1.5">
            {orderedIds
              .filter((id) => nodeStates[id])
              .map((id) => {
                const n = nodes.find((x) => x.id === id);
                const st = nodeStates[id];
                const label =
                  (n?.data as { label?: string; kind?: string } | undefined)?.label ?? id;
                const open = expanded[id] ?? false;
                return (
                  <div key={id} className="rounded-lg border border-border/60 bg-card">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left"
                      onClick={() => setExpanded((p) => ({ ...p, [id]: !open }))}
                    >
                      {st.status === "running" ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                      ) : st.status === "done" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      ) : st.status === "error" ? (
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
                      ) : (
                        <div className="h-3.5 w-3.5 shrink-0 rounded-full border border-border" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
                      <ChevronDown
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                          open && "rotate-180",
                        )}
                      />
                    </button>
                    {open && (
                      <div className="border-t border-border/40 px-3 py-2 text-xs">
                        {st.error ? (
                          <p className="text-rose-500">{st.error}</p>
                        ) : st.output ? (
                          <MarkdownMessage content={st.output.slice(0, 6000)} />
                        ) : (
                          <p className="text-muted-foreground">Waiting…</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}

        {runError && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            {runError}
          </p>
        )}

        {finalOutput && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
              Result
            </p>
            <div className="text-sm">
              <MarkdownMessage content={finalOutput} />
            </div>
          </div>
        )}
      </div>
      <EmbedFooter />
    </div>
  );
}
