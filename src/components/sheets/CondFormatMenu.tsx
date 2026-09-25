// Home > Conditional formatting, as Excel lays it out: highlight rules,
// top/bottom rules, data bars, color scales, icon sets, a formula rule, and
// the rules manager. Rules apply to the selection when made.

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Highlighter, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { openFocus } from "./focusAfterMenu";
import {
  BAR_COLORS,
  CF_PRESETS,
  describeRule,
  ICON_SET_NAMES,
  ICON_SETS,
  SCALE_PRESETS,
  type CfPeriod,
  type CfRule,
  type CfStyle,
  type CondFormat,
  type IconSet,
} from "@/lib/sheets/condFormat";

/** A rule that needs values before it can be made. */
export type RuleDraft =
  | { kind: "cell"; op: "gt" | "lt" | "between" | "eq" }
  | { kind: "text" }
  | { kind: "date" }
  | { kind: "top"; bottom?: boolean; percent?: boolean }
  | { kind: "duplicate" }
  | { kind: "formula" };

const DRAFT_TITLE = (d: RuleDraft): string => {
  switch (d.kind) {
    case "cell":
      return { gt: "Greater than", lt: "Less than", between: "Between", eq: "Equal to" }[d.op];
    case "text":
      return "Text that contains";
    case "date":
      return "A date occurring";
    case "top":
      return `${d.bottom ? "Bottom" : "Top"} ${d.percent ? "10%" : "10 items"}`;
    case "duplicate":
      return "Duplicate values";
    case "formula":
      return "Use a formula to decide which cells to format";
  }
};

const PERIODS: { p: CfPeriod; label: string }[] = [
  { p: "yesterday", label: "Yesterday" },
  { p: "today", label: "Today" },
  { p: "tomorrow", label: "Tomorrow" },
  { p: "last7", label: "In the last 7 days" },
  { p: "lastWeek", label: "Last week" },
  { p: "thisWeek", label: "This week" },
  { p: "nextWeek", label: "Next week" },
  { p: "lastMonth", label: "Last month" },
  { p: "thisMonth", label: "This month" },
  { p: "nextMonth", label: "Next month" },
];

export function CondFormatMenu({
  onAdd,
  onDraft,
  onClearSelection,
  onClearSheet,
  onManage,
  onDone,
}: {
  onAdd: (rule: CfRule) => void;
  onDraft: (d: RuleDraft) => void;
  onClearSelection: () => void;
  onClearSheet: () => void;
  onManage: () => void;
  onDone: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          title="Conditional formatting"
          data-testid="tool-cond-format"
          onMouseDown={(e) => e.preventDefault()}
        >
          <Highlighter className="h-4 w-4" /> Conditional
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-60"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onDone();
        }}
      >
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Highlight cells rules</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={() => onDraft({ kind: "cell", op: "gt" })}>
              Greater than…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDraft({ kind: "cell", op: "lt" })}>
              Less than…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDraft({ kind: "cell", op: "between" })}>
              Between…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDraft({ kind: "cell", op: "eq" })}>
              Equal to…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDraft({ kind: "text" })}>
              Text that contains…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDraft({ kind: "date" })}>
              A date occurring…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDraft({ kind: "duplicate" })}>
              Duplicate values…
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Top/bottom rules</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={() => onDraft({ kind: "top" })}>
              Top 10 items…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDraft({ kind: "top", percent: true })}>
              Top 10%…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDraft({ kind: "top", bottom: true })}>
              Bottom 10 items…
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onDraft({ kind: "top", bottom: true, percent: true })}
            >
              Bottom 10%…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onAdd({ kind: "average", style: CF_PRESETS[2].style })}
            >
              Above average
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onAdd({ kind: "average", below: true, style: CF_PRESETS[0].style })}
            >
              Below average
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Data bars</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {BAR_COLORS.map(({ color: c, label }) => (
              <DropdownMenuItem key={c} onSelect={() => onAdd({ kind: "bar", color: c })}>
                <span
                  className="mr-2 h-3 w-10 rounded-sm"
                  style={{ background: `linear-gradient(to right, ${c}, ${c}22)` }}
                />
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Color scales</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {SCALE_PRESETS.map((p) => (
              <DropdownMenuItem
                key={p.label}
                onSelect={() =>
                  onAdd({
                    kind: "scale",
                    min: { type: "min", color: p.min },
                    ...(p.mid ? { mid: { type: "percentile", value: 50, color: p.mid } } : {}),
                    max: { type: "max", color: p.max },
                  })
                }
              >
                <span
                  className="mr-2 h-3 w-10 rounded-sm"
                  style={{
                    background: `linear-gradient(to right, ${p.min}, ${p.mid ?? p.min}, ${p.max})`,
                  }}
                />
                {p.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Icon sets</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {(Object.keys(ICON_SETS) as IconSet[]).map((k) => (
              <DropdownMenuItem key={k} onSelect={() => onAdd({ kind: "icons", set: k })}>
                <span className="mr-2 w-16 tracking-widest">{ICON_SETS[k].join("")}</span>
                {ICON_SET_NAMES[k]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onDraft({ kind: "formula" })}>
          New rule with a formula…
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Clear rules</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={onClearSelection}>From selected cells</DropdownMenuItem>
            <DropdownMenuItem onSelect={onClearSheet}>From the entire sheet</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={onManage}>Manage rules…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The values a highlight or top/bottom rule needs, and its look. */
export function CondRuleDialog({
  draft,
  range,
  onCancel,
  onApply,
}: {
  draft: RuleDraft;
  range: string;
  onCancel: () => void;
  onApply: (rule: CfRule) => void;
}) {
  const [a, setA] = useState(draft.kind === "top" ? "10" : "");
  const [b, setB] = useState("");
  const [period, setPeriod] = useState<CfPeriod>("last7");
  const [preset, setPreset] = useState(0);
  const [unique, setUnique] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => setProblem(null), [a, b]);
  const style: CfStyle = CF_PRESETS[preset].style;

  const apply = () => {
    switch (draft.kind) {
      case "cell":
        if (!a.trim() || (draft.op === "between" && !b.trim()))
          return setProblem("Enter a value (or a formula such as =$B$1)");
        return onApply({
          kind: "cell",
          op: draft.op,
          a: a.trim(),
          ...(draft.op === "between" ? { b: b.trim() } : {}),
          style,
        });
      case "text":
        if (!a.trim()) return setProblem("Enter the text to look for");
        return onApply({ kind: "text", op: "contains", text: a, style });
      case "date":
        return onApply({ kind: "date", period, style });
      case "top": {
        const n = Number(a);
        if (!Number.isInteger(n) || n < 1 || n > (draft.percent ? 100 : 1000))
          return setProblem(
            draft.percent ? "A percentage from 1 to 100" : "A whole number from 1 to 1000",
          );
        return onApply({ kind: "top", n, percent: draft.percent, bottom: draft.bottom, style });
      }
      case "duplicate":
        return onApply({ kind: unique ? "unique" : "duplicate", style });
      case "formula":
        if (!a.trim())
          return setProblem("Enter a formula that is TRUE for the cells to format, e.g. =$C2<0");
        return onApply({
          kind: "formula",
          formula: a.trim().startsWith("=") ? a.trim() : `=${a.trim()}`,
          style,
        });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="cond-rule-dialog"
        onOpenAutoFocus={openFocus(
          () => formRef.current?.querySelector<HTMLElement>("input, select"),
          true,
        )}
      >
        <DialogHeader>
          <DialogTitle>{DRAFT_TITLE(draft)}</DialogTitle>
          <DialogDescription>
            Applies to {range}.
            {draft.kind === "formula" &&
              " Write it for the range's first cell; it moves with each cell as a copied formula would ($ keeps a part fixed)."}
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          {draft.kind === "date" ? (
            <div className="space-y-1">
              <Label htmlFor="cf-period">Dates occurring</Label>
              <select
                id="cf-period"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={period}
                onChange={(e) => setPeriod(e.target.value as CfPeriod)}
              >
                {PERIODS.map((p) => (
                  <option key={p.p} value={p.p}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          ) : draft.kind === "duplicate" ? (
            <div className="space-y-1">
              <Label htmlFor="cf-dup">Format cells that contain</Label>
              <select
                id="cf-dup"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={unique ? "unique" : "duplicate"}
                onChange={(e) => setUnique(e.target.value === "unique")}
              >
                <option value="duplicate">Duplicate values</option>
                <option value="unique">Unique values</option>
              </select>
            </div>
          ) : (
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="cf-a">
                  {draft.kind === "top"
                    ? draft.percent
                      ? "Percent of cells"
                      : "Number of cells"
                    : draft.kind === "text"
                      ? "Text"
                      : draft.kind === "formula"
                        ? "Formula"
                        : "Value"}
                </Label>
                <Input id="cf-a" value={a} onChange={(e) => setA(e.target.value)} />
              </div>
              {draft.kind === "cell" && draft.op === "between" && (
                <div className="flex-1 space-y-1">
                  <Label htmlFor="cf-b">and</Label>
                  <Input id="cf-b" value={b} onChange={(e) => setB(e.target.value)} />
                </div>
              )}
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="cf-style">Format with</Label>
            <select
              id="cf-style"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={preset}
              onChange={(e) => setPreset(Number(e.target.value))}
            >
              {CF_PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
            <div
              className="mt-1 inline-block rounded px-3 py-1 text-sm"
              style={{
                background: style.bg,
                color: style.color,
                fontWeight: style.b ? 600 : undefined,
              }}
            >
              AaBbCc 123
            </div>
          </div>
          {problem && <p className="text-sm text-destructive">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Every rule on the sheet, in priority order: reorder, change the range, delete. */
export function ManageRulesDialog({
  rules,
  onClose,
  onChange,
}: {
  rules: CondFormat[];
  onClose: () => void;
  onChange: (rules: CondFormat[]) => void;
}) {
  const [list, setList] = useState(rules);
  const [problem, setProblem] = useState<string | null>(null);
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    setList(next);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="sm:max-w-2xl"
        data-testid="cond-manage-dialog"
        onOpenAutoFocus={openFocus(() =>
          document.querySelector<HTMLElement>(
            '[data-testid="cond-manage-dialog"] input, [data-testid="cond-manage-dialog"] button',
          ),
        )}
      >
        <DialogHeader>
          <DialogTitle>Conditional formatting rules</DialogTitle>
          <DialogDescription>
            Rules higher in the list win where two set the same thing. Ranges are A1 addresses,
            several separated by commas.
          </DialogDescription>
        </DialogHeader>
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">This sheet has no rules.</p>
        ) : (
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {list.map((cf, i) => (
              <li
                key={cf.id}
                className="flex items-center gap-2 rounded border border-border p-2 text-sm"
                data-testid="cond-rule-row"
              >
                <span className="min-w-0 flex-1 truncate">{describeRule(cf.rule)}</span>
                <Input
                  aria-label="Applies to"
                  className="h-8 w-40 font-mono text-xs"
                  value={cf.ranges.join(", ")}
                  onChange={(e) => {
                    const ranges = e.target.value
                      .split(",")
                      .map((x) => x.trim().toUpperCase())
                      .filter(Boolean);
                    setList(list.map((x, k) => (k === i ? { ...x, ranges } : x)));
                  }}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label="Move up"
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label="Move down"
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive"
                  aria-label="Delete rule"
                  onClick={() => setList(list.filter((_, k) => k !== i))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {problem && <p className="text-sm text-destructive">{problem}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const bad = list.find(
                (cf) =>
                  !cf.ranges.length ||
                  cf.ranges.some((r) => !/^\$?[A-Z]{1,3}\$?\d+(:\$?[A-Z]{1,3}\$?\d+)?$/.test(r)),
              );
              if (bad)
                return setProblem(
                  `"${bad.ranges.join(", ") || "(empty)"}" is not a range such as B2:B40`,
                );
              onChange(list);
            }}
          >
            Save rules
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
