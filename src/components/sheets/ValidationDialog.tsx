// Data > Data validation: the rule a typed value must pass, an optional
// message shown when the cell is selected, and what happens when a value
// fails (Stop refuses it, Warning asks, Information tells).

import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { openFocus } from "./focusAfterMenu";
import type { DvOp, DvRule, Validation } from "@/lib/sheets/validation";

type Allow = "any" | "list" | "whole" | "decimal" | "date" | "time" | "length" | "custom";

const OPS: { op: DvOp; label: string }[] = [
  { op: "between", label: "between" },
  { op: "notBetween", label: "not between" },
  { op: "eq", label: "equal to" },
  { op: "ne", label: "not equal to" },
  { op: "gt", label: "greater than" },
  { op: "lt", label: "less than" },
  { op: "ge", label: "greater than or equal to" },
  { op: "le", label: "less than or equal to" },
];

const select = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

export function ValidationDialog({
  range,
  current,
  onCancel,
  onApply,
  onClear,
}: {
  range: string;
  current?: Validation;
  onCancel: () => void;
  onApply: (v: Omit<Validation, "id" | "ranges">) => void;
  onClear: () => void;
}) {
  const r = current?.rule;
  const [allow, setAllow] = useState<Allow>(r ? (r.kind as Allow) : "list");
  const [op, setOp] = useState<DvOp>(r && "op" in r ? r.op : "between");
  const [a, setA] = useState(r && "a" in r ? r.a : "");
  const [b, setB] = useState(r && "b" in r ? (r.b ?? "") : "");
  const [source, setSource] = useState(
    r?.kind === "list" ? (r.source ?? (r.items ?? []).join(", ")) : "",
  );
  const [formula, setFormula] = useState(r?.kind === "custom" ? r.formula : "");
  const [dropdown, setDropdown] = useState(r?.kind === "list" ? r.dropdown !== false : true);
  const [allowBlank, setAllowBlank] = useState(current?.allowBlank !== false);
  const [promptTitle, setPromptTitle] = useState(current?.prompt?.title ?? "");
  const [promptMessage, setPromptMessage] = useState(current?.prompt?.message ?? "");
  const [errStyle, setErrStyle] = useState<"stop" | "warning" | "info">(
    current?.error?.style ?? "stop",
  );
  const [errTitle, setErrTitle] = useState(current?.error?.title ?? "");
  const [errMessage, setErrMessage] = useState(current?.error?.message ?? "");
  const [tab, setTab] = useState<"settings" | "input" | "error">("settings");
  const [problem, setProblem] = useState<string | null>(null);

  const needsTwo = op === "between" || op === "notBetween";
  const apply = () => {
    let rule: DvRule | null = null;
    if (allow === "any") return onClear();
    if (allow === "list") {
      const s = source.trim();
      if (!s)
        return setProblem("List the choices, separated by commas, or a range such as =$F$2:$F$9");
      rule = s.startsWith("=")
        ? { kind: "list", source: s, dropdown }
        : {
            kind: "list",
            items: s
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
            dropdown,
          };
    } else if (allow === "custom") {
      if (!formula.trim())
        return setProblem("Enter a formula that is TRUE for a valid value, e.g. =ISNUMBER(A2)");
      rule = {
        kind: "custom",
        formula: formula.trim().startsWith("=") ? formula.trim() : `=${formula.trim()}`,
      };
    } else {
      if (!a.trim() || (needsTwo && !b.trim()))
        return setProblem("Enter the limits (a value, a date, or a formula such as =B1)");
      rule = { kind: allow, op, a: a.trim(), ...(needsTwo ? { b: b.trim() } : {}) };
    }
    onApply({
      rule,
      allowBlank,
      ...(promptMessage.trim()
        ? { prompt: { title: promptTitle.trim() || undefined, message: promptMessage.trim() } }
        : {}),
      error: {
        style: errStyle,
        title: errTitle.trim() || undefined,
        message: errMessage.trim() || undefined,
      },
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="validation-dialog"
        onOpenAutoFocus={openFocus(() => document.getElementById("dv-allow"))}
      >
        <DialogHeader>
          <DialogTitle>Data validation</DialogTitle>
          <DialogDescription>For {range}. Checked when a value is typed.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 border-b border-border" role="tablist">
          {(
            [
              ["settings", "Settings"],
              ["input", "Input message"],
              ["error", "Error alert"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`border-b-2 px-3 py-1.5 text-sm ${tab === id ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          {tab === "settings" && (
            <>
              <div className="space-y-1">
                <Label htmlFor="dv-allow">Allow</Label>
                <select
                  id="dv-allow"
                  className={select}
                  value={allow}
                  onChange={(e) => setAllow(e.target.value as Allow)}
                >
                  <option value="any">Any value</option>
                  <option value="list">List</option>
                  <option value="whole">Whole number</option>
                  <option value="decimal">Decimal</option>
                  <option value="date">Date</option>
                  <option value="time">Time</option>
                  <option value="length">Text length</option>
                  <option value="custom">Custom (a formula)</option>
                </select>
              </div>
              {allow === "list" && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="dv-source">Source</Label>
                    <Input
                      id="dv-source"
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                      placeholder="Open, In progress, Done   or   =$F$2:$F$9"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={dropdown}
                      onChange={(e) => setDropdown(e.target.checked)}
                    />
                    In-cell dropdown
                  </label>
                </>
              )}
              {allow === "custom" && (
                <div className="space-y-1">
                  <Label htmlFor="dv-formula">Formula</Label>
                  <Input
                    id="dv-formula"
                    value={formula}
                    onChange={(e) => setFormula(e.target.value)}
                    placeholder="=COUNTIF($A:$A,A2)=1"
                  />
                </div>
              )}
              {allow !== "any" && allow !== "list" && allow !== "custom" && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="dv-op">Data</Label>
                    <select
                      id="dv-op"
                      className={select}
                      value={op}
                      onChange={(e) => setOp(e.target.value as DvOp)}
                    >
                      {OPS.map((o) => (
                        <option key={o.op} value={o.op}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 space-y-1">
                      <Label htmlFor="dv-a">{needsTwo ? "Minimum" : "Value"}</Label>
                      <Input
                        id="dv-a"
                        value={a}
                        onChange={(e) => setA(e.target.value)}
                        placeholder={allow === "date" ? "2024-01-01" : "0"}
                      />
                    </div>
                    {needsTwo && (
                      <div className="flex-1 space-y-1">
                        <Label htmlFor="dv-b">Maximum</Label>
                        <Input
                          id="dv-b"
                          value={b}
                          onChange={(e) => setB(e.target.value)}
                          placeholder={allow === "date" ? "2024-12-31" : "100"}
                        />
                      </div>
                    )}
                  </div>
                </>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowBlank}
                  onChange={(e) => setAllowBlank(e.target.checked)}
                />
                Ignore blank
              </label>
            </>
          )}
          {tab === "input" && (
            <>
              <div className="space-y-1">
                <Label htmlFor="dv-pt">Title</Label>
                <Input
                  id="dv-pt"
                  value={promptTitle}
                  onChange={(e) => setPromptTitle(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dv-pm">Message shown when the cell is selected</Label>
                <Textarea
                  id="dv-pm"
                  value={promptMessage}
                  onChange={(e) => setPromptMessage(e.target.value)}
                  rows={3}
                />
              </div>
            </>
          )}
          {tab === "error" && (
            <>
              <div className="space-y-1">
                <Label htmlFor="dv-es">Style</Label>
                <select
                  id="dv-es"
                  className={select}
                  value={errStyle}
                  onChange={(e) => setErrStyle(e.target.value as typeof errStyle)}
                >
                  <option value="stop">Stop — the value is refused</option>
                  <option value="warning">Warning — asks whether to keep it</option>
                  <option value="info">Information — says so and keeps it</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="dv-et">Title</Label>
                <Input id="dv-et" value={errTitle} onChange={(e) => setErrTitle(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dv-em">Error message</Label>
                <Textarea
                  id="dv-em"
                  value={errMessage}
                  onChange={(e) => setErrMessage(e.target.value)}
                  rows={3}
                />
              </div>
            </>
          )}
          {problem && <p className="text-sm text-destructive">{problem}</p>}
          <DialogFooter className="gap-2">
            {current && (
              <Button type="button" variant="outline" className="mr-auto" onClick={onClear}>
                Clear all
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A typed value that fails a cell's rule, as Excel's alert: Stop refuses it
 * (Retry or Cancel), Warning asks (Yes keeps it, No goes back to it, Cancel
 * drops it), Information tells (OK keeps it, Cancel drops it).
 */
export function DvAlertDialog({
  style,
  title,
  message,
  onKeep,
  onRetry,
  onCancel,
}: {
  style: "stop" | "warning" | "info";
  title?: string;
  message: string;
  onKeep: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const heading =
    title ||
    (style === "stop" ? "Not allowed here" : style === "warning" ? "Check this value" : "Note");
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="dv-alert" data-style={style}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              aria-hidden
              className={
                style === "stop"
                  ? "text-destructive"
                  : style === "warning"
                    ? "text-amber-600"
                    : "text-sky-600"
              }
            >
              {style === "stop" ? "⛔" : style === "warning" ? "⚠" : "ℹ"}
            </span>
            {heading}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-wrap">{message}</DialogDescription>
          {style === "warning" && <p className="text-sm">Keep this value?</p>}
        </DialogHeader>
        <DialogFooter className="gap-2">
          {style === "stop" && (
            <>
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button autoFocus onClick={onRetry}>
                Retry
              </Button>
            </>
          )}
          {style === "warning" && (
            <>
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button variant="outline" onClick={onRetry}>
                No, edit it
              </Button>
              <Button autoFocus onClick={onKeep}>
                Yes, keep it
              </Button>
            </>
          )}
          {style === "info" && (
            <>
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button autoFocus onClick={onKeep}>
                OK
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
