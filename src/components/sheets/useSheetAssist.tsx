// The assistant in the editor: its panel beside the grid, Fill with AI, and
// carrying out what the assistant proposes through the same undoable steps
// the ribbon uses (a formula filled down, values, a chart, a highlight rule,
// a number format, a new sheet). A workbook shared to view can be asked
// about; nothing it proposes is applied there.

import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { colLetters, rangeA1, type RangeAddr } from "@/lib/sheets/a1";
import type { AssistAction } from "@/lib/sheets/assist";
import { planAction } from "@/lib/sheets/assistApply";
import type { TableColumns } from "@/lib/sheets/assistRuntime";
import { cellView } from "@/lib/sheets/cellView";
import type { WorkbookEngine } from "@/lib/sheets/engine";
import { sheetsAddTab } from "@/utils/sheets.functions";
import { AiFillDialog } from "./AiFillDialog";
import { AssistPanel } from "./AssistPanel";
import { useAssistDefault, useAssistModel } from "./useAssistModel";
import { DEFAULT_COL_W, ROW_H } from "./SheetGrid";
import type { useWorkbook } from "./useWorkbook";

type Workbook = ReturnType<typeof useWorkbook>;

const newId = () => Math.random().toString(36).slice(2, 10);

export function useSheetAssist({
  wb,
  engine,
  token,
  workbookId,
  workbookName,
  tabId,
  range,
  focus,
  tableColumns,
  aiFillMaxRows,
  onDone,
}: {
  wb: Workbook;
  engine: WorkbookEngine | null;
  token: string | undefined;
  workbookId: string;
  workbookName: string;
  tabId: string | null;
  range: RangeAddr;
  focus: { row: number; col: number };
  tableColumns?: TableColumns;
  aiFillMaxRows: number;
  /** The panel or a dialog closed: the grid takes the keyboard back. */
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [fill, setFill] = useState<RangeAddr | null>(null);
  const addTabFn = useServerFn(sheetsAddTab);
  // The model picked in the panel, for the panel and Fill with AI (R158).
  const [model, setModel] = useAssistModel();
  const defaultModel = useAssistDefault(token);

  /** Carry out one proposal as one undoable step; a sentence when it cannot be done. */
  const apply = async (a: AssistAction): Promise<string | null> => {
    if (wb.readOnly) return "This workbook is shared with you to view; nothing changes here";
    if (!engine || !tabId) return "The workbook is not open";
    const plan = planAction(a, {
      engine,
      activeSheetId: tabId,
      newId,
      colWidth: DEFAULT_COL_W,
      rowHeight: ROW_H,
    });
    switch (plan.kind) {
      case "refused":
        return plan.reason;
      case "edits":
        wb.applyEdits(plan.sheetId, plan.edits);
        return null;
      case "rule":
        wb.setGridMeta(plan.sheetId, { cond: plan.cond });
        return null;
      case "chart":
        wb.setGridMeta(plan.sheetId, { charts: plan.charts });
        return null;
      case "new_sheet": {
        if (!token) return "Not signed in";
        try {
          const r = await addTabFn({
            data: { access_token: token, workbook_id: workbookId, name: plan.name },
          });
          if (!r.ok) return r.error;
          wb.addTabLocal(r.tab);
          wb.applyEdits(r.tab.id, plan.edits);
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      }
    }
  };

  const shownAt = (row: number, col: number) =>
    engine && tabId
      ? cellView(engine.getValue(tabId, row, col), engine.getInput(tabId, row, col)).text
      : "";

  const openFill = () => {
    if (wb.readOnly) return;
    if (!engine || !tabId || engine.sheet(tabId)?.kind !== "grid") {
      toast.error("Fill with AI works on a grid sheet's cells.");
      return;
    }
    if (range.r0 === range.r1) {
      toast.error("Select the column of values to work from (several rows) first.");
      return;
    }
    setFill(range);
  };

  const toggle = (
    <Button
      size="sm"
      variant={open ? "secondary" : "ghost"}
      className="h-6 gap-1 px-2 text-xs"
      onClick={() => setOpen((o) => !o)}
      data-testid="assist-toggle"
      aria-pressed={open}
      title="Ask the assistant about this workbook"
    >
      <Sparkles className="h-3.5 w-3.5 text-primary" /> Ask AI
    </Button>
  );

  const panel =
    open && engine && tabId ? (
      <AssistPanel
        // A new conversation for each workbook and each way of seeing it.
        // FOUND IN R139: "View as" kept the owner's conversation, reads of
        // rows the share hides included, and sent it to the model.
        key={`${workbookId}:${wb.asShare ?? "own"}`}
        engine={engine}
        workbookId={workbookId}
        workbookName={workbookName}
        token={token}
        activeSheetId={tabId}
        selection={rangeA1(range)}
        focus={focus}
        tableColumns={tableColumns}
        asShare={wb.asShare}
        readOnly={wb.readOnly}
        settle={() => new Promise((r) => setTimeout(r, 500))}
        apply={async (a) => {
          const problem = await apply(a);
          if (!problem) toast.success("Applied (Ctrl+Z undoes it)");
          return problem;
        }}
        onFill={openFill}
        onClose={() => {
          setOpen(false);
          onDone();
        }}
        model={model}
        onModel={setModel}
        defaultModel={defaultModel}
      />
    ) : null;

  const dialogs =
    fill && tabId ? (
      <AiFillDialog
        workbookId={workbookId}
        token={token}
        range={fill}
        maxRows={aiFillMaxRows}
        model={model}
        defaultModel={defaultModel}
        read={shownAt}
        onWrite={(col, values) => {
          wb.applyEdits(
            tabId,
            values.map((v) => ({ row: v.row, col, input: v.value })),
          );
          toast.success(
            `Filled ${values.length} cell${values.length === 1 ? "" : "s"} in column ${colLetters(col)}`,
          );
        }}
        onClose={() => {
          setFill(null);
          onDone();
        }}
      />
    ) : null;

  return { toggle, panel, dialogs, openFill, apply };
}
