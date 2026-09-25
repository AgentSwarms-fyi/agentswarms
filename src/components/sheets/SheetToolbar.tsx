// The grid's ribbon: Home (fonts, colors, borders, alignment, merging,
// number formats), Insert, Data and View, one row of tools under the tabs,
// as Excel for the web lays it out. Every tool acts on the selection; the
// buttons show the active cell's state.

import { useEffect, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  Baseline,
  Bold,
  ChevronDown,
  Eraser,
  Grid2x2,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  Minus,
  PaintBucket,
  Paintbrush,
  Percent,
  Plus,
  Redo2,
  Strikethrough,
  TableCellsMerge,
  Underline,
  Undo2,
  WrapText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CellStyle } from "@/lib/sheets/engine";
import { PRESET_FORMATS } from "@/lib/sheets/format";
import { stepZoom, ZOOM_LEVELS } from "@/lib/sheets/geometry";
import type { MergeMode } from "@/lib/sheets/merge";
import {
  DEFAULT_FONT,
  DEFAULT_SIZE,
  fontStack,
  FONTS,
  SIZES,
  type BorderPreset,
  type BorderStyle,
} from "@/lib/sheets/style";
import { cn } from "@/lib/utils";
import { ColorPicker } from "./ColorPicker";

export type ClearKind = "all" | "formats" | "contents" | "links";

export type ToolbarActions = {
  undo: () => void;
  redo: () => void;
  style: (patch: Partial<CellStyle>) => void;
  toggle: (k: "b" | "i" | "u" | "st" | "wrap") => void;
  growFont: (dir: 1 | -1) => void;
  indent: (dir: 1 | -1) => void;
  borders: (preset: BorderPreset, style: BorderStyle, color: string) => void;
  merge: (mode: MergeMode | "unmerge") => void;
  format: (code: string) => void;
  customFormat: () => void;
  decimals: (dir: 1 | -1) => void;
  clear: (kind: ClearKind) => void;
  painter: () => void;
  link: () => void;
  saveToLakehouse: () => void;
  zoom: (z: number) => void;
  toggleGridlines: () => void;
};

type Props = {
  actions: ToolbarActions;
  style: CellStyle | undefined;
  format: string | undefined;
  /** The selection is (or includes) a merged cell. */
  merged: boolean;
  painting: boolean;
  zoom: number;
  gridlines: boolean;
  /** The save state badge, right-aligned. */
  status: React.ReactNode;
  /** Tools later milestones add to a tab (conditional formatting, charts…). */
  extra?: Partial<Record<RibbonTab, React.ReactNode>>;
  /** Give the keyboard back to the grid (a menu closing would leave it on its button). */
  onDone: () => void;
};

export type RibbonTab = "home" | "insert" | "data" | "view";
const TABS: { id: RibbonTab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "insert", label: "Insert" },
  { id: "data", label: "Data" },
  { id: "view", label: "View" },
];

const BORDER_ITEMS: { preset: BorderPreset; label: string }[] = [
  { preset: "bottom", label: "Bottom border" },
  { preset: "top", label: "Top border" },
  { preset: "left", label: "Left border" },
  { preset: "right", label: "Right border" },
  { preset: "none", label: "No border" },
  { preset: "all", label: "All borders" },
  { preset: "outside", label: "Outside borders" },
  { preset: "inside", label: "Inside borders" },
  { preset: "thick-outside", label: "Thick outside borders" },
  { preset: "bottom-double", label: "Bottom double border" },
];
const LINE_STYLES: { s: BorderStyle; label: string }[] = [
  { s: "thin", label: "Thin" },
  { s: "medium", label: "Medium" },
  { s: "thick", label: "Thick" },
  { s: "dashed", label: "Dashed" },
  { s: "dotted", label: "Dotted" },
  { s: "double", label: "Double" },
];
const LINE_COLORS = ["#000000", "#595959", "#C00000", "#0070C0", "#00B050", "#7030A0"];

export function SheetToolbar({
  onDone,
  actions: a,
  style: s,
  format,
  merged,
  painting,
  zoom,
  gridlines,
  status,
  extra,
}: Props) {
  const [tab, setTab] = useState<RibbonTab>("home");
  const backToGrid = (e: Event) => {
    e.preventDefault();
    onDone();
  };
  const [line, setLine] = useState<BorderStyle>("thin");
  const [lineColor, setLineColor] = useState("#000000");
  const [size, setSize] = useState(String(s?.sz ?? DEFAULT_SIZE));
  useEffect(() => setSize(String(s?.sz ?? DEFAULT_SIZE)), [s?.sz]);

  const tool = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    on = false,
    testId?: string,
  ) => (
    <Button
      size="icon"
      variant={on ? "secondary" : "ghost"}
      className="h-7 w-7"
      title={label}
      aria-label={label}
      aria-pressed={on}
      data-testid={testId}
      // Keep the keyboard in the grid (or the cell being edited).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </Button>
  );
  const sep = <div className="mx-1 h-5 w-px bg-border" />;
  const applySize = () => {
    const n = Number(size);
    if (Number.isFinite(n) && n >= 1 && n <= 409)
      a.style({ sz: n === DEFAULT_SIZE ? undefined : Math.round(n * 2) / 2 });
    else setSize(String(s?.sz ?? DEFAULT_SIZE));
  };
  const fmtLabel =
    PRESET_FORMATS.find((p) => p.code === format)?.label ?? (format ? "Custom" : "General");

  return (
    <div className="border-b border-border bg-muted/30" data-testid="sheet-ribbon">
      <div className="flex items-center gap-0.5 px-2 pt-1" role="tablist" aria-label="Ribbon">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={cn(
              "rounded-t px-2.5 py-0.5 text-xs",
              tab === t.id
                ? "border-b-2 border-primary bg-background font-medium text-foreground"
                : "border-b-2 border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 pr-1 text-xs" data-testid="save-state">
          {status}
        </div>
      </div>
      <div className="flex min-h-9 flex-wrap items-center gap-0.5 bg-background/60 px-2 py-1">
        {tab === "home" && (
          <>
            {tool("Undo (Ctrl+Z)", <Undo2 className="h-4 w-4" />, a.undo)}
            {tool("Redo (Ctrl+Y)", <Redo2 className="h-4 w-4" />, a.redo)}
            {tool(
              painting ? "Format painter: pick the cells to paint" : "Format painter",
              <Paintbrush className="h-4 w-4" />,
              a.painter,
              painting,
              "tool-painter",
            )}
            {sep}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 w-32 justify-between gap-1 px-2 text-xs"
                  title="Font"
                  data-testid="tool-font"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <span className="truncate" style={{ fontFamily: fontStack(s?.font) }}>
                    {s?.font ?? DEFAULT_FONT}
                  </span>
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                onCloseAutoFocus={backToGrid}
                align="start"
                className="max-h-80 overflow-y-auto"
              >
                {FONTS.map((f) => (
                  <DropdownMenuItem
                    key={f}
                    onSelect={() => a.style({ font: f === DEFAULT_FONT ? undefined : f })}
                    style={{ fontFamily: fontStack(f) }}
                  >
                    {f}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex items-center">
              <input
                aria-label="Font size"
                data-testid="tool-size"
                className="h-7 w-10 rounded-l border border-input bg-background px-1 text-center text-xs"
                value={size}
                onChange={(e) => setSize(e.target.value.replace(/[^\d.]/g, "").slice(0, 5))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applySize();
                  }
                }}
                onBlur={applySize}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-7 w-4 items-center justify-center rounded-r border border-l-0 border-input bg-background"
                    aria-label="Font sizes"
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    <ChevronDown className="h-3 w-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  onCloseAutoFocus={backToGrid}
                  align="start"
                  className="max-h-72 min-w-16 overflow-y-auto"
                >
                  {SIZES.map((n) => (
                    <DropdownMenuItem
                      key={n}
                      onSelect={() => a.style({ sz: n === DEFAULT_SIZE ? undefined : n })}
                    >
                      {n}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {tool(
              "Increase font size",
              <span className="text-xs font-semibold">
                A<sup>+</sup>
              </span>,
              () => a.growFont(1),
            )}
            {tool(
              "Decrease font size",
              <span className="text-[11px] font-semibold">
                A<sup>−</sup>
              </span>,
              () => a.growFont(-1),
            )}
            {sep}
            {tool(
              "Bold (Ctrl+B)",
              <Bold className="h-4 w-4" />,
              () => a.toggle("b"),
              !!s?.b,
              "tool-bold",
            )}
            {tool(
              "Italic (Ctrl+I)",
              <Italic className="h-4 w-4" />,
              () => a.toggle("i"),
              !!s?.i,
              "tool-italic",
            )}
            {tool(
              "Underline (Ctrl+U)",
              <Underline className="h-4 w-4" />,
              () => a.toggle("u"),
              !!s?.u,
              "tool-underline",
            )}
            {tool(
              "Strikethrough (Ctrl+5)",
              <Strikethrough className="h-4 w-4" />,
              () => a.toggle("st"),
              !!s?.st,
              "tool-strike",
            )}
            <ColorPicker
              label="Font color"
              testId="tool-font-color"
              icon={<Baseline className="h-3.5 w-3.5" />}
              initial="#FF0000"
              clearLabel="Automatic"
              onDone={onDone}
              onPick={(c) => a.style({ color: c ?? undefined })}
            />
            <ColorPicker
              label="Fill color"
              testId="tool-fill-color"
              icon={<PaintBucket className="h-3.5 w-3.5" />}
              initial="#FFFF00"
              clearLabel="No fill"
              onDone={onDone}
              onPick={(c) => a.style({ bg: c ?? undefined })}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-0.5 px-1.5"
                  title="Borders"
                  aria-label="Borders"
                  data-testid="tool-borders"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <Grid2x2 className="h-4 w-4" />
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent onCloseAutoFocus={backToGrid} align="start" className="w-56">
                {BORDER_ITEMS.map((b) => (
                  <DropdownMenuItem
                    key={b.preset}
                    onSelect={() => a.borders(b.preset, line, lineColor)}
                  >
                    {b.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Line style</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {LINE_STYLES.map((l) => (
                      <DropdownMenuCheckboxItem
                        key={l.s}
                        checked={line === l.s}
                        onSelect={(e) => {
                          e.preventDefault();
                          setLine(l.s);
                        }}
                      >
                        {l.label}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    Line color
                    <span
                      className="ml-auto h-3 w-3 rounded-sm border"
                      style={{ background: lineColor }}
                    />
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {LINE_COLORS.map((c) => (
                      <DropdownMenuCheckboxItem
                        key={c}
                        checked={lineColor === c}
                        onSelect={(e) => {
                          e.preventDefault();
                          setLineColor(c);
                        }}
                      >
                        <span
                          className="mr-2 h-3 w-3 rounded-sm border"
                          style={{ background: c }}
                        />
                        {c}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
            {sep}
            {tool(
              "Align left",
              <AlignLeft className="h-4 w-4" />,
              () => a.style({ align: s?.align === "left" ? undefined : "left" }),
              s?.align === "left",
            )}
            {tool(
              "Center",
              <AlignCenter className="h-4 w-4" />,
              () => a.style({ align: s?.align === "center" ? undefined : "center" }),
              s?.align === "center",
            )}
            {tool(
              "Align right",
              <AlignRight className="h-4 w-4" />,
              () => a.style({ align: s?.align === "right" ? undefined : "right" }),
              s?.align === "right",
            )}
            {tool(
              "Top align",
              <AlignVerticalJustifyStart className="h-4 w-4" />,
              () => a.style({ va: s?.va === "top" ? undefined : "top" }),
              s?.va === "top",
            )}
            {tool(
              "Middle align",
              <AlignVerticalJustifyCenter className="h-4 w-4" />,
              () => a.style({ va: s?.va === "middle" ? undefined : "middle" }),
              s?.va === "middle",
            )}
            {tool(
              "Bottom align",
              <AlignVerticalJustifyEnd className="h-4 w-4" />,
              () => a.style({ va: undefined }),
              !s?.va || s.va === "bottom",
            )}
            {tool("Decrease indent", <IndentDecrease className="h-4 w-4" />, () => a.indent(-1))}
            {tool("Increase indent", <IndentIncrease className="h-4 w-4" />, () => a.indent(1))}
            {tool(
              "Wrap text",
              <WrapText className="h-4 w-4" />,
              () => a.toggle("wrap"),
              !!s?.wrap,
              "tool-wrap",
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant={merged ? "secondary" : "ghost"}
                  className="h-7 gap-1 px-1.5 text-xs"
                  title="Merge cells"
                  data-testid="tool-merge"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <TableCellsMerge className="h-4 w-4" />
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent onCloseAutoFocus={backToGrid} align="start">
                <DropdownMenuItem onSelect={() => a.merge("center")}>
                  Merge &amp; Center
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => a.merge("across")}>Merge Across</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => a.merge("merge")}>Merge Cells</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => a.merge("unmerge")} disabled={!merged}>
                  Unmerge Cells
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {sep}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs"
                  title="Number format"
                  data-testid="tool-number-format"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {fmtLabel}
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent onCloseAutoFocus={backToGrid} align="start">
                {PRESET_FORMATS.map((p) => (
                  <DropdownMenuItem key={p.code} onSelect={() => a.format(p.code)}>
                    <span className="w-28">{p.label}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{p.code}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={a.customFormat}>Custom…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {tool("Currency", <span className="text-xs font-semibold">$</span>, () =>
              a.format('"$"#,##0.00'),
            )}
            {tool("Percent style", <Percent className="h-3.5 w-3.5" />, () => a.format("0%"))}
            {tool("Comma style", <span className="text-sm font-semibold">,</span>, () =>
              a.format("#,##0.00"),
            )}
            {tool("Increase decimal", <span className="text-[10px] font-semibold">.0→</span>, () =>
              a.decimals(1),
            )}
            {tool("Decrease decimal", <span className="text-[10px] font-semibold">←.0</span>, () =>
              a.decimals(-1),
            )}
            {extra?.home && (
              <>
                {sep}
                {extra.home}
              </>
            )}
            {sep}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-0.5 px-1.5"
                  title="Clear"
                  aria-label="Clear"
                  data-testid="tool-clear"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <Eraser className="h-4 w-4" />
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent onCloseAutoFocus={backToGrid} align="start">
                <DropdownMenuItem onSelect={() => a.clear("all")}>Clear all</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => a.clear("formats")}>
                  Clear formats
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => a.clear("contents")}>
                  Clear contents
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => a.clear("links")}>
                  Clear hyperlinks
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        {tab === "insert" && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              data-testid="tool-link"
              onMouseDown={(e) => e.preventDefault()}
              onClick={a.link}
            >
              <Link2 className="h-4 w-4" /> Link
              <span className="text-muted-foreground">Ctrl+K</span>
            </Button>
            {extra?.insert}
          </>
        )}
        {tab === "data" && (
          <>
            {extra?.data}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              title="Save the selection (or the whole sheet) as a lakehouse table"
              onMouseDown={(e) => e.preventDefault()}
              onClick={a.saveToLakehouse}
            >
              Save to lakehouse
            </Button>
          </>
        )}
        {tab === "view" && (
          <>
            <ZoomControl zoom={zoom} onZoom={a.zoom} onDone={onDone} />
            {sep}
            <label className="flex items-center gap-1.5 px-2 text-xs">
              <input
                type="checkbox"
                checked={gridlines}
                onChange={a.toggleGridlines}
                data-testid="tool-gridlines"
              />
              Gridlines
            </label>
            {extra?.view}
          </>
        )}
      </div>
    </div>
  );
}

/** − 100% + with the preset levels in a menu, as Excel's status bar has it. */
export function ZoomControl({
  zoom,
  onZoom,
  onDone,
}: {
  zoom: number;
  onZoom: (z: number) => void;
  onDone?: () => void;
}) {
  const backToGrid = (e: Event) => {
    e.preventDefault();
    onDone?.();
  };
  return (
    <div className="flex items-center gap-0.5" data-testid="zoom-control">
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-muted"
        aria-label="Zoom out"
        title="Zoom out"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onZoom(stepZoom(zoom, -1))}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="h-6 w-12 rounded text-center text-xs tabular-nums hover:bg-muted"
            aria-label="Zoom level"
            data-testid="zoom-level"
            onMouseDown={(e) => e.preventDefault()}
          >
            {zoom}%
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          onCloseAutoFocus={backToGrid}
          side="top"
          align="center"
          className="min-w-20"
        >
          <DropdownMenuLabel className="text-xs">Zoom</DropdownMenuLabel>
          {ZOOM_LEVELS.map((z) => (
            <DropdownMenuCheckboxItem key={z} checked={z === zoom} onSelect={() => onZoom(z)}>
              {z}%
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-muted"
        aria-label="Zoom in"
        title="Zoom in"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onZoom(stepZoom(zoom, 1))}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
