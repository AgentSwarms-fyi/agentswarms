// The table a visual is built from, picked by searching (R499).
//
// FOUND IN R499's UI test: Fields mode opened with a plain select over every
// dataset in the workspace — about a hundred on the test account, in creation
// order, with no search. Type-ahead jumped to the first table starting with
// the first letter typed (analytics_authz_probe for "saas_sales"), so finding
// a table meant scrolling the whole list. This filters as you type, on any
// part of the name, and says how many columns each table has.
import { useState } from "react";
import { Check, ChevronsUpDown, Table2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function BiTableCombobox({
  tables,
  value,
  onChange,
}: {
  tables: { name: string; cols: string[] }[];
  value: string;
  onChange: (table: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? tables.filter((t) => t.name.toLowerCase().includes(q)) : tables;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label="Table to build from"
          className="h-8 w-full justify-between gap-1.5 px-2 text-xs font-normal"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Table2 className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
            {value ? (
              <span className="truncate font-mono">{value}</span>
            ) : (
              <span className="text-muted-foreground">Pick a table</span>
            )}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      {/* The builder's Add button is pinned to the pane's foot; keep the list
          clear of it, so near the bottom it opens upward instead. */}
      <PopoverContent
        className="w-[--radix-popover-trigger-width] min-w-[16rem] p-0"
        align="start"
        collisionPadding={{ bottom: 80, top: 8 }}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search tables…"
            value={query}
            onValueChange={setQuery}
            autoFocus
          />
          <CommandList className="max-h-72">
            {shown.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                {tables.length === 0
                  ? "This source has no tables yet."
                  : `No table matches “${query.trim()}”.`}
              </p>
            ) : (
              shown.map((t) => (
                <CommandItem
                  key={t.name}
                  value={t.name}
                  onSelect={() => {
                    onChange(t.name);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-3.5 w-3.5 shrink-0",
                      t.name === value ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{t.name}</span>
                  <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                    {t.cols.length} {t.cols.length === 1 ? "column" : "columns"}
                  </span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
