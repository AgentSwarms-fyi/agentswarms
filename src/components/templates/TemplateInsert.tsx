// Insert a template reference instead of typing it (R495).
//
// Many fields take a `{{…}}` reference: a swarm node reads `{{input}}` or an
// earlier step's output, a report footer reads `{{page}}`. The text stays text
// — a prompt or a URL is genuinely free text — but the reference is picked from
// a list of the ones that exist here and put at the cursor, so nobody has to
// remember a spelling or a variable's name. The workflow editor already did
// this for `{{ params.x }}` (components/workflows/inspectorFields.tsx); this is
// the same idea for every other kind of reference.
import { Braces } from "lucide-react";
import { useState, type ReactNode } from "react";

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
import { Textarea } from "@/components/ui/textarea";
import { useInsertAtCaret } from "@/hooks/use-insert-at-caret";
import { cn } from "@/lib/utils";

export type TemplateToken = {
  /** Exactly what goes into the field, e.g. `{{input}}`. */
  insert: string;
  /** What the menu shows, e.g. `input`. */
  label: string;
  /** Where the value comes from, in a few words. */
  detail?: string;
  /** The heading the menu lists it under. */
  group?: string;
};

/**
 * The menu: a small "{ } Variable" button that lists what can be referenced
 * here, grouped and searchable, and hands the picked one's text to `onPick`.
 */
export function TemplateInsertMenu({
  tokens,
  onPick,
  label = "Variable",
  fieldLabel,
  emptyNote,
  className,
}: {
  tokens: TemplateToken[];
  onPick: (text: string) => void;
  /** The button's word, e.g. "Variable", "Token", "Parameter". */
  label?: string;
  /** The field it inserts into, for the button's accessible name. */
  fieldLabel?: string;
  /** Shown under the list, e.g. how to make more appear. */
  emptyNote?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const groups = new Map<string, TemplateToken[]>();
  for (const t of tokens) {
    const g = t.group ?? "";
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // Keep the field's cursor where it is: focus moving to the button
          // would otherwise be harmless, but a mousedown on some browsers
          // collapses the field's selection first.
          onMouseDown={(e) => e.preventDefault()}
          aria-label={`Insert a ${label.toLowerCase()}${fieldLabel ? ` into ${fieldLabel}` : ""}`}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-md border border-dashed px-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground",
            className,
          )}
        >
          <Braces className="h-3 w-3" aria-hidden />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}s…`} className="h-8 text-xs" />
          <CommandList className="max-h-72">
            <CommandEmpty className="px-3 py-3 text-xs text-muted-foreground">
              Nothing matches.
            </CommandEmpty>
            {[...groups].map(([group, items]) => (
              <CommandGroup key={group || "_"} heading={group || undefined}>
                {items.map((t) => (
                  <CommandItem
                    key={t.insert}
                    value={`${t.label} ${t.detail ?? ""} ${t.insert}`}
                    onSelect={() => {
                      onPick(t.insert);
                      setOpen(false);
                    }}
                    className="flex flex-col items-start gap-0"
                  >
                    <span className="font-mono text-xs">{t.label}</span>
                    {t.detail ? (
                      <span className="text-[10px] text-muted-foreground">{t.detail}</span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          {emptyNote ? (
            <p className="border-t px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
              {emptyNote}
            </p>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A text field (one line, or several with `rows`) with the menu above it on
 * the right, and an optional line under it saying what the field takes.
 */
export function TemplateText({
  value,
  onChange,
  tokens,
  rows,
  placeholder,
  ariaLabel,
  menuLabel,
  emptyNote,
  hint,
  toolbar,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  tokens: TemplateToken[];
  /** Several lines; one line when omitted. */
  rows?: number;
  placeholder?: string;
  ariaLabel: string;
  menuLabel?: string;
  emptyNote?: ReactNode;
  /** What the field takes, under it. */
  hint?: ReactNode;
  /** Other controls for the row above the field, left of the menu. */
  toolbar?: ReactNode;
  className?: string;
}) {
  const { ref, insert } = useInsertAtCaret<HTMLInputElement & HTMLTextAreaElement>(value, onChange);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-end gap-1">
        {toolbar}
        <TemplateInsertMenu
          tokens={tokens}
          onPick={insert}
          label={menuLabel}
          fieldLabel={ariaLabel.toLowerCase()}
          emptyNote={emptyNote}
        />
      </div>
      {rows ? (
        <Textarea
          ref={ref}
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={cn("font-mono text-xs", className)}
        />
      ) : (
        <Input
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={cn("font-mono text-xs", className)}
        />
      )}
      {hint ? <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
