// The Ontology Manager: every element of the model in a tree, the editor for
// the one selected, the canvas when nothing is, and the problems list that
// stops a publish — each problem a link to the field it is about.
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CircleAlert,
  Link2,
  Plus,
  Search,
  Shapes,
  Type as TypeIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ModelCanvas } from "@/components/ontology/ModelCanvas";
import { InterfaceEditor, LinkEditor, ValueTypeEditor } from "@/components/ontology/ModelEditors";
import { useOntology } from "@/components/ontology/OntologyContext";
import { TypeEditor } from "@/components/ontology/TypeEditor";
import { iconOf, toneOf } from "@/components/ontology/theme";
import { freshConceptName, freshMemberName, newObjectType } from "@/lib/ontology/edit";
import type { ObjectType } from "@/lib/ontology/spec";
import { validateSpec, type Issue } from "@/lib/ontology/validate";
import { cn } from "@/lib/utils";

type Sel =
  | { kind: "type"; name: string }
  | { kind: "link"; from: string; name: string }
  | { kind: "value"; name: string }
  | { kind: "interface"; name: string }
  | null;

export function ModelTab() {
  const o = useOntology();
  const [sel, setSel] = useState<Sel>(null);
  const [q, setQ] = useState("");
  const issues = useMemo(() => validateSpec(o.spec).issues, [o.spec]);

  useEffect(() => {
    if (o.focus?.kind === "type") setSel({ kind: "type", name: o.focus.name });
    if (o.focus?.kind === "link") setSel({ kind: "link", from: o.focus.from, name: o.focus.name });
  }, [o.focus]);

  const problemsFor = (prefix: string) =>
    issues.filter((i) => i.level === "error" && i.path.startsWith(prefix)).length;
  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());

  const domains = useMemo(() => {
    const m = new Map<string, ObjectType[]>();
    for (const t of o.spec.objectTypes) {
      const d = t.domain ?? "No domain";
      m.set(d, [...(m.get(d) ?? []), t]);
    }
    return [...m].sort((a, b) => a[0].localeCompare(b[0]));
  }, [o.spec.objectTypes]);

  const addType = () => {
    const t = newObjectType(o.spec);
    o.setSpec((s) => ({ ...s, objectTypes: [...s.objectTypes, t] }));
    setSel({ kind: "type", name: t.name });
  };
  const addLink = () => {
    const [a, b] = o.spec.objectTypes;
    if (!a) return;
    const to = b ?? a;
    const name = freshMemberName(
      o.spec.linkTypes.filter((l) => l.from === a.name).map((l) => l.name),
      "related_to",
    );
    o.setSpec((s) => ({
      ...s,
      linkTypes: [
        ...s.linkTypes,
        {
          name,
          from: a.name,
          to: to.name,
          cardinality: "many_to_one",
          join: {
            kind: "foreign_key",
            fromProperties: [a.properties[0]?.name ?? "id"],
            toProperties: [to.primaryKey[0] ?? to.properties[0]?.name ?? "id"],
          },
        },
      ],
    }));
    setSel({ kind: "link", from: a.name, name });
  };
  const addValue = () => {
    const name = freshConceptName(o.spec, "NewValueType");
    o.setSpec((s) => ({ ...s, valueTypes: [...s.valueTypes, { name, base: "string" }] }));
    setSel({ kind: "value", name });
  };
  const addInterface = () => {
    const name = freshConceptName(o.spec, "NewInterface");
    o.setSpec((s) => ({ ...s, interfaces: [...s.interfaces, { name, properties: [] }] }));
    setSel({ kind: "interface", name });
  };

  const jumpTo = (i: Issue) => {
    const [head, a, b, c] = i.path.split(".");
    if (head === "objectTypes" && a) setSel({ kind: "type", name: a });
    else if (head === "linkTypes" && a && b) setSel({ kind: "link", from: a, name: b });
    else if (head === "valueTypes" && a) setSel({ kind: "value", name: a });
    else if (head === "interfaces" && a) setSel({ kind: "interface", name: a });
    else if (head === "rules") o.go("rules", { kind: "rule", id: a });
    else if (head === "actionTypes") o.go("actions");
    void c;
  };

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find in the model"
              className="h-9 pl-7 text-sm"
              aria-label="Find in the model"
            />
          </div>
          {o.canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="h-9" aria-label="Add to the model">
                  <Plus className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={addType}>
                  <Shapes className="mr-2 h-4 w-4" /> Object type
                </DropdownMenuItem>
                <DropdownMenuItem onClick={addLink} disabled={!o.spec.objectTypes.length}>
                  <Link2 className="mr-2 h-4 w-4" /> Link
                </DropdownMenuItem>
                <DropdownMenuItem onClick={addValue}>
                  <TypeIcon className="mr-2 h-4 w-4" /> Value type
                </DropdownMenuItem>
                <DropdownMenuItem onClick={addInterface}>
                  <Boxes className="mr-2 h-4 w-4" /> Interface
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <nav
          className="max-h-[calc(100vh-22rem)] space-y-4 overflow-y-auto rounded-xl border border-border bg-card p-2"
          aria-label="Model elements"
        >
          <button
            type="button"
            onClick={() => setSel(null)}
            className={cn(
              "w-full rounded-md px-2 py-1.5 text-left text-sm",
              sel === null ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted",
            )}
          >
            Canvas
          </button>
          {domains.map(([domain, types]) => {
            const shown = types.filter((t) => match(t.name) || match(t.label ?? ""));
            if (!shown.length) return null;
            return (
              <div key={domain}>
                <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {domain}
                </p>
                {shown.map((t) => {
                  const Icon = iconOf(t);
                  const n = problemsFor(`objectTypes.${t.name}`);
                  const active = sel?.kind === "type" && sel.name === t.name;
                  return (
                    <button
                      key={t.name}
                      type="button"
                      onClick={() => setSel({ kind: "type", name: t.name })}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                        active ? "bg-primary/10 font-medium" : "hover:bg-muted",
                      )}
                    >
                      <Icon className={cn("h-3.5 w-3.5", toneOf(t).ink)} />
                      <span className="truncate">{t.name}</span>
                      {n > 0 && (
                        <span className="ml-auto rounded bg-rose-500/15 px-1 text-[10px] text-rose-700 dark:text-rose-300">
                          {n}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {o.spec.linkTypes.some((l) => match(l.name) || match(l.from) || match(l.to)) && (
            <div>
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Links
              </p>
              {o.spec.linkTypes
                .filter((l) => match(l.name) || match(l.from) || match(l.to))
                .map((l) => {
                  const active = sel?.kind === "link" && sel.from === l.from && sel.name === l.name;
                  const n = problemsFor(`linkTypes.${l.from}.${l.name}`);
                  return (
                    <button
                      key={`${l.from}.${l.name}`}
                      type="button"
                      onClick={() => setSel({ kind: "link", from: l.from, name: l.name })}
                      className={cn(
                        "flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs",
                        active ? "bg-primary/10 font-medium" : "hover:bg-muted",
                      )}
                    >
                      <span className="truncate">{l.from}</span>
                      <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="truncate font-mono text-muted-foreground">{l.name}</span>
                      <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">{l.to}</span>
                      {n > 0 && (
                        <span className="ml-auto rounded bg-rose-500/15 px-1 text-[10px] text-rose-700 dark:text-rose-300">
                          {n}
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
          )}
          {o.spec.valueTypes.length > 0 && (
            <div>
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Value types
              </p>
              {o.spec.valueTypes
                .filter((v) => match(v.name))
                .map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    onClick={() => setSel({ kind: "value", name: v.name })}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                      sel?.kind === "value" && sel.name === v.name
                        ? "bg-primary/10 font-medium"
                        : "hover:bg-muted",
                    )}
                  >
                    <TypeIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate">{v.name}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">{v.base}</span>
                  </button>
                ))}
            </div>
          )}
          {o.spec.interfaces.length > 0 && (
            <div>
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Interfaces
              </p>
              {o.spec.interfaces
                .filter((i) => match(i.name))
                .map((i) => (
                  <button
                    key={i.name}
                    type="button"
                    onClick={() => setSel({ kind: "interface", name: i.name })}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                      sel?.kind === "interface" && sel.name === i.name
                        ? "bg-primary/10 font-medium"
                        : "hover:bg-muted",
                    )}
                  >
                    <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate">{i.name}</span>
                  </button>
                ))}
            </div>
          )}
        </nav>

        <section className="rounded-xl border border-border bg-card p-3" aria-label="Problems">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
            {errors.length ? (
              <CircleAlert className="h-3.5 w-3.5 text-rose-600" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            Problems{" "}
            {errors.length > 0 && (
              <span className="text-rose-700 dark:text-rose-300">{errors.length}</span>
            )}
            {warnings.length > 0 && (
              <span className="font-normal text-muted-foreground">
                · {warnings.length} suggestions
              </span>
            )}
          </p>
          {!issues.length ? (
            <p className="text-xs text-muted-foreground">Nothing to fix.</p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {[...errors, ...warnings].slice(0, 80).map((i, n) => (
                <li key={n}>
                  <button
                    type="button"
                    onClick={() => jumpTo(i)}
                    className={cn(
                      "w-full rounded-md px-2 py-1 text-left text-[11px] hover:bg-muted",
                      i.level === "error"
                        ? "text-rose-700 dark:text-rose-300"
                        : "text-muted-foreground",
                    )}
                  >
                    <span className="font-mono">
                      {i.path.replace(
                        /^(objectTypes|linkTypes|valueTypes|interfaces|rules|actionTypes)\./,
                        "",
                      )}
                    </span>
                    <span className="block">{i.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      <section className="min-w-0">
        {sel === null ? (
          <ModelCanvas
            spec={o.spec}
            issues={issues}
            canEdit={o.canEdit}
            onSelectType={(name) => setSel({ kind: "type", name })}
            onSelectLink={(from, name) => setSel({ kind: "link", from, name })}
            onMove={(pos) =>
              o.setSpec((s) => ({
                ...s,
                objectTypes: s.objectTypes.map((t) =>
                  pos.get(t.name) ? { ...t, position: pos.get(t.name) } : t,
                ),
              }))
            }
            className="h-[min(72vh,760px)] min-h-[460px]"
          />
        ) : sel.kind === "type" ? (
          <TypeEditor
            key={sel.name}
            typeName={sel.name}
            onRenamed={(n) => setSel({ kind: "type", name: n })}
          />
        ) : sel.kind === "link" ? (
          <LinkEditor
            key={`${sel.from}.${sel.name}`}
            from={sel.from}
            name={sel.name}
            onRenamed={(from, name) => setSel({ kind: "link", from, name })}
          />
        ) : sel.kind === "value" ? (
          <ValueTypeEditor
            key={sel.name}
            name={sel.name}
            onRenamed={(n) => setSel({ kind: "value", name: n })}
          />
        ) : (
          <InterfaceEditor key={sel.name} name={sel.name} />
        )}
      </section>
    </div>
  );
}
