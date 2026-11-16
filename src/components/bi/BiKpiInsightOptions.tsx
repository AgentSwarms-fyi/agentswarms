// Builder options for the R498 visuals: a KPI's period comparison, and the
// narrative widget's kind, fields and sentence. Kept out of BiBuilderPane,
// which owns one piece of state per field already; these hold theirs as one
// object each and hand the spec fields back.
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
import { TemplateText, type TemplateToken } from "@/components/templates/TemplateInsert";
import type { BiInsightKind, BiKpiCompare } from "@/lib/biAgent";
import { INSIGHT_KINDS, INSIGHT_TOKENS } from "@/lib/biInsights";
import {
  insightNeedsCategory,
  insightNeedsDate,
  type InsightOpts,
  type KpiOpts,
} from "@/lib/biKpiInsightOpts";

const sectionLabel = "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground";

function ColumnPick({
  label,
  value,
  onChange,
  columns,
  optional,
  ariaLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  columns: string[];
  optional?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className={sectionLabel}>{label}</Label>
      <Select
        value={value || (optional ? "__none__" : undefined)}
        onValueChange={(v) => onChange(v === "__none__" ? "" : v)}
      >
        <SelectTrigger className="h-8 text-xs" aria-label={ariaLabel ?? label}>
          <SelectValue placeholder="Pick a column" />
        </SelectTrigger>
        <SelectContent>
          {optional && (
            <SelectItem value="__none__" className="text-xs">
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

function GrainPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className={sectionLabel}>Period</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 text-xs" aria-label="Period grain">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto" className="text-xs">
            As the rows are
          </SelectItem>
          {(["day", "week", "month", "quarter", "year"] as const).map((g) => (
            <SelectItem key={g} value={g} className="text-xs">
              {g[0].toUpperCase() + g.slice(1)} (sum)
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Label className="flex cursor-pointer items-center gap-2 text-xs font-normal normal-case tracking-normal text-foreground">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(Boolean(v))} />
      {children}
    </Label>
  );
}

/** KPI: the period column and what the latest period is compared with. */
export function BiKpiOptions({
  opts,
  setOpts,
  columns,
  grain,
  setGrain,
}: {
  opts: KpiOpts;
  setOpts: (next: KpiOpts) => void;
  columns: string[];
  grain: string;
  setGrain: (v: string) => void;
}) {
  return (
    <div className="col-span-2 space-y-2 rounded-md border border-border/60 p-2">
      <ColumnPick
        label="Date — compare periods"
        ariaLabel="KPI date column"
        value={opts.dateField}
        onChange={(v) => setOpts({ ...opts, dateField: v })}
        columns={columns}
        optional
      />
      {opts.dateField ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className={sectionLabel}>Compare with</Label>
              <Select
                value={opts.compareTo}
                onValueChange={(v) => setOpts({ ...opts, compareTo: v as BiKpiCompare })}
              >
                <SelectTrigger className="h-8 text-xs" aria-label="Compare the latest period with">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="previous" className="text-xs">
                    The period before
                  </SelectItem>
                  <SelectItem value="year" className="text-xs">
                    Same period last year
                  </SelectItem>
                  <SelectItem value="none" className="text-xs">
                    Nothing
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <GrainPick value={grain} onChange={setGrain} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            <Toggle checked={opts.sparkline} onChange={(v) => setOpts({ ...opts, sparkline: v })}>
              Trend line
            </Toggle>
            <Toggle
              checked={opts.lowerIsBetter}
              onChange={(v) => setOpts({ ...opts, lowerIsBetter: v })}
            >
              Lower is better
            </Toggle>
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            The tile shows the latest period. Group the query by the date (one row per period), or
            pick a period to add the rows up.
          </p>
        </>
      ) : (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Pick a date to show the latest period, its change against the one before and a trend line.
          Without one the tile shows the first row.
        </p>
      )}
    </div>
  );
}

/** Narrative: which sentence, over which columns, and the author's own wording. */
export function BiInsightOptions({
  opts,
  setOpts,
  columns,
  valueField,
  setValueField,
  label,
  setLabel,
  grain,
  setGrain,
}: {
  opts: InsightOpts;
  setOpts: (next: InsightOpts) => void;
  columns: string[];
  valueField: string;
  setValueField: (v: string) => void;
  /** The measure's name in the sentence. */
  label: string;
  setLabel: (v: string) => void;
  grain: string;
  setGrain: (v: string) => void;
}) {
  const tokens: TemplateToken[] = INSIGHT_TOKENS[opts.kind].map((t) => ({
    insert: `{{${t.token}}}`,
    label: t.token,
    detail: t.detail,
  }));
  const kind = INSIGHT_KINDS.find((k) => k.value === opts.kind);
  return (
    <div className="col-span-2 space-y-2 rounded-md border border-border/60 p-2">
      <div className="space-y-1">
        <Label className={sectionLabel}>Narrative</Label>
        <Select
          value={opts.kind}
          onValueChange={(v) => setOpts({ ...opts, kind: v as BiInsightKind, template: "" })}
        >
          <SelectTrigger className="h-8 text-xs" aria-label="Narrative kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INSIGHT_KINDS.map((k) => (
              <SelectItem key={k.value} value={k.value} className="text-xs">
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {kind && <p className="text-[10px] text-muted-foreground">Needs {kind.needs}.</p>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <ColumnPick
          label="Measure (numeric)"
          ariaLabel="Narrative measure"
          value={valueField}
          onChange={setValueField}
          columns={columns}
        />
        {insightNeedsCategory(opts.kind) && (
          <ColumnPick
            label={opts.kind === "movers" ? "Members" : "Ranked by"}
            ariaLabel="Narrative category column"
            value={opts.categoryField}
            onChange={(v) => setOpts({ ...opts, categoryField: v })}
            columns={columns}
          />
        )}
        {insightNeedsDate(opts.kind) && (
          <ColumnPick
            label="Date"
            ariaLabel="Narrative date column"
            value={opts.dateField}
            onChange={(v) => setOpts({ ...opts, dateField: v })}
            columns={columns}
          />
        )}
        {insightNeedsDate(opts.kind) && <GrainPick value={grain} onChange={setGrain} />}
        {insightNeedsCategory(opts.kind) && (
          <div className="space-y-1">
            <Label className={sectionLabel}>How many</Label>
            <Input
              value={opts.topN}
              onChange={(e) => setOpts({ ...opts, topN: e.target.value })}
              inputMode="numeric"
              aria-label="How many to list"
              className="h-8 text-xs"
              placeholder="3"
            />
          </div>
        )}
        {opts.kind === "growth" && (
          <div className="space-y-1">
            <Label className={sectionLabel}>Over periods</Label>
            <Input
              value={opts.periods}
              onChange={(e) => setOpts({ ...opts, periods: e.target.value })}
              inputMode="numeric"
              aria-label="Periods the growth rate covers"
              className="h-8 text-xs"
              placeholder="all"
            />
          </div>
        )}
      </div>
      <div className="space-y-1">
        <Label className={sectionLabel}>Measure name</Label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="h-8 text-xs"
          placeholder={valueField || "Revenue"}
          aria-label="Measure name in the sentence"
        />
      </div>
      {opts.kind !== "top" && opts.kind !== "bottom" && opts.kind !== "forecast" && (
        <Toggle
          checked={opts.lowerIsBetter}
          onChange={(v) => setOpts({ ...opts, lowerIsBetter: v })}
        >
          Lower is better (a fall shows green)
        </Toggle>
      )}
      <div className="space-y-1">
        <Label className={sectionLabel}>Your own sentence (optional)</Label>
        <TemplateText
          value={opts.template}
          onChange={(v) => setOpts({ ...opts, template: v })}
          tokens={tokens}
          rows={2}
          ariaLabel="Narrative sentence"
          menuLabel="Value"
          searchPlaceholder="Search values…"
          placeholder="Leave empty for the standard sentence"
          hint="Values fill in from the data and follow the dashboard's filters."
          className="font-sans"
        />
      </div>
    </div>
  );
}
