// The builder's Fields mode (R499): build a visual by putting fields into
// "Group by" and "Values" instead of writing SQL. The query is written from
// the picks (lib/biFieldQuery), run as the author changes them, and shown so
// it can be taken over in SQL mode at any time.
//
// Owns only its own view state — the field list read from a sample, the
// search box, the calculated-field form. The query itself belongs to the
// builder, which stores it on the widget so editing returns here.
import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, Code2, Hash, Plus, Sigma, Type, X } from "lucide-react";
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
import { BiTableCombobox } from "@/components/bi/BiTableCombobox";
import type { MeasureAgg } from "@/lib/biAggregate";
import type { DateGrain } from "@/lib/biChartMath";
import {
  AGG_LABEL,
  EMPTY_FIELD_QUERY,
  GRAIN_LABEL,
  ROWS_FIELD,
  aggsFor,
  buildFieldSql,
  defaultAgg,
  inferFields,
  tableRef,
  type FieldInfo,
  type FieldItem,
  type FieldQuery,
  type FieldSort,
  type FieldSql,
  type FilterOp,
} from "@/lib/biFieldQuery";
import type { SqlDialect } from "@/lib/semanticLayer";
import type { QueryResult } from "@/lib/sqlEngine";
import { cn } from "@/lib/utils";

export type FieldsTable = { name: string; cols: string[]; types?: Record<string, string> };

const label = "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground";

const OPS: [FilterOp, string][] = [
  ["in", "is one of"],
  ["not_in", "is not one of"],
  ["eq", "="],
  ["neq", "≠"],
  ["gt", ">"],
  ["gte", "≥"],
  ["lt", "<"],
  ["lte", "≤"],
  ["between", "between"],
  ["contains", "contains"],
  ["not_empty", "is not empty"],
];

function KindIcon({ f }: { f: FieldInfo }) {
  const cls = "h-3 w-3 shrink-0 text-muted-foreground";
  if (f.calc) return <Sigma className={cls} aria-label="Calculated field" />;
  if (f.kind === "number") return <Hash className={cls} aria-label="Number" />;
  if (f.kind === "date") return <Calendar className={cls} aria-label="Date" />;
  return <Type className={cls} aria-label="Text" />;
}

export function BiFieldsBuilder({
  tables,
  dialect,
  query,
  onQueryChange,
  runSql,
  onBuilt,
  onEditSql,
}: {
  tables: FieldsTable[];
  dialect: SqlDialect;
  query: FieldQuery;
  onQueryChange: (next: FieldQuery) => void;
  /** Runs a sample query to learn the table's field kinds. */
  runSql: (sql: string) => Promise<QueryResult>;
  /** The written query, or null while the picks are incomplete. */
  onBuilt: (built: FieldSql | null, query: FieldQuery, fields: FieldInfo[]) => void;
  onEditSql: (sql: string) => void;
}) {
  const [sample, setSample] = useState<{ table: string; rows: Record<string, unknown>[] } | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [calcOpen, setCalcOpen] = useState(false);
  const [calcName, setCalcName] = useState("");
  const [calcExpr, setCalcExpr] = useState("");
  const [calcAgg, setCalcAgg] = useState(true);

  const table = tables.find((t) => t.name === query.table);

  // A sample tells the kinds apart: a VARCHAR of "11/9/2024" is a date.
  useEffect(() => {
    if (!table || sample?.table === table.name) return;
    let alive = true;
    runSql(`SELECT * FROM ${tableRef(table.name, dialect)} LIMIT 50`)
      .then((res) => {
        if (alive) setSample({ table: table.name, rows: res.rows });
      })
      .catch(() => {
        if (alive) setSample({ table: table.name, rows: [] });
      });
    return () => {
      alive = false;
    };
  }, [table, sample?.table, runSql, dialect]);

  const fields: FieldInfo[] = useMemo(() => {
    if (!table) return [];
    const base = inferFields(
      table.cols,
      sample?.table === table.name ? sample.rows : [],
      table.types ?? {},
    );
    const calcs: FieldInfo[] = (query.calcs ?? []).map((c) => ({
      name: c.name,
      kind: c.kind ?? "number",
      calc: { expr: c.expr, aggregated: c.aggregated },
    }));
    return [...base, ...calcs];
  }, [table, sample, query.calcs]);

  const built = useMemo((): { ok: FieldSql | null; error: string | null } => {
    if (!table) return { ok: null, error: null };
    try {
      return { ok: buildFieldSql(query, fields, dialect), error: null };
    } catch (e) {
      return { ok: null, error: (e as Error).message };
    }
  }, [query, fields, dialect, table]);

  // Run as the author picks, a beat after the last change.
  const lastSql = useRef<string | null>(null);
  const onBuiltRef = useRef(onBuilt);
  useEffect(() => {
    onBuiltRef.current = onBuilt;
  }, [onBuilt]);
  useEffect(() => {
    const sql = built.ok?.sql ?? null;
    if (sql === lastSql.current) return;
    const t = setTimeout(() => {
      lastSql.current = sql;
      onBuiltRef.current(built.ok, query, fields);
    }, 350);
    return () => clearTimeout(t);
  }, [built, query, fields]);

  const set = (patch: Partial<FieldQuery>) => onQueryChange({ ...query, ...patch });
  const kindOf = (name: string) => fields.find((f) => f.name === name)?.kind ?? "text";

  const addTo = (role: "dims" | "measures", f: FieldInfo) => {
    if (role === "dims") {
      if (query.dims.some((d) => d.field === f.name)) return;
      set({
        dims: [...query.dims, { field: f.name, grain: f.kind === "date" ? "month" : undefined }],
      });
    } else {
      if (query.measures.some((m) => m.field === f.name)) return;
      set({
        measures: [
          ...query.measures,
          f.calc?.aggregated ? { field: f.name } : { field: f.name, agg: defaultAgg(f.kind) },
        ],
      });
    }
  };
  const addDefault = (f: FieldInfo) =>
    addTo(f.kind === "number" || f.calc?.aggregated ? "measures" : "dims", f);

  const shown = fields.filter((f) => f.name.toLowerCase().includes(search.trim().toLowerCase()));
  // A grouped date runs in time order unless a sort says otherwise, and its
  // "top N" is the latest N periods — the menu and the label say so.
  const timeDim = query.dims.some(
    (d) => d.grain && fields.find((f) => f.name === d.field)?.kind === "date",
  );
  const timeOrder = timeDim && (!query.sort || query.sort === "label_asc");

  const updateItem = (role: "dims" | "measures", i: number, patch: Partial<FieldItem>) =>
    set({ [role]: query[role].map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const removeItem = (role: "dims" | "measures", i: number) =>
    set({ [role]: query[role].filter((_, j) => j !== i) });

  function addCalc() {
    const name = calcName.trim();
    const expr = calcExpr.trim();
    if (!name || !expr || fields.some((f) => f.name === name)) return;
    if (/;/.test(expr)) return;
    set({ calcs: [...(query.calcs ?? []), { name, expr, aggregated: calcAgg, kind: "number" }] });
    setCalcName("");
    setCalcExpr("");
    setCalcOpen(false);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className={label}>Table</Label>
        <BiTableCombobox
          tables={tables}
          value={query.table}
          onChange={(v) => onQueryChange({ ...EMPTY_FIELD_QUERY, table: v })}
        />
      </div>

      {table && (
        <>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className={label}>Fields</Label>
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] text-primary hover:underline"
                onClick={() => setCalcOpen((v) => !v)}
              >
                <Plus className="h-3 w-3" /> Calculated field
              </button>
            </div>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search fields"
              aria-label="Search fields"
              className="h-7 text-xs"
            />
            {calcOpen && (
              <div className="space-y-1.5 rounded-md border border-border/60 p-2">
                <Input
                  value={calcName}
                  onChange={(e) => setCalcName(e.target.value)}
                  placeholder="Name, e.g. Margin %"
                  aria-label="Calculated field name"
                  className="h-7 text-xs"
                />
                <Textarea
                  value={calcExpr}
                  onChange={(e) => setCalcExpr(e.target.value)}
                  rows={2}
                  placeholder={'e.g. 100 * SUM("Profit") / SUM("Sales")'}
                  aria-label="Calculated field expression"
                  className="font-mono text-xs"
                />
                <Label className="flex cursor-pointer items-center gap-2 text-[11px] font-normal">
                  <Checkbox checked={calcAgg} onCheckedChange={(v) => setCalcAgg(Boolean(v))} />
                  It aggregates by itself (SUM, AVG, COUNT…) — use it as a value as written
                </Label>
                <div className="flex justify-end gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => setCalcOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={!calcName.trim() || !calcExpr.trim() || /;/.test(calcExpr)}
                    onClick={addCalc}
                  >
                    Add field
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  An expression over this table&apos;s columns, in the source&apos;s SQL. Quote
                  names with spaces. It runs with the rest of the query, read-only.
                </p>
              </div>
            )}
            <div className="max-h-44 overflow-y-auto rounded-md border border-border/60">
              <FieldRow
                f={{ name: ROWS_FIELD, kind: "number" }}
                display="Number of rows"
                onGroup={null}
                onValue={() =>
                  !query.measures.some((m) => m.field === ROWS_FIELD) &&
                  set({ measures: [...query.measures, { field: ROWS_FIELD, agg: "count" }] })
                }
              />
              {shown.map((f) => (
                <FieldRow
                  key={f.name}
                  f={f}
                  display={f.name}
                  onDefault={() => addDefault(f)}
                  onGroup={f.calc?.aggregated ? null : () => addTo("dims", f)}
                  onValue={() => addTo("measures", f)}
                />
              ))}
            </div>
            {!sample && <p className="text-[10px] text-muted-foreground">Reading the table…</p>}
          </div>

          <Well title="Group by" empty="Add a field to group by — a category or a date.">
            {query.dims.map((d, i) => (
              <Chip key={d.field} name={d.field} onRemove={() => removeItem("dims", i)}>
                {kindOf(d.field) === "date" && (
                  <Select
                    value={d.grain ?? "none"}
                    onValueChange={(v) =>
                      updateItem("dims", i, { grain: v === "none" ? undefined : (v as DateGrain) })
                    }
                  >
                    <SelectTrigger
                      className="h-6 w-24 text-[11px]"
                      aria-label={`${d.field} period`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(GRAIN_LABEL) as DateGrain[]).map((g) => (
                        <SelectItem key={g} value={g} className="text-xs">
                          {GRAIN_LABEL[g]}
                        </SelectItem>
                      ))}
                      <SelectItem value="none" className="text-xs">
                        Exact value
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </Chip>
            ))}
          </Well>

          <Well title="Values" empty="Add a number to add up, average or count.">
            {query.measures.map((m, i) => {
              const f = fields.find((x) => x.name === m.field);
              const fixed = m.field === ROWS_FIELD || f?.calc?.aggregated;
              return (
                <Chip
                  key={m.field}
                  name={m.field === ROWS_FIELD ? "Number of rows" : m.field}
                  onRemove={() => removeItem("measures", i)}
                >
                  {!fixed && f && (
                    <Select
                      value={m.agg ?? defaultAgg(f.kind)}
                      onValueChange={(v) => updateItem("measures", i, { agg: v as MeasureAgg })}
                    >
                      <SelectTrigger
                        className="h-6 w-28 text-[11px]"
                        aria-label={`${m.field} aggregation`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {aggsFor(f.kind).map((a) => (
                          <SelectItem key={a} value={a} className="text-xs">
                            {AGG_LABEL[a]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Chip>
              );
            })}
          </Well>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className={label}>Filters</Label>
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] text-primary hover:underline"
                onClick={() =>
                  set({
                    filters: [
                      ...query.filters,
                      {
                        field: fields.find((f) => !f.calc?.aggregated)?.name ?? "",
                        op: "in",
                        values: [],
                      },
                    ],
                  })
                }
              >
                <Plus className="h-3 w-3" /> Add filter
              </button>
            </div>
            {query.filters.map((flt, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1">
                <Select
                  value={flt.field || undefined}
                  onValueChange={(v) =>
                    set({
                      filters: query.filters.map((x, j) => (j === i ? { ...x, field: v } : x)),
                    })
                  }
                >
                  <SelectTrigger
                    className="h-7 w-32 text-[11px]"
                    aria-label={`Filter ${i + 1} field`}
                  >
                    <SelectValue placeholder="Field" />
                  </SelectTrigger>
                  <SelectContent>
                    {fields
                      .filter((f) => !f.calc?.aggregated)
                      .map((f) => (
                        <SelectItem key={f.name} value={f.name} className="text-xs">
                          {f.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Select
                  value={flt.op}
                  onValueChange={(v) =>
                    set({
                      filters: query.filters.map((x, j) =>
                        j === i ? { ...x, op: v as FilterOp } : x,
                      ),
                    })
                  }
                >
                  <SelectTrigger
                    className="h-7 w-28 text-[11px]"
                    aria-label={`Filter ${i + 1} condition`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPS.map(([v, l]) => (
                      <SelectItem key={v} value={v} className="text-xs">
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {flt.op !== "not_empty" && (
                  <Input
                    value={flt.values.join(
                      flt.op === "in" || flt.op === "not_in" || flt.op === "between" ? ", " : "",
                    )}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const values =
                        flt.op === "in" || flt.op === "not_in" || flt.op === "between"
                          ? raw.split(",").map((s) => s.trimStart())
                          : [raw];
                      set({
                        filters: query.filters.map((x, j) => (j === i ? { ...x, values } : x)),
                      });
                    }}
                    placeholder={
                      flt.op === "between"
                        ? "from, to"
                        : flt.op === "in" || flt.op === "not_in"
                          ? "a, b, c"
                          : "value"
                    }
                    aria-label={`Filter ${i + 1} value`}
                    className="h-7 min-w-0 flex-1 text-[11px]"
                  />
                )}
                <button
                  type="button"
                  aria-label={`Remove filter ${i + 1}`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => set({ filters: query.filters.filter((_, j) => j !== i) })}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          {query.dims.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className={label}>Sort</Label>
                <Select
                  value={query.sort ?? (timeDim ? "label_asc" : "value_desc")}
                  onValueChange={(v) => set({ sort: v as FieldSort })}
                >
                  <SelectTrigger className="h-8 text-xs" aria-label="Sort groups">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="value_desc" className="text-xs">
                      Largest value first
                    </SelectItem>
                    <SelectItem value="value_asc" className="text-xs">
                      Smallest value first
                    </SelectItem>
                    <SelectItem value="label_asc" className="text-xs">
                      A → Z (dates oldest first)
                    </SelectItem>
                    <SelectItem value="label_desc" className="text-xs">
                      Z → A (dates newest first)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className={label}>{timeOrder ? "Show latest" : "Show top"}</Label>
                <Input
                  value={query.limit ? String(query.limit) : ""}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    set({
                      limit:
                        e.target.value.trim() && Number.isFinite(n) && n > 0
                          ? Math.round(n)
                          : undefined,
                    });
                  }}
                  placeholder="all"
                  inputMode="numeric"
                  aria-label={timeOrder ? "Show the latest N periods" : "Show the top N groups"}
                  className="h-8 text-xs"
                />
              </div>
            </div>
          )}

          {built.error && (query.dims.length > 0 || query.measures.length > 0) && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">{built.error}</p>
          )}
          {built.ok && (
            <details className="rounded-md border border-border/60 px-2 py-1">
              <summary className="cursor-pointer text-[11px] text-muted-foreground">
                The query these fields write
              </summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
                {built.ok.sql}
              </pre>
              <Button
                size="sm"
                variant="outline"
                className="mt-1 h-7 gap-1 text-[11px]"
                onClick={() => onEditSql(built.ok!.sql)}
              >
                <Code2 className="h-3 w-3" /> Edit as SQL
              </Button>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function FieldRow({
  f,
  display,
  onDefault,
  onGroup,
  onValue,
}: {
  f: FieldInfo;
  display: string;
  onDefault?: () => void;
  onGroup: (() => void) | null;
  onValue: () => void;
}) {
  return (
    <div className="group flex items-center gap-1.5 border-b border-border/30 px-2 py-1 last:border-0 hover:bg-muted/40">
      <KindIcon f={f} />
      <button
        type="button"
        className={cn(
          "min-w-0 flex-1 truncate text-left text-[11px]",
          onDefault && "hover:text-primary",
        )}
        title={onDefault ? `Add ${display} where it fits` : display}
        onClick={onDefault ?? onValue}
      >
        {display}
      </button>
      {onGroup && (
        <button
          type="button"
          className="rounded px-1 text-[10px] text-muted-foreground hover:bg-primary/10 hover:text-primary"
          aria-label={`Group by ${display}`}
          onClick={onGroup}
        >
          Group
        </button>
      )}
      <button
        type="button"
        className="rounded px-1 text-[10px] text-muted-foreground hover:bg-primary/10 hover:text-primary"
        aria-label={`Add ${display} to values`}
        onClick={onValue}
      >
        Value
      </button>
    </div>
  );
}

function Well({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  const has = children.length > 0;
  return (
    <div className="space-y-1">
      <Label className={label}>{title}</Label>
      <div
        className={cn(
          "min-h-8 space-y-1 rounded-md border border-dashed p-1",
          has ? "border-border/60" : "border-border",
        )}
      >
        {has ? children : <p className="px-1 py-1 text-[10px] text-muted-foreground">{empty}</p>}
      </div>
    </div>
  );
}

function Chip({
  name,
  onRemove,
  children,
}: {
  name: string;
  onRemove: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-0.5">
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={name}>
        {name}
      </span>
      {children}
      <button
        type="button"
        aria-label={`Remove ${name}`}
        className="text-muted-foreground hover:text-destructive"
        onClick={onRemove}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/** Build from fields, or from SQL — the builder's two ways in (R499). */
export function BiQueryModeSwitch({
  value,
  onChange,
}: {
  value: "fields" | "sql";
  onChange: (v: "fields" | "sql") => void;
}) {
  return (
    <div className="flex rounded-md bg-muted p-0.5" role="group" aria-label="Build from">
      {(["fields", "sql"] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={value === m}
          onClick={() => onChange(m)}
          className={cn(
            "flex-1 rounded px-2 py-1 text-xs font-medium",
            value === m ? "bg-background shadow-sm" : "text-muted-foreground",
          )}
        >
          {m === "fields" ? "Fields" : "SQL"}
        </button>
      ))}
    </div>
  );
}
