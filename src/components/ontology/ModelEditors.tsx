// Editors for the model's connective tissue: links between types, value
// types (a type with meaning: an e-mail address, an order status) and
// interfaces (properties several types share, so "every Party" works).
import { useState } from "react";
import { toast } from "sonner";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { useOntology } from "@/components/ontology/OntologyContext";
import { Field, Section } from "@/components/ontology/TypeEditor";
import { TypeBadge } from "@/components/ontology/theme";
import { useLakehouseTables } from "@/components/ontology/useLakehouseTables";
import { freshMemberName } from "@/lib/ontology/edit";
import {
  allProperties,
  BASE_TYPES,
  CARDINALITIES,
  CONCEPT_NAME,
  findObjectType,
  MEMBER_NAME,
  type Cardinality,
  type LinkType,
  type OntologyInterface,
  type ValueType,
} from "@/lib/ontology/spec";

const CARD_TEXT: Record<Cardinality, string> = {
  many_to_one: "Many to one — each has at most one",
  one_to_one: "One to one",
  one_to_many: "One to many — each has many",
  many_to_many: "Many to many (needs a join table)",
};

/** "{Order} is placed by {Customer}" → "an Order is placed by a Customer" */
export function sentence(v: string | undefined, link: LinkType): string {
  const text =
    v?.trim() || `{${link.from}} ${(link.label ?? link.name).replace(/_/g, " ")} {${link.to}}`;
  return text.replace(/\{([A-Za-z0-9]+)(?::([a-z_]+))?\}/g, (_, t: string, role?: string) => {
    const word = role ? `${t} (${role.replace(/_/g, " ")})` : t;
    return `${/^[AEIOU]/.test(t) ? "an" : "a"} ${word}`;
  });
}

export function LinkEditor({
  from,
  name,
  onRenamed,
}: {
  from: string;
  name: string;
  onRenamed: (from: string, name: string) => void;
}) {
  const o = useOntology();
  const ro = !o.canEdit;
  const link = o.spec.linkTypes.find((l) => l.from === from && l.name === name);
  const { tables } = useLakehouseTables(o.tokenRef, o.canEdit);
  const [nameDraft, setNameDraft] = useState(name);
  if (!link) return <p className="text-sm text-muted-foreground">That link no longer exists.</p>;
  const fromT = findObjectType(o.spec, link.from);
  const toT = findObjectType(o.spec, link.to);
  const fromProps = fromT ? allProperties(o.spec, fromT).map((p) => p.name) : [];
  const toProps = toT ? allProperties(o.spec, toT).map((p) => p.name) : [];

  const update = (patch: Partial<LinkType> | ((l: LinkType) => LinkType)) =>
    o.setSpec((s) => ({
      ...s,
      linkTypes: s.linkTypes.map((l) =>
        l === link
          ? typeof patch === "function"
            ? patch(l)
            : ({ ...l, ...patch } as LinkType)
          : l,
      ),
    }));

  const commitName = () => {
    const n = nameDraft.trim();
    if (n === link.name) return;
    if (!MEMBER_NAME.test(n)) {
      toast.error("A link name is snake_case");
      setNameDraft(link.name);
      return;
    }
    o.setSpec((s) => ({
      ...s,
      linkTypes: s.linkTypes.map((l) => (l === link ? { ...l, name: n } : l)),
      rules: s.rules.map((r) =>
        r.kind === "referential" && r.link === link.name && r.objectType === link.from
          ? { ...r, link: n }
          : r,
      ),
    }));
    onRenamed(link.from, n);
  };

  const pairs = link.join.fromProperties.map(
    (p, i) => [p, link.join.toProperties[i] ?? ""] as const,
  );
  const jt = link.join.kind === "join_table" ? link.join : null;
  const jtTable = jt
    ? tables?.find((x) => x.table.toLowerCase() === jt.table.toLowerCase())
    : undefined;

  return (
    <div className="space-y-5">
      <Section title="The link">
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 p-3 text-sm">
          <TypeBadge type={fromT} size="md" />
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{(link.label ?? link.name).replace(/_/g, " ")}</span>
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <TypeBadge type={toT} size="md" />
          <span className="ml-auto text-xs text-muted-foreground">
            “{sentence(link.verbalization, link)}”
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From">
            <Select value={link.from} onValueChange={(v) => update({ from: v })} disabled={ro}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {o.spec.objectTypes.map((t) => (
                  <SelectItem key={t.name} value={t.name}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="To">
            <Select value={link.to} onValueChange={(v) => update({ to: v })} disabled={ro}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {o.spec.objectTypes.map((t) => (
                  <SelectItem key={t.name} value={t.name}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Name, read from the From side" hint="An Order is `placed_by` a Customer">
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
              value={link.label ?? ""}
              onChange={(e) => update({ label: e.target.value || undefined })}
              disabled={ro}
              placeholder="placed by"
            />
          </Field>
          <Field label="Name, read from the To side" hint="A Customer's `orders`">
            <Input
              value={link.inverseName ?? ""}
              onChange={(e) => update({ inverseName: e.target.value || undefined })}
              disabled={ro}
              className="font-mono"
              placeholder="orders"
            />
          </Field>
          <Field label="How many">
            <Select
              value={link.cardinality}
              onValueChange={(v) => update({ cardinality: v as Cardinality })}
              disabled={ro}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CARDINALITIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CARD_TEXT[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="As a sentence"
            className="sm:col-span-2"
            hint={`Placeholders name types: {${link.from}} …. Reads: “${sentence(link.verbalization, link)}”`}
          >
            <Input
              value={link.verbalization ?? ""}
              onChange={(e) => update({ verbalization: e.target.value || undefined })}
              disabled={ro}
              placeholder={`{${link.from}} is placed by {${link.to}}`}
            />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea
              value={link.description ?? ""}
              onChange={(e) => update({ description: e.target.value || undefined })}
              disabled={ro}
              rows={2}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="How objects are matched"
        description="Through a key on one side, or through a join table for many-to-many."
      >
        <div className="mb-3 inline-flex rounded-lg border border-border p-0.5 text-xs">
          {(["foreign_key", "join_table"] as const).map((k) => (
            <button
              key={k}
              type="button"
              disabled={ro}
              onClick={() =>
                update((l) =>
                  k === "foreign_key"
                    ? {
                        ...l,
                        join: {
                          kind: "foreign_key",
                          fromProperties: l.join.fromProperties,
                          toProperties: l.join.toProperties,
                        },
                      }
                    : {
                        ...l,
                        cardinality: "many_to_many",
                        join: {
                          kind: "join_table",
                          table: tables?.[0]?.table ?? "schema.table",
                          fromColumns: l.join.fromProperties,
                          fromProperties: l.join.fromProperties,
                          toColumns: l.join.toProperties,
                          toProperties: l.join.toProperties,
                        },
                      },
                )
              }
              className={
                k === link.join.kind
                  ? "rounded-md bg-primary/10 px-3 py-1 font-medium text-primary"
                  : "px-3 py-1 text-muted-foreground"
              }
            >
              {k === "foreign_key" ? "Through a key" : "Through a join table"}
            </button>
          ))}
        </div>
        {jt && (
          <Field label="Join table" className="mb-3 max-w-md">
            <Select
              value={jt.table}
              onValueChange={(v) => update((l) => ({ ...l, join: { ...jt, table: v } }))}
              disabled={ro}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {!jtTable && <SelectItem value={jt.table}>{jt.table}</SelectItem>}
                {(tables ?? []).map((x) => (
                  <SelectItem key={x.table} value={x.table} className="font-mono text-xs">
                    {x.table}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <div className="space-y-2">
          {pairs.map(([fp, tp], i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <PropSelect
                value={fp}
                options={fromProps}
                disabled={ro}
                label={`${link.from} property`}
                onChange={(v) =>
                  update((l) => ({
                    ...l,
                    join: {
                      ...l.join,
                      fromProperties: l.join.fromProperties.map((x, j) => (j === i ? v : x)),
                    } as LinkType["join"],
                  }))
                }
              />
              {jt && (
                <ColumnSelect
                  value={jt.fromColumns[i] ?? ""}
                  options={jtTable?.columns.map((c) => c.name) ?? []}
                  disabled={ro}
                  label="join-table column"
                  onChange={(v) =>
                    update((l) => ({
                      ...l,
                      join: { ...jt, fromColumns: jt.fromColumns.map((x, j) => (j === i ? v : x)) },
                    }))
                  }
                />
              )}
              <span className="text-muted-foreground">=</span>
              {jt && (
                <ColumnSelect
                  value={jt.toColumns[i] ?? ""}
                  options={jtTable?.columns.map((c) => c.name) ?? []}
                  disabled={ro}
                  label="join-table column"
                  onChange={(v) =>
                    update((l) => ({
                      ...l,
                      join: { ...jt, toColumns: jt.toColumns.map((x, j) => (j === i ? v : x)) },
                    }))
                  }
                />
              )}
              <PropSelect
                value={tp}
                options={toProps}
                disabled={ro}
                label={`${link.to} property`}
                onChange={(v) =>
                  update((l) => ({
                    ...l,
                    join: {
                      ...l.join,
                      toProperties: l.join.toProperties.map((x, j) => (j === i ? v : x)),
                    } as LinkType["join"],
                  }))
                }
              />
            </div>
          ))}
        </div>
      </Section>

      {!ro && (
        <div className="flex justify-end border-t border-border pt-4">
          <Button
            variant="outline"
            className="text-destructive"
            onClick={async () => {
              if (
                await confirmAsk({
                  title: `Remove the link ${link.from}.${link.name}?`,
                  body: "Rules that check this link go with it. No data changes.",
                  actionLabel: "Remove",
                })
              )
                o.setSpec((s) => ({
                  ...s,
                  linkTypes: s.linkTypes.filter((l) => l !== link),
                  rules: s.rules.filter(
                    (r) =>
                      !(
                        r.kind === "referential" &&
                        r.link === link.name &&
                        r.objectType === link.from
                      ),
                  ),
                }));
            }}
          >
            <Trash2 className="mr-1.5 h-4 w-4" /> Remove link
          </Button>
        </div>
      )}
    </div>
  );
}

function PropSelect(props: {
  value: string;
  options: string[];
  disabled: boolean;
  label: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select
      value={props.value || undefined}
      onValueChange={props.onChange}
      disabled={props.disabled}
    >
      <SelectTrigger className="h-8 w-44 font-mono text-xs" aria-label={props.label}>
        <SelectValue placeholder={props.label} />
      </SelectTrigger>
      <SelectContent>
        {props.options.map((p) => (
          <SelectItem key={p} value={p} className="font-mono text-xs">
            {p}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ColumnSelect(props: {
  value: string;
  options: string[];
  disabled: boolean;
  label: string;
  onChange: (v: string) => void;
}) {
  const opts =
    props.value && !props.options.includes(props.value)
      ? [props.value, ...props.options]
      : props.options;
  return (
    <Select
      value={props.value || undefined}
      onValueChange={props.onChange}
      disabled={props.disabled}
    >
      <SelectTrigger className="h-8 w-40 border-dashed font-mono text-xs" aria-label={props.label}>
        <SelectValue placeholder="column" />
      </SelectTrigger>
      <SelectContent>
        {opts.map((p) => (
          <SelectItem key={p} value={p} className="font-mono text-xs">
            {p}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ValueTypeEditor({
  name,
  onRenamed,
}: {
  name: string;
  onRenamed: (n: string) => void;
}) {
  const o = useOntology();
  const ro = !o.canEdit;
  const v = o.spec.valueTypes.find((x) => x.name === name);
  const [nameDraft, setNameDraft] = useState(name);
  if (!v) return <p className="text-sm text-muted-foreground">That value type no longer exists.</p>;
  const update = (patch: Partial<ValueType>) =>
    o.setSpec((s) => ({
      ...s,
      valueTypes: s.valueTypes.map((x) => (x.name === name ? { ...x, ...patch } : x)),
    }));
  const usedBy = o.spec.objectTypes.flatMap((t) =>
    t.properties.filter((p) => p.type === v.name).map((p) => `${t.name}.${p.name}`),
  );
  const commitName = () => {
    const n = nameDraft.trim();
    if (n === v.name) return;
    if (!CONCEPT_NAME.test(n)) {
      toast.error("A value type name is PascalCase");
      setNameDraft(v.name);
      return;
    }
    o.setSpec((s) => ({
      ...s,
      valueTypes: s.valueTypes.map((x) => (x.name === v.name ? { ...x, name: n } : x)),
      objectTypes: s.objectTypes.map((t) => ({
        ...t,
        properties: t.properties.map((p) => (p.type === v.name ? { ...p, type: n } : p)),
      })),
      interfaces: s.interfaces.map((i) => ({
        ...i,
        properties: i.properties.map((p) => (p.type === v.name ? { ...p, type: n } : p)),
      })),
    }));
    onRenamed(n);
  };
  return (
    <div className="space-y-5">
      <Section
        title="Value type"
        description="A type with meaning. Its checks become rules on every property that uses it."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              disabled={ro}
              className="font-mono"
            />
          </Field>
          <Field label="Based on">
            <Select
              value={v.base}
              onValueChange={(b) => update({ base: b as ValueType["base"] })}
              disabled={ro}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BASE_TYPES.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea
              value={v.description ?? ""}
              onChange={(e) => update({ description: e.target.value || undefined })}
              disabled={ro}
              rows={2}
            />
          </Field>
          <Field
            label="Allowed values"
            hint="One per line; leave empty for any value"
            className="sm:col-span-2"
          >
            <Textarea
              value={(v.enum ?? []).join("\n")}
              onChange={(e) => {
                const vals = e.target.value
                  .split("\n")
                  .map((x) => x.trim())
                  .filter(Boolean);
                update({ enum: vals.length ? vals : undefined });
              }}
              disabled={ro}
              rows={3}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Pattern" hint="A regular expression every value matches">
            <Input
              value={v.pattern ?? ""}
              onChange={(e) => update({ pattern: e.target.value || undefined })}
              disabled={ro}
              className="font-mono text-xs"
              placeholder="^[A-Z]{2}$"
            />
          </Field>
          <Field label="Unit">
            <Input
              value={v.unit ?? ""}
              onChange={(e) => update({ unit: e.target.value || undefined })}
              disabled={ro}
              placeholder="USD"
            />
          </Field>
          <Field label="Minimum">
            <Input
              type="number"
              value={v.min ?? ""}
              onChange={(e) =>
                update({ min: e.target.value === "" ? undefined : Number(e.target.value) })
              }
              disabled={ro}
            />
          </Field>
          <Field label="Maximum">
            <Input
              type="number"
              value={v.max ?? ""}
              onChange={(e) =>
                update({ max: e.target.value === "" ? undefined : Number(e.target.value) })
              }
              disabled={ro}
            />
          </Field>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Used by: {usedBy.length ? usedBy.join(", ") : "no property yet"}
        </p>
      </Section>
      {!ro && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            className="text-destructive"
            onClick={async () => {
              if (
                await confirmAsk({
                  title: `Remove ${v.name}?`,
                  body: usedBy.length
                    ? `${usedBy.length} propert${usedBy.length === 1 ? "y becomes" : "ies become"} plain ${v.base}.`
                    : "Nothing uses it.",
                  actionLabel: "Remove",
                })
              )
                o.setSpec((s) => ({
                  ...s,
                  valueTypes: s.valueTypes.filter((x) => x.name !== v.name),
                  objectTypes: s.objectTypes.map((t) => ({
                    ...t,
                    properties: t.properties.map((p) =>
                      p.type === v.name ? { ...p, type: v.base } : p,
                    ),
                  })),
                }));
            }}
          >
            <Trash2 className="mr-1.5 h-4 w-4" /> Remove value type
          </Button>
        </div>
      )}
    </div>
  );
}

export function InterfaceEditor({ name }: { name: string }) {
  const o = useOntology();
  const ro = !o.canEdit;
  const i = o.spec.interfaces.find((x) => x.name === name);
  if (!i) return <p className="text-sm text-muted-foreground">That interface no longer exists.</p>;
  const update = (patch: Partial<OntologyInterface>) =>
    o.setSpec((s) => ({
      ...s,
      interfaces: s.interfaces.map((x) => (x.name === name ? { ...x, ...patch } : x)),
    }));
  const implementers = o.spec.objectTypes.filter((t) => (t.interfaces ?? []).includes(i.name));
  return (
    <div className="space-y-5">
      <Section
        title={`Interface ${i.name}`}
        description="Properties several types share, so a question about every implementer (every Party) has one answer."
        action={
          !ro && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                update({
                  properties: [
                    ...i.properties,
                    { name: freshMemberName(i.properties.map((p) => p.name)), type: "string" },
                  ],
                })
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Property
            </Button>
          )
        }
      >
        <Field label="Description" className="mb-3">
          <Textarea
            value={i.description ?? ""}
            onChange={(e) => update({ description: e.target.value || undefined })}
            disabled={ro}
            rows={2}
          />
        </Field>
        <div className="space-y-2">
          {i.properties.map((p, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Input
                value={p.name}
                onChange={(e) =>
                  update({
                    properties: i.properties.map((q, j) =>
                      j === idx ? { ...q, name: e.target.value } : q,
                    ),
                  })
                }
                disabled={ro}
                className="h-8 w-48 font-mono text-xs"
                aria-label="Property name"
              />
              <Select
                value={p.type}
                onValueChange={(t) =>
                  update({
                    properties: i.properties.map((q, j) => (j === idx ? { ...q, type: t } : q)),
                  })
                }
                disabled={ro}
              >
                <SelectTrigger className="h-8 w-48 text-xs" aria-label="Type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[...BASE_TYPES, ...o.spec.valueTypes.map((v) => v.name)].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!ro && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => update({ properties: i.properties.filter((_, j) => j !== idx) })}
                  aria-label="Remove property"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Implemented by:</span>
          {implementers.length ? (
            implementers.map((t) => <TypeBadge key={t.name} type={t} />)
          ) : (
            <span className="text-muted-foreground">no type yet</span>
          )}
        </div>
      </Section>
      {!ro && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            className="text-destructive"
            onClick={() =>
              o.setSpec((s) => ({
                ...s,
                interfaces: s.interfaces.filter((x) => x.name !== i.name),
                objectTypes: s.objectTypes.map((t) => ({
                  ...t,
                  interfaces: (t.interfaces ?? []).filter((x) => x !== i.name),
                })),
              }))
            }
          >
            <Trash2 className="mr-1.5 h-4 w-4" /> Remove interface
          </Button>
        </div>
      )}
    </div>
  );
}
