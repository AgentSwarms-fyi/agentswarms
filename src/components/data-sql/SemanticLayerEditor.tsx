// Drawer to edit per-table business metadata for the BI Agent.
import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Save, Wand2, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { saveSemantics, type ColumnMeta, type SemanticEntry } from "@/lib/biAgent";
import type { DatasetMeta } from "@/lib/sqlEngine";

export function SemanticLayerEditor({
  open,
  onOpenChange,
  dataset,
  semantic,
  userId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dataset: DatasetMeta | null;
  semantic: SemanticEntry | null;
  userId: string;
  onSaved: () => void;
}) {
  const [tableDescription, setTableDescription] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [primaryKey, setPrimaryKey] = useState("");
  const [columnMeta, setColumnMeta] = useState<Record<string, ColumnMeta>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTableDescription(semantic?.table_description ?? "");
    setBusinessName(semantic?.business_name ?? "");
    setPrimaryKey(semantic?.primary_key ?? "");
    setColumnMeta(semantic?.column_meta ?? {});
  }, [open, semantic]);

  if (!dataset) return null;

  const isSampleReadOnly = dataset.is_sample && !semantic?.id;

  function updateCol(name: string, patch: Partial<ColumnMeta>) {
    setColumnMeta((prev) => ({
      ...prev,
      [name]: { ...prev[name], ...patch },
    }));
  }

  async function handleSave() {
    if (!dataset || !userId) return;
    if (dataset.is_sample) {
      toast.error("Sample datasets are shared and read-only.");
      return;
    }
    setBusy(true);
    try {
      await saveSemantics({
        userId,
        tableId: dataset.id,
        table_description: tableDescription.trim() || null,
        business_name: businessName.trim() || null,
        column_meta: columnMeta,
        primary_key: primaryKey.trim() || null,
      });
      toast.success("Semantic layer saved");
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-indigo-600" />
            Semantic layer · <span className="font-mono text-sm">{dataset.name}</span>
          </SheetTitle>
          <SheetDescription className="text-xs">
            Teach the BI Agent about this dataset. Better metadata = better SQL and clearer answers.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {isSampleReadOnly && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
              This is a shared sample dataset — metadata is read-only.
            </div>
          )}

          <div>
            <Label className="text-xs">Business name</Label>
            <Input
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder={`e.g. "Q3 SaaS Sales"`}
              disabled={isSampleReadOnly}
              className="mt-1 text-xs"
            />
          </div>

          <div>
            <Label className="text-xs">What this table is about</Label>
            <Textarea
              value={tableDescription}
              onChange={(e) => setTableDescription(e.target.value)}
              placeholder="e.g. Per-order line items from our SaaS subscriptions, one row per renewal."
              disabled={isSampleReadOnly}
              className="mt-1 text-xs min-h-[60px]"
            />
          </div>

          <div>
            <Label className="text-xs">Primary key (optional)</Label>
            <Input
              value={primaryKey}
              onChange={(e) => setPrimaryKey(e.target.value)}
              placeholder="e.g. order_id"
              disabled={isSampleReadOnly}
              className="mt-1 text-xs font-mono"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <Label className="text-xs">Columns</Label>
              <span className="text-[10px] text-slate-500">{dataset.columns.length} total</span>
            </div>
            <div className="space-y-2 rounded-md border border-slate-200 dark:border-slate-800 p-2">
              {dataset.columns.map((col) => {
                const meta = columnMeta[col.name] ?? {};
                return (
                  <div key={col.name} className="grid grid-cols-12 gap-1.5 items-start">
                    <div className="col-span-3 pt-1.5">
                      <div className="text-[10px] font-mono text-slate-700 dark:text-slate-300 truncate">
                        {col.name}
                      </div>
                      <div className="text-[9px] text-slate-400">{col.type}</div>
                    </div>
                    <Input
                      placeholder="alias"
                      value={meta.alias ?? ""}
                      onChange={(e) => updateCol(col.name, { alias: e.target.value })}
                      disabled={isSampleReadOnly}
                      className="col-span-3 h-7 text-[10px]"
                    />
                    <Input
                      placeholder="description"
                      value={meta.description ?? ""}
                      onChange={(e) => updateCol(col.name, { description: e.target.value })}
                      disabled={isSampleReadOnly}
                      className="col-span-6 h-7 text-[10px]"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={busy || isSampleReadOnly}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              Save
            </Button>
          </div>

          <p className="text-[10px] text-slate-400 pt-2 flex items-center gap-1">
            <Wand2 className="h-2.5 w-2.5" />
            Inspired by Wren AI's MDL pattern.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
