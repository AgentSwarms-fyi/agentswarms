// View > Freeze, as Excel's Freeze Panes: the rows above and the columns
// left of the active cell, the top row, or the first column stay in view
// while the rest scrolls (R151).

import { ChevronDown, Snowflake } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { a1 } from "@/lib/sheets/a1";

export function FreezeMenu({
  frozenRows,
  frozenCols,
  active,
  onFreeze,
  onDone,
}: {
  frozenRows: number;
  frozenCols: number;
  /** The active cell: Freeze Panes freezes what is above and left of it. */
  active: { row: number; col: number };
  onFreeze: (rows: number, cols: number) => void;
  /** Where the keyboard goes once the menu closes (the grid). */
  onDone: () => void;
}) {
  const frozen = frozenRows > 0 || frozenCols > 0;
  const atCell = active.row > 0 || active.col > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant={frozen ? "secondary" : "ghost"}
          className="h-7 gap-1 px-2 text-xs"
          title="Freeze panes: keep rows and columns in view while the rest scrolls"
          data-testid="tool-freeze"
          onMouseDown={(e) => e.preventDefault()}
        >
          <Snowflake className="h-4 w-4" /> Freeze
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onDone();
        }}
      >
        <DropdownMenuItem
          disabled={!atCell}
          // Its text is two lines; a screen reader is told it in one.
          aria-label={atCell ? `Freeze panes at ${a1(active.row, active.col)}` : "Freeze panes"}
          onSelect={() => onFreeze(active.row, active.col)}
        >
          <div>
            <div>Freeze panes</div>
            <div className="text-xs text-muted-foreground">
              {atCell
                ? `Rows above and columns left of ${a1(active.row, active.col)}`
                : "Select the cell below and right of what should stay"}
            </div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onFreeze(1, 0)}>Freeze top row</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onFreeze(0, 1)}>Freeze first column</DropdownMenuItem>
        {frozen && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onFreeze(0, 0)}>Unfreeze panes</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
