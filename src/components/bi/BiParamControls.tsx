// A dashboard's parameters as controls (R501): a radio list, a dropdown, a
// date. Shown in the filter bar, or on the canvas by a Controls visual. The
// editor provides the values through BiParamContext; where nothing provides
// them (a public link, an export) the controls show the defaults, disabled.
import { useContext } from "react";

import { BiTextBlock } from "@/components/bi/BiTextBlock";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ChartSpec } from "@/lib/biAgent";
import { BiParamContext } from "@/components/bi/biParamContext";
import type { BiParamConfig } from "@/lib/biParams";
import { cn } from "@/lib/utils";

export function BiParamControl({
  param,
  value,
  onChange,
  disabled,
  compact = false,
}: {
  param: BiParamConfig;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const id = `param-${param.id}`;
  if (param.control === "date") {
    return (
      // Wraps under its label in a narrow column instead of scrolling it sideways.
      <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", compact && "gap-x-1.5")}>
        <Label htmlFor={id} className="shrink-0 text-xs">
          {param.label}
        </Label>
        <Input
          id={id}
          type="date"
          value={value}
          disabled={disabled}
          aria-label={param.label}
          onChange={(e) => e.target.value && onChange(e.target.value)}
          className="h-7 min-w-[8.5rem] max-w-[11rem] flex-1 text-xs"
        />
      </div>
    );
  }
  if (param.control === "radio") {
    return (
      <div className="space-y-1">
        <div className="text-xs font-medium">{param.label}</div>
        <RadioGroup
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          aria-label={param.label}
          className={cn(compact ? "flex flex-wrap gap-3" : "grid gap-1")}
        >
          {(param.options ?? []).map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-1.5 text-xs">
              <RadioGroupItem value={o.value} aria-label={o.label} className="h-3.5 w-3.5" />
              {o.label}
            </label>
          ))}
        </RadioGroup>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Label className="shrink-0 text-xs">{param.label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          className="h-7 min-w-[6rem] max-w-[11rem] flex-1 text-xs"
          aria-label={param.label}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(param.options ?? []).map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

type ControlsChart = Extract<ChartSpec, { type: "controls" }>;

/** The Controls visual: the parameters it names, under its own short intro. */
export function BiControlsVisual({ chart }: { chart: ControlsChart }) {
  const state = useContext(BiParamContext);
  const byName = new Map((state?.params ?? []).map((p) => [p.name, p]));
  const shown = chart.params.map((n) => byName.get(n)).filter((p): p is BiParamConfig => !!p);
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-1 py-1">
      {chart.intro?.trim() && (
        <div className="shrink-0">
          <BiTextBlock text={chart.intro} style={{ size: "md" }} />
        </div>
      )}
      {!state ? (
        <p className="text-xs text-muted-foreground">
          These controls change the dashboard in the app; here it shows its saved values.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None of this visual&apos;s parameters exist any more — edit it to pick others.
        </p>
      ) : (
        shown.map((p) => (
          <BiParamControl
            key={p.id}
            param={p}
            value={state.values[p.name] ?? p.default}
            onChange={(v) => state.setValue(p.name, v)}
          />
        ))
      )}
    </div>
  );
}
