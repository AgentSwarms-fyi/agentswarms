// Parameters in the filter bar (R501): a chip per parameter that opens its
// control, and for the owner the dialog that defines one — its {{name}}, how
// it is picked (radio list, dropdown, date; a number box or a slider since
// R503), its options or range and its default, and
// whether it shows here or only in a Controls visual on the canvas.
import { useState } from "react";
import { toast } from "sonner";
import { Braces, Pencil, Plus, Trash2 } from "lucide-react";

import { BiParamControl } from "@/components/bi/BiParamControls";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import {
  NUMBER_CONTROLS,
  PARAM_NAME,
  numberRange,
  paramValueLabel,
  parseOptionLines,
  parseParams,
  type BiParamConfig,
  type BiParamControl as Control,
  type BiParamValues,
} from "@/lib/biParams";

const small = "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground";

function ParamDialog({
  open,
  onOpenChange,
  initial,
  taken,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: BiParamConfig | null;
  /** Names already used by the dashboard's other parameters. */
  taken: string[];
  onSave: (p: BiParamConfig) => void;
}) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [control, setControl] = useState<Control>("dropdown");
  const [optionsText, setOptionsText] = useState("");
  const [def, setDef] = useState("");
  const [placement, setPlacement] = useState<"bar" | "canvas">("bar");
  // A number box or a slider (R503): its range and step.
  const [min, setMin] = useState("1");
  const [max, setMax] = useState("25");
  const [step, setStep] = useState("1");
  const [seen, setSeen] = useState(false);
  if (open && !seen) {
    setSeen(true);
    setName(initial?.name ?? "");
    setLabel(initial?.label ?? "");
    setControl(initial?.control ?? "dropdown");
    setOptionsText((initial?.options ?? []).map((o) => `${o.value} | ${o.label}`).join("\n"));
    setDef(initial?.default ?? "");
    setPlacement(initial?.placement ?? "bar");
    setMin(String(initial?.min ?? 1));
    setMax(String(initial?.max ?? 25));
    setStep(String(initial?.step ?? 1));
  } else if (!open && seen) {
    setSeen(false);
  }

  const options = parseOptionLines(optionsText);
  const numeric = NUMBER_CONTROLS.includes(control);
  const choice = control === "radio" || control === "dropdown";
  function save() {
    const n = name.trim();
    if (!PARAM_NAME.test(n)) {
      return toast.error("Name: lowercase letters, digits and _, starting with a letter");
    }
    // {{selected}} in titles and text is the value a click picks (R503).
    if (n === "selected") {
      return toast.error('"selected" names what a click picks: choose another name');
    }
    if (taken.includes(n)) return toast.error(`A parameter named "${n}" already exists`);
    if (choice && options.length === 0) {
      return toast.error("List at least one option, one per line");
    }
    const range = numeric ? numberRange(min, max, step) : null;
    if (numeric && !range) {
      return toast.error(
        "The lowest value must be below the highest, and the step above 0 and no wider than the range",
      );
    }
    // The same check a saved dashboard gets when it loads.
    const [p] = parseParams([
      {
        id: initial?.id ?? crypto.randomUUID(),
        kind: "param",
        name: n,
        label: label.trim() || n,
        control,
        options: choice ? options : undefined,
        ...(range ?? {}),
        default: def,
        placement,
      },
    ]);
    if (!p) return toast.error("That parameter is not complete");
    if (p.default !== def && def) {
      toast.info(
        numeric
          ? `The default is now ${p.default}: ${def} is outside ${p.min}–${p.max} or off its steps`
          : `The default is now "${p.default}": "${def}" is not one of the choices`,
      );
    }
    onSave(p);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Braces className="h-4 w-4 text-primary" />
            {initial ? "Edit parameter" : "Add parameter"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            A value people pick that widget SQL reads as{" "}
            <code className="rounded bg-muted px-1">{`{{${name.trim() || "name"}}}`}</code>, for
            example{" "}
            <code className="rounded bg-muted px-1">{`WHERE ride_date >= {{date_from}}`}</code>. The
            query re-runs when it changes.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className={small}>Name in SQL</Label>
            <Input
              aria-label="Parameter name"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="rider"
              className="h-8 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className={small}>Label</Label>
            <Input
              aria-label="Parameter label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Rider group"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className={small}>Picked from</Label>
            <Select
              value={control}
              onValueChange={(v) => {
                setControl(v as Control);
                // A default for another kind of control means nothing here.
                if (v !== control) setDef("");
              }}
            >
              <SelectTrigger className="h-8 text-xs" aria-label="Picked from">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="radio" className="text-xs">
                  A radio list
                </SelectItem>
                <SelectItem value="dropdown" className="text-xs">
                  A dropdown
                </SelectItem>
                <SelectItem value="date" className="text-xs">
                  A date
                </SelectItem>
                <SelectItem value="number" className="text-xs">
                  A number box
                </SelectItem>
                <SelectItem value="slider" className="text-xs">
                  A slider
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className={small}>Shown</Label>
            <Select value={placement} onValueChange={(v) => setPlacement(v as "bar" | "canvas")}>
              <SelectTrigger className="h-8 text-xs" aria-label="Where it is shown">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bar" className="text-xs">
                  In the filter bar
                </SelectItem>
                <SelectItem value="canvas" className="text-xs">
                  Only in a Controls visual
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {numeric && (
            <div className="col-span-2 grid grid-cols-3 gap-2">
              {(
                [
                  ["Lowest", min, setMin],
                  ["Highest", max, setMax],
                  ["Step", step, setStep],
                ] as const
              ).map(([lbl, val, set]) => (
                <div key={lbl} className="space-y-1">
                  <Label className={small}>{lbl}</Label>
                  <Input
                    type="number"
                    aria-label={`${lbl} value`}
                    value={val}
                    onChange={(e) => set(e.target.value)}
                    className="h-8 text-xs tabular-nums"
                  />
                </div>
              ))}
              <p className="col-span-3 text-[10px] text-muted-foreground">
                Goes into SQL as a bare number, so{" "}
                <code className="rounded bg-muted px-1">{`LIMIT {{${name.trim() || "top_n"}}}`}</code>{" "}
                shows the top N.
              </p>
            </div>
          )}
          {choice && (
            <div className="col-span-2 space-y-1">
              <Label className={small}>Choices — value | label, one per line</Label>
              <Textarea
                aria-label="Parameter choices"
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                rows={4}
                className="font-mono text-xs"
                placeholder={"all | Select all\nmember | Member\ncasual | Casual"}
              />
            </div>
          )}
          <div className="col-span-2 space-y-1">
            <Label className={small}>Default</Label>
            {control === "date" ? (
              <Input
                type="date"
                aria-label="Default value"
                value={def}
                onChange={(e) => setDef(e.target.value)}
                className="h-8 w-44 text-xs"
              />
            ) : numeric ? (
              <Input
                type="number"
                aria-label="Default value"
                value={def}
                placeholder={min}
                onChange={(e) => setDef(e.target.value)}
                className="h-8 w-32 text-xs tabular-nums"
              />
            ) : (
              <Select value={def || undefined} onValueChange={setDef}>
                <SelectTrigger className="h-8 text-xs" aria-label="Default value">
                  <SelectValue placeholder="The first choice" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="text-xs">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-[10px] text-muted-foreground">
              What a viewer sees first, and what every refresh and schedule runs with.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" onClick={save}>
            {initial ? "Save parameter" : "Add parameter"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The parameter chips and, for the owner, the means to add and change them. */
export function BiParamBarItems({
  params,
  values,
  onValue,
  editable,
  onParamsChange,
}: {
  params: BiParamConfig[];
  values: BiParamValues;
  onValue: (name: string, value: string) => void;
  editable: boolean;
  onParamsChange?: (next: BiParamConfig[]) => void;
}) {
  const [dialog, setDialog] = useState<{ open: boolean; initial: BiParamConfig | null }>({
    open: false,
    initial: null,
  });
  // Viewers see only the bar's parameters; the owner sees every one, to edit.
  const shown = params.filter((p) => editable || p.placement !== "canvas");
  return (
    <>
      {shown.map((p) => {
        const v = values[p.name] ?? p.default;
        return (
          <Popover key={p.id}>
            <PopoverTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-2 text-[10px]"
                aria-label={`Parameter ${p.label}`}
              >
                <Braces className="h-2.5 w-2.5 text-primary" />
                {p.label}: <strong className="font-semibold">{paramValueLabel(p, v)}</strong>
                {p.placement === "canvas" && (
                  <span className="text-muted-foreground">· canvas</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 space-y-3 p-3" align="start">
              <BiParamControl param={p} value={v} onChange={(nv) => onValue(p.name, nv)} />
              <p className="text-[10px] text-muted-foreground">
                In SQL: <code className="rounded bg-muted px-1">{`{{${p.name}}}`}</code> · default{" "}
                {paramValueLabel(p, p.default)}
              </p>
              {editable && (
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 gap-1 px-2 text-[10px]"
                    onClick={() => setDialog({ open: true, initial: p })}
                  >
                    <Pencil className="h-2.5 w-2.5" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 gap-1 px-2 text-[10px] text-destructive"
                    onClick={() => onParamsChange?.(params.filter((x) => x.id !== p.id))}
                  >
                    <Trash2 className="h-2.5 w-2.5" /> Remove
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        );
      })}
      {editable && (
        <>
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 border-dashed px-2 text-[10px]"
            onClick={() => setDialog({ open: true, initial: null })}
          >
            <Plus className="h-2.5 w-2.5" /> Add parameter
          </Button>
          <ParamDialog
            open={dialog.open}
            onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
            initial={dialog.initial}
            taken={params.filter((p) => p.id !== dialog.initial?.id).map((p) => p.name)}
            onSave={(p) =>
              onParamsChange?.(
                params.some((x) => x.id === p.id)
                  ? params.map((x) => (x.id === p.id ? p : x))
                  : [...params, p],
              )
            }
          />
        </>
      )}
    </>
  );
}
