// The Object Explorer: pick a type, search and filter its objects, and walk
// out along links ("search around": the customers of these orders, the
// products those customers bought). Each object opens in a side panel with
// its properties, the rules it breaks, its own metrics, what it links to and
// the actions available on it. Hidden properties say "hidden", never blank.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Code2,
  EyeOff,
  Filter as FilterIcon,
  Loader2,
  Network,
  Plus,
  Search,
  X,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ActionDialog } from "@/components/ontology/ActionDialog";
import { useOntology } from "@/components/ontology/OntologyContext";
import {
  formatValue,
  looksLikeIdentifier,
  SeverityChip,
  TypeBadge,
} from "@/components/ontology/theme";
import {
  ontologyObject,
  ontologyObjects,
  type ObjectSetResult,
  type ObjectView,
} from "@/utils/ontologyData.functions";
import type { Filter, FilterOp, PathStep } from "@/lib/ontology/compile";
import {
  allProperties,
  findObjectType,
  findValueType,
  linkReading,
  linksOf,
  pluralTitleOf,
  propertyTitle,
  titleOf,
} from "@/lib/ontology/spec";
import { cn } from "@/lib/utils";

const OP_LABEL: Record<FilterOp, string> = {
  eq: "is",
  neq: "is not",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
  starts_with: "starts with",
  in: "is one of",
  not_in: "is not one of",
  between: "between",
  is_null: "is empty",
  not_null: "is not empty",
};

const PAGE = 50;

export function ExploreTab() {
  const o = useOntology();
  const bound = o.spec.objectTypes.filter((t) => t.source);
  const [typeName, setTypeName] = useState<string>(() =>
    o.focus?.kind === "type" ? o.focus.name : (bound[0]?.name ?? ""),
  );
  const [search, setSearch] = useState("");
  const [searchLive, setSearchLive] = useState("");
  const [filters, setFilters] = useState<Filter[]>([]);
  const [path, setPath] = useState<PathStep[]>([]);
  const [offset, setOffset] = useState(0);
  const [order, setOrder] = useState<{ property: string; direction: "asc" | "desc" } | null>(null);
  const [result, setResult] = useState<ObjectSetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [open, setOpen] = useState<{ objectType: string; key: Record<string, unknown> } | null>(
    o.focus?.kind === "object" ? { objectType: o.focus.objectType, key: o.focus.key } : null,
  );
  const objectsFn = useServerFn(ontologyObjects);

  const start = findObjectType(o.spec, typeName);
  // The type the results are: the end of the search-around path.
  const endType = useMemo(() => {
    let at = start;
    for (const s of path) {
      if (!at) break;
      const l = linksOf(o.spec, at.name).find(
        (x) => x.direction === s.direction && linkReading(x.link, x.direction) === s.link,
      );
      at = l ? findObjectType(o.spec, l.other) : undefined;
    }
    return at;
  }, [o.spec, start, path]);

  useEffect(() => {
    const id = setTimeout(() => setSearchLive(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  const run = useCallback(async () => {
    if (!typeName) return;
    setLoading(true);
    try {
      const res = await objectsFn({
        data: {
          access_token: o.tokenRef.current,
          id: o.id,
          query: {
            objectType: typeName,
            filters,
            ...(searchLive.trim() ? { search: searchLive.trim() } : {}),
            ...(path.length ? { path } : {}),
            ...(order ? { orderBy: order } : {}),
            limit: PAGE,
            offset,
          },
          count: true,
        },
      });
      if (res.ok) {
        setResult(res);
        setError(null);
      } else {
        setError(res.error);
        setResult(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [objectsFn, o.tokenRef, o.id, typeName, filters, searchLive, path, order, offset]);

  useEffect(() => {
    void run();
  }, [run]);

  const resetTo = (name: string) => {
    setTypeName(name);
    setFilters([]);
    setPath([]);
    setOffset(0);
    setOrder(null);
    setSearch("");
  };

  if (!bound.length) {
    return (
      <div className="rounded-xl border border-dashed border-border p-10 text-center">
        <p className="font-medium">Nothing to explore yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Bind an object type to a lakehouse table under Model.
        </p>
        <Button className="mt-4" variant="outline" onClick={() => o.go("model")}>
          Open the model
        </Button>
      </div>
    );
  }

  const nextSteps = endType
    ? linksOf(o.spec, endType.name).filter(({ other }) => findObjectType(o.spec, other)?.source)
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Object types">
        {bound.map((t) => (
          <button
            key={t.name}
            type="button"
            role="tab"
            aria-selected={t.name === typeName}
            onClick={() => resetTo(t.name)}
            className={cn(
              "rounded-lg border px-1 py-1 transition",
              t.name === typeName
                ? "border-primary ring-1 ring-primary"
                : "border-transparent hover:border-border",
            )}
          >
            <TypeBadge type={t} label={pluralTitleOf(t)} size="md" />
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
            placeholder={start ? `Search ${pluralTitleOf(start).toLowerCase()}` : "Search"}
            className="pl-8"
            aria-label="Search objects"
          />
        </div>
        {start && (
          <FilterBuilder
            typeName={start.name}
            onAdd={(f) => {
              setFilters((fs) => [...fs, f]);
              setOffset(0);
            }}
          />
        )}
        {nextSteps.length > 0 && (
          <Select
            value=""
            onValueChange={(v) => {
              const [direction, link] = v.split(":") as ["forward" | "inverse", string];
              setPath((p) => [...p, { link, direction }]);
              setOffset(0);
              setOrder(null);
            }}
          >
            <SelectTrigger className="w-56 [&>span]:flex" aria-label="Search around">
              {/* The trigger clamps a child span to one line, which drops it out
                  of flex and stacks the icon over the words; keep it a row. */}
              <span className="flex items-center gap-1.5 text-sm">
                <Network className="h-4 w-4 shrink-0" /> Search around…
              </span>
            </SelectTrigger>
            <SelectContent>
              {nextSteps.map(({ link, direction, other }) => (
                <SelectItem
                  key={`${direction}:${link.from}.${link.name}`}
                  value={`${direction}:${linkReading(link, direction)}`}
                >
                  {(direction === "forward"
                    ? (link.label ?? link.name)
                    : (link.inverseLabel ?? linkReading(link, direction))
                  ).replace(/_/g, " ")}{" "}
                  → {other}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowSql((s) => !s)}
          aria-pressed={showSql}
        >
          <Code2 className="mr-1 h-4 w-4" /> SQL
        </Button>
      </div>

      {(filters.length > 0 || path.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {filters.map((f, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5"
            >
              <FilterIcon className="h-3 w-3" />
              {propertyTitle({ name: f.property })} {OP_LABEL[f.op]}{" "}
              {f.value !== undefined && f.value !== null
                ? String(Array.isArray(f.value) ? f.value.join(", ") : f.value)
                : ""}
              <button
                type="button"
                onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}
                aria-label="Remove filter"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {path.length > 0 && start && (
            <span className="inline-flex flex-wrap items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 text-primary">
              <Network className="h-3 w-3" /> {pluralTitleOf(start)}
              {path.map((s, i) => (
                <span key={i} className="inline-flex items-center gap-1">
                  <ArrowRight className="h-3 w-3" /> {s.link.replace(/_/g, " ")}
                </span>
              ))}
              <button
                type="button"
                onClick={() => setPath((p) => p.slice(0, -1))}
                aria-label="Step back"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
        </div>
      )}

      {showSql && result && (
        <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-[11px]">
          {result.sql}
        </pre>
      )}

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" /> {error}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <span>
              {loading ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading
                </span>
              ) : result ? (
                <>
                  <span className="font-medium text-foreground">
                    {result.total?.toLocaleString() ?? result.rows.length}
                  </span>{" "}
                  {endType ? pluralTitleOf(endType).toLowerCase() : "objects"} ·{" "}
                  {result.duration_ms} ms
                </>
              ) : null}
            </span>
            <span className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                disabled={offset === 0}
                onClick={() => setOffset((x) => Math.max(0, x - PAGE))}
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="tabular-nums">
                {result?.rows.length ? `${offset + 1}–${offset + result.rows.length}` : "0"}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                disabled={
                  !result ||
                  (result.total !== null
                    ? offset + PAGE >= result.total
                    : result.rows.length < PAGE)
                }
                onClick={() => setOffset((x) => x + PAGE)}
                aria-label="Next page"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </span>
          </div>
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground shadow-[0_1px_0_var(--border)]">
                <tr>
                  {(result?.columns ?? []).map((c) => (
                    <th key={c.key} className="whitespace-nowrap px-3 py-2 font-medium">
                      <button
                        type="button"
                        disabled={c.masked}
                        onClick={() =>
                          setOrder((cur) => ({
                            property: c.property,
                            direction:
                              cur?.property === c.property && cur.direction === "asc"
                                ? "desc"
                                : "asc",
                          }))
                        }
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        {propertyTitle(
                          (endType &&
                            allProperties(o.spec, endType).find((p) => p.name === c.property)) || {
                            name: c.property,
                          },
                        )}
                        {c.isKey && <span className="text-[9px] text-amber-600">key</span>}
                        {c.masked && <EyeOff className="h-3 w-3" aria-label="hidden" />}
                        {order?.property === c.property && (order.direction === "asc" ? "↑" : "↓")}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(result?.rows ?? []).map((r, i) => {
                  const t = endType;
                  const key = t ? Object.fromEntries(t.primaryKey.map((k) => [k, r[k]])) : {};
                  return (
                    <tr
                      key={i}
                      className="cursor-pointer border-t border-border hover:bg-muted/40"
                      onClick={() => t && setOpen({ objectType: t.name, key })}
                      tabIndex={0}
                      onKeyDown={(e) =>
                        e.key === "Enter" && t && setOpen({ objectType: t.name, key })
                      }
                    >
                      {(result?.columns ?? []).map((c) => {
                        const vt = endType
                          ? findValueType(
                              o.spec,
                              allProperties(o.spec, endType).find((p) => p.name === c.property)
                                ?.type ?? "",
                            )
                          : undefined;
                        return (
                          <td
                            key={c.key}
                            className={cn(
                              "max-w-[280px] truncate whitespace-nowrap px-3 py-1.5",
                              (c.base === "integer" ||
                                c.base === "decimal" ||
                                c.base === "float") &&
                                "text-right tabular-nums",
                            )}
                          >
                            {c.masked ? (
                              <span className="text-xs italic text-muted-foreground">hidden</span>
                            ) : (
                              formatValue(r[c.key], {
                                unit: vt?.unit,
                                plain: c.isKey || looksLikeIdentifier(c.property),
                              })
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {result && !result.rows.length && (
              <p className="p-8 text-center text-sm text-muted-foreground">No objects match.</p>
            )}
          </div>
        </div>
      )}

      <ObjectPanel target={open} onClose={() => setOpen(null)} onNavigate={setOpen} />
    </div>
  );
}

export function FilterBuilder({
  typeName,
  onAdd,
}: {
  typeName: string;
  onAdd: (f: Filter) => void;
}) {
  const o = useOntology();
  const t = findObjectType(o.spec, typeName);
  const [prop, setProp] = useState("");
  const [op, setOp] = useState<FilterOp>("eq");
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  if (!t) return null;
  const props = allProperties(o.spec, t);
  const vt = findValueType(o.spec, props.find((p) => p.name === prop)?.type ?? "");
  const noValue = op === "is_null" || op === "not_null";
  const add = () => {
    if (!prop) return;
    const list = op === "in" || op === "not_in" || op === "between";
    onAdd({
      property: prop,
      op,
      ...(noValue
        ? {}
        : {
            value: list
              ? value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean)
              : value,
          }),
    });
    setValue("");
    setOpen(false);
  };
  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1 h-3.5 w-3.5" /> Filter
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={prop || undefined} onValueChange={setProp}>
        <SelectTrigger className="h-8 w-40 text-xs" aria-label="Property">
          <SelectValue placeholder="Property" />
        </SelectTrigger>
        <SelectContent>
          {props.map((p) => (
            <SelectItem key={p.name} value={p.name}>
              {propertyTitle(p)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={op} onValueChange={(v) => setOp(v as FilterOp)}>
        <SelectTrigger className="h-8 w-32 text-xs" aria-label="Condition">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(OP_LABEL) as FilterOp[]).map((k) => (
            <SelectItem key={k} value={k}>
              {OP_LABEL[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!noValue &&
        (vt?.enum && (op === "eq" || op === "neq") ? (
          <Select value={value || undefined} onValueChange={setValue}>
            <SelectTrigger className="h-8 w-36 text-xs" aria-label="Value">
              <SelectValue placeholder="Value" />
            </SelectTrigger>
            <SelectContent>
              {vt.enum.map((e) => (
                <SelectItem key={e} value={e}>
                  {e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            className="h-8 w-40 text-xs"
            placeholder={
              op === "in" || op === "not_in" ? "a, b, c" : op === "between" ? "low, high" : "Value"
            }
            aria-label="Value"
          />
        ))}
      <Button
        size="sm"
        className="h-8"
        onClick={add}
        disabled={!prop || (!noValue && !value.trim())}
      >
        Add
      </Button>
      <Button size="sm" variant="ghost" className="h-8" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}

export function ObjectPanel(props: {
  target: { objectType: string; key: Record<string, unknown> } | null;
  onClose: () => void;
  onNavigate: (t: { objectType: string; key: Record<string, unknown> }) => void;
}) {
  const o = useOntology();
  const objectFn = useServerFn(ontologyObject);
  const [view, setView] = useState<ObjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const shown = useRef<typeof props.target>(null);

  useEffect(() => {
    if (!props.target) return;
    // A refresh after an action keeps the panel, and the action dialog's
    // outcome, on screen; only a different object starts from blank.
    if (shown.current !== props.target) {
      setView(null);
      shown.current = props.target;
    }
    setError(null);
    let live = true;
    void (async () => {
      const res = await objectFn({
        data: {
          access_token: o.tokenRef.current,
          id: o.id,
          objectType: props.target!.objectType,
          key: props.target!.key as Record<string, string | number | boolean>,
        },
      });
      if (!live) return;
      if (res.ok) setView(res);
      else setError(res.error);
    })();
    return () => {
      live = false;
    };
  }, [props.target, objectFn, o.tokenRef, o.id, nonce]);

  const t = props.target ? findObjectType(o.spec, props.target.objectType) : undefined;
  return (
    <Sheet open={!!props.target} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <TypeBadge type={t} label={t ? titleOf(t) : ""} size="md" />
          </div>
          <SheetTitle className="text-xl">
            {view?.title ?? (error ? "Not found" : "Loading…")}
          </SheetTitle>
        </SheetHeader>
        {error ? (
          <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            {error}
          </p>
        ) : !view ? (
          <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the object and what it links to…
          </p>
        ) : (
          <div className="mt-4 space-y-5">
            {view.broken.length > 0 && (
              <section className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
                  <AlertTriangle className="h-3.5 w-3.5" /> Breaks {view.broken.length} rule
                  {view.broken.length === 1 ? "" : "s"}
                </p>
                {view.broken.map((r) => (
                  <p key={r.id} className="flex items-start gap-2 text-xs">
                    <SeverityChip severity={r.severity} /> <span>{r.statement}</span>
                  </p>
                ))}
              </section>
            )}

            {view.actions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {view.actions.map((a) => (
                  <Button
                    key={a.name}
                    size="sm"
                    variant="outline"
                    onClick={() => setAction(a.name)}
                  >
                    <Zap className="mr-1 h-3.5 w-3.5" /> {a.label}
                    {a.requiresApproval && (
                      <Badge variant="secondary" className="ml-1.5 text-[9px]">
                        approval
                      </Badge>
                    )}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    props.target &&
                    o.go("graph", {
                      kind: "object",
                      objectType: props.target.objectType,
                      key: props.target.key,
                    })
                  }
                >
                  <Network className="mr-1 h-3.5 w-3.5" /> Graph
                </Button>
              </div>
            )}

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Properties
              </h3>
              <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-4 gap-y-1.5 text-sm">
                {view.columns.map((c) => {
                  const prop = t
                    ? allProperties(o.spec, t).find((p) => p.name === c.property)
                    : undefined;
                  const vt = prop ? findValueType(o.spec, prop.type) : undefined;
                  return (
                    <div key={c.key} className="contents">
                      <dt className="truncate text-muted-foreground">
                        {propertyTitle(prop ?? { name: c.property })}
                      </dt>
                      <dd className="truncate tabular-nums">
                        {c.masked ? (
                          <span className="inline-flex items-center gap-1 text-xs italic text-muted-foreground">
                            <EyeOff className="h-3 w-3" /> hidden from you
                          </span>
                        ) : (
                          formatValue(view.object[c.key], {
                            unit: vt?.unit,
                            plain: c.isKey || looksLikeIdentifier(c.property),
                          })
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>

            {view.metrics.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Measured
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {view.metrics.map((m) => (
                    <div key={m.name} className="rounded-lg border border-border px-3 py-2">
                      <p className="text-[11px] text-muted-foreground">{m.label}</p>
                      <p className="text-lg font-semibold tabular-nums">
                        {formatValue(m.value, { format: m.format })}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Linked
              </h3>
              {view.links.map((g) => {
                const ot = findObjectType(o.spec, g.objectType);
                return (
                  <div key={`${g.direction}-${g.link}`} className="rounded-lg border border-border">
                    <p className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
                      <span className="font-medium capitalize">{g.label}</span>
                      <TypeBadge type={ot} />
                      <span className="ml-auto tabular-nums text-muted-foreground">
                        {g.error ? "error" : g.total.toLocaleString()}
                      </span>
                    </p>
                    {g.error ? (
                      <p className="px-3 py-2 text-xs text-destructive">{g.error}</p>
                    ) : g.objects.length ? (
                      <ul className="divide-y divide-border">
                        {g.objects.map((x, i) => (
                          <li key={i}>
                            <button
                              type="button"
                              onClick={() =>
                                props.onNavigate({ objectType: g.objectType, key: x.key })
                              }
                              className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-muted/40"
                            >
                              <span className="truncate">{x.title}</span>
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            </button>
                          </li>
                        ))}
                        {g.total > g.objects.length && (
                          <li className="px-3 py-1.5 text-xs text-muted-foreground">
                            and {(g.total - g.objects.length).toLocaleString()} more — use Search
                            around
                          </li>
                        )}
                      </ul>
                    ) : (
                      <p className="px-3 py-2 text-xs text-muted-foreground">None</p>
                    )}
                  </div>
                );
              })}
            </section>
          </div>
        )}
        {action && view && (
          <ActionDialog
            open
            actionName={action}
            objectKey={props.target?.key ?? null}
            current={view.object}
            onClose={() => setAction(null)}
            onDone={() => setNonce((n) => n + 1)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
