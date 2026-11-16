// Builder controls for the visuals and styles added in R500 (see
// lib/biVisualOpts): card templates with their pictures, the start and end
// of a range, a colour column for lines, rank charts and radial bars, end
// labels and shaded bands, the heatmap's diverging scale, striped tables.
// Templates take their {{column}} values from a menu, as other templates do.
// Owns no state.
import type { ReactNode } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TemplateText, type TemplateToken } from "@/components/templates/TemplateInsert";
import type { BiParamConfig } from "@/lib/biParams";
import { COLOR_FIELD_VISUALS, type VisualOpts } from "@/lib/biVisualOpts";
import { cn } from "@/lib/utils";

const small = "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground";
const NONE = "__none";

function ColumnSelect({
  label,
  value,
  onChange,
  columns,
  optional,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  columns: string[];
  optional?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label className={small}>{label}</Label>
      <Select
        value={value || (optional ? NONE : undefined)}
        onValueChange={(v) => onChange(v === NONE ? "" : v)}
      >
        <SelectTrigger className="h-8 text-xs" aria-label={label}>
          <SelectValue placeholder="Pick a column" />
        </SelectTrigger>
        <SelectContent>
          {optional && (
            <SelectItem value={NONE} className="text-xs">
              None
            </SelectItem>
          )}
          {columns.map((c) => (
            <SelectItem key={c} value={c} className="text-xs">
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function BiVisualOptions({
  type,
  opts,
  setOpts,
  columns,
  params = [],
}: {
  type: string;
  opts: VisualOpts;
  setOpts: (o: VisualOpts) => void;
  columns: string[];
  /** The dashboard's parameters, for a Controls visual (R501). */
  params?: BiParamConfig[];
}) {
  const set = (patch: Partial<VisualOpts>) => setOpts({ ...opts, ...patch });
  const tokens: TemplateToken[] = columns.flatMap((c) => [
    { insert: `{{${c}}}`, label: c, group: "Columns" },
  ]);
  const template = (
    key: "heading" | "title" | "body" | "lead" | "value",
    label: string,
    placeholder: string,
    rows?: number,
  ) => (
    <div className="space-y-1">
      <Label className={small}>{label}</Label>
      <TemplateText
        value={opts[key]}
        onChange={(v) => set({ [key]: v })}
        tokens={tokens}
        rows={rows}
        ariaLabel={label}
        menuLabel="Column"
        searchPlaceholder="Search columns…"
        placeholder={placeholder}
      />
    </div>
  );

  const parts: ReactNode[] = [];

  if (type === "cards") {
    parts.push(
      <div key="cards" className="col-span-2 space-y-2 rounded-md border border-border/60 p-2">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className={small}>Layout</Label>
            <Select
              value={opts.cardsLayout}
              onValueChange={(v) => set({ cardsLayout: v as VisualOpts["cardsLayout"] })}
            >
              <SelectTrigger className="h-8 text-xs" aria-label="Card layout">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tiles" className="text-xs">
                  Side by side (a podium)
                </SelectItem>
                <SelectItem value="rows" className="text-xs">
                  One row each (a list)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className={small}>Cards shown</Label>
            <Input
              value={opts.max}
              onChange={(e) => set({ max: e.target.value })}
              placeholder={opts.cardsLayout === "rows" ? "6" : "4"}
              inputMode="numeric"
              aria-label="Cards shown"
              className="h-8 text-xs"
            />
          </div>
          <ColumnSelect
            label="Picture"
            value={opts.imageField}
            onChange={(v) => set({ imageField: v })}
            columns={columns}
            optional
          />
          <div className="space-y-1">
            <Label className={small}>Small pictures</Label>
            <div className="flex flex-wrap gap-1">
              {columns.map((c) => {
                const on = opts.iconFields.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set({
                        iconFields: on
                          ? opts.iconFields.filter((x) => x !== c)
                          : [...opts.iconFields, c],
                      })
                    }
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px]",
                      on ? "border-primary bg-primary/10 text-primary" : "border-border/60",
                    )}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {opts.cardsLayout === "tiles" && template("heading", "Heading", "**{{position}}** Place")}
        {opts.cardsLayout === "rows" && template("lead", "Number at the start", "{{position}}")}
        {template("title", "Title", "{{given_name}} **{{family_name}}**")}
        {template("body", "Lines under it", "{{race_time}}\n**{{points}}** points", 2)}
        {opts.cardsLayout === "rows" && template("value", "Value at the end", "{{points}} pts")}
        <p className="text-[10px] text-muted-foreground">
          **bold** sets text bold; {"{{column|ordinal}}"} writes 1 as 1st.
        </p>
      </div>,
    );
  }

  if (type === "range") {
    parts.push(
      <div
        key="range"
        className="col-span-2 grid grid-cols-2 gap-2 rounded-md border border-border/60 p-2"
      >
        <ColumnSelect
          label="Each row is"
          value={opts.categoryField}
          onChange={(v) => set({ categoryField: v })}
          columns={columns}
        />
        <ColumnSelect
          label="Label beside it"
          value={opts.labelField}
          onChange={(v) => set({ labelField: v })}
          columns={columns}
          optional
        />
        <ColumnSelect
          label="Started at"
          value={opts.startField}
          onChange={(v) => set({ startField: v })}
          columns={columns}
        />
        <ColumnSelect
          label="Finished at"
          value={opts.endField}
          onChange={(v) => set({ endField: v })}
          columns={columns}
        />
        <Label className="col-span-2 flex cursor-pointer items-center gap-2 text-xs font-normal">
          <Checkbox
            checked={opts.higherIsBetter}
            onCheckedChange={(v) => set({ higherIsBetter: v === true })}
          />
          Higher is better (otherwise a lower number, like a position, is better)
        </Label>
      </div>,
    );
  }

  if (type === "pointmap") {
    parts.push(
      <div
        key="pointmap"
        className="col-span-2 grid grid-cols-2 gap-2 rounded-md border border-border/60 p-2"
      >
        <ColumnSelect
          label="Latitude"
          value={opts.latField}
          onChange={(v) => set({ latField: v })}
          columns={columns}
        />
        <ColumnSelect
          label="Longitude"
          value={opts.lngField}
          onChange={(v) => set({ lngField: v })}
          columns={columns}
        />
        <ColumnSelect
          label="Colour by"
          value={opts.colorField}
          onChange={(v) => set({ colorField: v })}
          columns={columns}
          optional
        />
        <ColumnSelect
          label="Size by"
          value={opts.sizeField}
          onChange={(v) => set({ sizeField: v })}
          columns={columns}
          optional
        />
        <ColumnSelect
          label="Name on hover"
          value={opts.labelField}
          onChange={(v) => set({ labelField: v })}
          columns={columns}
          optional
        />
        <p className="col-span-2 text-[10px] leading-snug text-muted-foreground">
          Colour by a category, or by a column of #rrggbb colours. Double-click or Ctrl + scroll to
          zoom; drag to move.
        </p>
      </div>,
    );
  }

  if (type === "journey") {
    parts.push(
      <div
        key="journey"
        className="col-span-2 grid grid-cols-2 gap-2 rounded-md border border-border/60 p-2"
      >
        <ColumnSelect
          label="Each pin is"
          value={opts.categoryField}
          onChange={(v) => set({ categoryField: v })}
          columns={columns}
        />
        <ColumnSelect
          label="Value in the pin"
          value={opts.measureField}
          onChange={(v) => set({ measureField: v })}
          columns={columns}
        />
        <ColumnSelect
          label="Pin colour from column"
          value={opts.colorField}
          onChange={(v) => set({ colorField: v })}
          columns={columns}
          optional
        />
        <p className="col-span-2 text-[10px] leading-snug text-muted-foreground">
          Pins follow the road in the order the query returns its rows: ORDER BY sets the route.
        </p>
      </div>,
    );
  }

  if (type === "controls") {
    parts.push(
      <div key="controls" className="col-span-2 space-y-2 rounded-md border border-border/60 p-2">
        <Label className={small}>Parameters shown</Label>
        {params.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            This dashboard has no parameters yet. Add one with <strong>Add parameter</strong> in the
            filter bar, then pick it here.
          </p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {params.map((p) => (
              <Label
                key={p.id}
                className="flex cursor-pointer items-center gap-1.5 text-xs font-normal"
              >
                <Checkbox
                  aria-label={`Show ${p.label}`}
                  checked={opts.params.includes(p.name)}
                  onCheckedChange={(v) =>
                    set({
                      params:
                        v === true
                          ? params
                              .map((x) => x.name)
                              .filter((n) => n === p.name || opts.params.includes(n))
                          : opts.params.filter((n) => n !== p.name),
                    })
                  }
                />
                {p.label}
              </Label>
            ))}
          </div>
        )}
        <Label className={small}>Above the controls (Markdown)</Label>
        <Textarea
          aria-label="Above the controls"
          value={opts.intro}
          onChange={(e) => set({ intro: e.target.value })}
          rows={3}
          className="text-xs"
          placeholder="You can use the controls below to see…"
        />
      </div>,
    );
  }

  if (COLOR_FIELD_VISUALS.has(type)) {
    parts.push(
      <ColumnSelect
        key="color"
        label="Colour from column"
        value={opts.colorField}
        onChange={(v) => set({ colorField: v })}
        columns={columns}
        optional
      />,
    );
  }

  if (type === "line") {
    parts.push(
      <Label
        key="endLabels"
        className="flex cursor-pointer items-center gap-2 self-end pb-2 text-xs font-normal"
      >
        <Checkbox
          checked={opts.endLabels}
          onCheckedChange={(v) => set({ endLabels: v === true })}
        />
        Name each line at its end
      </Label>,
    );
  }

  if (type === "line" || type === "bump") {
    parts.push(
      <div key="bands" className="col-span-2 space-y-1">
        <div className="flex items-center justify-between">
          <Label className={small}>Shaded spans</Label>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={() => set({ bands: [...opts.bands, { from: "", to: "", label: "" }] })}
          >
            <Plus className="h-3 w-3" /> Add span
          </Button>
        </div>
        {opts.bands.map((b, i) => (
          <div key={i} className="flex items-center gap-1">
            {(["from", "to", "label"] as const).map((k) => (
              <Input
                key={k}
                value={b[k]}
                onChange={(e) =>
                  set({
                    bands: opts.bands.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)),
                  })
                }
                placeholder={k === "from" ? "From" : k === "to" ? "To" : "Caption"}
                aria-label={`Span ${i + 1} ${k}`}
                className={cn("h-7 text-xs", k === "label" ? "flex-1" : "w-16")}
              />
            ))}
            <button
              type="button"
              aria-label={`Remove span ${i + 1}`}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => set({ bands: opts.bands.filter((_, j) => j !== i) })}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>,
    );
  }

  if (type === "heatmap") {
    parts.push(
      <div key="heat" className="space-y-1">
        <Label className={small}>Colours</Label>
        <Select
          value={opts.heatScale}
          onValueChange={(v) => set({ heatScale: v as VisualOpts["heatScale"] })}
        >
          <SelectTrigger className="h-8 text-xs" aria-label="Heatmap colours">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sequential" className="text-xs">
              Low to high
            </SelectItem>
            <SelectItem value="diverging" className="text-xs">
              Green below zero, red above
            </SelectItem>
          </SelectContent>
        </Select>
      </div>,
    );
  }

  if (type === "table") {
    parts.push(
      <Label key="striped" className="flex cursor-pointer items-center gap-2 text-xs font-normal">
        <Checkbox checked={opts.striped} onCheckedChange={(v) => set({ striped: v === true })} />
        Shade alternate rows
      </Label>,
    );
  }

  return parts.length ? <>{parts}</> : null;
}
