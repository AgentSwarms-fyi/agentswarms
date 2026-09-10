// The parts of a step that used to be typed, and are now assembled.
//
// The rule this file exists to enforce: a workflow author configures a step by
// making choices, not by learning a notation. Three things were notations —
// a condition expression, a block of `Name: value` header lines, and a
// comma-separated list of model names — and each has become a control that
// can only produce something valid. What stays free text is text that really
// is text: a SQL statement, a message, a question for a person. Even there,
// `{{ params.x }}` is offered by a button rather than remembered.
import { Plus, Trash2 } from "lucide-react";
import { useRef } from "react";

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
import { cn } from "@/lib/utils";
import {
  CONDITION_OPS,
  CONDITION_OP_LABEL,
  formatCondition,
  parseCondition,
  type Condition,
  type ConditionSide,
  type WorkflowParam,
} from "@/lib/workflows";

/** The sentinel a Select uses for "not one of the listed things". */
const TYPED = "__typed";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px]">{label}</Label>
      {children}
    </div>
  );
}

// ── Free text that may mention a parameter ──────────────────────────────────

/**
 * A text field with an "insert a parameter" control beside it.
 *
 * A SQL statement is genuinely text and turning it into a form would be worse
 * than the notation. The part nobody should have to remember is the
 * `{{ params.day }}` spelling, so it is inserted — at the cursor, so it lands
 * mid-statement where it is wanted rather than at the end.
 */
export function TemplatedText({
  label,
  value,
  params,
  rows,
  mono,
  placeholder,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  params: WorkflowParam[];
  rows?: number;
  mono?: boolean;
  placeholder?: string;
  hint?: React.ReactNode;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  const insert = (name: string) => {
    const token = `{{ params.${name} }}`;
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const to = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, at) + token + value.slice(to));
    // Put the caret after what was just inserted, so typing carries on.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const Control = rows ? Textarea : Input;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[11px]">{label}</Label>
        {params.length > 0 ? (
          <Select value="" onValueChange={insert}>
            <SelectTrigger
              className="h-6 w-auto gap-1 border-dashed px-1.5 text-[10px] text-muted-foreground"
              aria-label={`Insert a parameter into ${label.toLowerCase()}`}
            >
              <Plus className="h-3 w-3" />
              Parameter
            </SelectTrigger>
            <SelectContent>
              {params.map((p) => (
                <SelectItem key={p.name} value={p.name} className="text-xs">
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <Control
        ref={ref}
        rows={rows}
        className={cn(rows ? "text-xs" : "h-7 text-xs", mono && "font-mono text-[11px]")}
        placeholder={placeholder}
        value={value}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement & HTMLInputElement>) =>
          onChange(e.target.value)
        }
      />
      {hint ? <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// ── Conditions ──────────────────────────────────────────────────────────────

/** One side of the comparison: pick a parameter, or type a value. */
function SideControl({
  label,
  side,
  params,
  onChange,
}: {
  label: string;
  side: ConditionSide;
  params: WorkflowParam[];
  onChange: (side: ConditionSide) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      <Select
        value={side.from === "param" ? side.name : TYPED}
        onValueChange={(v) =>
          onChange(v === TYPED ? { from: "value", value: "" } : { from: "param", name: v })
        }
      >
        <SelectTrigger className="h-7 text-xs" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {params.map((p) => (
            <SelectItem key={p.name} value={p.name} className="text-xs">
              Parameter · {p.name}
            </SelectItem>
          ))}
          <SelectItem value={TYPED} className="text-xs">
            A fixed value
          </SelectItem>
        </SelectContent>
      </Select>
      {side.from === "value" ? (
        <Input
          className="h-7 text-xs"
          placeholder="true"
          value={side.value}
          aria-label={`${label} value`}
          onChange={(e) => onChange({ from: "value", value: e.target.value })}
        />
      ) : null}
    </div>
  );
}

/**
 * The condition, assembled.
 *
 * It writes the same expression string the engine has always evaluated, so
 * nothing downstream changes: what changed is that the string is now a
 * consequence of three choices rather than something to get right by hand.
 */
export function ConditionBuilder({
  text,
  params,
  onChange,
}: {
  text: string | undefined;
  params: WorkflowParam[];
  onChange: (text: string) => void;
}) {
  const cond = parseCondition(text);
  const set = (next: Condition) => onChange(formatCondition(next));

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-2">
      <p className="text-[11px] font-medium">Take the true arrow when…</p>

      <SideControl
        label="This"
        side={cond.left}
        params={params}
        onChange={(left) => set({ ...cond, left })}
      />

      <div className="space-y-1">
        <Label className="text-[10px] text-muted-foreground">Test</Label>
        <Select
          value={cond.mode === "flag" ? "__flag" : cond.op}
          onValueChange={(v) =>
            set(
              v === "__flag"
                ? { mode: "flag", left: cond.left }
                : {
                    mode: "compare",
                    left: cond.left,
                    op: v as (typeof CONDITION_OPS)[number],
                    right: cond.mode === "compare" ? cond.right : { from: "value", value: "" },
                  },
            )
          }
        >
          <SelectTrigger className="h-7 text-xs" aria-label="Test">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONDITION_OPS.map((op) => (
              <SelectItem key={op} value={op} className="text-xs">
                {CONDITION_OP_LABEL[op]}
              </SelectItem>
            ))}
            <SelectItem value="__flag" className="text-xs">
              is set (true, yes or 1)
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {cond.mode === "compare" ? (
        <SideControl
          label="That"
          side={cond.right}
          params={params}
          onChange={(right) => set({ ...cond, right })}
        />
      ) : null}

      {params.length === 0 ? (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Declare a parameter in Settings to branch on one.
        </p>
      ) : null}
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Drag two arrows out of this step; the first is <b>true</b> and the second <b>false</b>, and
        the canvas labels them.
      </p>
    </div>
  );
}

// ── HTTP headers ────────────────────────────────────────────────────────────

const SECRET_REF = /^\{\{secret:([A-Za-z0-9_.-]+)\}\}$/;

/**
 * Headers as rows, and a secret as a choice.
 *
 * The old field was a textarea parsed on every keystroke, which meant the
 * `Name: value` shape was something to know and a colon in a value was a
 * quiet corruption. It also invited people to TYPE `{{secret:CI_TOKEN}}`,
 * which is a spelling nobody should have to hold — the names are known, so
 * they are offered. Only the name ever reaches the browser; the value is
 * resolved server-side at run time.
 */
export function HeaderRows({
  headers,
  secrets,
  onChange,
}: {
  headers: Record<string, string> | undefined;
  secrets: string[];
  onChange: (headers: Record<string, string>) => void;
}) {
  const rows = Object.entries(headers ?? {});
  // FOUND FROM THE UI. This used to drop rows whose name was still blank,
  // which meant picking the secret before typing the header name made the
  // whole row vanish under you. A half-filled row is a row being filled in;
  // `runHttpNodeCore` already ignores a blank name at run time, so there is
  // nothing to protect the request from here.
  const write = (next: [string, string][]) => onChange(Object.fromEntries(next));
  const edit = (i: number, k: string, v: string) => {
    const next = rows.map((r) => [...r] as [string, string]);
    next[i] = [k, v];
    write(next);
  };

  return (
    <div className="space-y-1">
      <Label className="text-[11px]">Headers</Label>
      {rows.length === 0 ? (
        <p className="text-[10px] text-muted-foreground">None. Most webhooks need at least one.</p>
      ) : null}
      {rows.map(([k, v], i) => {
        const secret = SECRET_REF.exec(v)?.[1];
        return (
          <div key={i} className="flex items-start gap-1">
            <div className="grid min-w-0 flex-1 gap-1">
              <Input
                className="h-7 text-xs"
                placeholder="Authorization"
                aria-label={`Header ${i + 1} name`}
                value={k}
                onChange={(e) => edit(i, e.target.value, v)}
              />
              <Select
                value={secret ?? TYPED}
                onValueChange={(s) => edit(i, k, s === TYPED ? "" : `{{secret:${s}}}`)}
              >
                <SelectTrigger className="h-7 text-xs" aria-label={`Header ${i + 1} value source`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TYPED} className="text-xs">
                    A value I type
                  </SelectItem>
                  {secrets.map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">
                      Secret · {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {secret ? (
                <p className="text-[10px] text-muted-foreground">
                  Filled in on the server at run time. The value never reaches this page.
                </p>
              ) : (
                <Input
                  className="h-7 font-mono text-[11px]"
                  placeholder="application/json"
                  aria-label={`Header ${i + 1} value`}
                  value={v}
                  onChange={(e) => edit(i, k, e.target.value)}
                />
              )}
            </div>
            <button
              title="Remove header"
              aria-label={`Remove header ${i + 1}`}
              className="mt-1.5 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => write(rows.filter((_, j) => j !== i) as [string, string][])}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        className="h-6 w-full gap-1 text-[10px]"
        onClick={() => onChange({ ...(headers ?? {}), "": "" })}
        disabled={Object.keys(headers ?? {}).includes("")}
      >
        <Plus className="h-3 w-3" />
        Add a header
      </Button>
    </div>
  );
}

// ── SQL models ──────────────────────────────────────────────────────────────

/**
 * Which models to build, ticked from the ones that exist.
 *
 * Typed names were a silent trap: a rename or a typo produced a step that
 * built nothing and said it succeeded. A model that is selected but no longer
 * exists still appears, ticked and flagged, rather than disappearing from the
 * step that depends on it.
 */
export function ModelPicker({
  selected,
  available,
  onChange,
}: {
  selected: string[];
  available: string[];
  onChange: (models: string[]) => void;
}) {
  const missing = selected.filter((m) => !available.includes(m));
  const all = [...available, ...missing];
  const toggle = (name: string, on: boolean) =>
    onChange(on ? [...selected, name] : selected.filter((m) => m !== name));

  return (
    <div className="space-y-1">
      <Label className="text-[11px]">Models</Label>
      {all.length === 0 ? (
        <p className="text-[10px] text-muted-foreground">
          You have no active SQL models yet. This step would build nothing.
        </p>
      ) : (
        <div className="max-h-[140px] space-y-1 overflow-y-auto rounded-md border p-1.5">
          {all.map((m) => (
            <label key={m} className="flex items-center gap-2 text-[11px]">
              <Checkbox
                checked={selected.includes(m)}
                onCheckedChange={(v) => toggle(m, v === true)}
              />
              <span className={cn("truncate", missing.includes(m) && "text-destructive")}>
                {m}
                {missing.includes(m) ? " · no longer exists" : ""}
              </span>
            </label>
          ))}
        </div>
      )}
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {selected.length === 0
          ? "Nothing ticked builds every active model."
          : "Ticked models build together with everything they are built from."}
      </p>
    </div>
  );
}
