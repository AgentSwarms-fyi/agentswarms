// Metrics, broken down. Pick a type's metric and group it by its own
// properties or by those of a type it walks TO ONE of — an Order's Customer's
// region, never through a link that fans out (that would count an order once
// per product and give a confident wrong total). The chart, the table and
// the compiled SQL are three views of one governed query.
import { reportFailure } from "@/lib/silentFailureNet";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BadgeCheck, Code2, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FilterBuilder } from "@/components/ontology/ExploreTab";
import { useOntology } from "@/components/ontology/OntologyContext";
import { formatValue, TypeBadge } from "@/components/ontology/theme";
import { ontologyMetric } from "@/utils/ontologyData.functions";
import type { ColumnMeta, Filter, GroupBy, PathStep, TimeGrain } from "@/lib/ontology/compile";
import { TIME_GRAINS } from "@/lib/ontology/compile";
import {
  allProperties,
  baseTypeOf,
  findObjectType,
  linkReading,
  linksOf,
  propertyTitle,
  walksToOne,
  type OntologySpec,
} from "@/lib/ontology/spec";

type GroupOption = {
  id: string;
  label: string;
  via: string;
  property: string;
  path: PathStep[];
  isDate: boolean;
};

/** Every property a metric of `typeName` can be grouped by: its own, then one and two to-one steps out. */
export function groupOptions(spec: OntologySpec, typeName: string): GroupOption[] {
  const out: GroupOption[] = [];
  const visit = (at: string, path: PathStep[], via: string, depth: number) => {
    const t = findObjectType(spec, at);
    if (!t?.source) return;
    for (const p of allProperties(spec, t)) {
      const base = baseTypeOf(spec, p.type) ?? "string";
      out.push({
        id: `${path.map((s) => `${s.direction}:${s.link}`).join("/")}|${p.name}`,
        label: propertyTitle(p),
        via,
        property: p.name,
        path,
        isDate: ["date", "datetime", "timestamp"].includes(base),
      });
    }
    if (depth >= 2) return;
    for (const { link, direction, other } of linksOf(spec, at)) {
      if (!walksToOne(link, direction)) continue;
      const step = { link: linkReading(link, direction), direction };
      visit(other, [...path, step], `${via} → ${other}`, depth + 1);
    }
  };
  visit(typeName, [], typeName, 0);
  return out;
}

export function MetricsTab() {
  const o = useOntology();
  const metricFn = useServerFn(ontologyMetric);
  const withMetrics = o.spec.objectTypes.filter((t) => t.source && t.metrics.length);
  const firstCertified = withMetrics.flatMap((t) =>
    t.metrics.filter((m) => m.certified).map((m) => [t.name, m.name] as const),
  )[0];
  const [typeName, setTypeName] = useState(firstCertified?.[0] ?? withMetrics[0]?.name ?? "");
  const [metric, setMetric] = useState(
    firstCertified?.[1] ?? withMetrics[0]?.metrics[0]?.name ?? "",
  );
  const [groups, setGroups] = useState<{ optionId: string; grain?: TimeGrain }[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [result, setResult] = useState<{
    columns: ColumnMeta[];
    rows: Record<string, unknown>[];
    sql: string;
    duration_ms: number;
    certified: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const t = findObjectType(o.spec, typeName);
  const m = t?.metrics.find((x) => x.name === metric);
  const options = useMemo(
    () => (typeName ? groupOptions(o.spec, typeName) : []),
    [o.spec, typeName],
  );

  useEffect(() => {
    if (!typeName || !metric) return;
    let live = true;
    setBusy(true);
    const groupBy: GroupBy[] = groups
      .map((g) => {
        const opt = options.find((x) => x.id === g.optionId);
        return opt
          ? {
              property: opt.property,
              ...(opt.path.length ? { path: opt.path } : {}),
              ...(g.grain ? { grain: g.grain } : {}),
            }
          : null;
      })
      .filter((g): g is GroupBy => !!g);
    void (async () => {
      try {
        const res = await metricFn({
          data: {
            access_token: o.tokenRef.current,
            id: o.id,
            query: {
              objectType: typeName,
              metric,
              groupBy,
              filters,
              order: groupBy.some((g) => g.grain) ? "group_asc" : "metric_desc",
              limit: 200,
            },
          },
        });
        if (!live) return;
        if (res.ok) {
          setResult(res);
          setError(null);
        } else {
          setError(res.error);
          setResult(null);
        }
      } catch (e) {
        reportFailure("finish", e);
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [typeName, metric, groups, filters, options, metricFn, o.tokenRef, o.id]);

  if (!withMetrics.length) {
    return (
      <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
        No bound type has a metric yet. Add one under Model.
      </p>
    );
  }

  const groupCols = result?.columns.filter((c) => c.key !== metric) ?? [];
  const isTime = groups.some((g) => g.grain);
  const chartData = (result?.rows ?? []).map((r) => ({
    label: groupCols.map((c) => formatValue(r[c.key])).join(" · ") || m?.label || metric,
    value: typeof r[metric] === "number" ? (r[metric] as number) : Number(r[metric] ?? 0),
  }));

  return (
    <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="space-y-4 rounded-xl border border-border bg-card p-4">
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Measure
          </p>
          <Select
            value={`${typeName}|${metric}`}
            onValueChange={(v) => {
              const [tn, mn] = v.split("|");
              setTypeName(tn);
              setMetric(mn);
              setGroups([]);
              setFilters([]);
            }}
          >
            <SelectTrigger aria-label="Metric">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {withMetrics.map((x) => (
                <SelectGroup key={x.name}>
                  <SelectLabel>{x.name}</SelectLabel>
                  {x.metrics.map((mm) => (
                    <SelectItem key={mm.name} value={`${x.name}|${mm.name}`}>
                      {mm.label ?? mm.name} {mm.certified ? "✓" : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          {m && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <TypeBadge type={t} />
              <span className="font-mono">{m.expression}</span>
              {m.certified && (
                <span className="inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-300">
                  <BadgeCheck className="h-3.5 w-3.5" /> certified
                </span>
              )}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Broken down by
          </p>
          {groups.map((g, i) => {
            const opt = options.find((x) => x.id === g.optionId);
            return (
              <div
                key={i}
                className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border p-2 text-xs"
              >
                <span className="text-muted-foreground">{opt?.via}</span>
                <span className="font-medium">{opt?.label}</span>
                {opt?.isDate && (
                  <Select
                    value={g.grain ?? "month"}
                    onValueChange={(v) =>
                      setGroups((gs) =>
                        gs.map((x, j) => (j === i ? { ...x, grain: v as TimeGrain } : x)),
                      )
                    }
                  >
                    <SelectTrigger className="h-7 w-24 text-xs" aria-label="Time grain">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIME_GRAINS.map((tg) => (
                        <SelectItem key={tg} value={tg}>
                          by {tg}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <button
                  type="button"
                  className="ml-auto text-muted-foreground hover:text-foreground"
                  onClick={() => setGroups((gs) => gs.filter((_, j) => j !== i))}
                  aria-label="Remove grouping"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          {groups.length < 3 && (
            <Select
              value=""
              onValueChange={(v) => {
                const opt = options.find((x) => x.id === v);
                setGroups((gs) => [
                  ...gs,
                  { optionId: v, ...(opt?.isDate ? { grain: "month" as TimeGrain } : {}) },
                ]);
              }}
            >
              <SelectTrigger className="text-xs" aria-label="Add a grouping">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Plus className="h-3.5 w-3.5" /> Add a grouping
                </span>
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {[...new Set(options.map((x) => x.via))].map((via) => (
                  <SelectGroup key={via}>
                    <SelectLabel>{via}</SelectLabel>
                    {options
                      .filter((x) => x.via === via)
                      .map((x) => (
                        <SelectItem key={x.id} value={x.id}>
                          {x.label}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="text-[11px] text-muted-foreground">
            Only links where each {t?.name} has at most one are offered, so the totals never double
            count.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Only {t?.name ?? ""}s where
          </p>
          {filters.map((f, i) => (
            <span
              key={i}
              className="mr-1 inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs"
            >
              {f.property} {f.op} {f.value !== undefined && f.value !== null ? String(f.value) : ""}
              <button
                type="button"
                onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}
                aria-label="Remove filter"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {t && <FilterBuilder typeName={t.name} onAdd={(f) => setFilters((fs) => [...fs, f])} />}
        </div>
      </aside>

      <section className="space-y-3">
        {error ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            {error}
          </p>
        ) : (
          <>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">{m?.label ?? metric}</h3>
                  <p className="text-xs text-muted-foreground">
                    {busy
                      ? "Computing…"
                      : result
                        ? `${result.rows.length} row${result.rows.length === 1 ? "" : "s"} · ${result.duration_ms} ms`
                        : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowSql((s) => !s)}
                  aria-pressed={showSql}
                >
                  <Code2 className="mr-1 h-4 w-4" /> SQL
                </Button>
              </div>
              {busy && !result ? (
                <div className="flex h-64 items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : !groupCols.length && result ? (
                <p className="py-10 text-center text-5xl font-semibold tabular-nums">
                  {formatValue(result.rows[0]?.[metric], { format: m?.format })}
                </p>
              ) : (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    {isTime ? (
                      <LineChart
                        data={chartData}
                        margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 11 }}
                          className="fill-muted-foreground"
                        />
                        <YAxis
                          tick={{ fontSize: 11 }}
                          tickFormatter={(v: number) =>
                            formatValue(v, {
                              format: m?.format === "currency" ? "integer" : m?.format,
                            })
                          }
                          width={70}
                        />
                        <Tooltip
                          formatter={(v: number) => formatValue(v, { format: m?.format })}
                          contentStyle={{
                            background: "var(--card)",
                            border: "1px solid var(--border)",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                        />
                        <Line
                          type="monotone"
                          dataKey="value"
                          stroke="var(--primary)"
                          strokeWidth={2}
                          dot={false}
                        />
                      </LineChart>
                    ) : (
                      <BarChart
                        data={chartData.slice(0, 40)}
                        margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          vertical={false}
                          className="stroke-border"
                        />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 11 }}
                          interval={0}
                          angle={chartData.length > 8 ? -30 : 0}
                          textAnchor={chartData.length > 8 ? "end" : "middle"}
                          height={chartData.length > 8 ? 70 : 30}
                        />
                        <YAxis
                          tick={{ fontSize: 11 }}
                          tickFormatter={(v: number) =>
                            formatValue(v, {
                              format: m?.format === "currency" ? "integer" : m?.format,
                            })
                          }
                          width={70}
                        />
                        <Tooltip
                          formatter={(v: number) => formatValue(v, { format: m?.format })}
                          contentStyle={{
                            background: "var(--card)",
                            border: "1px solid var(--border)",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                        />
                        <Bar dataKey="value" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                </div>
              )}
              {showSql && result && (
                <pre className="mt-3 overflow-x-auto rounded-lg bg-muted/50 p-3 text-[11px]">
                  {result.sql}
                </pre>
              )}
            </div>
            {result && groupCols.length > 0 && (
              <div className="max-h-[40vh] overflow-auto rounded-xl border border-border bg-card">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                    <tr>
                      {result.columns.map((c) => (
                        <th key={c.key} className="px-3 py-2 font-medium">
                          {c.key === metric
                            ? (m?.label ?? metric)
                            : `${c.objectType !== typeName ? `${c.objectType} ` : ""}${propertyTitle({ name: c.property })}`}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        {result.columns.map((c) => (
                          <td
                            key={c.key}
                            className={
                              c.key === metric
                                ? "px-3 py-1.5 text-right font-medium tabular-nums"
                                : "px-3 py-1.5"
                            }
                          >
                            {formatValue(
                              r[c.key],
                              c.key === metric ? { format: m?.format } : undefined,
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
