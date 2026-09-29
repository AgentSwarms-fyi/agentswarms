// Change a query sheet's SQL (R154). The sheet keeps its calculated columns,
// sort and filters; the new query's columns replace the old ones, and a
// setting that names a column the query no longer returns says so, as after
// a table loses a column.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TableConfig } from "@/lib/sheets/sql/tableQuery";
import { sheetsSetTableQuery } from "@/utils/sheetsTables.functions";
import { QueryEditor } from "./QueryEditor";
import type { TabMeta, useWorkbook } from "./useWorkbook";

type Workbook = ReturnType<typeof useWorkbook>;

export function EditQueryDialog({
  open,
  onOpenChange,
  wb,
  token,
  tab,
  config,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wb: Workbook;
  token: string;
  tab: TabMeta;
  config: TableConfig;
}) {
  const saveFn = useServerFn(sheetsSetTableQuery);
  const [sql, setSql] = useState(config.source.kind === "query" ? config.source.sql : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!sql.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await saveFn({
        data: {
          access_token: token,
          tab_id: tab.id,
          base_version: tab.version,
          sql: sql.trim(),
          config,
        },
      });
      if (!r.ok) return setError(r.error);
      wb.applyServerTab(r.tab);
      toast.success(`${tab.name} runs the new query`);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="edit-query-dialog">
        <DialogHeader>
          <DialogTitle>Query for {tab.name}</DialogTitle>
          <DialogDescription>
            The sheet&apos;s rows are what this query returns, run as whoever reads the sheet. Its
            calculated columns, sort and filters stay.
          </DialogDescription>
        </DialogHeader>
        <QueryEditor token={token} workbookId={wb.workbookId} sql={sql} onSql={setSql} />
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!sql.trim() || busy}
            onClick={() => void save()}
            data-testid="save-query"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save query
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
