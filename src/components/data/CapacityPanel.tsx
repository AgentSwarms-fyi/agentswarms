// What this workspace is holding in columnar form, and the choice behind each
// dataset.
//
// The most useful thing a capacity feature ships is not the engine — it is
// this: a page that says how much room is left and which datasets are using
// it. QuickSight's SPICE bar is more valuable to most teams than SPICE.
//
// Every row states its EFFECTIVE mode and the reason, because `auto` deciding
// something on your behalf is only acceptable if it will tell you what it
// decided. Switching a dataset to `direct` drops its mirror on the next
// refresh; switching to `import` builds one. Neither changes an answer —
// mirrors are a cache over the same rows — so the control is safe to give
// people without a warning attached.
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Database, HardDrive, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { describeCapacity, formatBytes, resolveMode, type StorageMode } from "@/lib/capacityPlan";

type Row = {
  id: string;
  name: string;
  storage_mode: StorageMode;
  parquet_bytes: number | null;
  parquet_rows: number | null;
  parquet_last_used_at: string | null;
  is_sample: boolean | null;
};

/**
 * The budget is a server setting, so the browser cannot read it directly.
 * Rather than invent a number, the panel reports what it can measure — how
 * much is held — and says the budget is set on the server when it does not
 * know it. A capacity bar showing a made-up ceiling would be worse than none.
 */
export function CapacityPanel({ userId }: { userId: string | undefined }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  /** Show the datasets holding nothing too — the per-dataset storage control. */
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase
      .from("user_data_tables")
      .select(
        "id, name, storage_mode, parquet_bytes, parquet_rows, parquet_last_used_at, is_sample",
      )
      .eq("user_id", userId)
      .order("parquet_bytes", { ascending: false, nullsFirst: false });
    if (error) {
      toast.error(error.message);
      setRows([]);
      return;
    }
    setRows((data ?? []) as Row[]);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setMode(id: string, mode: StorageMode) {
    setSaving(id);
    const { error } = await supabase
      .from("user_data_tables")
      .update({ storage_mode: mode })
      .eq("id", id);
    setSaving(null);
    if (error) return toast.error(error.message);
    // Honest about WHEN it takes effect: the mirror is rebuilt or dropped by
    // the next refresh, not this instant.
    toast.success(
      mode === "direct"
        ? "Set to direct query — the mirror is dropped on the next refresh."
        : mode === "import"
          ? "Set to import — a mirror is built on the next refresh."
          : "Set to auto — size decides on the next refresh.",
    );
    void load();
  }

  const held = (rows ?? []).filter((r) => (r.parquet_bytes ?? 0) > 0);
  const usedBytes = held.reduce((n, r) => n + (r.parquet_bytes ?? 0), 0);

  // SHOW WHAT IS USING SOMETHING; hide what is not.
  //
  // This panel used to list every dataset in the workspace, most of them saying
  // "Not mirrored — reads its rows directly", i.e. holding nothing. On a
  // workspace with a dozen datasets that is a dozen rows of nothing between the
  // machine's resource cards and the service health list — the two things the
  // page exists for. The rows that hold bytes are observability; the rest are a
  // configuration list, and a configuration list should not outrank service
  // status on the page you open when something is wrong.
  const visible = expanded ? (rows ?? []) : held;
  const hiddenCount = (rows?.length ?? 0) - held.length;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <HardDrive className="h-4 w-4" /> Materialised data
        </p>
        <p className="text-[11px] text-muted-foreground">
          {rows === null
            ? "Loading…"
            : `${describeCapacity(usedBytes, 0).replace(" — no budget set, so nothing is evicted.", "")} across ${held.length} dataset${held.length === 1 ? "" : "s"} · budget is set on the server (MIRROR_BUDGET_BYTES)`}
        </p>
      </div>

      <div className="divide-y">
        {rows === null ? (
          <p className="p-4 text-sm text-muted-foreground">Reading dataset sizes…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No datasets yet. Upload one and it will appear here with its storage mode.
          </p>
        ) : visible.length === 0 ? (
          <p className="px-4 py-2.5 text-xs text-muted-foreground">
            Nothing is mirrored — every dataset reads its rows directly, so no memory is held.
          </p>
        ) : (
          visible.map((r) => {
            const rowCount = r.parquet_rows ?? 0;
            // The panel cannot know the server's thresholds, so it explains
            // an EXPLICIT mode exactly and leaves `auto` to say what it did
            // rather than predicting what it will do.
            const decided =
              r.storage_mode === "auto"
                ? (r.parquet_bytes ?? 0) > 0
                  ? { mode: "import" as const, reason: "Mirrored automatically." }
                  : { mode: "direct" as const, reason: "Not mirrored — reads its rows directly." }
                : resolveMode({ mode: r.storage_mode, rows: rowCount, minRows: 0, maxRows: 1e12 });
            return (
              <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">
                    {r.name}
                    {r.is_sample && (
                      <Badge variant="outline" className="ml-1.5 text-[9px]">
                        sample
                      </Badge>
                    )}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {decided.reason}
                    {(r.parquet_bytes ?? 0) > 0 &&
                      ` ${formatBytes(r.parquet_bytes ?? 0)}${
                        rowCount ? ` · ${rowCount.toLocaleString()} rows` : ""
                      }`}
                    {r.parquet_last_used_at
                      ? ` · last read ${new Date(r.parquet_last_used_at).toLocaleDateString()}`
                      : (r.parquet_bytes ?? 0) > 0
                        ? " · never read"
                        : ""}
                  </p>
                </div>
                <Badge
                  variant={decided.mode === "import" ? "secondary" : "outline"}
                  className="shrink-0 text-[9px]"
                >
                  {decided.mode === "import" ? "in memory" : "direct"}
                </Badge>
                <Select
                  value={r.storage_mode}
                  onValueChange={(v) => void setMode(r.id, v as StorageMode)}
                  disabled={saving === r.id}
                >
                  <SelectTrigger className="h-7 w-28 text-xs">
                    {saving === r.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <SelectValue />
                    )}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="import">Import</SelectItem>
                    <SelectItem value="direct">Direct</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            );
          })
        )}
      </div>

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-1.5 border-t px-4 py-2 text-left text-[11px] text-muted-foreground hover:bg-muted/40"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          {expanded
            ? "Hide datasets that hold nothing"
            : `Show ${hiddenCount} dataset${hiddenCount === 1 ? "" : "s"} holding nothing, to change how they are stored`}
        </button>
      )}

      <p className="border-t bg-muted/20 px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
        A mirror is a <strong>cache over the same rows</strong>, so changing a mode — or having one
        evicted to stay within budget — changes how fast a query runs, never what it answers. When
        the budget evicts something, you are told which datasets went.
      </p>
    </Card>
  );
}
