// The report designer's R508 controls: the report's parameters, the bar that
// runs the report with chosen values, a block's own query, and the editors of
// the fields, picture and barcode blocks. Kept out of the route so the route
// stays the layout and the save and export flow.
import { useState } from "react";
import { Loader2, Play, Plus, Trash2 } from "lucide-react";

import { BiParamControl } from "@/components/bi/BiParamControls";
import { TemplateInsertMenu } from "@/components/templates/TemplateInsert";
import { paramNameProblem, paramTokens } from "@/lib/biReportDesign";
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
import { useInsertAtCaret } from "@/hooks/use-insert-at-caret";
import { barcodeProblem } from "@/lib/biBarcode";
import type { BiWidget } from "@/lib/biDashboards";
import {
  PARAM_NAME,
  isValidParamValue,
  parseOptionLines,
  type BiParamConfig,
  type BiParamControl as Control,
  type BiParamValues,
} from "@/lib/biParams";
import {
  IMAGE_MAX_CHARS,
  MAX_REPORT_PARAMS,
  RESERVED_TOKEN_NAMES,
  fieldColumns,
  fieldLabel,
  imageSourceProblem,
  type ReportAlign,
  type ReportBlock,
} from "@/lib/biReports";
import type { WarehouseConnectionSummary } from "@/utils/warehouse/types";

/** The controls a report parameter can use, in the order offered. */
const CONTROLS: { value: Control; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "date", label: "Date" },
  { value: "number", label: "Number" },
  { value: "dropdown", label: "List" },
];

function newParam(taken: BiParamConfig[]): BiParamConfig {
  let n = taken.length + 1;
  while (taken.some((p) => p.name === `param_${n}`)) n++;
  return {
    id: `p_${Math.random().toString(36).slice(2, 10)}`,
    kind: "param",
    name: `param_${n}`,
    label: `Parameter ${n}`,
    control: "text",
    default: "",
  };
}

/** One parameter's definition. */
function ParamRow({
  param,
  others,
  onChange,
  onRemove,
}: {
  param: BiParamConfig;
  others: BiParamConfig[];
  onChange: (p: BiParamConfig) => void;
  onRemove: () => void;
}) {
  const problem = paramNameProblem(param.name, others);
  const [optionText, setOptionText] = useState(
    (param.options ?? [])
      .map((o) => (o.label === o.value ? o.value : `${o.value} | ${o.label}`))
      .join("\n"),
  );
  const setControl = (control: Control) => {
    const next: BiParamConfig = { ...param, control };
    if (control === "date") next.default = new Date().toISOString().slice(0, 10);
    else if (control === "number")
      Object.assign(next, { min: 0, max: 1000000, step: 1, default: "0" });
    else if (control === "dropdown") {
      const options = param.options?.length ? param.options : [{ value: "A", label: "A" }];
      Object.assign(next, { options, default: options[0].value });
      setOptionText(options.map((o) => o.value).join("\n"));
    } else next.default = "";
    onChange(next);
  };
  return (
    <div className="space-y-1 rounded-md border p-2" data-testid="report-param">
      <div className="flex items-center gap-1">
        <Input
          className="h-7 font-mono text-[11px]"
          aria-label="Parameter name"
          value={param.name}
          onChange={(e) => onChange({ ...param, name: e.target.value.trim().toLowerCase() })}
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0 text-destructive"
          aria-label={`Remove the parameter ${param.name}`}
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {problem ? <p className="text-[10px] text-destructive">{problem}</p> : null}
      <Input
        className="h-7 text-[11px]"
        aria-label="Parameter label"
        placeholder="Label"
        value={param.label}
        onChange={(e) => onChange({ ...param, label: e.target.value })}
      />
      <Select value={param.control} onValueChange={(v) => setControl(v as Control)}>
        <SelectTrigger className="h-7 text-[11px]" aria-label="Parameter kind">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONTROLS.map((c) => (
            <SelectItem key={c.value} value={c.value} className="text-xs">
              {c.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {param.control === "dropdown" ? (
        <Textarea
          rows={3}
          className="font-mono text-[11px]"
          aria-label="Parameter options, one per line"
          placeholder={"EMEA\nAMER | Americas"}
          value={optionText}
          onChange={(e) => {
            setOptionText(e.target.value);
            const options = parseOptionLines(e.target.value);
            if (options.length) {
              onChange({
                ...param,
                options,
                default: options.some((o) => o.value === param.default)
                  ? param.default
                  : options[0].value,
              });
            }
          }}
        />
      ) : null}
      <div className="space-y-0.5">
        <Label className="text-[10px] text-muted-foreground">Default</Label>
        <BiParamControl
          param={{ ...param, label: "" }}
          value={param.default}
          onChange={(v) => {
            if (isValidParamValue(param, v)) onChange({ ...param, default: v });
          }}
          compact
        />
      </div>
    </div>
  );
}

/** The report's parameters, defined. */
export function ReportParamsEditor({
  params,
  onChange,
}: {
  params: BiParamConfig[];
  onChange: (params: BiParamConfig[]) => void;
}) {
  return (
    <div className="space-y-2 border-t pt-2">
      <div className="flex items-center justify-between">
        <Label className="text-[11px]">Parameters</Label>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[10px]"
          disabled={params.length >= MAX_REPORT_PARAMS}
          onClick={() => onChange([...params, newParam(params)])}
        >
          <Plus className="mr-1 h-3 w-3" /> Add
        </Button>
      </div>
      {params.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          A parameter is a value chosen when the report runs, such as an order number or a month.
          Queries, text, the header and footer and barcodes read it as <code>{"{{name}}"}</code>.
        </p>
      ) : null}
      {params.map((p, i) => (
        <ParamRow
          key={p.id}
          param={p}
          others={params.filter((_, j) => j !== i)}
          onChange={(next) => onChange(params.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(params.filter((_, j) => j !== i))}
        />
      ))}
    </div>
  );
}

/** The values the report runs with, and the button that runs its queries. */
export function ReportRunBar({
  params,
  values,
  onValue,
  onRun,
  running,
  stale,
  ranOnce,
}: {
  params: BiParamConfig[];
  values: BiParamValues;
  onValue: (name: string, value: string) => void;
  onRun: () => void;
  running: boolean;
  /** The blocks' rows may not be for these values. */
  stale: boolean;
  /** A block that needs a run ran before with other values. */
  ranOnce: boolean;
}) {
  if (!params.length) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border bg-background px-3 py-2"
      data-testid="report-run-bar"
    >
      {params.map((p) => (
        <BiParamControl
          key={p.id}
          param={p}
          value={values[p.name] ?? p.default}
          onChange={(v) => onValue(p.name, v)}
          compact
        />
      ))}
      <Button size="sm" className="h-7" disabled={running} onClick={onRun}>
        {running ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Play className="mr-1 h-3.5 w-3.5" />
        )}
        Run report
      </Button>
      {stale && !running ? (
        <span className="text-[11px] text-amber-600 dark:text-amber-400">
          {ranOnce
            ? "Values changed: run the report to update its blocks"
            : "Run the report to fill its blocks for these values"}
        </span>
      ) : null}
    </div>
  );
}

/** A block's query: where it runs, its SQL with {{parameters}}, and Run. */
export function ReportQueryEditor({
  widget,
  warehouses,
  params,
  running,
  onChange,
  onRun,
}: {
  widget: BiWidget;
  warehouses: WarehouseConnectionSummary[];
  params: BiParamConfig[];
  running: boolean;
  onChange: (w: BiWidget) => void;
  onRun: () => void;
}) {
  const sql = widget.sql ?? "";
  const { ref, insert } = useInsertAtCaret<HTMLTextAreaElement>(sql, (v) =>
    onChange({ ...widget, sql: v }),
  );
  const sourceKey = widget.source?.kind === "warehouse" ? widget.source.connection_id : "local";
  return (
    <div className="space-y-1 border-t pt-2">
      <Label className="text-[11px]">Title</Label>
      <Input
        className="h-7 text-xs"
        aria-label="Block title"
        value={widget.title}
        onChange={(e) => onChange({ ...widget, title: e.target.value })}
      />
      <Label className="text-[11px]">Query</Label>
      <Select
        value={sourceKey}
        onValueChange={(v) => {
          const wh = warehouses.find((w) => w.id === v);
          onChange({
            ...widget,
            source: wh
              ? {
                  kind: "warehouse",
                  connection_id: wh.id,
                  connection_name: wh.name,
                  provider: wh.provider,
                }
              : { kind: "local" },
          });
        }}
      >
        <SelectTrigger className="h-7 text-[11px]" aria-label="Where the query runs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="local" className="text-xs">
            Local datasets
          </SelectItem>
          {warehouses.map((w) => (
            <SelectItem key={w.id} value={w.id} className="text-xs">
              {w.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Textarea
        ref={ref}
        rows={6}
        className="font-mono text-[11px]"
        aria-label="Block SQL"
        placeholder={"SELECT … FROM … WHERE order_id = {{order_id}}"}
        value={sql}
        onChange={(e) => onChange({ ...widget, sql: e.target.value })}
      />
      <div className="flex items-center gap-1">
        {params.length ? (
          <TemplateInsertMenu
            className="h-7"
            tokens={paramTokens(params)}
            onPick={insert}
            label="Parameter"
            fieldLabel="Block SQL"
          />
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 text-[11px]"
          disabled={running || !sql.trim()}
          onClick={onRun}
        >
          {running ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Play className="mr-1 h-3 w-3" />
          )}
          Run
        </Button>
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {(widget.rows ?? []).length.toLocaleString()} row(s), {(widget.columns ?? []).length}{" "}
        column(s). A <code>{"{{parameter}}"}</code> goes in as a value: text quoted, a date as a
        date, a number as written.
      </p>
    </div>
  );
}

export function FieldsBlockEditor({
  block,
  onChange,
}: {
  block: Extract<ReportBlock, { kind: "fields" }>;
  onChange: (b: Extract<ReportBlock, { kind: "fields" }>) => void;
}) {
  const all = block.widget.columns ?? [];
  const shown = fieldColumns(block);
  return (
    <div className="space-y-1 border-t pt-2">
      <Label className="text-[11px]">Pairs across the page</Label>
      <Select
        value={String(block.perRow ?? 2)}
        onValueChange={(v) => onChange({ ...block, perRow: Number(v) as 1 | 2 | 3 })}
      >
        <SelectTrigger className="h-7 text-[11px]" aria-label="Pairs across the page">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[1, 2, 3].map((n) => (
            <SelectItem key={n} value={String(n)} className="text-xs">
              {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {all.length ? <Label className="text-[11px]">Fields and their labels</Label> : null}
      {all.map((c) => (
        <div key={c} className="flex items-center gap-1.5">
          <Checkbox
            checked={shown.includes(c)}
            aria-label={`Show ${c}`}
            onCheckedChange={(on) => {
              const next = on
                ? all.filter((x) => x === c || shown.includes(x))
                : shown.filter((x) => x !== c);
              onChange({ ...block, columns: next.length === all.length ? undefined : next });
            }}
          />
          <Input
            className="h-6 text-[11px]"
            aria-label={`Label for ${c}`}
            placeholder={fieldLabel({ ...block, labels: {} }, c)}
            value={block.labels?.[c] ?? ""}
            onChange={(e) =>
              onChange({ ...block, labels: { ...(block.labels ?? {}), [c]: e.target.value } })
            }
          />
        </div>
      ))}
    </div>
  );
}

const ALIGNS: { value: ReportAlign; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "center", label: "Centre" },
  { value: "right", label: "Right" },
];

function AlignSelect({
  value,
  onChange,
}: {
  value: ReportAlign | undefined;
  onChange: (a: ReportAlign) => void;
}) {
  return (
    <Select value={value ?? "left"} onValueChange={(v) => onChange(v as ReportAlign)}>
      <SelectTrigger className="h-7 text-[11px]" aria-label="Alignment">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ALIGNS.map((a) => (
          <SelectItem key={a.value} value={a.value} className="text-xs">
            {a.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ImageBlockEditor({
  block,
  onChange,
}: {
  block: Extract<ReportBlock, { kind: "image" }>;
  onChange: (b: Extract<ReportBlock, { kind: "image" }>) => void;
}) {
  const problem = block.src ? imageSourceProblem(block.src) : null;
  return (
    <div className="space-y-1 border-t pt-2">
      <Label className="text-[11px]">Picture (PNG or JPEG, up to about 1 MB)</Label>
      <Input
        type="file"
        accept="image/png,image/jpeg"
        className="h-8 text-[11px]"
        aria-label="Choose a picture"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            const src = String(reader.result ?? "");
            if (src.length > IMAGE_MAX_CHARS) return;
            onChange({ ...block, src, alt: block.alt || file.name.replace(/\.[^.]+$/, "") });
          };
          reader.readAsDataURL(file);
        }}
      />
      <Input
        className="h-7 text-[11px]"
        aria-label="Picture address"
        placeholder="or https://… address"
        value={block.src.startsWith("data:") ? "" : block.src}
        onChange={(e) => onChange({ ...block, src: e.target.value.trim() })}
      />
      {block.src.startsWith("data:") ? (
        <p className="text-[10px] text-muted-foreground">
          A picture you chose is kept in the report.
        </p>
      ) : null}
      {problem ? <p className="text-[10px] text-destructive">{problem}</p> : null}
      <div className="grid grid-cols-2 gap-1">
        <div>
          <Label className="text-[10px]">Height (pt)</Label>
          <Input
            type="number"
            className="h-7 text-[11px]"
            value={block.height}
            onChange={(e) => onChange({ ...block, height: Number(e.target.value) || 48 })}
          />
        </div>
        <div>
          <Label className="text-[10px]">Alignment</Label>
          <AlignSelect value={block.align} onChange={(align) => onChange({ ...block, align })} />
        </div>
      </div>
      <Input
        className="h-7 text-[11px]"
        aria-label="Picture description"
        placeholder="Description (what the picture shows)"
        value={block.alt ?? ""}
        onChange={(e) => onChange({ ...block, alt: e.target.value })}
      />
    </div>
  );
}

export function BarcodeBlockEditor({
  block,
  params,
  filledValue,
  onChange,
}: {
  block: Extract<ReportBlock, { kind: "barcode" }>;
  params: BiParamConfig[];
  /** The value with its tokens filled, as it will print. */
  filledValue: string;
  onChange: (b: Extract<ReportBlock, { kind: "barcode" }>) => void;
}) {
  const { ref, insert } = useInsertAtCaret<HTMLInputElement>(block.value, (v) =>
    onChange({ ...block, value: v }),
  );
  const problem = barcodeProblem(block.format, filledValue);
  return (
    <div className="space-y-1 border-t pt-2">
      <Label className="text-[11px]">Kind</Label>
      <Select
        value={block.format}
        onValueChange={(v) => onChange({ ...block, format: v as "code128" | "qr" })}
      >
        <SelectTrigger className="h-7 text-[11px]" aria-label="Barcode kind">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="code128" className="text-xs">
            Code 128 (bars)
          </SelectItem>
          <SelectItem value="qr" className="text-xs">
            QR code
          </SelectItem>
        </SelectContent>
      </Select>
      <Label className="text-[11px]">Value</Label>
      <div className="flex items-center gap-1">
        <Input
          ref={ref}
          className="h-7 font-mono text-[11px]"
          aria-label="Barcode value"
          placeholder="{{order_id}}"
          value={block.value}
          onChange={(e) => onChange({ ...block, value: e.target.value })}
        />
        {params.length ? (
          <TemplateInsertMenu
            className="h-7 shrink-0"
            tokens={paramTokens(params)}
            onPick={insert}
            label="Parameter"
            fieldLabel="Barcode value"
          />
        ) : null}
      </div>
      {problem ? (
        <p className="text-[10px] text-destructive">{problem}</p>
      ) : (
        <p className="text-[10px] text-muted-foreground">Prints: {filledValue}</p>
      )}
      <div className="grid grid-cols-2 gap-1">
        <div>
          <Label className="text-[10px]">Height (pt)</Label>
          <Input
            type="number"
            className="h-7 text-[11px]"
            value={block.height}
            onChange={(e) => onChange({ ...block, height: Number(e.target.value) || 48 })}
          />
        </div>
        <div>
          <Label className="text-[10px]">Alignment</Label>
          <AlignSelect value={block.align} onChange={(align) => onChange({ ...block, align })} />
        </div>
      </div>
      {block.format === "code128" ? (
        <label className="flex items-center gap-1.5 text-[11px]">
          <Checkbox
            checked={block.showText !== false}
            onCheckedChange={(on) => onChange({ ...block, showText: on === true })}
          />
          Print the value under the bars
        </label>
      ) : null}
    </div>
  );
}
