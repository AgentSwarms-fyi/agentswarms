// "Starting the SQL engine…" — what the user sees while DuckDB-Wasm loads.
//
// The first local query in a session downloads ~8 MB of compressed
// WebAssembly. That is a one-off (the browser caches it afterwards), but
// without a signal a Run button just sits there and the honest reading is
// "this is broken". duckdb-wasm reports real bytes, so this is a progress
// bar rather than an indeterminate spinner.
//
// One component for every surface — workbench, BI, prep — so the wording and
// the threshold for showing anything are defined once.
import { useEffect, useState } from "react";
import { AlertTriangle, Database, Loader2 } from "lucide-react";

import { browserEngineStatus, onBrowserEngineStatus } from "@/lib/browserDuckdb";
import type { EngineStatus } from "@/lib/browserDuckdb";

/** Subscribe a component to engine status. */
export function useSqlEngineStatus(): EngineStatus {
  const [status, setStatus] = useState<EngineStatus>(browserEngineStatus);
  useEffect(() => onBrowserEngineStatus(setStatus), []);
  return status;
}

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * A one-line status strip. Renders NOTHING when the engine is ready or has not
 * been asked for anything yet — a permanent "engine: ok" badge is noise, and
 * the interesting states are the two nobody can otherwise explain.
 */
export function SqlEngineStatus({ className = "" }: { className?: string }) {
  const status = useSqlEngineStatus();

  if (status.phase === "idle" || status.phase === "ready") return null;

  if (status.phase === "error") {
    return (
      <div
        className={`flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive ${className}`}
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <p className="font-medium">The SQL engine could not load.</p>
          <p className="mt-0.5 opacity-90">
            {status.message} — queries over uploaded tables will not run. On a restricted network
            this is usually a Content-Security-Policy or proxy blocking WebAssembly; open{" "}
            <code>/engine-check</code> to confirm.
          </p>
        </div>
      </div>
    );
  }

  const pct =
    status.bytesTotal > 0
      ? Math.min(100, Math.round((status.bytesLoaded / status.bytesTotal) * 100))
      : 0;

  return (
    <div
      className={`flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground ${className}`}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
      <Database className="h-3.5 w-3.5 shrink-0 opacity-60" />
      <span className="shrink-0">Starting the SQL engine…</span>
      {status.bytesTotal > 0 && (
        <>
          <span className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-border">
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="shrink-0 tabular-nums">
            {mb(status.bytesLoaded)} / {mb(status.bytesTotal)}
          </span>
        </>
      )}
      <span className="hidden shrink-0 opacity-70 sm:inline">
        one-off download, cached from here on
      </span>
    </div>
  );
}
