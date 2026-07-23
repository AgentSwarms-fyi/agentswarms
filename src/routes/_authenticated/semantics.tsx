// Semantic Layer — define governed metrics + dimensions over a dataset, then
// query them (the same definitions the metric_query agent tool consumes).
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Layers, Play, Plus, Save, Trash2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MetricAgg, SemanticDimension, SemanticMetric } from "@/lib/semanticLayer";
import {
  semanticDeleteModel,
  semanticListLocalSources,
  semanticListModels,
  semanticRunQuery,
  semanticUpsertModel,
} from "@/utils/semantic.functions";

export const Route = createFileRoute("/_authenticated/semantics")({
  head: () => ({
    meta: [
      { title: "Semantic Layer — AgentSwarms" },
      {
        name: "description",
        content:
          "Define governed metrics and dimensions once; BI and AI agents query the same definitions.",
      },
    ],
  }),
  component: SemanticsPage,
});

type LocalSource = { id: string; name: string; is_sample: boolean; columns: { name: string; type: string }[] };

type Draft = {
  id?: string;
  name: string;
  label: string;
  description: string;
  source_table: string;
  table_id: string | null;
  dimensions: SemanticDimension[];
  metrics: SemanticMetric[];
};

const AGGS: MetricAgg[] = ["sum", "avg", "count", "count_distinct", "min", "max", "custom"];

function slug(s: string): string {
  const out = s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z_]/.test(out) ? out : `f_${out}`;
}

function emptyDraft(): Draft {
  return {
    name: "",
    label: "",
    description: "",
    source_table: "",
    table_id: null,
    dimensions: [],
    metrics: [],
  };
}

function SemanticsPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";

  const listFn = useServerFn(semanticListModels);
  const sourcesFn = useServerFn(semanticListLocalSources);
  const upsertFn = useServerFn(semanticUpsertModel);
  const deleteFn = useServerFn(semanticDeleteModel);
  const runFn = useServerFn(semanticRunQuery);

  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<Array<Record<string, unknown>>>([]);
  const [sources, setSources] = useState<LocalSource[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  // Run panel
  const [pickedMetrics, setPickedMetrics] = useState<string[]>([]);
  const [pickedDims, setPickedDims] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ columns: string[]; rows: Record<string, unknown>[]; sql: string } | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [ms, ss] = await Promise.all([
        listFn({ data: { accessToken: token } }),
        sourcesFn({ data: { accessToken: token } }),
      ]);
      setModels(ms as Array<Record<string, unknown>>);
      setSources(ss as LocalSource[]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load semantic models");
    } finally {
      setLoading(false);
    }
  }, [token, listFn, sourcesFn]);

  useEffect(() => {
    void load();
  }, [load]);

  const editModel = (m: Record<string, unknown>) => {
    setDraft({
      id: m.id as string,
      name: (m.name as string) ?? "",
      label: (m.label as string) ?? "",
      description: (m.description as string) ?? "",
      source_table: (m.source_table as string) ?? "",
      table_id: (m.table_id as string) ?? null,
      dimensions: Array.isArray(m.dimensions) ? (m.dimensions as SemanticDimension[]) : [],
      metrics: Array.isArray(m.metrics) ? (m.metrics as SemanticMetric[]) : [],
    });
    setResult(null);
    setPickedMetrics([]);
    setPickedDims([]);
  };

  const selectedSource = useMemo(
    () => sources.find((s) => s.name === draft?.source_table),
    [sources, draft?.source_table],
  );

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return toast.error("Model needs a name");
    if (!draft.source_table) return toast.error("Pick a source dataset");
    setSaving(true);
    try {
      const res = (await upsertFn({
        data: {
          accessToken: token,
          model: {
            id: draft.id,
            name: draft.name.trim(),
            label: draft.label || undefined,
            description: draft.description || undefined,
            source_kind: "data_table",
            table_id: draft.table_id,
            source_table: draft.source_table,
            dimensions: draft.dimensions,
            metrics: draft.metrics,
          },
        },
      })) as { id: string };
      toast.success("Saved");
      setDraft((d) => (d ? { ...d, id: res.id } : d));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteFn({ data: { accessToken: token, id } });
      if (draft?.id === id) setDraft(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const run = async () => {
    if (!draft?.id) return toast.error("Save the model first");
    if (pickedMetrics.length === 0 && pickedDims.length === 0)
      return toast.error("Pick at least one metric or dimension");
    setRunning(true);
    setResult(null);
    try {
      const res = (await runFn({
        data: {
          accessToken: token,
          query: {
            model: draft.name,
            metrics: pickedMetrics,
            dimensions: pickedDims,
            limit: 100,
          },
        },
      })) as { columns: string[]; rows: Record<string, unknown>[]; sql: string };
      setResult(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Query failed");
    } finally {
      setRunning(false);
    }
  };

  // Field editors
  const addDimFromColumn = (col: string) =>
    patch({
      dimensions: [
        ...(draft?.dimensions ?? []),
        { name: slug(col), label: col, sql: `\`${col}\``, type: "categorical" },
      ],
    });
  const addMetricFromColumn = (col: string) =>
    patch({
      metrics: [
        ...(draft?.metrics ?? []),
        { name: slug(col), label: col, agg: "sum", sql: `\`${col}\`` },
      ],
    });

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Layers className="h-6 w-6 text-primary" /> Semantic Layer
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Define governed <strong>metrics</strong> and <strong>dimensions</strong> once. The BI
          engine and your AI agents (via the <code>metric_query</code> tool) query the same
          definitions, so &ldquo;revenue&rdquo; always computes the same way — and the AI picks
          names, never writes SQL.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        {/* Model list */}
        <div className="space-y-2">
          <Button
            size="sm"
            className="w-full"
            onClick={() => {
              setDraft(emptyDraft());
              setResult(null);
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> New model
          </Button>
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : models.length === 0 ? (
            <p className="px-1 py-3 text-xs text-muted-foreground">
              No models yet. Create one from a dataset.
            </p>
          ) : (
            models.map((m) => (
              <Card
                key={m.id as string}
                className={`cursor-pointer transition-colors ${draft?.id === m.id ? "border-primary" : ""}`}
                onClick={() => editModel(m)}
              >
                <CardContent className="flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{(m.label as string) || (m.name as string)}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {m.name as string} · {m.source_table as string}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(m.id as string);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {/* Editor */}
        {!draft ? (
          <Card>
            <CardContent className="p-10 text-center text-sm text-muted-foreground">
              Select a model to edit, or create a new one.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-5">
            <Card>
              <CardContent className="space-y-4 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Name (id)</Label>
                    <Input
                      value={draft.name}
                      placeholder="orders"
                      onChange={(e) => patch({ name: e.target.value })}
                      className="h-8 font-mono"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Label</Label>
                    <Input
                      value={draft.label}
                      placeholder="Orders"
                      onChange={(e) => patch({ label: e.target.value })}
                      className="h-8"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Description</Label>
                  <Textarea
                    value={draft.description}
                    onChange={(e) => patch({ description: e.target.value })}
                    className="min-h-[48px] text-sm"
                    placeholder="What this model represents…"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Source dataset</Label>
                  <Select
                    value={draft.source_table}
                    onValueChange={(v) => {
                      const s = sources.find((x) => x.name === v);
                      patch({ source_table: v, table_id: s?.id ?? null });
                    }}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue placeholder="Pick a dataset…" />
                    </SelectTrigger>
                    <SelectContent>
                      {sources.map((s) => (
                        <SelectItem key={s.id} value={s.name}>
                          {s.name} {s.is_sample ? "(sample)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedSource && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {selectedSource.columns.map((c) => (
                        <Badge key={c.name} variant="secondary" className="font-mono text-[10px]">
                          {c.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <Button size="sm" onClick={save} disabled={saving}>
                  <Save className="mr-1 h-4 w-4" /> {saving ? "Saving…" : "Save model"}
                </Button>
              </CardContent>
            </Card>

            {/* Dimensions */}
            <FieldSection
              title="Dimensions"
              hint="How you slice — a column or SQL expression."
              cols={selectedSource?.columns.map((c) => c.name) ?? []}
              onAddFromColumn={addDimFromColumn}
              onAddBlank={() =>
                patch({ dimensions: [...draft.dimensions, { name: "", sql: "", type: "categorical" }] })
              }
            >
              {draft.dimensions.map((d, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1.4fr_120px_36px]">
                  <Input
                    value={d.name}
                    placeholder="region"
                    className="h-8 font-mono"
                    onChange={(e) =>
                      patch({ dimensions: draft.dimensions.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
                    }
                  />
                  <Input
                    value={d.sql}
                    placeholder="`Region`"
                    className="h-8 font-mono"
                    onChange={(e) =>
                      patch({ dimensions: draft.dimensions.map((x, j) => (j === i ? { ...x, sql: e.target.value } : x)) })
                    }
                  />
                  <Select
                    value={d.type ?? "categorical"}
                    onValueChange={(v) =>
                      patch({ dimensions: draft.dimensions.map((x, j) => (j === i ? { ...x, type: v as SemanticDimension["type"] } : x)) })
                    }
                  >
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["categorical", "time", "number", "boolean"].map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button variant="ghost" size="icon" className="h-8 w-8"
                    onClick={() => patch({ dimensions: draft.dimensions.filter((_, j) => j !== i) })}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </FieldSection>

            {/* Metrics */}
            <FieldSection
              title="Metrics"
              hint="What you measure — an aggregation over a column."
              cols={selectedSource?.columns.map((c) => c.name) ?? []}
              onAddFromColumn={addMetricFromColumn}
              onAddBlank={() =>
                patch({ metrics: [...draft.metrics, { name: "", agg: "sum", sql: "" }] })
              }
            >
              {draft.metrics.map((m, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[1fr_130px_1.3fr_36px]">
                  <Input
                    value={m.name}
                    placeholder="revenue"
                    className="h-8 font-mono"
                    onChange={(e) =>
                      patch({ metrics: draft.metrics.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
                    }
                  />
                  <Select
                    value={m.agg}
                    onValueChange={(v) =>
                      patch({ metrics: draft.metrics.map((x, j) => (j === i ? { ...x, agg: v as MetricAgg } : x)) })
                    }
                  >
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {AGGS.map((a) => (<SelectItem key={a} value={a}>{a}</SelectItem>))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={m.sql ?? ""}
                    placeholder={m.agg === "count" ? "(optional)" : "`Amount`"}
                    className="h-8 font-mono"
                    onChange={(e) =>
                      patch({ metrics: draft.metrics.map((x, j) => (j === i ? { ...x, sql: e.target.value } : x)) })
                    }
                  />
                  <Button variant="ghost" size="icon" className="h-8 w-8"
                    onClick={() => patch({ metrics: draft.metrics.filter((_, j) => j !== i) })}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </FieldSection>

            {/* Run panel */}
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Query runner</h3>
                  <Button size="sm" onClick={run} disabled={running || !draft.id}>
                    <Play className="mr-1 h-4 w-4" /> {running ? "Running…" : "Run"}
                  </Button>
                </div>
                {!draft.id && (
                  <p className="text-xs text-muted-foreground">Save the model to run queries.</p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Picker
                    label="Metrics"
                    options={draft.metrics.map((m) => m.name).filter(Boolean)}
                    picked={pickedMetrics}
                    onToggle={(n) =>
                      setPickedMetrics((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]))
                    }
                  />
                  <Picker
                    label="Dimensions"
                    options={draft.dimensions.map((d) => d.name).filter(Boolean)}
                    picked={pickedDims}
                    onToggle={(n) =>
                      setPickedDims((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]))
                    }
                  />
                </div>
                {result && (
                  <div className="space-y-2">
                    <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-[11px]">{result.sql}</pre>
                    <div className="max-h-72 overflow-auto rounded border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {result.columns.map((c) => (
                              <TableHead key={c} className="font-mono text-xs">{c}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {result.rows.map((r, i) => (
                            <TableRow key={i}>
                              {result.columns.map((c) => (
                                <TableCell key={c} className="font-mono text-xs">{String(r[c] ?? "")}</TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{result.rows.length} row(s)</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function FieldSection({
  title,
  hint,
  cols,
  onAddFromColumn,
  onAddBlank,
  children,
}: {
  title: string;
  hint: string;
  cols: string[];
  onAddFromColumn: (c: string) => void;
  onAddBlank: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="text-xs text-muted-foreground">{hint}</p>
          </div>
          <div className="flex gap-2">
            {cols.length > 0 && (
              <Select onValueChange={onAddFromColumn}>
                <SelectTrigger className="h-8 w-[150px] text-xs">
                  <SelectValue placeholder="+ from column" />
                </SelectTrigger>
                <SelectContent>
                  {cols.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
                </SelectContent>
              </Select>
            )}
            <Button variant="outline" size="sm" onClick={onAddBlank}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </div>
        <div className="space-y-2">{children}</div>
      </CardContent>
    </Card>
  );
}

function Picker({
  label,
  options,
  picked,
  onToggle,
}: {
  label: string;
  options: string[];
  picked: string[];
  onToggle: (n: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex flex-wrap gap-1">
        {options.length === 0 ? (
          <span className="text-xs text-muted-foreground">none defined</span>
        ) : (
          options.map((o) => (
            <Badge
              key={o}
              variant={picked.includes(o) ? "default" : "outline"}
              className="cursor-pointer font-mono text-[10px]"
              onClick={() => onToggle(o)}
            >
              {o}
            </Badge>
          ))
        )}
      </div>
    </div>
  );
}
