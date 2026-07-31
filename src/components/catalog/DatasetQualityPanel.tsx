// Quality checks + version history for one local dataset, rendered inside the
// catalog's asset sheet.
//
// These two live together because they answer the same question from opposite
// ends: "is this data still trustworthy?" and "if it isn't, what do I go back
// to?" Both only apply to datasets stored in this app — a warehouse table is
// governed where it lives.
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  History,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

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
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { describeFreshness } from "@/lib/biFreshness";
import {
  createQualityTest,
  deleteQualityTest,
  listQualityTests,
  loadLatestQualityResults,
  setQualityTestEnabled,
} from "@/lib/dataQuality";
import {
  QUALITY_TEST_LABELS,
  describeQualityTest,
  rollupQuality,
  validateQualityTest,
  type QualityResult,
  type QualityRollup,
  type QualitySeverity,
  type QualityTest,
  type QualityTestConfig,
  type QualityTestKind,
} from "@/lib/dataQualityCore";
import { cn } from "@/lib/utils";
import {
  listDatasetVersionsFn,
  restoreDatasetVersionFn,
  runQualityTests,
  type DatasetVersionRow,
} from "@/utils/dataQuality.functions";

const KINDS: QualityTestKind[] = [
  "not_null",
  "unique",
  "accepted_values",
  "range",
  "row_count_min",
  "freshness",
];

const REASON_LABELS: Record<string, string> = {
  upload: "File upload",
  prep_run: "Prep flow run",
  prep_refresh: "Scheduled refresh",
  restore: "Restore",
  overwrite: "Overwrite",
};

export function statusTone(status: QualityRollup["status"]): string {
  switch (status) {
    case "pass":
      return "border-emerald-500/50 text-emerald-600 dark:text-emerald-400";
    case "fail":
      return "border-red-500/50 text-red-600 dark:text-red-400";
    case "warn":
      return "border-amber-500/50 text-amber-600 dark:text-amber-400";
    case "error":
      return "border-orange-500/50 text-orange-600 dark:text-orange-400";
    default:
      return "border-border text-muted-foreground";
  }
}

export function DatasetQualityPanel({
  tableId,
  tableName,
  columns,
  readOnly,
}: {
  tableId: string;
  tableName: string;
  columns: { name: string }[];
  /** Sample datasets are shared and read-only — no tests, no restores. */
  readOnly?: boolean;
}) {
  const { user, session } = useAuth();
  const [tests, setTests] = useState<QualityTest[]>([]);
  const [results, setResults] = useState<Map<string, QualityResult>>(new Map());
  const [versions, setVersions] = useState<DatasetVersionRow[]>([]);
  const [versionCap, setVersionCap] = useState(20_000);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [ts, rs] = await Promise.all([
        listQualityTests(tableId),
        loadLatestQualityResults([tableId]),
      ]);
      setTests(ts);
      setResults(new Map(rs.map((r) => [r.test_id, r])));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tableId]);

  const reloadVersions = useCallback(async () => {
    if (!session?.access_token) return;
    const res = await listDatasetVersionsFn({
      data: { accessToken: session.access_token, tableId },
    });
    if (res.ok) {
      setVersions(res.versions);
      setVersionCap(res.cap);
    }
  }, [session?.access_token, tableId]);

  useEffect(() => {
    void reload();
    void reloadVersions();
  }, [reload, reloadVersions]);

  const rollup = rollupQuality(
    tests,
    new Map([...results].map(([id, r]) => [id, { status: r.status, ran_at: r.ran_at }])),
  );

  async function run() {
    if (!session?.access_token) return;
    setRunning(true);
    try {
      const res = await runQualityTests({
        data: { accessToken: session.access_token, tableId },
      });
      if (!res.ok) throw new Error(res.error);
      await reload();
      const bad = res.results.filter((r) => r.status !== "pass").length;
      if (res.results.length === 0) toast.info("No checks configured yet.");
      else if (bad === 0) toast.success(`All ${res.results.length} checks pass.`);
      else toast.warning(`${bad} of ${res.results.length} checks did not pass.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function restore(v: DatasetVersionRow) {
    if (!session?.access_token) return;
    setRestoring(v.id);
    try {
      const res = await restoreDatasetVersionFn({
        data: { accessToken: session.access_token, versionId: v.id },
      });
      if (!res.ok) throw new Error(res.error);
      toast.success(`Restored ${res.rowCount.toLocaleString()} rows to "${res.tableName}".`);
      await reloadVersions();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Quality checks
          </p>
          <Badge
            variant="outline"
            className={cn("h-4 px-1.5 text-[9px]", statusTone(rollup.status))}
          >
            {rollup.status === "unknown" ? "not run" : rollup.status}
          </Badge>
          {rollup.ranAt && (
            <span className="text-[10px] text-muted-foreground">
              {describeFreshness(rollup.ranAt)?.relative}
            </span>
          )}
          <div className="flex-1" />
          {!readOnly && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={run}
              disabled={running || tests.length === 0}
            >
              {running ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Play className="mr-1 h-3 w-3" />
              )}
              Run
            </Button>
          )}
        </div>

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading checks…</p>
        ) : tests.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No checks yet. Add one to be told when “{tableName}” goes empty, gains duplicates, or
            stops refreshing.
          </p>
        ) : (
          <div className="space-y-1">
            {tests.map((t) => {
              const r = results.get(t.id);
              const tone =
                !r || !t.enabled
                  ? "border-border text-muted-foreground"
                  : r.status === "pass"
                    ? statusTone("pass")
                    : t.severity === "warn"
                      ? statusTone("warn")
                      : statusTone(r.status === "error" ? "error" : "fail");
              return (
                <div
                  key={t.id}
                  className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px]"
                >
                  <Badge
                    variant="outline"
                    className={cn("mt-0.5 h-4 shrink-0 px-1.5 text-[9px]", tone)}
                  >
                    {!t.enabled ? "off" : (r?.status ?? "—")}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" title={describeQualityTest(t)}>
                      {describeQualityTest(t)}
                      {t.severity === "warn" && (
                        <span className="ml-1 text-[9px] uppercase tracking-wider text-muted-foreground">
                          warn
                        </span>
                      )}
                    </p>
                    {r && <p className="text-muted-foreground">{r.detail}</p>}
                  </div>
                  {!readOnly && (
                    <>
                      <Switch
                        checked={t.enabled}
                        className="mt-0.5 scale-75"
                        onCheckedChange={async (v) => {
                          try {
                            await setQualityTestEnabled(t.id, v);
                            setTests((prev) =>
                              prev.map((x) => (x.id === t.id ? { ...x, enabled: v } : x)),
                            );
                          } catch (e) {
                            toast.error((e as Error).message);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="mt-0.5 text-muted-foreground transition-colors hover:text-destructive"
                        title="Delete this check"
                        onClick={async () => {
                          try {
                            await deleteQualityTest(t.id);
                            setTests((prev) => prev.filter((x) => x.id !== t.id));
                          } catch (e) {
                            toast.error((e as Error).message);
                          }
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!readOnly &&
          (adding ? (
            <AddCheckForm
              columns={columns}
              onCancel={() => setAdding(false)}
              onSave={async (draft) => {
                if (!user) return;
                try {
                  const id = await createQualityTest(user.id, { table_id: tableId, ...draft });
                  setTests((prev) => [
                    ...prev,
                    { id, table_id: tableId, enabled: true, ...draft } as QualityTest,
                  ]);
                  setAdding(false);
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            />
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7 text-[11px]"
              onClick={() => setAdding(true)}
            >
              <Plus className="mr-1 h-3 w-3" /> Add check
            </Button>
          ))}
      </div>

      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <History className="h-3 w-3" /> Version history
        </p>
        {versions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No previous versions. One is recorded automatically each time this dataset is
            overwritten by an upload or a prep flow.
          </p>
        ) : (
          <div className="space-y-1">
            {versions.map((v) => (
              <div
                key={v.id}
                className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px]"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {REASON_LABELS[v.reason] ?? v.reason}
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {v.row_count.toLocaleString()} rows · {v.column_count} cols
                    </span>
                  </p>
                  <p
                    className="text-muted-foreground"
                    title={new Date(v.created_at).toLocaleString()}
                  >
                    {describeFreshness(v.created_at)?.relative}
                    {v.note ? ` · ${v.note}` : ""}
                  </p>
                </div>
                {v.rows_omitted ? (
                  <span
                    className="flex shrink-0 items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400"
                    title={`Larger than the ${versionCap.toLocaleString()}-row snapshot cap, so only metadata was kept. Raise DATASET_VERSION_ROW_CAP to snapshot datasets this size.`}
                  >
                    <AlertTriangle className="h-3 w-3" /> metadata only
                  </span>
                ) : (
                  !readOnly && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-2 text-[11px]"
                      disabled={restoring !== null}
                      onClick={() => restore(v)}
                    >
                      {restoring === v.id ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcw className="mr-1 h-3 w-3" />
                      )}
                      Restore
                    </Button>
                  )
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Sentinel for "measure freshness from the dataset's load time, not a column". */
const LOAD_TIME = "__load_time__";

type Draft = {
  kind: QualityTestKind;
  column_name: string | null;
  config: QualityTestConfig;
  severity: QualitySeverity;
};

function AddCheckForm({
  columns,
  onSave,
  onCancel,
}: {
  columns: { name: string }[];
  onSave: (d: Draft) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<QualityTestKind>("not_null");
  // Radix rejects an empty SelectItem value, so "no column" needs a sentinel.
  const [column, setColumn] = useState(columns[0]?.name ?? LOAD_TIME);
  const [severity, setSeverity] = useState<QualitySeverity>("error");
  const [values, setValues] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [count, setCount] = useState("1");
  const [hours, setHours] = useState("24");

  const needsColumn = kind !== "row_count_min" && kind !== "freshness";

  function submit() {
    const config: QualityTestConfig = {};
    if (kind === "accepted_values") {
      config.values = values
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean);
    } else if (kind === "range") {
      config.min = min.trim() === "" ? null : Number(min);
      config.max = max.trim() === "" ? null : Number(max);
    } else if (kind === "row_count_min") {
      config.count = Number(count);
    } else if (kind === "freshness") {
      config.max_age_hours = Number(hours);
    }
    // freshness may optionally watch a date column instead of the load time.
    const chosen = column === LOAD_TIME ? null : column;
    const col = needsColumn ? chosen : kind === "freshness" ? chosen : null;
    const err = validateQualityTest({ kind, column_name: col, config });
    if (err) return toast.error(err);
    void onSave({ kind, column_name: col, config, severity });
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/20 p-2">
      <div className="flex gap-1.5">
        <Select value={kind} onValueChange={(v) => setKind(v as QualityTestKind)}>
          <SelectTrigger className="h-7 flex-1 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((k) => (
              <SelectItem key={k} value={k} className="text-xs">
                {QUALITY_TEST_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={(v) => setSeverity(v as QualitySeverity)}>
          <SelectTrigger className="h-7 w-24 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="error" className="text-xs">
              Error
            </SelectItem>
            <SelectItem value="warn" className="text-xs">
              Warn
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {(needsColumn || kind === "freshness") && (
        <Select value={column} onValueChange={setColumn}>
          <SelectTrigger className="h-7 text-[11px]">
            <SelectValue
              placeholder={kind === "freshness" ? "Use the dataset's load time" : "Pick a column"}
            />
          </SelectTrigger>
          <SelectContent>
            {kind === "freshness" && (
              <SelectItem value={LOAD_TIME} className="text-xs">
                Dataset load time
              </SelectItem>
            )}
            {columns.map((c) => (
              <SelectItem key={c.name} value={c.name} className="text-xs">
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {kind === "accepted_values" && (
        <Input
          value={values}
          onChange={(e) => setValues(e.target.value)}
          placeholder="Allowed values, comma separated"
          className="h-7 text-[11px]"
        />
      )}
      {kind === "range" && (
        <div className="flex gap-1.5">
          <Input
            value={min}
            onChange={(e) => setMin(e.target.value)}
            placeholder="Min"
            className="h-7 text-[11px]"
          />
          <Input
            value={max}
            onChange={(e) => setMax(e.target.value)}
            placeholder="Max"
            className="h-7 text-[11px]"
          />
        </div>
      )}
      {kind === "row_count_min" && (
        <Input
          value={count}
          onChange={(e) => setCount(e.target.value)}
          placeholder="Minimum rows"
          className="h-7 text-[11px]"
        />
      )}
      {kind === "freshness" && (
        <Input
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          placeholder="Maximum age in hours"
          className="h-7 text-[11px]"
        />
      )}

      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onCancel}>
          <X className="mr-1 h-3 w-3" /> Cancel
        </Button>
        <Button size="sm" className="h-6 px-2 text-[11px]" onClick={submit}>
          <Check className="mr-1 h-3 w-3" /> Add
        </Button>
      </div>
    </div>
  );
}

/** Compact verdict chip used in the asset list. */
export function QualityChip({ rollup }: { rollup: QualityRollup }) {
  if (rollup.status === "unknown") return null;
  return (
    <Badge
      variant="outline"
      className={cn("h-4 gap-1 px-1.5 text-[9px]", statusTone(rollup.status))}
      title={`${rollup.passed}/${rollup.total} quality checks passing`}
    >
      <ShieldCheck className="h-2.5 w-2.5" />
      {rollup.passed}/{rollup.total}
    </Badge>
  );
}
