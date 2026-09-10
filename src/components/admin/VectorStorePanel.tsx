// Where the knowledge base's vectors actually live, and whether that place is
// answering.
//
// Read-only on purpose: which store a deployment uses is an environment
// decision made before the app starts (VECTOR_STORE, QDRANT_URL), not a
// setting to toggle at runtime — switching stores mid-flight would leave half
// a knowledge base in each. What this page is for is telling an operator the
// truth about the choice already made: which store, is it up, and does it hold
// as many vectors as the database has chunks.
//
// That last comparison is the useful one. An external index can drift from the
// rows it indexes — a Qdrant restored from an empty volume, a store switched on
// after documents were already embedded — and the symptom is retrieval quietly
// getting worse rather than an error. Two numbers side by side make it obvious,
// and Re-index makes it go away.

import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Database, RefreshCw, Server } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { vectorStoreReindex, vectorStoreStatus } from "@/utils/vector/vector.functions";
import type { VectorStoreStatus } from "@/utils/vector/vector.functions";

/** A count that reads as a count, not as an exponent. */
const n = (v: number | undefined) => (typeof v === "number" ? v.toLocaleString() : "—");

export function VectorStorePanel({ token }: { token: string }) {
  const statusFn = useServerFn(vectorStoreStatus);
  const reindexFn = useServerFn(vectorStoreReindex);
  const [status, setStatus] = useState<VectorStoreStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await statusFn({ data: { access_token: token } });
      if ("ok" in res && res.ok === false) {
        setError(res.error);
        setStatus(null);
      } else {
        setStatus(res as VectorStoreStatus);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the vector store status");
    } finally {
      setBusy(false);
    }
  }, [statusFn, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const reindex = async () => {
    if (
      !(await confirmAsk({
        title: "Re-index every knowledge base?",
        body:
          "Every vector in the external store is dropped and written again from the chunks in " +
          "the database. Retrieval falls back to keyword search for the knowledge bases still " +
          "being written, and nothing is lost either way.",
        actionLabel: "Re-index",
      }))
    )
      return;
    setBusy(true);
    try {
      const res = await reindexFn({ data: { access_token: token } });
      if ("ok" in res && res.ok === false) {
        toast.error(res.error);
      } else if (res.skipped) {
        toast.info("pgvector needs no index — the vector is stored on the chunk row itself.");
      } else {
        toast.success(`Re-indexed ${res.indexed.toLocaleString()} vectors`);
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Re-index failed");
    } finally {
      setBusy(false);
    }
  };

  const info = status?.info;
  // Only meaningful for an external store: pgvector reports the same rows the
  // comparison is against, so it can never disagree with itself.
  const drifted =
    !!status?.external &&
    !!info?.ok &&
    typeof info.points === "number" &&
    info.points !== status.chunksInDatabase;

  return (
    <div className="space-y-3 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">Vector store</p>
          {status && (
            <Badge variant={status.external ? "default" : "secondary"} className="gap-1">
              {status.external ? <Server className="h-3 w-3" /> : <Database className="h-3 w-3" />}
              {status.selected}
            </Badge>
          )}
          {info &&
            (info.ok ? (
              <Badge variant="outline" className="gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                Reachable
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                Unreachable
              </Badge>
            ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          {status?.external && (
            <Button size="sm" variant="outline" onClick={() => void reindex()} disabled={busy}>
              Re-index
            </Button>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Where knowledge-base embeddings are searched. The default keeps them in Postgres beside the
        chunks they belong to; an external store gives the index its own RAM and its own scaling,
        instead of competing with every other query on the database. Either way the chunk text stays
        in Postgres — so keyword search is unaffected, an external index can always be rebuilt, and
        losing it degrades retrieval rather than breaking it.
      </p>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {info && !info.ok && info.error && (
        <p className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {info.error}
        </p>
      )}

      {status && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Chunks in Postgres" value={n(status.chunksInDatabase)} />
          <Stat
            label={status.external ? "Vectors in the store" : "Vectors"}
            value={status.external ? n(info?.points) : n(status.chunksInDatabase)}
            warn={drifted}
          />
          <Stat label="Dimensions" value={String(status.dims)} />
          <Stat
            label="Copies per vector"
            value={status.external ? (info?.replication ? String(info.replication) : "—") : "—"}
            hint={
              status.external
                ? "1 means a node that goes down takes its shard with it."
                : "Whatever your Postgres replication provides."
            }
          />
        </div>
      )}

      {status?.external && info?.endpoint && (
        <p className="text-[11px] text-muted-foreground">
          <span className="font-mono">{info.endpoint}</span>
          {info.version ? ` · v${info.version}` : ""}
        </p>
      )}

      {drifted && (
        <p className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
          The store holds a different number of vectors than the database has chunks. That is normal
          while a document is being embedded; if it persists, Re-index writes every chunk back.
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={`text-sm font-medium tabular-nums ${warn ? "text-amber-600 dark:text-amber-400" : ""}`}
      >
        {value}
      </p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
