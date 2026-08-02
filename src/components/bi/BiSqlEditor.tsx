// The SQL box, its Run button, and the certified-metric chips above it.
//
// Extracted from BiBuilderPane. Running the query stays in the parent — this
// takes runPreview as a prop rather than owning it, because the result feeds
// the chart configuration below and the parent is what holds that.
import { BadgeCheck, Loader2, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SavedMetric } from "@/lib/biAgent";
import type { QueryResult } from "@/lib/sqlEngine";

export function BiSqlEditor({
  sql,
  setSql,
  sourceKey,
  metrics,
  insertMetric,
  runPreview,
  running,
  preview,
  runError,
}: {
  sql: string;
  setSql: (v: string) => void;
  sourceKey: string;
  /** Certified metrics, offered as chips only for the local source. */
  metrics: SavedMetric[];
  insertMetric: (m: SavedMetric) => void;
  runPreview: () => void;
  running: boolean;
  preview: QueryResult | null;
  runError: string | null;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        SQL (SELECT only)
      </Label>
      {sourceKey === "local" && metrics.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pb-0.5">
          <span
            className="flex items-center gap-1 text-[10px] text-muted-foreground"
            title="Certified metrics saved from Data & SQL — click to insert as a query"
          >
            <BadgeCheck className="h-3 w-3 text-primary" /> Metrics:
          </span>
          {metrics.slice(0, 8).map((m) => (
            <button
              key={m.id}
              type="button"
              title={`${m.sql_expression}${m.description ? ` — ${m.description}` : ""}`}
              onClick={() => insertMetric(m)}
              className="rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/10"
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
      <Textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        rows={5}
        className="font-mono text-xs"
        placeholder="Select tables above, or write your own query"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          className="h-7 gap-1.5 text-xs"
          onClick={() => void runPreview()}
          disabled={running || !sql.trim()}
        >
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          Run
        </Button>
        {preview && (
          <span className="text-[10px] text-muted-foreground">
            {preview.row_count} rows · {preview.columns.length} cols
            {preview.capped ? " (truncated)" : ""}
          </span>
        )}
      </div>
      {runError && (
        <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {runError}
        </p>
      )}
    </div>
  );
}
