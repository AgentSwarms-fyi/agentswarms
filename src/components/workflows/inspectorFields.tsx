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
import { SecretHeaderValue } from "@/components/secrets/SecretHeaderValue";
import { TemplateInsertMenu, type TemplateToken } from "@/components/templates/TemplateInsert";
import { useInsertAtCaret } from "@/hooks/use-insert-at-caret";
import { useRowKeys } from "@/hooks/use-row-keys";
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
  // R495: the shared insert (components/templates/TemplateInsert). It also
  // fixes a pick made before the field had focus landing at the START: the
  // browser reports a cursor of 0 for a field nobody has clicked into.
  const { ref, insert } = useInsertAtCaret<HTMLTextAreaElement & HTMLInputElement>(value, onChange);

  const Control = rows ? Textarea : Input;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[11px]">{label}</Label>
        {params.length > 0 ? (
          <TemplateInsertMenu
            tokens={paramTokens(params)}
            onPick={insert}
            label="Parameter"
            fieldLabel={label.toLowerCase()}
          />
        ) : null}
      </div>
      <Control
        ref={ref}
        rows={rows}
        className={cn(rows ? "text-xs" : "h-7 text-xs", mono && "font-mono text-[11px]")}
        placeholder={placeholder}
        value={value}
        aria-label={label}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement & HTMLInputElement>) =>
          onChange(e.target.value)
        }
      />
      {hint ? <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** A workflow's parameters, as the insert menu lists them. */
function paramTokens(params: WorkflowParam[]): TemplateToken[] {
  return params.map((p) => ({
    insert: `{{ params.${p.name} }}`,
    label: p.name,
    detail: p.default ? `Default: ${p.default}` : "No default",
  }));
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

/**
 * Headers as rows, and a secret as a choice.
 *
 * The old field was a textarea parsed on every keystroke, which meant the
 * `Name: value` shape was something to know and a colon in a value was a
 * quiet corruption. It also invited people to TYPE `{{secret:CI_TOKEN}}`,
 * which is a spelling nobody should have to hold — the names are known, so
 * they are offered. Only the name ever reaches the browser; the value is
 * resolved server-side at run time.
 *
 * R493: the value is the shared header control the swarm HTTP node uses too:
 * a scheme ("Bearer ") before the secret, New secret in place, and the
 * server's own spelling of a reference. This file's detection regex had
 * allowed `.` and `-` in a name, which the server never resolves.
 */
export function HeaderRows({
  headers,
  url,
  params = [],
  onChange,
}: {
  headers: Record<string, string> | undefined;
  /** The request's URL: a secret shared with you goes only toward hosts its owner allowed. */
  url?: string;
  /** The run's parameters, offered for a text value (R495). */
  params?: WorkflowParam[];
  onChange: (headers: Record<string, string>) => void;
}) {
  const rows = Object.entries(headers ?? {});
  const rowKeys = useRowKeys(rows.length);
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
      {rows.map(([k, v], i) => (
        <div key={rowKeys.keys[i]} className="flex items-start gap-1">
          <div className="grid min-w-0 flex-1 gap-1">
            <Input
              className="h-7 text-xs"
              placeholder="Authorization"
              aria-label={`Header ${i + 1} name`}
              value={k}
              onChange={(e) => edit(i, e.target.value, v)}
            />
            <SecretHeaderValue
              index={i}
              headerName={k}
              value={v}
              onChange={(value) => edit(i, k, value)}
              destination={url}
              insertLabel="Parameter"
              insertTokens={params.length > 0 ? paramTokens(params) : undefined}
              textHint={
                <>
                  Text as sent.{" "}
                  {params.length > 0 ? (
                    <>
                      <strong>Parameter</strong> puts a run parameter in it.
                    </>
                  ) : (
                    <>Declare a parameter in Settings to use one here.</>
                  )}
                </>
              }
            />
          </div>
          <button
            title="Remove header"
            aria-label={`Remove header ${i + 1}`}
            className="mt-1.5 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => {
              rowKeys.removeAt(i);
              write(rows.filter((_, j) => j !== i) as [string, string][]);
            }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
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
