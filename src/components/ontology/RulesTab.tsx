// Rules: what must hold true, written in words AND checked against the data.
//
// Two kinds sit side by side: the rules people wrote (a total is never
// negative; delivery comes after shipping) and the ones the model implies
// without anyone writing them (keys are present and unique, required
// properties are filled, value types' allowed values hold, links point at
// something). Running them counts the objects that break each one and keeps
// a few, which open like any other object.
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { reportFailure } from "@/lib/silentFailureNet";
import {
  CheckCircle2,
  CircleAlert,
  Loader2,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ObjectPanel } from "@/components/ontology/ExploreTab";
import { useOntology } from "@/components/ontology/OntologyContext";
import { Field } from "@/components/ontology/TypeEditor";
import { formatValue, relativeTime, SeverityChip, TypeBadge } from "@/components/ontology/theme";
import {
  ontologyRuleRuns,
  ontologyRunRules,
  type RuleResult,
  type RuleRun,
} from "@/utils/ontologyData.functions";
import { impliedRules } from "@/lib/ontology/compile";
import { checkExpr } from "@/lib/ontology/expr";
import {
  allProperties,
  findObjectType,
  RULE_KINDS,
  SEVERITIES,
  type OntologyRule,
  type RuleKind,
} from "@/lib/ontology/spec";
import { clickable } from "@/lib/clickable";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<RuleKind, string> = {
  required: "Must be filled in",
  unique: "Must be unique",
  pattern: "Must match a pattern",
  range: "Must be within a range",
  allowed_values: "Must be one of",
  referential: "Link must point at something",
  predicate: "Condition must hold",
};

export function RulesTab() {
  const o = useOntology();
  const runFn = useServerFn(ontologyRunRules);
  const runsFn = useServerFn(ontologyRuleRuns);
  const [runs, setRuns] = useState<RuleRun[] | null>(null);
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState<OntologyRule | "new" | null>(null);
  const [open, setOpen] = useState<{ objectType: string; key: Record<string, unknown> } | null>(
    null,
  );
  const isOwner = o.detail.role === "owner";
  const implied = useMemo(() => impliedRules(o.spec), [o.spec]);

  const loadRuns = async () => {
    const res = await runsFn({ data: { access_token: o.tokenRef.current, id: o.id, limit: 20 } });
    if (res.ok) setRuns(res.runs);
  };
  useEffect(() => {
    void loadRuns();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runAll = async () => {
    setRunning(true);
    try {
      const res = await runFn({
        data: { access_token: o.tokenRef.current, id: o.id, include_implied: true },
      });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(
          `${res.run.rules_run} rules checked: ${res.run.passed} pass, ${res.run.failed} failing${res.run.errored ? `, ${res.run.errored} errored` : ""}`,
        );
        setRuns((r) => [res.run, ...(r ?? [])]);
        void o.reload();
      }
    } catch (e) {
      reportFailure("run the rules", e);
    } finally {
      setRunning(false);
    }
  };

  const last = runs?.[0];
  const resultOf = (id: string): RuleResult | undefined => last?.results.find((r) => r.id === id);

  const saveRule = (rule: OntologyRule, previousId?: string) =>
    o.setSpec((s) => ({
      ...s,
      rules: previousId ? s.rules.map((r) => (r.id === previousId ? rule : r)) : [...s.rules, rule],
    }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          {last ? (
            <>
              <Stat
                label="Pass"
                value={last.passed}
                tone="text-emerald-700 dark:text-emerald-400"
              />
              <Stat
                label="Failing"
                value={last.failed}
                tone={last.failed ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}
              />
              <Stat
                label="Errored"
                value={last.errored}
                tone={last.errored ? "text-rose-700 dark:text-rose-300" : "text-muted-foreground"}
              />
              <span className="text-xs text-muted-foreground">
                Last run {relativeTime(last.finished_at)}, on revision {last.revision}
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">Not run yet.</span>
          )}
        </div>
        <div className="flex gap-2">
          {o.canEdit && (
            <Button variant="outline" onClick={() => setEditing("new")}>
              <Plus className="mr-1.5 h-4 w-4" /> Rule
            </Button>
          )}
          {isOwner && (
            <Button onClick={() => void runAll()} disabled={running}>
              {running ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-4 w-4" />
              )}{" "}
              Run all rules
            </Button>
          )}
        </div>
      </div>

      {runs && runs.length > 1 && <RunHistory runs={runs} />}

      <RuleTable
        title="Written rules"
        rules={o.spec.rules}
        resultOf={resultOf}
        onEdit={o.canEdit ? (r) => setEditing(r) : undefined}
        onRemove={
          o.canEdit
            ? (r) => o.setSpec((s) => ({ ...s, rules: s.rules.filter((x) => x.id !== r.id) }))
            : undefined
        }
        onToggle={
          o.canEdit
            ? (r, on) =>
                o.setSpec((s) => ({
                  ...s,
                  rules: s.rules.map((x) => (x.id === r.id ? { ...x, enabled: on } : x)),
                }))
            : undefined
        }
        onOpen={setOpen}
        empty="No rules written yet. Add one in words; give it a condition and it is checked against the data."
      />
      <RuleTable
        title="Implied by the model"
        subtitle="Keys, required properties, value types and links, checked without anyone writing them."
        rules={implied}
        resultOf={resultOf}
        onOpen={setOpen}
        implied
        empty="Bind types to tables to get these."
      />

      {editing && (
        <RuleDialog
          rule={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(r) => {
            saveRule(r, editing === "new" ? undefined : editing.id);
            setEditing(null);
          }}
        />
      )}
      <ObjectPanel target={open} onClose={() => setOpen(null)} onNavigate={setOpen} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div>
      <p className={cn("text-2xl font-semibold tabular-nums", tone)}>{value}</p>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

function RunHistory({ runs }: { runs: RuleRun[] }) {
  const pts = [...runs].reverse();
  const max = Math.max(1, ...pts.map((r) => r.rules_run));
  return (
    <div
      className="flex items-end gap-1 rounded-xl border border-border bg-card p-3"
      aria-label="Recent runs"
    >
      <span className="mr-2 self-center text-xs text-muted-foreground">Recent runs</span>
      {pts.map((r) => (
        <div
          key={r.id}
          className="flex h-12 w-3 flex-col justify-end overflow-hidden rounded-sm bg-muted"
          title={`${new Date(r.started_at).toLocaleString()}: ${r.passed} pass, ${r.failed} failing`}
        >
          <div className="bg-amber-500" style={{ height: `${(r.failed / max) * 100}%` }} />
          <div className="bg-emerald-500" style={{ height: `${(r.passed / max) * 100}%` }} />
        </div>
      ))}
    </div>
  );
}

function RuleTable(props: {
  title: string;
  subtitle?: string;
  rules: OntologyRule[];
  resultOf: (id: string) => RuleResult | undefined;
  onEdit?: (r: OntologyRule) => void;
  onRemove?: (r: OntologyRule) => void;
  onToggle?: (r: OntologyRule, on: boolean) => void;
  onOpen: (t: { objectType: string; key: Record<string, unknown> }) => void;
  implied?: boolean;
  empty: string;
}) {
  const o = useOntology();
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {props.implied && <Sparkles className="h-4 w-4 text-primary" />} {props.title}
          <span className="font-normal text-muted-foreground">{props.rules.length}</span>
        </h3>
        {props.subtitle && <p className="text-xs text-muted-foreground">{props.subtitle}</p>}
      </header>
      {!props.rules.length ? (
        <p className="p-6 text-center text-sm text-muted-foreground">{props.empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {props.rules.map((r) => {
            const res = props.resultOf(r.id);
            const t = findObjectType(o.spec, r.objectType);
            const failing = (res?.violations ?? 0) > 0;
            const isOpen = expanded === r.id;
            return (
              <li key={r.id} className={cn("px-4 py-3", !r.enabled && "opacity-60")}>
                <div className="flex flex-wrap items-start gap-3">
                  <span className="mt-0.5">
                    {!res ? (
                      <span
                        className="block h-4 w-4 rounded-full border-2 border-muted-foreground/30"
                        aria-label="not run"
                      />
                    ) : res.error ? (
                      <CircleAlert className="h-4 w-4 text-rose-600" aria-label="errored" />
                    ) : failing ? (
                      <CircleAlert className="h-4 w-4 text-amber-600" aria-label="failing" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="passes" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.name}</span>
                      <SeverityChip severity={r.severity} />
                      <TypeBadge type={t} />
                      <Badge variant="outline" className="text-[10px]">
                        {KIND_LABEL[r.kind]}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">{r.statement}</p>
                    {r.kind === "predicate" && r.predicate && (
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                        {r.predicate}
                      </p>
                    )}
                    {res && (
                      <p className="mt-1 text-xs">
                        {res.error ? (
                          <span className="text-rose-700 dark:text-rose-300">{res.error}</span>
                        ) : (
                          <>
                            <span
                              className={
                                failing
                                  ? "font-medium text-amber-800 dark:text-amber-300"
                                  : "text-emerald-700 dark:text-emerald-400"
                              }
                            >
                              {res.violations?.toLocaleString()} of {res.checked?.toLocaleString()}{" "}
                              break it
                            </span>
                            {failing && (
                              <button
                                type="button"
                                className="ml-2 text-primary underline-offset-2 hover:underline"
                                onClick={() => setExpanded(isOpen ? null : r.id)}
                              >
                                {isOpen ? "Hide examples" : "Show examples"}
                              </button>
                            )}
                          </>
                        )}
                      </p>
                    )}
                    {isOpen && res && res.sample.length > 0 && t && (
                      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
                        <table className="w-full text-xs">
                          <thead className="bg-muted/40 text-left text-muted-foreground">
                            <tr>
                              {Object.keys(res.sample[0]).map((k) => (
                                <th key={k} className="px-2 py-1 font-medium">
                                  {k}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {res.sample.map((s, i) => (
                              <tr
                                key={i}
                                className="cursor-pointer border-t border-border hover:bg-muted/40"
                                {...clickable(
                                  () =>
                                    props.onOpen({
                                      objectType: t.name,
                                      key: Object.fromEntries(t.primaryKey.map((k) => [k, s[k]])),
                                    }),
                                  `Open ${t.name}`,
                                )}
                              >
                                {Object.keys(res.sample[0]).map((k) => (
                                  <td key={k} className="px-2 py-1 tabular-nums">
                                    {formatValue(s[k])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  {!props.implied && (props.onEdit || props.onToggle) && (
                    <div className="flex items-center gap-1">
                      {props.onToggle && (
                        <Switch
                          checked={r.enabled}
                          onCheckedChange={(v) => props.onToggle!(r, v)}
                          aria-label={`Enable ${r.name}`}
                        />
                      )}
                      {props.onEdit && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => props.onEdit!(r)}
                          aria-label={`Edit ${r.name}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {props.onRemove && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => props.onRemove!(r)}
                          aria-label={`Remove ${r.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function RuleDialog(props: {
  rule: OntologyRule | null;
  onClose: () => void;
  onSave: (r: OntologyRule) => void;
}) {
  const o = useOntology();
  const bound = o.spec.objectTypes.filter((t) => t.source);
  const [r, setR] = useState<OntologyRule>(
    props.rule ?? {
      id: `rule-${Date.now().toString(36)}`,
      name: "",
      statement: "",
      objectType: bound[0]?.name ?? "",
      kind: "predicate",
      predicate: "",
      severity: "warning",
      enabled: true,
    },
  );
  const t = findObjectType(o.spec, r.objectType);
  const props_ = t ? allProperties(o.spec, t).map((p) => p.name) : [];
  const links = o.spec.linkTypes.filter(
    (l) => l.from === r.objectType && l.join.kind === "foreign_key",
  );
  const check =
    r.kind === "predicate" && r.predicate ? checkExpr(r.predicate, "predicate", props_) : null;
  const set = (patch: Partial<OntologyRule>) => setR((x) => ({ ...x, ...patch }));
  const needsProp = ["required", "unique", "pattern", "range", "allowed_values"].includes(r.kind);
  const valid =
    r.name.trim() &&
    r.statement.trim() &&
    t &&
    (!needsProp || r.property) &&
    (r.kind !== "predicate" || (r.predicate && check?.ok)) &&
    (r.kind !== "referential" || r.link) &&
    (r.kind !== "pattern" || r.pattern) &&
    (r.kind !== "allowed_values" || r.values?.length) &&
    (r.kind !== "range" || r.min !== undefined || r.max !== undefined);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{props.rule ? "Edit rule" : "New rule"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">
            <Input
              value={r.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Order totals are not negative"
            />
          </Field>
          <Field
            label="In words"
            hint="What people read, and what agents are told"
            className="sm:col-span-2"
          >
            <Textarea
              value={r.statement}
              onChange={(e) => set({ statement: e.target.value })}
              rows={2}
              placeholder="An order's total is zero or more."
            />
          </Field>
          <Field label="About">
            <Select
              value={r.objectType}
              onValueChange={(v) => set({ objectType: v, property: undefined, link: undefined })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {bound.map((x) => (
                  <SelectItem key={x.name} value={x.name}>
                    {x.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Kind">
            <Select value={r.kind} onValueChange={(v) => set({ kind: v as RuleKind })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {needsProp && (
            <Field label="Property">
              <Select value={r.property ?? ""} onValueChange={(v) => set({ property: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {props_.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {r.kind === "referential" && (
            <Field label="Link">
              <Select value={r.link ?? ""} onValueChange={(v) => set({ link: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {links.map((l) => (
                    <SelectItem key={l.name} value={l.name}>
                      {l.name} → {l.to}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {r.kind === "predicate" && (
            <Field
              label="Condition every object meets"
              className="sm:col-span-2"
              error={check && !check.ok ? check.error : undefined}
              hint={`Uses ${t?.name ?? ""} properties: ${props_.slice(0, 8).join(", ")}${props_.length > 8 ? "…" : ""}`}
            >
              <Input
                value={r.predicate ?? ""}
                onChange={(e) => set({ predicate: e.target.value })}
                className="font-mono text-xs"
                placeholder="total_amount >= 0"
              />
            </Field>
          )}
          {r.kind === "pattern" && (
            <Field label="Pattern (regular expression)" className="sm:col-span-2">
              <Input
                value={r.pattern ?? ""}
                onChange={(e) => set({ pattern: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>
          )}
          {r.kind === "range" && (
            <>
              <Field label="At least">
                <Input
                  type="number"
                  value={r.min ?? ""}
                  onChange={(e) =>
                    set({ min: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="At most">
                <Input
                  type="number"
                  value={r.max ?? ""}
                  onChange={(e) =>
                    set({ max: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              </Field>
            </>
          )}
          {r.kind === "allowed_values" && (
            <Field label="Allowed values" hint="One per line" className="sm:col-span-2">
              <Textarea
                value={(r.values ?? []).join("\n")}
                onChange={(e) =>
                  set({
                    values: e.target.value
                      .split("\n")
                      .map((v) => v.trim())
                      .filter(Boolean),
                  })
                }
                rows={3}
                className="font-mono text-xs"
              />
            </Field>
          )}
          <Field label="Severity">
            <Select
              value={r.severity}
              onValueChange={(v) => set({ severity: v as OntologyRule["severity"] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={() => props.onSave(r)} disabled={!valid}>
            Save rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
