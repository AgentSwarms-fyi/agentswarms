// Editing one object type: what it is, where its objects come from, what is
// known about each, and what is measured. Every field validates as you type,
// and a property or metric expression says exactly which name it does not
// know before anything runs.
import { useMemo, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { reportFailure } from "@/lib/silentFailureNet";
import {
  Database,
  Eye,
  KeyRound,
  Loader2,
  Plus,
  Sparkles,
  Star,
  Trash2,
  Wand2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { useOntology } from "@/components/ontology/OntologyContext";
import { TYPE_ICON, TYPE_TONE, formatValue } from "@/components/ontology/theme";
import { useLakehouseTables } from "@/components/ontology/useLakehouseTables";
import { ontologyPreviewTable } from "@/utils/ontologyData.functions";
import { usesOfType } from "@/lib/ontology/diff";
import { freshMemberName, removeType, renameProperty, renameType } from "@/lib/ontology/edit";
import { checkExpr } from "@/lib/ontology/expr";
import {
  allProperties,
  BASE_TYPES,
  baseTypeFromSql,
  CONCEPT_NAME,
  MEMBER_NAME,
  memberNameFrom,
  METRIC_FORMATS,
  SENSITIVITIES,
  TYPE_COLORS,
  TYPE_ICONS,
  TYPE_STATUSES,
  type ObjectType,
  type OntologyProperty,
  type OntologySpec,
} from "@/lib/ontology/spec";
import { cn } from "@/lib/utils";

const NONE = "__none__";

export function TypeEditor({
  typeName,
  onRenamed,
}: {
  typeName: string;
  onRenamed: (n: string) => void;
}) {
  const o = useOntology();
  const t = o.spec.objectTypes.find((x) => x.name === typeName);
  const [nameDraft, setNameDraft] = useState(typeName);
  if (!t) return <p className="text-sm text-muted-foreground">That type no longer exists.</p>;
  const ro = !o.canEdit;

  const update = (patch: Partial<ObjectType> | ((t: ObjectType) => ObjectType)) =>
    o.setSpec((s) => ({
      ...s,
      objectTypes: s.objectTypes.map((x) =>
        x.name === typeName ? (typeof patch === "function" ? patch(x) : { ...x, ...patch }) : x,
      ),
    }));

  const commitName = () => {
    const n = nameDraft.trim();
    if (n === t.name) return;
    if (!CONCEPT_NAME.test(n)) {
      toast.error("A type name is PascalCase: a capital letter, then letters and digits");
      setNameDraft(t.name);
      return;
    }
    if (
      o.spec.objectTypes.some((x) => x.name.toLowerCase() === n.toLowerCase() && x.name !== t.name)
    ) {
      toast.error(`${n} already exists`);
      setNameDraft(t.name);
      return;
    }
    o.setSpec((s) => renameType(s, t.name, n));
    onRenamed(n);
  };

  const remove = async () => {
    const uses = usesOfType(o.spec, t.name);
    const ok = await confirmAsk({
      title: `Remove ${t.name}?`,
      body: uses.length
        ? `These go with it: ${uses.join(", ")}. The table itself is not touched.`
        : "Its table is not touched; only the model forgets it.",
      actionLabel: "Remove",
    });
    if (ok) o.setSpec((s) => removeType(s, t.name));
  };

  return (
    <div className="space-y-5">
      <Section title="What it is">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" hint="PascalCase; how links, rules and exports refer to it">
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              disabled={ro}
              className="font-mono"
            />
          </Field>
          <Field label="Label">
            <Input
              value={t.label ?? ""}
              onChange={(e) => update({ label: e.target.value || undefined })}
              disabled={ro}
              placeholder={t.name}
            />
          </Field>
          <Field
            label="Description"
            className="sm:col-span-2"
            hint="What ONE object is. People and agents read this."
          >
            <Textarea
              value={t.description ?? ""}
              onChange={(e) => update({ description: e.target.value || undefined })}
              disabled={ro}
              rows={2}
            />
          </Field>
          <Field label="Also called" hint="Comma-separated words people use for it">
            <Input
              value={(t.synonyms ?? []).join(", ")}
              onChange={(e) =>
                update({
                  synonyms: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .slice(0, 50),
                })
              }
              disabled={ro}
              placeholder="client, account"
            />
          </Field>
          <Field label="Domain">
            <Input
              value={t.domain ?? ""}
              onChange={(e) => update({ domain: e.target.value || undefined })}
              disabled={ro}
              placeholder="Sales"
            />
          </Field>
          <Field label="Status">
            <Select
              value={t.status ?? "draft"}
              onValueChange={(v) => update({ status: v as ObjectType["status"] })}
              disabled={ro}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="A kind of" hint="Inherit another type's properties">
            <Select
              value={t.extends ?? NONE}
              onValueChange={(v) => update({ extends: v === NONE ? undefined : v })}
              disabled={ro}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Nothing (a type of its own)</SelectItem>
                {o.spec.objectTypes
                  .filter((x) => x.name !== t.name)
                  .map((x) => (
                    <SelectItem key={x.name} value={x.name}>
                      {x.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Icon">
            {TYPE_ICONS.map((i) => {
              const Icon = TYPE_ICON[i];
              return (
                <button
                  key={i}
                  type="button"
                  disabled={ro}
                  onClick={() => update({ icon: i })}
                  className={cn(
                    "rounded-md border p-1.5",
                    t.icon === i
                      ? "border-primary bg-primary/10"
                      : "border-transparent hover:bg-muted",
                  )}
                  aria-label={i}
                  aria-checked={t.icon === i}
                  role="radio"
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Colour">
            {TYPE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={ro}
                onClick={() => update({ color: c })}
                className={cn(
                  "h-5 w-5 rounded-full border-2",
                  TYPE_TONE[c].dot,
                  t.color === c ? "border-foreground" : "border-transparent",
                )}
                aria-label={c}
                aria-checked={t.color === c}
                role="radio"
              />
            ))}
          </div>
        </div>
        {o.spec.interfaces.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Implements:</span>
            {o.spec.interfaces.map((i) => {
              const on = (t.interfaces ?? []).includes(i.name);
              return (
                <button
                  key={i.name}
                  type="button"
                  disabled={ro}
                  onClick={() =>
                    update({
                      interfaces: on
                        ? (t.interfaces ?? []).filter((x) => x !== i.name)
                        : [...(t.interfaces ?? []), i.name],
                    })
                  }
                  className={cn(
                    "rounded-full border px-2 py-0.5",
                    on
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {i.name}
                </button>
              );
            })}
          </div>
        )}
      </Section>

      <BindingSection t={t} update={update} ro={ro} />
      <PropertiesSection t={t} update={update} ro={ro} />
      <MetricsSection t={t} update={update} ro={ro} />

      <Section
        title="Told to AI"
        description="How an assistant should treat this type: defaults, exclusions, the metric to prefer."
      >
        <Textarea
          value={t.aiInstructions ?? ""}
          onChange={(e) => update({ aiInstructions: e.target.value || undefined })}
          disabled={ro}
          rows={3}
          placeholder="Revenue means the certified revenue metric; exclude test orders unless asked."
        />
      </Section>

      {!ro && (
        <div className="flex justify-end border-t border-border pt-4">
          <Button variant="outline" className="text-destructive" onClick={() => void remove()}>
            <Trash2 className="mr-1.5 h-4 w-4" /> Remove {t.name}
          </Button>
        </div>
      )}
    </div>
  );
}

type Updater = (patch: Partial<ObjectType> | ((t: ObjectType) => ObjectType)) => void;

function BindingSection({ t, update, ro }: { t: ObjectType; update: Updater; ro: boolean }) {
  const o = useOntology();
  const { tables, error } = useLakehouseTables(o.tokenRef, o.canEdit);
  const previewFn = useServerFn(ontologyPreviewTable);
  const [preview, setPreview] = useState<{
    columns: string[];
    rows: Record<string, unknown>[];
    total: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const table = tables?.find((x) => x.table.toLowerCase() === t.source?.table.toLowerCase());
  const filterCheck = t.source?.filter
    ? checkExpr(t.source.filter, "predicate", table ? table.columns.map((c) => c.name) : null)
    : null;

  const runPreview = async () => {
    if (!t.source) return;
    setBusy(true);
    try {
      const res = await previewFn({
        data: {
          access_token: o.tokenRef.current,
          id: o.id,
          table: t.source.table,
          filter: t.source.filter,
        },
      });
      if (!res.ok) toast.error(res.error);
      else setPreview(res);
    } catch (e) {
      reportFailure("preview the table", e);
    } finally {
      setBusy(false);
    }
  };

  const addColumns = () => {
    if (!table) return;
    update((x) => {
      const mapped = new Set(x.properties.map((p) => p.column?.toLowerCase()).filter(Boolean));
      const names = x.properties.map((p) => p.name);
      const added: OntologyProperty[] = [];
      for (const c of table.columns) {
        if (mapped.has(c.name.toLowerCase())) continue;
        const name = freshMemberName(
          [...names, ...added.map((a) => a.name)],
          memberNameFrom(c.name),
        );
        added.push({ name, type: baseTypeFromSql(c.type), column: c.name });
      }
      const props = [...x.properties, ...added];
      const key = x.primaryKey.length
        ? x.primaryKey
        : props.find((p) => p.name === "id" || p.name.endsWith("_id"))
          ? [props.find((p) => p.name === "id" || p.name.endsWith("_id"))!.name]
          : [];
      return { ...x, properties: props, primaryKey: key };
    });
  };

  return (
    <Section
      title="Where its objects come from"
      description="One row of the table is one object. A filter makes a subtype of the same table (e.g. VIP customers)."
    >
      {!o.canEdit ? (
        <p className="flex items-center gap-2 text-sm">
          <Database className="h-4 w-4 text-muted-foreground" />
          {t.source ? <span className="font-mono">{t.source.table}</span> : "Not bound to a table"}
          {t.source?.filter && (
            <span className="text-muted-foreground">where {t.source.filter}</span>
          )}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Table">
              <Select
                value={t.source?.table ?? NONE}
                onValueChange={(v) =>
                  update({
                    source:
                      v === NONE
                        ? null
                        : { table: v, ...(t.source?.filter ? { filter: t.source.filter } : {}) },
                  })
                }
                disabled={ro}
              >
                <SelectTrigger>
                  <SelectValue placeholder={error ?? "Pick a table"} />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={NONE}>Not bound (an abstract type)</SelectItem>
                  {t.source && !table && (
                    <SelectItem value={t.source.table}>{t.source.table} (not readable)</SelectItem>
                  )}
                  {(tables ?? []).map((x) => (
                    <SelectItem key={x.table} value={x.table} className="font-mono text-xs">
                      {x.table}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Only rows where"
              hint="Optional SQL over the table's columns"
              error={filterCheck && !filterCheck.ok ? filterCheck.error : undefined}
            >
              <Input
                value={t.source?.filter ?? ""}
                onChange={(e) =>
                  t.source &&
                  update({
                    source: {
                      table: t.source.table,
                      ...(e.target.value ? { filter: e.target.value } : {}),
                    },
                  })
                }
                disabled={ro || !t.source}
                className="font-mono text-xs"
                placeholder="segment = 'Enterprise'"
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runPreview()}
              disabled={!t.source || busy}
            >
              {busy ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Eye className="mr-1.5 h-3.5 w-3.5" />
              )}{" "}
              Preview rows
            </Button>
            <Button size="sm" variant="outline" onClick={addColumns} disabled={!table || ro}>
              <Wand2 className="mr-1.5 h-3.5 w-3.5" /> Add a property per unmapped column
            </Button>
          </div>
          {preview && (
            <div className="overflow-x-auto rounded-lg border border-border">
              <p className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                {preview.total.toLocaleString()} matching rows · first {preview.rows.length}
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    {preview.columns.map((c) => (
                      <th
                        key={c}
                        className="whitespace-nowrap border-b border-border px-2 py-1 text-left font-medium"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 8).map((r, i) => (
                    <tr key={i} className="odd:bg-muted/20">
                      {preview.columns.map((c) => (
                        <td
                          key={c}
                          className="max-w-[200px] truncate whitespace-nowrap px-2 py-1 tabular-nums"
                        >
                          {formatValue(r[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function typeOptions(spec: OntologySpec) {
  return (
    <>
      <SelectGroup>
        <SelectLabel>Base types</SelectLabel>
        {BASE_TYPES.map((b) => (
          <SelectItem key={b} value={b}>
            {b}
          </SelectItem>
        ))}
      </SelectGroup>
      {spec.valueTypes.length > 0 && (
        <SelectGroup>
          <SelectLabel>Value types</SelectLabel>
          {spec.valueTypes.map((v) => (
            <SelectItem key={v.name} value={v.name}>
              {v.name} ({v.base})
            </SelectItem>
          ))}
        </SelectGroup>
      )}
    </>
  );
}

function PropertiesSection({ t, update, ro }: { t: ObjectType; update: Updater; ro: boolean }) {
  const o = useOntology();
  const { tables } = useLakehouseTables(o.tokenRef, o.canEdit);
  const table = tables?.find((x) => x.table.toLowerCase() === t.source?.table.toLowerCase());
  const inherited = useMemo(
    () => allProperties(o.spec, t).filter((p) => !t.properties.some((q) => q.name === p.name)),
    [o.spec, t],
  );
  const [names, setNames] = useState<Record<string, string>>({});

  const patchProp = (name: string, patch: Partial<OntologyProperty>) =>
    update((x) => ({
      ...x,
      properties: x.properties.map((p) => (p.name === name ? { ...p, ...patch } : p)),
    }));

  const commitRename = (from: string) => {
    const to = (names[from] ?? from).trim();
    setNames((n) => {
      const { [from]: _gone, ...rest } = n;
      void _gone;
      return rest;
    });
    if (to === from) return;
    if (!MEMBER_NAME.test(to)) {
      toast.error(
        "A property name is snake_case: a lowercase letter, then lowercase letters, digits and _",
      );
      return;
    }
    if (allProperties(o.spec, t).some((p) => p.name === to)) {
      toast.error(`${t.name} already has ${to}`);
      return;
    }
    o.setSpec((s) => renameProperty(s, t.name, from, to));
  };

  return (
    <Section
      title="Properties"
      description="What is known about each object. Key = identifies one object; title = the name shown for it."
      action={
        !ro && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              update((x) => ({
                ...x,
                properties: [
                  ...x.properties,
                  {
                    name: freshMemberName(allProperties(o.spec, x).map((p) => p.name)),
                    type: "string",
                  },
                ],
              }))
            }
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Property
          </Button>
        )
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-xs">
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-8 py-1" title="Part of the key">
                Key
              </th>
              <th className="w-8 py-1" title="Shown as the object's name">
                Title
              </th>
              <th className="py-1">Name</th>
              <th className="py-1">Type</th>
              <th className="py-1">Column or expression</th>
              <th className="w-16 py-1">Required</th>
              <th className="py-1">Sensitivity</th>
              <th className="py-1">Description</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {t.properties.map((p) => {
              const isKey = t.primaryKey.includes(p.name);
              const exprCheck = p.expression
                ? checkExpr(p.expression, "scalar", table ? table.columns.map((c) => c.name) : null)
                : null;
              return (
                <tr key={p.name} className="border-t border-border align-top">
                  <td className="py-1.5">
                    <button
                      type="button"
                      disabled={ro}
                      onClick={() =>
                        update((x) => ({
                          ...x,
                          primaryKey: isKey
                            ? x.primaryKey.filter((k) => k !== p.name)
                            : [...x.primaryKey, p.name],
                        }))
                      }
                      className={cn(
                        "rounded p-1",
                        isKey
                          ? "text-amber-600"
                          : "text-muted-foreground/40 hover:text-muted-foreground",
                      )}
                      aria-label={
                        isKey ? `Remove ${p.name} from the key` : `Make ${p.name} part of the key`
                      }
                      aria-pressed={isKey}
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                    </button>
                  </td>
                  <td className="py-1.5">
                    <button
                      type="button"
                      disabled={ro}
                      onClick={() =>
                        update({ titleProperty: t.titleProperty === p.name ? undefined : p.name })
                      }
                      className={cn(
                        "rounded p-1",
                        t.titleProperty === p.name
                          ? "text-primary"
                          : "text-muted-foreground/40 hover:text-muted-foreground",
                      )}
                      aria-label={`Show ${p.name} as the title`}
                      aria-pressed={t.titleProperty === p.name}
                    >
                      <Star className="h-3.5 w-3.5" />
                    </button>
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input
                      value={names[p.name] ?? p.name}
                      onChange={(e) => setNames((n) => ({ ...n, [p.name]: e.target.value }))}
                      onBlur={() => commitRename(p.name)}
                      disabled={ro}
                      className="h-8 font-mono text-xs"
                      aria-label="Property name"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Select
                      value={p.type}
                      onValueChange={(v) => patchProp(p.name, { type: v })}
                      disabled={ro}
                    >
                      <SelectTrigger className="h-8 text-xs" aria-label="Type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>{typeOptions(o.spec)}</SelectContent>
                    </Select>
                  </td>
                  <td className="py-1.5 pr-2">
                    {p.expression !== undefined ? (
                      <div>
                        <Input
                          value={p.expression}
                          onChange={(e) =>
                            patchProp(p.name, { expression: e.target.value, column: undefined })
                          }
                          disabled={ro}
                          className={cn(
                            "h-8 font-mono text-xs",
                            exprCheck && !exprCheck.ok && "border-destructive",
                          )}
                          placeholder="quantity * unit_price"
                          aria-label="Derived expression"
                        />
                        {exprCheck && !exprCheck.ok && (
                          <p className="mt-0.5 text-[10px] text-destructive">{exprCheck.error}</p>
                        )}
                        {!ro && (
                          <button
                            type="button"
                            className="mt-0.5 text-[10px] text-primary"
                            onClick={() => patchProp(p.name, { expression: undefined })}
                          >
                            Use a column instead
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Select
                          value={p.column ?? NONE}
                          onValueChange={(v) =>
                            patchProp(p.name, { column: v === NONE ? undefined : v })
                          }
                          disabled={ro || !table}
                        >
                          <SelectTrigger className="h-8 text-xs" aria-label="Column">
                            <SelectValue placeholder={t.source ? "Column" : "Bind a table first"} />
                          </SelectTrigger>
                          <SelectContent className="max-h-64">
                            <SelectItem value={NONE}>—</SelectItem>
                            {p.column && !table?.columns.some((c) => c.name === p.column) && (
                              <SelectItem value={p.column}>{p.column}</SelectItem>
                            )}
                            {(table?.columns ?? []).map((c) => (
                              <SelectItem key={c.name} value={c.name} className="font-mono text-xs">
                                {c.name}{" "}
                                <span className="text-muted-foreground">
                                  ({c.type.toLowerCase()})
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {!ro && (
                          <button
                            type="button"
                            className="shrink-0 text-[10px] text-primary"
                            onClick={() =>
                              patchProp(p.name, {
                                expression: p.column ? `"${p.column}"` : "",
                                column: undefined,
                              })
                            }
                            title="Derive it with an expression"
                          >
                            ƒx
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 text-center">
                    <Switch
                      checked={!!p.required}
                      onCheckedChange={(v) => patchProp(p.name, { required: v || undefined })}
                      disabled={ro}
                      aria-label="Required"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Select
                      value={p.sensitivity ?? "public"}
                      onValueChange={(v) =>
                        patchProp(p.name, {
                          sensitivity:
                            v === "public" ? undefined : (v as OntologyProperty["sensitivity"]),
                        })
                      }
                      disabled={ro}
                    >
                      <SelectTrigger className="h-8 text-xs" aria-label="Sensitivity">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SENSITIVITIES.map((s) => (
                          <SelectItem key={s} value={s} className="capitalize">
                            {s}
                            {s === "restricted" ? " — owner only" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input
                      value={p.description ?? ""}
                      onChange={(e) =>
                        patchProp(p.name, { description: e.target.value || undefined })
                      }
                      disabled={ro}
                      className="h-8 text-xs"
                      aria-label="Description"
                    />
                  </td>
                  <td className="py-1.5">
                    {!ro && (
                      <button
                        type="button"
                        className="rounded p-1 text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          update((x) => ({
                            ...x,
                            properties: x.properties.filter((q) => q.name !== p.name),
                            primaryKey: x.primaryKey.filter((k) => k !== p.name),
                            ...(x.titleProperty === p.name ? { titleProperty: undefined } : {}),
                          }))
                        }
                        aria-label={`Remove ${p.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {inherited.map((p) => (
              <tr key={`inh-${p.name}`} className="border-t border-border text-muted-foreground">
                <td colSpan={2} />
                <td className="py-1.5 font-mono">{p.name}</td>
                <td className="py-1.5">{p.type}</td>
                <td className="py-1.5" colSpan={5}>
                  inherited from {t.extends}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!t.properties.length && !inherited.length && (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No properties yet. Bind a table above and add a property per column.
          </p>
        )}
      </div>
    </Section>
  );
}

function MetricsSection({ t, update, ro }: { t: ObjectType; update: Updater; ro: boolean }) {
  const o = useOntology();
  const names = allProperties(o.spec, t).map((p) => p.name);
  const patch = (name: string, p: Partial<ObjectType["metrics"][number]>) =>
    update((x) => ({
      ...x,
      metrics: x.metrics.map((m) => (m.name === name ? { ...m, ...p } : m)),
    }));
  return (
    <Section
      title="Metrics"
      description="Aggregates over this type's properties. Certify the ones the business agrees on; agents prefer them."
      action={
        !ro && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              update((x) => ({
                ...x,
                metrics: [
                  ...x.metrics,
                  {
                    name: freshMemberName(
                      [...x.metrics.map((m) => m.name), ...names],
                      "new_metric",
                    ),
                    expression: "COUNT(*)",
                  },
                ],
              }))
            }
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Metric
          </Button>
        )
      }
    >
      {!t.metrics.length ? (
        <p className="text-xs text-muted-foreground">No metrics.</p>
      ) : (
        <div className="space-y-2">
          {t.metrics.map((m) => {
            const c = checkExpr(m.expression, "aggregate", names);
            return (
              <div
                key={m.name}
                className="grid gap-2 rounded-lg border border-border p-2.5 sm:grid-cols-[160px_160px_1fr_120px_auto_auto] sm:items-start"
              >
                <Input
                  value={m.name}
                  disabled
                  className="h-8 font-mono text-xs"
                  aria-label="Metric name"
                />
                <Input
                  value={m.label ?? ""}
                  onChange={(e) => patch(m.name, { label: e.target.value || undefined })}
                  disabled={ro}
                  className="h-8 text-xs"
                  placeholder="Label"
                  aria-label="Metric label"
                />
                <div>
                  <Input
                    value={m.expression}
                    onChange={(e) => patch(m.name, { expression: e.target.value })}
                    disabled={ro}
                    className={cn("h-8 font-mono text-xs", !c.ok && "border-destructive")}
                    aria-label="Metric expression"
                  />
                  {!c.ok && <p className="mt-0.5 text-[10px] text-destructive">{c.error}</p>}
                </div>
                <Select
                  value={m.format ?? "number"}
                  onValueChange={(v) =>
                    patch(m.name, { format: v as (typeof METRIC_FORMATS)[number] })
                  }
                  disabled={ro}
                >
                  <SelectTrigger className="h-8 text-xs" aria-label="Format">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METRIC_FORMATS.map((f) => (
                      <SelectItem key={f} value={f} className="capitalize">
                        {f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <label className="flex h-8 items-center gap-1.5 text-xs">
                  <Switch
                    checked={!!m.certified}
                    onCheckedChange={(v) => patch(m.name, { certified: v || undefined })}
                    disabled={ro}
                    aria-label="Certified"
                  />
                  {m.certified ? (
                    <Badge
                      variant="outline"
                      className="gap-0.5 border-emerald-500/40 text-[10px] text-emerald-700 dark:text-emerald-300"
                    >
                      <Sparkles className="h-2.5 w-2.5" /> certified
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">certify</span>
                  )}
                </label>
                {!ro && (
                  <button
                    type="button"
                    className="h-8 rounded p-1 text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      update((x) => ({ ...x, metrics: x.metrics.filter((q) => q.name !== m.name) }))
                    }
                    aria-label={`Remove ${m.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label className="text-xs">{label}</Label>
      {children}
      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
