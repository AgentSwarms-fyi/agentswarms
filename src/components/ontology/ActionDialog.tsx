// Running an action on an object: a typed form for its parameters, its
// criteria and whether it needs approval said up front, and the outcome said
// plainly — applied (with what changed) or waiting for approval.
import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { reportFailure } from "@/lib/silentFailureNet";
import { CheckCircle2, Clock, Loader2, ShieldCheck } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOntology } from "@/components/ontology/OntologyContext";
import { formatValue } from "@/components/ontology/theme";
import { ontologyActionRequest } from "@/utils/ontologyActions.functions";
import { allProperties, baseTypeOf, findObjectType, findValueType } from "@/lib/ontology/spec";

export function ActionDialog(props: {
  open: boolean;
  onClose: () => void;
  actionName: string;
  objectKey: Record<string, unknown> | null;
  current?: Record<string, unknown> | null;
  onDone?: () => void;
}) {
  const o = useOntology();
  const requestFn = useServerFn(ontologyActionRequest);
  const action = o.spec.actionTypes.find((a) => a.name === props.actionName);
  const t = action ? findObjectType(o.spec, action.objectType) : undefined;
  const props_ = useMemo(() => (t ? allProperties(o.spec, t) : []), [o.spec, t]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (action?.parameters ?? []).map((p) => [
        p.name,
        props.current?.[p.property] == null ? "" : String(props.current[p.property]),
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | {
        status: "applied";
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }
    | { status: "proposed" }
    | null
  >(null);
  if (!action || !t) return null;

  const submit = async () => {
    setBusy(true);
    try {
      const params: Record<string, string | number | boolean | null> = {};
      for (const p of action.parameters) {
        const raw = values[p.name] ?? "";
        const prop = props_.find((x) => x.name === p.property);
        const base = prop ? baseTypeOf(o.spec, prop.type) : "string";
        if (raw === "") params[p.name] = null;
        else if (base === "integer" || base === "decimal" || base === "float")
          params[p.name] = Number(raw);
        else if (base === "boolean") params[p.name] = raw === "true";
        else params[p.name] = raw;
      }
      const res = await requestFn({
        data: {
          access_token: o.tokenRef.current,
          id: o.id,
          action: action.name,
          key: (props.objectKey as Record<string, string | number | boolean> | null) ?? null,
          params,
        },
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setResult(
        res.status === "applied"
          ? { status: "applied", before: res.before, after: res.after }
          : { status: "proposed" },
      );
      toast.success(
        res.status === "applied" ? `${action.label ?? action.name}: done` : "Sent for approval",
      );
      props.onDone?.();
    } catch (e) {
      reportFailure("save it", e);
    } finally {
      setBusy(false);
    }
  };

  const changed =
    result?.status === "applied" && result.before && result.after
      ? Object.keys(result.after).filter(
          (k) => JSON.stringify(result.before![k]) !== JSON.stringify(result.after![k]),
        )
      : [];

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          setResult(null);
          props.onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action.label ?? action.name}</DialogTitle>
          <DialogDescription>
            {action.description ??
              `${action.kind === "create" ? "Create" : action.kind === "delete" ? "Delete" : "Change"} a ${t.name}.`}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          result.status === "proposed" ? (
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
              <Clock className="mt-0.5 h-4 w-4 text-amber-600" />
              <div>
                <p className="font-medium">Waiting for approval</p>
                <p className="text-muted-foreground">
                  The owner sees it under Actions → Waiting for approval. Nothing has changed yet.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Applied
              </p>
              {changed.length ? (
                <ul className="space-y-1 text-xs">
                  {changed.map((k) => (
                    <li key={k} className="font-mono">
                      {k}: {formatValue(result.before?.[k])} →{" "}
                      <span className="font-semibold">{formatValue(result.after?.[k])}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {action.kind === "delete"
                    ? "The object was removed."
                    : "No property changed value."}
                </p>
              )}
            </div>
          )
        ) : (
          <div className="space-y-3">
            {action.parameters.map((p) => {
              const prop = props_.find((x) => x.name === p.property);
              const vt = prop ? findValueType(o.spec, prop.type) : undefined;
              const base = prop ? baseTypeOf(o.spec, prop.type) : "string";
              return (
                <div key={p.name} className="space-y-1">
                  <Label className="text-xs">
                    {p.label ?? p.name}
                    {p.required && <span className="text-destructive"> *</span>}
                    <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                      → {p.property}
                    </span>
                  </Label>
                  {vt?.enum ? (
                    <Select
                      value={values[p.name] || undefined}
                      onValueChange={(v) => setValues((s) => ({ ...s, [p.name]: v }))}
                    >
                      <SelectTrigger aria-label={p.label ?? p.name}>
                        <SelectValue placeholder="Choose" />
                      </SelectTrigger>
                      <SelectContent>
                        {vt.enum.map((e) => (
                          <SelectItem key={e} value={e}>
                            {e}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : base === "boolean" ? (
                    <Select
                      value={values[p.name] || undefined}
                      onValueChange={(v) => setValues((s) => ({ ...s, [p.name]: v }))}
                    >
                      <SelectTrigger aria-label={p.label ?? p.name}>
                        <SelectValue placeholder="Choose" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">Yes</SelectItem>
                        <SelectItem value="false">No</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      type={
                        base === "integer" || base === "decimal" || base === "float"
                          ? "number"
                          : base === "date"
                            ? "date"
                            : "text"
                      }
                      value={values[p.name] ?? ""}
                      onChange={(e) => setValues((s) => ({ ...s, [p.name]: e.target.value }))}
                      aria-label={p.label ?? p.name}
                    />
                  )}
                </div>
              );
            })}
            {action.criteria && (
              <p className="rounded-md bg-muted/50 px-3 py-2 text-xs">
                Runs only when <span className="font-mono">{action.criteria}</span> holds for this{" "}
                {t.name}.
              </p>
            )}
            {action.requiresApproval && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" /> A person approves this before anything
                changes.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          {result ? (
            <Button
              onClick={() => {
                setResult(null);
                props.onClose();
              }}
            >
              Close
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={props.onClose}>
                Cancel
              </Button>
              <Button
                onClick={() => void submit()}
                disabled={
                  busy ||
                  action.parameters.some((p) => p.required && !(values[p.name] ?? "").trim())
                }
              >
                {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {action.requiresApproval ? "Request" : "Apply"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
