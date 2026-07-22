// Dashboard filter bar: renders the owner-defined filters (value slicers,
// date ranges with relative presets, numeric ranges) plus the active
// cross-filter chip. Selections are runtime state applied client-side to
// widget snapshots — works identically in the editor, the shared read-only
// view and the public page. Owners can pin any selection as the filter's
// saved default, applied whenever a viewer opens the dashboard.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CalendarDays,
  ChevronDown,
  Filter,
  Hash,
  ListFilter,
  Pin,
  Plus,
  Trash2,
  X,
} from "lucide-react";

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
  DATE_PRESETS,
  filterOptions,
  presetRange,
  type BiCrossFilter,
  type BiFilterConfig,
  type BiFilterDefault,
  type BiFilterKind,
  type BiFilterState,
  type BiWidget,
} from "@/lib/biDashboards";

/** Footer shared by every chip: clear, save-default (owners), remove. */
function ChipFooter({
  onClear,
  editable,
  hasDefault,
  onSaveDefault,
  onClearDefault,
  onRemove,
}: {
  onClear: () => void;
  editable: boolean;
  hasDefault: boolean;
  onSaveDefault?: () => void;
  onClearDefault?: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="mt-1.5 space-y-1 border-t border-border/50 pt-1.5">
      <div className="flex items-center justify-between">
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={onClear}>
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
      {editable && (
        <div className="flex items-center justify-between">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px] text-muted-foreground"
            onClick={onSaveDefault}
            title="Viewers will see this selection applied when they open the dashboard"
          >
            <Pin className="mr-1 h-2.5 w-2.5" /> Save as default
          </Button>
          {hasDefault && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] text-muted-foreground"
              onClick={onClearDefault}
            >
              Clear default
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

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
      return (
        st &&
        ((st.values?.length ?? 0) > 0 ||
          st.from ||
          st.to ||
          st.min !== undefined ||
          st.max !== undefined)
      );
    });

  // Owners: persist a filter's saved default into its config.
  const setDefault = (cfgId: string, def: BiFilterDefault | null) => {
    onConfigsChange?.(
      configs.map((c) => (c.id === cfgId ? { ...c, default: def === null ? undefined : def } : c)),
    );
  };

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
            onSetDefault={(def) => setDefault(cfg.id, def)}
            onRemove={() => onConfigsChange?.(configs.filter((c) => c.id !== cfg.id))}
          />
        ) : cfg.kind === "numrange" ? (
          <NumFilterChip
            key={cfg.id}
            cfg={cfg}
            min={state[cfg.id]?.min}
            max={state[cfg.id]?.max}
            onChange={(min, max) => onStateChange({ ...state, [cfg.id]: { min, max } })}
            editable={editable}
            onSetDefault={(def) => setDefault(cfg.id, def)}
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
            onSetDefault={(def) => setDefault(cfg.id, def)}
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
  onSetDefault,
  onRemove,
}: {
  cfg: BiFilterConfig;
  widgets: BiWidget[];
  selected: string[];
  onChange: (values: string[]) => void;
  editable: boolean;
  onSetDefault: (def: BiFilterDefault | null) => void;
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
        <ChipFooter
          onClear={() => onChange([])}
          editable={editable}
          hasDefault={Boolean(cfg.default)}
          onSaveDefault={() => onSetDefault(selected.length > 0 ? { values: selected } : null)}
          onClearDefault={() => onSetDefault(null)}
          onRemove={onRemove}
        />
      </PopoverContent>
    </Popover>
  );
}

function NumFilterChip({
  cfg,
  min,
  max,
  onChange,
  editable,
  onSetDefault,
  onRemove,
}: {
  cfg: BiFilterConfig;
  min: number | undefined;
  max: number | undefined;
  onChange: (min: number | undefined, max: number | undefined) => void;
  editable: boolean;
  onSetDefault: (def: BiFilterDefault | null) => void;
  onRemove: () => void;
}) {
  const active = min !== undefined || max !== undefined;
  const parse = (v: string) => {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant={active ? "secondary" : "outline"}
          className="h-6 gap-1 px-2 text-[10px]"
        >
          <Hash className="h-2.5 w-2.5" />
          {cfg.label || cfg.column}
          {active ? `: ${min ?? "…"} – ${max ?? "…"}` : ""}
          <ChevronDown className="h-2.5 w-2.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 space-y-2 p-3">
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Min
            </Label>
            <Input
              type="number"
              value={min ?? ""}
              onChange={(e) => onChange(parse(e.target.value), max)}
              className="h-7 text-xs"
              placeholder="any"
            />
          </div>
          <div className="flex-1 space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Max
            </Label>
            <Input
              type="number"
              value={max ?? ""}
              onChange={(e) => onChange(min, parse(e.target.value))}
              className="h-7 text-xs"
              placeholder="any"
            />
          </div>
        </div>
        <ChipFooter
          onClear={() => onChange(undefined, undefined)}
          editable={editable}
          hasDefault={Boolean(cfg.default)}
          onSaveDefault={() => onSetDefault(active ? { min, max } : null)}
          onClearDefault={() => onSetDefault(null)}
          onRemove={onRemove}
        />
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
  onSetDefault,
  onRemove,
}: {
  cfg: BiFilterConfig;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  editable: boolean;
  onSetDefault: (def: BiFilterDefault | null) => void;
  onRemove: () => void;
}) {
  const active = Boolean(from || to);
  // Which preset (if any) the current selection matches — drives both the
  // highlighted preset button and preset-relative default saving.
  const activePreset = DATE_PRESETS.find((p) => {
    const r = presetRange(p.id);
    return r.from === from && r.to === to;
  })?.id;
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
        <div className="flex flex-wrap gap-1">
          {DATE_PRESETS.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant={activePreset === p.id ? "secondary" : "outline"}
              className="h-6 px-2 text-[10px]"
              onClick={() => {
                const r = presetRange(p.id);
                onChange(r.from, r.to);
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>
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
        <ChipFooter
          onClear={() => onChange("", "")}
          editable={editable}
          hasDefault={Boolean(cfg.default)}
          onSaveDefault={() =>
            onSetDefault(
              activePreset
                ? { preset: activePreset }
                : from || to
                  ? { from: from || undefined, to: to || undefined }
                  : null,
            )
          }
          onClearDefault={() => onSetDefault(null)}
          onRemove={onRemove}
        />
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
                <SelectItem value="daterange">Date range (with presets)</SelectItem>
                <SelectItem value="numrange">Numeric range (min / max)</SelectItem>
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
