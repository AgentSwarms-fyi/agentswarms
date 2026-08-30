// Structured editors for ETL transform configuration.
//
// WHY THIS EXISTS. Every transform used to be configured by typing into a text
// box: comma-separated column lists, `old:new` pairs for a rename, and — worst
// of all — `column:fn:alias` one-per-line for an aggregate. That format is
// invisible until you already know it, silently drops a line with a typo (the
// parser required all three parts and skipped anything else), and gives no clue
// which column names are even available. A visual canvas that then asks you to
// hand-write its own micro-syntax is a canvas in name only.
//
// These editors keep the same stored config shape — the compiler is untouched —
// and only change how it is entered: a picker per column, a dropdown per
// function, one row per thing, with add and remove buttons.
//
// The free-text escape hatch stays everywhere. Column names are only KNOWN once
// something has run a preview (or the source could be resolved), so a picker
// that refused unknown names would be unusable on a pipeline you are still
// building. Typing a name the list doesn't have is offered as an explicit row
// rather than rejected.
import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Columns we know about for the node being configured, if anything found them. */
export type ColumnHints = string[];

function hintNote(columns: ColumnHints): string {
  return columns.length
    ? `${columns.length} column(s) from the last preview`
    : "Run Preview data to load column names — or type them";
}

// ── One column ──────────────────────────────────────────────────────────────

export function ColumnCombo({
  value,
  onChange,
  columns,
  placeholder = "column",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  columns: ColumnHints;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const listed = columns.filter((c) => !q || c.toLowerCase().includes(q));
    // A name that isn't in the list is still legitimate — offer it explicitly
    // instead of making the box look broken.
    const custom = query.trim() && !columns.includes(query.trim()) ? [query.trim()] : [];
    return { listed, custom };
  }, [columns, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "h-7 justify-between px-2 font-mono text-xs font-normal",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <span className="truncate">{value || placeholder}</span>
          <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search or type a column…"
            value={query}
            onValueChange={setQuery}
            className="h-8 text-xs"
          />
          <CommandList>
            <CommandEmpty className="px-3 py-2 text-xs text-muted-foreground">
              {hintNote(columns)}
            </CommandEmpty>
            {options.custom.length > 0 && (
              <CommandGroup heading="Use this name">
                {options.custom.map((c) => (
                  <CommandItem
                    key={c}
                    value={c}
                    onSelect={() => {
                      onChange(c);
                      setQuery("");
                      setOpen(false);
                    }}
                    className="font-mono text-xs"
                  >
                    {c}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {options.listed.length > 0 && (
              <CommandGroup heading="Columns">
                {options.listed.map((c) => (
                  <CommandItem
                    key={c}
                    value={c}
                    onSelect={() => {
                      onChange(c);
                      setQuery("");
                      setOpen(false);
                    }}
                    className="font-mono text-xs"
                  >
                    <Check
                      className={cn("mr-1 h-3 w-3", value === c ? "opacity-100" : "opacity-0")}
                    />
                    {c}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── Many columns ────────────────────────────────────────────────────────────

export function ColumnChips({
  value,
  onChange,
  columns,
  emptyMeans,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  columns: ColumnHints;
  /** Shown when nothing is picked, e.g. "all columns". */
  emptyMeans?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const picked = value ?? [];

  const toggle = (col: string) =>
    onChange(picked.includes(col) ? picked.filter((c) => c !== col) : [...picked, col]);

  const q = query.trim();
  const listed = columns.filter((c) => !q || c.toLowerCase().includes(q.toLowerCase()));
  const custom = q && !columns.includes(q) && !picked.includes(q) ? q : null;

  return (
    <div className="space-y-1.5">
      {picked.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {picked.map((c, i) => (
            <Badge key={c} variant="secondary" className="gap-1 py-0 pr-1 font-mono text-[10px]">
              {picked.length > 1 && <span className="text-muted-foreground">{i + 1}</span>}
              {c}
              <button
                type="button"
                aria-label={`Remove ${c}`}
                onClick={() => onChange(picked.filter((x) => x !== c))}
                className="rounded-sm hover:bg-muted-foreground/20"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </Badge>
          ))}
        </div>
      ) : (
        emptyMeans && <p className="text-[11px] text-muted-foreground">{emptyMeans}</p>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 w-full justify-start px-2 text-xs">
            <Plus className="mr-1 h-3 w-3" /> Add column
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search or type a column…"
              value={query}
              onValueChange={setQuery}
              className="h-8 text-xs"
            />
            <CommandList>
              <CommandEmpty className="px-3 py-2 text-xs text-muted-foreground">
                {hintNote(columns)}
              </CommandEmpty>
              {custom && (
                <CommandGroup heading="Use this name">
                  <CommandItem
                    value={custom}
                    onSelect={() => {
                      toggle(custom);
                      setQuery("");
                    }}
                    className="font-mono text-xs"
                  >
                    {custom}
                  </CommandItem>
                </CommandGroup>
              )}
              {listed.length > 0 && (
                <CommandGroup heading="Columns">
                  {listed.map((c) => (
                    <CommandItem
                      key={c}
                      value={c}
                      onSelect={() => toggle(c)}
                      className="font-mono text-xs"
                    >
                      <Check
                        className={cn(
                          "mr-1 h-3 w-3",
                          picked.includes(c) ? "opacity-100" : "opacity-0",
                        )}
                      />
                      {c}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ── Aggregations ────────────────────────────────────────────────────────────

export type AggRow = { column: string; fn: string; as: string };

/** Suggest an output name so the alias is never the reason a row is invalid. */
function defaultAlias(column: string, fn: string): string {
  if (!column) return fn === "count" ? "count" : "";
  return fn === "count" ? `${column}_count` : `${fn}_${column}`;
}

export function AggregationsEditor({
  value,
  onChange,
  columns,
  functions,
}: {
  value: AggRow[];
  onChange: (v: AggRow[]) => void;
  columns: ColumnHints;
  functions: readonly string[];
}) {
  const rows = value ?? [];
  const patch = (i: number, p: Partial<AggRow>) =>
    onChange(
      rows.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r, ...p };
        // Keep the alias in step while the user hasn't chosen one of their own.
        if ((p.column || p.fn) && (!r.as || r.as === defaultAlias(r.column, r.fn))) {
          next.as = defaultAlias(next.column, next.fn);
        }
        return next;
      }),
    );

  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        // Two lines per row: the panel is too narrow to fit function, column
        // and output name side by side without truncating the column to "am…".
        <div key={i} className="space-y-1 rounded-md border p-1.5">
          <div className="flex items-center gap-1">
            <Select value={r.fn} onValueChange={(v) => patch(i, { fn: v })}>
              <SelectTrigger className="h-7 w-[92px] shrink-0 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {functions.map((f) => (
                  <SelectItem key={f} value={f} className="text-xs">
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ColumnCombo
              value={r.column}
              onChange={(v) => patch(i, { column: v })}
              columns={columns}
              className="min-w-0 flex-1"
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-6 shrink-0"
              aria-label="Remove aggregation"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-[92px] shrink-0 pl-1 text-[10px] text-muted-foreground">
              output name
            </span>
            <Input
              value={r.as}
              onChange={(e) => patch(i, { as: e.target.value })}
              placeholder={defaultAlias(r.column, r.fn) || "name"}
              className="h-7 min-w-0 flex-1 px-2 font-mono text-xs"
            />
          </div>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        className="h-7 w-full text-xs"
        onClick={() => onChange([...rows, { column: "", fn: functions[0] ?? "sum", as: "" }])}
      >
        <Plus className="mr-1 h-3 w-3" /> Add aggregation
      </Button>
      {rows.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          Without one, the group-by columns come back on their own.
        </p>
      )}
    </div>
  );
}

// ── Renames ─────────────────────────────────────────────────────────────────

export function RenameEditor({
  value,
  onChange,
  columns,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  columns: ColumnHints;
}) {
  // Edited as a list so a half-typed row can exist; an empty key is simply
  // not stored, rather than being silently dropped mid-keystroke.
  const rows = Object.entries(value ?? {});
  const write = (next: [string, string][]) => {
    const out: Record<string, string> = {};
    for (const [from, to] of next) if (from.trim()) out[from.trim()] = to.trim();
    onChange(out);
  };

  return (
    <div className="space-y-1.5">
      {rows.map(([from, to], i) => (
        <div key={i} className="flex items-center gap-1">
          <ColumnCombo
            value={from}
            onChange={(v) => {
              const next = [...rows] as [string, string][];
              next[i] = [v, to];
              write(next);
            }}
            columns={columns}
            className="min-w-0 flex-1"
          />
          <span className="shrink-0 text-[10px] text-muted-foreground">→</span>
          <Input
            value={to}
            onChange={(e) => {
              const next = [...rows] as [string, string][];
              next[i] = [from, e.target.value];
              write(next);
            }}
            placeholder="new name"
            className="h-7 min-w-0 flex-1 px-2 font-mono text-xs"
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-6 shrink-0"
            aria-label="Remove rename"
            onClick={() => write(rows.filter((_, j) => j !== i) as [string, string][])}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        className="h-7 w-full text-xs"
        onClick={() => write([...(rows as [string, string][]), ["", ""]])}
      >
        <Plus className="mr-1 h-3 w-3" /> Add rename
      </Button>
    </div>
  );
}
