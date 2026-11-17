// One table column's style (R498): how its cells are drawn — value, data bar,
// picture or link — and its conditional colours, icons and row highlight.
// Opens from the column's row in the builder's "Column formats" list.
import type React from "react";
import { Paintbrush } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { BiCondFormatEditor } from "@/components/bi/BiCondFormatEditor";
import type { BiColumnFormat, BiCondRule } from "@/lib/biAgent";
import { cn } from "@/lib/utils";

/** True when the column has any style (or its own title) beyond its number format. */
function hasColumnStyle(f: BiColumnFormat | undefined): boolean {
  return Boolean(f?.display || f?.cond || f?.rowHighlight || f?.label || f?.prefix || f?.suffix);
}

export function BiColumnStyle({
  column,
  pivot = false,
  value,
  onChange,
}: {
  column: string;
  /** A pivot's measure (R506): a number in each cell, so no picture, link,
   *  data bar, text rule or whole-row colour. */
  pivot?: boolean;
  value: BiColumnFormat;
  onChange: (next: BiColumnFormat) => void;
}) {
  const cond = value.cond;
  const mode = cond?.mode ?? "none";
  const rules: BiCondRule[] = cond?.mode === "rules" ? cond.rules : [];
  const scaleColor = cond?.mode === "scale" ? (cond.color ?? "blue") : "blue";

  const setMode = (m: string) => {
    if (m === "none") onChange({ ...value, cond: undefined, rowHighlight: undefined });
    else if (m === "scale")
      onChange({ ...value, cond: { mode: "scale", color: scaleColor }, rowHighlight: undefined });
    else onChange({ ...value, cond: { mode: "rules", rules } });
  };
  const setRules: React.Dispatch<React.SetStateAction<BiCondRule[]>> = (action) => {
    const next = typeof action === "function" ? action(rules) : action;
    onChange({ ...value, cond: { mode: "rules", rules: next } });
  };

  const styled = hasColumnStyle(value);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn("h-7 w-7 shrink-0 p-0", styled && "text-primary")}
          aria-label={`Style the ${column} column`}
          title="Cell style: data bar, picture, link, colours and icons"
        >
          <Paintbrush className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      {/* Opens beside the builder pane, over the dashboard, and scrolls:
          FOUND IN R498's UI test, a column near the bottom of the list opened
          its editor below the window, and the rules it grows were out of
          reach. */}
      <PopoverContent
        side="left"
        align="start"
        collisionPadding={8}
        className="max-h-[var(--radix-popover-content-available-height)] w-[360px] space-y-3 overflow-y-auto p-3"
      >
        <p className="truncate text-xs font-semibold" title={column}>
          {column}
        </p>
        <div className="space-y-1">
          <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {pivot ? "Title" : "Column title"}
          </Label>
          <Input
            value={value.label ?? ""}
            onChange={(e) => onChange({ ...value, label: e.target.value || undefined })}
            placeholder={column}
            aria-label={`Title of the ${column} column`}
            className="h-8 text-xs"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Before the value
            </Label>
            <Input
              value={value.prefix ?? ""}
              onChange={(e) => onChange({ ...value, prefix: e.target.value || undefined })}
              placeholder="e.g. P"
              aria-label={`Text before each ${column} value`}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              After the value
            </Label>
            <Input
              value={value.suffix ?? ""}
              onChange={(e) => onChange({ ...value, suffix: e.target.value || undefined })}
              placeholder="e.g.  pts"
              aria-label={`Text after each ${column} value`}
              className="h-8 text-xs"
            />
          </div>
        </div>
        <div className={cn("space-y-1", pivot && "hidden")}>
          <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Show as
          </Label>
          <Select
            value={value.display ?? "value"}
            onValueChange={(v) =>
              onChange({
                ...value,
                display: v === "value" ? undefined : (v as BiColumnFormat["display"]),
              })
            }
          >
            <SelectTrigger className="h-8 text-xs" aria-label={`Show ${column} as`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="value" className="text-xs">
                The value
              </SelectItem>
              <SelectItem value="bar" className="text-xs">
                Data bar (numbers)
              </SelectItem>
              <SelectItem value="image" className="text-xs">
                Picture from a URL
              </SelectItem>
              <SelectItem value="link" className="text-xs">
                Link to a URL
              </SelectItem>
            </SelectContent>
          </Select>
          {(value.display === "image" || value.display === "link") && (
            <p className="text-[10px] text-muted-foreground">
              Only https:// and http:// addresses are drawn
              {value.display === "image" ? " (and image data)" : " (and mailto:)"}; anything else
              shows as text.
            </p>
          )}
        </div>
        <BiCondFormatEditor
          matFmtMode={mode}
          setMatFmtMode={setMode}
          matScaleColor={scaleColor}
          setMatScaleColor={(c) => onChange({ ...value, cond: { mode: "scale", color: c } })}
          matRules={rules}
          setMatRules={setRules}
          withIcons
          allowText={!pivot}
          totalsNote={false}
        />
        {mode === "rules" && !pivot && (
          <Label className="flex cursor-pointer items-center gap-2 text-xs font-normal">
            <Checkbox
              checked={Boolean(value.rowHighlight)}
              onCheckedChange={(v) => onChange({ ...value, rowHighlight: v ? true : undefined })}
            />
            Colour the whole row when a rule matches
          </Label>
        )}
      </PopoverContent>
    </Popover>
  );
}
