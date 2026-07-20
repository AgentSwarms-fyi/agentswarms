// Dashboard filter bar: renders the owner-defined filters (value slicers +
// date ranges) plus the active cross-filter chip. Selections are runtime
// state applied client-side to widget snapshots — works identically in the
// editor, the shared read-only view and the public page.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarDays, ChevronDown, Filter, ListFilter, Plus, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  filterOptions,
  type BiCrossFilter,
  type BiFilterConfig,
  type BiFilterKind,
  type BiFilterState,
  type BiWidget,
} from "@/lib/biDashboards";

export function BiFilterBar({
  configs,
  widgets,
  state,
  onStateChange,
  cross,
  onClearCross,
  editable = false,
  onConfigsChange,
}: {
  configs: BiFilterConfig[];
  widgets: BiWidget[];
  state: BiFilterState;
  onStateChange: (next: BiFilterState) => void;
  cross: BiCrossFilter;
  onClearCross: () => void;
  /** Owner mode: can add/remove filter definitions. */
  editable?: boolean;
  onConfigsChange?: (next: BiFilterConfig[]) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);

  const anyActive =
    cross !== null ||
    configs.some((c) => {
      const st = state[c.id];
      return st && ((st.values?.length ?? 0) > 0 || st.from || st.to);
    });

  if (configs.length === 0 && !editable && !cross) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <Filter className="h-3.5 w-3.5 text-muted-foreground" />
      {configs.map((cfg) =>
        cfg.kind === "select" ? (
          <SelectFilterChip
            key={cfg.id}
            cfg={cfg}
            widgets={widgets}
            selected={state[cfg.id]?.values ?? []}
            onChange={(values) => onStateChange({ ...state, [cfg.id]: { values } })}
            editable={editable}
            onRemove={() => onConfigsChange?.(configs.filter((c) => c.id !== cfg.id))}
          />
        ) : (
          <DateFilterChip
            key={cfg.id}
            cfg={cfg}
            from={state[cfg.id]?.from ?? ""}
            to={state[cfg.id]?.to ?? ""}
            onChange={(from, to) =>
              onStateChange({
                ...state,
                [cfg.id]: { from: from || undefined, to: to || undefined },
              })
            }
            editable={editable}
            onRemove={() => onConfigsChange?.(configs.filter((c) => c.id !== cfg.id))}
          />
        ),
      )}
      {cross && (
        <Badge variant="secondary" className="gap-1 text-[10px]">
          {cross.column}: {cross.value}
          <button type="button" onClick={onClearCross} title="Clear cross-filter">
            <X className="h-2.5 w-2.5" />
          </button>
        </Badge>
      )}
      {anyActive && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px] text-muted-foreground"
          onClick={() => {
            onStateChange({});
            onClearCross();
          }}
        >
          Clear all
        </Button>
      )}
      {editable && (
        <>
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 border-dashed px-2 text-[10px]"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="h-2.5 w-2.5" /> Add filter
          </Button>
          <AddFilterDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            widgets={widgets}
            onAdd={(cfg) => onConfigsChange?.([...configs, cfg])}
          />
        </>
      )}
    </div>
  );
}

function SelectFilterChip({
  cfg,
  widgets,
  selected,
  onChange,
  editable,
  onRemove,
}: {
  cfg: BiFilterConfig;
  widgets: BiWidget[];
  selected: string[];
  onChange: (values: string[]) => void;
  editable: boolean;
  onRemove: () => void;
}) {
  const options = useMemo(() => filterOptions(cfg.column, widgets), [cfg.column, widgets]);
  const active = selected.length > 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant={active ? "secondary" : "outline"}
          className="h-6 gap-1 px-2 text-[10px]"
        >
          <ListFilter className="h-2.5 w-2.5" />
          {cfg.label || cfg.column}
          {active ? `: ${selected.length} selected` : ""}
          <ChevronDown className="h-2.5 w-2.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div className="max-h-56 space-y-0.5 overflow-y-auto">
          {options.length === 0 && (
            <p className="px-1 py-2 text-[11px] text-muted-foreground">
              No values found for “{cfg.column}”.
            </p>
          )}
          {options.map((v) => {
            const checked = selected.includes(v);
            return (
              <Label
                key={v}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs font-normal hover:bg-muted/60"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(on) =>
                    onChange(on ? [...selected, v] : selected.filter((x) => x !== v))
                  }
                />
                <span className="truncate">{v}</span>
              </Label>
            );
          })}
        </div>
        <div className="mt-1.5 flex items-center justify-between border-t border-border/50 pt-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={() => onChange([])}
          >
            Clear
          </Button>
          {editable && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              title="Remove this filter from the dashboard"
            >
              <Trash2 className="mr-1 h-2.5 w-2.5" /> Remove filter
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DateFilterChip({
  cfg,
  from,
  to,
  onChange,
  editable,
  onRemove,
}: {
  cfg: BiFilterConfig;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  editable: boolean;
  onRemove: () => void;
}) {
  const active = Boolean(from || to);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant={active ? "secondary" : "outline"}
          className="h-6 gap-1 px-2 text-[10px]"
        >
          <CalendarDays className="h-2.5 w-2.5" />
          {cfg.label || cfg.column}
          {active ? `: ${from || "…"} → ${to || "…"}` : ""}
          <ChevronDown className="h-2.5 w-2.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 space-y-2 p-3">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">From</Label>
          <Input
            type="date"
            value={from}
            onChange={(e) => onChange(e.target.value, to)}
            className="h-7 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">To</Label>
          <Input
            type="date"
            value={to}
            onChange={(e) => onChange(from, e.target.value)}
            className="h-7 text-xs"
          />
        </div>
        <div className="flex items-center justify-between border-t border-border/50 pt-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={() => onChange("", "")}
          >
            Clear
          </Button>
          {editable && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] text-muted-foreground hover:text-destructive"
              onClick={onRemove}
            >
              <Trash2 className="mr-1 h-2.5 w-2.5" /> Remove filter
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AddFilterDialog({
  open,
  onOpenChange,
  widgets,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  widgets: BiWidget[];
  onAdd: (cfg: BiFilterConfig) => void;
}) {
  const [label, setLabel] = useState("");
  const [column, setColumn] = useState("");
  const [kind, setKind] = useState<BiFilterKind>("select");

  const columns = useMemo(() => {
    const seen = new Set<string>();
    for (const w of widgets) {
      if (w.kind !== "chart") continue;
      for (const c of w.columns ?? []) seen.add(c);
    }
    return [...seen].sort();
  }, [widgets]);

  function submit() {
    if (!column) return toast.error("Pick the column this filter applies to");
    onAdd({
      id: crypto.randomUUID(),
      label: label.trim() || column,
      column,
      kind,
    });
    setLabel("");
    setColumn("");
    setKind("select");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add dashboard filter</DialogTitle>
          <DialogDescription>
            Filters apply to every widget that contains the chosen column; other widgets are
            unaffected.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Column</Label>
            <Select value={column || undefined} onValueChange={setColumn}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a column" />
              </SelectTrigger>
              <SelectContent>
                {columns.map((c) => (
                  <SelectItem key={c} value={c} className="font-mono text-xs">
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as BiFilterKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="select">Values (multi-select)</SelectItem>
                <SelectItem value="daterange">Date range</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Label (optional)</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={column || "Region"}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Add filter</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
