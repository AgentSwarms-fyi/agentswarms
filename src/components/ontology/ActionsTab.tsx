// Actions: the only way the ontology changes data, and the record of every
// change. Each action type says what may change, its criteria, whether a
// person approves it and what agents may do with it. The queue holds what is
// waiting for approval; the log holds everything — who asked (a person or an
// agent), who decided, and each property's value before and after.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { reportFailure } from "@/lib/silentFailureNet";
import {
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  User,
  X,
  Zap,
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
import { ActionDialog } from "@/components/ontology/ActionDialog";
import { useOntology } from "@/components/ontology/OntologyContext";
import { Field } from "@/components/ontology/TypeEditor";
import { formatValue, relativeTime, TypeBadge } from "@/components/ontology/theme";
import {
  ontologyActionDecide,
  ontologyActionLog,
  type ActionLogRow,
} from "@/utils/ontologyActions.functions";
import { checkExpr } from "@/lib/ontology/expr";
import {
  ACTION_KINDS,
  AGENT_MODES,
  allProperties,
  findObjectType,
  MEMBER_NAME,
  titleOf,
  type ActionType,
} from "@/lib/ontology/spec";
import { cn } from "@/lib/utils";

/** "Order 1063", "Order line 12 · 3", or "a new Customer" for a create. */
function ObjectRef(props: { type: string; objectKey: Record<string, unknown> | null }) {
  const o = useOntology();
  const t = findObjectType(o.spec, props.type);
  const name = t ? titleOf(t) : props.type;
  if (!props.objectKey) return <>a new {name}</>;
  return (
    <>
      {name} <span className="font-mono text-xs">{Object.values(props.objectKey).join(" · ")}</span>
    </>
  );
}

const AGENT_TEXT: Record<ActionType["agentMode"], string> = {
  none: "Agents may not use it",
  propose: "Agents may request it; a person approves",
  execute: "Agents may run it",
};

export function ActionsTab() {
  const o = useOntology();
  const logFn = useServerFn(ontologyActionLog);
  const decideFn = useServerFn(ontologyActionDecide);
  const [log, setLog] = useState<ActionLogRow[] | null>(null);
  const [status, setStatus] = useState<"all" | ActionLogRow["status"]>("all");
  const [editing, setEditing] = useState<ActionType | "new" | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const isOwner = o.detail.role === "owner";

  const load = async () => {
    const res = await logFn({ data: { access_token: o.tokenRef.current, id: o.id, limit: 200 } });
    if (res.ok) setLog(res.actions);
    else toast.error(res.error);
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (row: ActionLogRow, approve: boolean) => {
    setDeciding(row.id);
    try {
      const res = await decideFn({
        data: { access_token: o.tokenRef.current, id: o.id, action_id: row.id, approve },
      });
      if (res.ok) toast.success("Approved and applied");
      else if (res.error === "Rejected") toast.success("Rejected");
      else toast.error(res.error);
      await load();
      void o.reload();
    } catch (e) {
      reportFailure("record the decision", e);
    } finally {
      setDeciding(null);
    }
  };

  const pending = (log ?? []).filter((r) => r.status === "proposed");
  const shown = (log ?? []).filter((r) => status === "all" || r.status === status);

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Action types</h3>
            <p className="text-xs text-muted-foreground">
              What may change, under which conditions, and who decides.
            </p>
          </div>
          {o.canEdit && (
            <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Action type
            </Button>
          )}
        </header>
        {!o.spec.actionTypes.length ? (
          <p className="p-6 text-center text-sm text-muted-foreground">No action types yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {o.spec.actionTypes.map((a) => (
              <li key={a.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Zap className="h-4 w-4 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.label ?? a.name}</span>
                    <TypeBadge type={findObjectType(o.spec, a.objectType)} />
                    <Badge variant="outline" className="text-[10px] capitalize">
                      {a.kind}
                    </Badge>
                    {a.requiresApproval && (
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        <ShieldCheck className="h-3 w-3" /> approval
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Sets {a.parameters.map((p) => p.property).join(", ") || "nothing"}
                    {a.criteria && (
                      <>
                        {" "}
                        · when <span className="font-mono">{a.criteria}</span>
                      </>
                    )}{" "}
                    · {AGENT_TEXT[a.agentMode]}
                  </p>
                </div>
                {a.kind === "create" && (
                  <Button size="sm" variant="outline" onClick={() => setCreating(a.name)}>
                    {a.label ?? a.name}
                  </Button>
                )}
                {o.canEdit && (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => setEditing(a)}
                      aria-label={`Edit ${a.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        o.setSpec((s) => ({
                          ...s,
                          actionTypes: s.actionTypes.filter((x) => x.name !== a.name),
                        }))
                      }
                      aria-label={`Remove ${a.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {isOwner && pending.length > 0 && (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/5">
          <header className="flex items-center gap-2 border-b border-amber-500/30 px-4 py-3">
            <Clock className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-semibold">Waiting for your approval</h3>
            <span className="text-xs text-muted-foreground">{pending.length}</span>
          </header>
          <ul className="divide-y divide-amber-500/20">
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p>
                    <span className="font-medium">
                      {o.spec.actionTypes.find((a) => a.name === r.action_name)?.label ??
                        r.action_name}
                    </span>{" "}
                    on <ObjectRef type={r.object_type} objectKey={r.object_key} />
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {Object.entries(r.params)
                      .map(([k, v]) => `${k} → ${formatValue(v)}`)
                      .join(", ")}{" "}
                    · asked by {r.via === "agent" ? "an agent for " : ""}
                    {r.requested_by_email ?? "someone"} {relativeTime(r.created_at)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void decide(r, false)}
                  disabled={deciding === r.id}
                >
                  <X className="mr-1 h-3.5 w-3.5" /> Reject
                </Button>
                <Button size="sm" onClick={() => void decide(r, true)} disabled={deciding === r.id}>
                  {deciding === r.id ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="mr-1 h-3.5 w-3.5" />
                  )}{" "}
                  Approve and apply
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-xl border border-border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Edit log</h3>
            <p className="text-xs text-muted-foreground">
              {isOwner ? "Every action requested on this ontology." : "The actions you requested."}
            </p>
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
            <SelectTrigger className="h-8 w-40 text-xs" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everything</SelectItem>
              <SelectItem value="proposed">Waiting</SelectItem>
              <SelectItem value="applied">Applied</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
        </header>
        {!log ? (
          <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading
          </p>
        ) : !shown.length ? (
          <p className="p-6 text-center text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ol className="divide-y divide-border">
            {shown.map((r) => {
              const changed =
                r.before && r.after
                  ? Object.keys(r.after).filter(
                      (k) => JSON.stringify(r.before![k]) !== JSON.stringify(r.after![k]),
                    )
                  : [];
              return (
                <li key={r.id} className="flex gap-3 px-4 py-3 text-sm">
                  <span className="mt-0.5">
                    {r.status === "applied" ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="applied" />
                    ) : r.status === "proposed" ? (
                      <Clock className="h-4 w-4 text-amber-600" aria-label="waiting" />
                    ) : r.status === "rejected" ? (
                      <X className="h-4 w-4 text-muted-foreground" aria-label="rejected" />
                    ) : (
                      <CircleAlert className="h-4 w-4 text-rose-600" aria-label="failed" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p>
                      <span className="font-medium">
                        {o.spec.actionTypes.find((a) => a.name === r.action_name)?.label ??
                          r.action_name}
                      </span>{" "}
                      <span className="text-muted-foreground">on</span>{" "}
                      <ObjectRef type={r.object_type} objectKey={r.object_key} />
                    </p>
                    {changed.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-xs">
                        {changed.map((k) => (
                          <li key={k} className="font-mono">
                            {k}:{" "}
                            <span className="text-muted-foreground line-through">
                              {formatValue(r.before?.[k])}
                            </span>{" "}
                            → <span className="font-semibold">{formatValue(r.after?.[k])}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {r.error && (
                      <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">{r.error}</p>
                    )}
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      {r.via === "agent" ? (
                        <Bot className="h-3 w-3" />
                      ) : (
                        <User className="h-3 w-3" />
                      )}
                      {r.via === "agent" ? "Agent, for " : ""}
                      {r.requested_by_email ?? "unknown"} · {relativeTime(r.created_at)}
                      {r.decided_by_email && r.status !== "applied" && (
                        <> · decided by {r.decided_by_email}</>
                      )}
                      {r.decided_by_email &&
                        r.status === "applied" &&
                        r.decided_by_email !== r.requested_by_email && (
                          <> · approved by {r.decided_by_email}</>
                        )}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      "h-fit text-[10px] capitalize",
                      r.status === "failed" && "border-rose-500/40 text-rose-700",
                    )}
                  >
                    {r.status === "proposed" ? "waiting" : r.status}
                  </Badge>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {editing && (
        <ActionTypeDialog
          action={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(a, prev) => {
            o.setSpec((s) => ({
              ...s,
              actionTypes: prev
                ? s.actionTypes.map((x) => (x.name === prev ? a : x))
                : [...s.actionTypes, a],
            }));
            setEditing(null);
          }}
        />
      )}
      {creating && (
        <ActionDialog
          open
          actionName={creating}
          objectKey={null}
          onClose={() => setCreating(null)}
          onDone={() => void load()}
        />
      )}
    </div>
  );
}

function ActionTypeDialog(props: {
  action: ActionType | null;
  onClose: () => void;
  onSave: (a: ActionType, previousName?: string) => void;
}) {
  const o = useOntology();
  const bound = o.spec.objectTypes.filter((t) => t.source);
  const [a, setA] = useState<ActionType>(
    props.action ?? {
      name: "",
      label: "",
      objectType: bound[0]?.name ?? "",
      kind: "modify",
      parameters: [],
      requiresApproval: true,
      agentMode: "propose",
    },
  );
  const t = findObjectType(o.spec, a.objectType);
  const props_ = t ? allProperties(o.spec, t).filter((p) => !p.expression) : [];
  const crit = a.criteria
    ? checkExpr(a.criteria, "predicate", t ? allProperties(o.spec, t).map((p) => p.name) : [])
    : null;
  const set = (patch: Partial<ActionType>) => setA((x) => ({ ...x, ...patch }));
  const valid =
    MEMBER_NAME.test(a.name) &&
    t &&
    (a.kind !== "modify" || a.parameters.length) &&
    (!crit || crit.ok);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{props.action ? "Edit action type" : "New action type"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" hint="snake_case">
            <Input
              value={a.name}
              onChange={(e) => set({ name: e.target.value })}
              className="font-mono"
              placeholder="update_status"
            />
          </Field>
          <Field label="Label">
            <Input
              value={a.label ?? ""}
              onChange={(e) => set({ label: e.target.value || undefined })}
              placeholder="Update order status"
            />
          </Field>
          <Field label="On">
            <Select
              value={a.objectType}
              onValueChange={(v) => set({ objectType: v, parameters: [] })}
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
          <Field label="Does">
            <Select value={a.kind} onValueChange={(v) => set({ kind: v as ActionType["kind"] })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTION_KINDS.map((k) => (
                  <SelectItem key={k} value={k} className="capitalize">
                    {k === "modify"
                      ? "Change an object"
                      : k === "create"
                        ? "Create an object"
                        : "Delete an object"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {a.kind !== "delete" && (
            <Field label="Sets these properties" className="sm:col-span-2">
              <div className="flex flex-wrap gap-1.5">
                {props_.map((p) => {
                  const on = a.parameters.some((x) => x.property === p.name);
                  const isKey = t?.primaryKey.includes(p.name);
                  return (
                    <button
                      key={p.name}
                      type="button"
                      disabled={a.kind === "modify" && isKey}
                      onClick={() =>
                        set({
                          parameters: on
                            ? a.parameters.filter((x) => x.property !== p.name)
                            : [
                                ...a.parameters,
                                {
                                  name: p.name,
                                  property: p.name,
                                  label: p.label,
                                  required: a.kind === "create" && isKey,
                                },
                              ],
                        })
                      }
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs disabled:opacity-40",
                        on ? "border-primary bg-primary/10 text-primary" : "border-border",
                      )}
                    >
                      {p.name}
                      {isKey && " (key)"}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
          <Field
            label="Only when"
            hint="Optional condition on the object as it is now"
            error={crit && !crit.ok ? crit.error : undefined}
            className="sm:col-span-2"
          >
            <Input
              value={a.criteria ?? ""}
              onChange={(e) => set({ criteria: e.target.value || undefined })}
              className="font-mono text-xs"
              placeholder="status <> 'cancelled'"
            />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea
              value={a.description ?? ""}
              onChange={(e) => set({ description: e.target.value || undefined })}
              rows={2}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={a.requiresApproval}
              onCheckedChange={(v) => set({ requiresApproval: v })}
            />{" "}
            A person approves each one
          </label>
          <Field label="Agents">
            <Select
              value={a.agentMode}
              onValueChange={(v) => set({ agentMode: v as ActionType["agentMode"] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {AGENT_TEXT[m]}
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
          <Button onClick={() => props.onSave(a, props.action?.name)} disabled={!valid}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
