// AI analyst inside the BI project editor: the same GenBI pipeline used on
// /data-sql (plan → SQL → execute → chart → narrative). Each finished answer
// can be inserted into the dashboard as a widget with its data snapshot.
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Send, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BiChatMessage } from "@/components/data-sql/BiChatMessage";
import { sourceFromKey, type BiDataContext } from "@/components/bi/biDataContext";
import { runBiTurn, type BiTurn } from "@/lib/biAgent";
import { widgetFromBiTurn, type BiWidget } from "@/lib/biDashboards";
import { warehouseTablesAsDatasets } from "@/lib/warehouseClient";
import { WAREHOUSE_LABELS } from "@/utils/warehouse/types";

export function AiWidgetDialog({
  open,
  onOpenChange,
  ctx,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ctx: BiDataContext;
  onInsert: (widget: BiWidget) => void;
}) {
  const [sourceKey, setSourceKey] = useState("local");
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<BiTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [insertedIdx, setInsertedIdx] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setTurns([]);
      setInsertedIdx(new Set());
      setQuestion("");
    }
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const activeWarehouse =
    sourceKey !== "local" ? (ctx.warehouses.find((w) => w.id === sourceKey) ?? null) : null;

  const datasets = useMemo(() => {
    if (!activeWarehouse) return ctx.datasets;
    const tables = ctx.whTables[activeWarehouse.id];
    if (!tables || tables === "loading" || tables === "error") return [];
    return warehouseTablesAsDatasets(activeWarehouse.id, tables, ctx.userId);
  }, [activeWarehouse, ctx.datasets, ctx.whTables, ctx.userId]);

  const schemaLoading = activeWarehouse
    ? ctx.whTables[activeWarehouse.id] === "loading" ||
      ctx.whTables[activeWarehouse.id] === undefined
    : false;

  async function send() {
    const q = question.trim();
    if (!q || busy) return;
    if (datasets.length === 0) {
      toast.error(
        activeWarehouse
          ? "The warehouse schema hasn't loaded yet."
          : "No local datasets — upload data on the Data & SQL page first.",
      );
      return;
    }
    setQuestion("");
    setBusy(true);
    setTurns((prev) => [...prev, { question: q, status: "planning" }]);
    try {
      await runBiTurn({
        question: q,
        datasets,
        semantics: activeWarehouse ? new Map() : ctx.semantics,
        metrics: activeWarehouse ? [] : ctx.metrics,
        execute: activeWarehouse
          ? (sql) => ctx.runSql(sourceFromKey(activeWarehouse.id, ctx.warehouses), sql)
          : undefined,
        dialect: activeWarehouse ? WAREHOUSE_LABELS[activeWarehouse.provider] : undefined,
        onUpdate: (turn) => {
          setTurns((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = turn;
            return copy;
          });
        },
      });
    } finally {
      setBusy(false);
    }
  }

  function insertTurn(turn: BiTurn, idx: number) {
    const widget = widgetFromBiTurn(turn, sourceFromKey(sourceKey, ctx.warehouses));
    if (!widget) return toast.error("This answer has no result to insert");
    onInsert(widget);
    setInsertedIdx((prev) => new Set(prev).add(idx));
    toast.success("Widget inserted into the dashboard");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Generate a visual with AI
          </DialogTitle>
          <DialogDescription>
            Ask a business question — the BI agent plans, writes SQL against the selected source,
            runs it and picks a chart. Insert any answer as a dashboard widget.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Label className="shrink-0 text-xs">Source</Label>
          <Select
            value={sourceKey}
            onValueChange={(v) => {
              setSourceKey(v);
              if (v !== "local") ctx.ensureSchema(v);
            }}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local" className="text-xs">
                Local datasets (Data &amp; SQL)
              </SelectItem>
              {ctx.warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id} className="text-xs">
                  {w.name} — {WAREHOUSE_LABELS[w.provider]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {schemaLoading && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> loading schema…
            </span>
          )}
        </div>

        <div
          ref={scrollRef}
          className="min-h-40 flex-1 space-y-3 overflow-y-auto rounded-md border border-border/50 bg-muted/20 p-3"
        >
          {turns.length === 0 && (
            <p className="py-10 text-center text-xs text-muted-foreground">
              e.g. “Top 5 products by revenue” or “Monthly signups this year as a line chart”
            </p>
          )}
          {turns.map((t, i) => (
            <div key={i} className="space-y-1.5">
              <BiChatMessage turn={t} />
              {t.status === "done" && t.result && (
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    variant={insertedIdx.has(i) ? "secondary" : "default"}
                    onClick={() => insertTurn(t, i)}
                  >
                    <Plus className="h-3 w-3" />
                    {insertedIdx.has(i) ? "Insert again" : "Insert into dashboard"}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex gap-1.5">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask a business question…"
            className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-xs focus:border-primary focus:outline-none"
            disabled={busy}
          />
          <Button
            size="icon"
            className="h-9 w-9"
            onClick={() => void send()}
            disabled={busy || !question.trim() || schemaLoading}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
