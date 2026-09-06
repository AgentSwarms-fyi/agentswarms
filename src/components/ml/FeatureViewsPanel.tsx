// Feature views: name a table, say which columns identify a row and which are
// features, and models can then be scored by key instead of by row.
//
// The panel leads with WHY rather than with a form, because the value is not
// obvious from the fields: nothing here computes anything, and the point is
// that the caller stops having to.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { validateView } from "@/lib/featureViews";
import {
  featureViewDelete,
  featureViewPreview,
  featureViewSave,
  featureViewsList,
  mlModelSetFeatureView,
} from "@/utils/featureViews.functions";
import type { FeatureViewRow } from "@/utils/featureViews/lookup.server";

type SourceTable = { schema: string; table: string; columns: { name: string; type: string }[] };

type Draft = {
  id: string | null;
  name: string;
  description: string;
  schema_name: string;
  table_name: string;
  key_columns: string[];
  feature_columns: string[];
  timestamp_column: string;
};

const empty: Draft = {
  id: null,
  name: "",
  description: "",
  schema_name: "",
  table_name: "",
  key_columns: [],
  feature_columns: [],
  timestamp_column: "",
};

export function FeatureViewsPanel({ token }: { token: string }) {
  const listFn = useServerFn(featureViewsList);
  const saveFn = useServerFn(featureViewSave);
  const deleteFn = useServerFn(featureViewDelete);
  const previewFn = useServerFn(featureViewPreview);

  const [views, setViews] = useState<FeatureViewRow[]>([]);
  const [tables, setTables] = useState<SourceTable[]>([]);
  const [usedBy, setUsedBy] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [probe, setProbe] = useState<Record<string, string>>({});
  const [probed, setProbed] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(async () => {
    const res = await listFn({ data: { accessToken: token } });
    if (res.ok) {
      setViews(res.views);
      setTables(res.tables);
      setUsedBy(res.usedBy);
    } else toast.error(res.error);
    setLoading(false);
  }, [listFn, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const columnsOf = useMemo(() => {
    if (!draft?.schema_name || !draft?.table_name) return [];
    return (
      tables.find((t) => t.schema === draft.schema_name && t.table === draft.table_name)?.columns ??
      []
    );
  }, [tables, draft?.schema_name, draft?.table_name]);

  const problem = draft
    ? validateView({
        name: draft.name,
        schema_name: draft.schema_name,
        table_name: draft.table_name,
        key_columns: draft.key_columns,
        feature_columns: draft.feature_columns,
        timestamp_column: draft.timestamp_column || null,
      })
    : null;

  async function save() {
    if (!draft || problem) return problem ? toast.error(problem) : undefined;
    setBusy(true);
    try {
      const res = await saveFn({
        data: {
          accessToken: token,
          id: draft.id,
          name: draft.name,
          description: draft.description || null,
          schema_name: draft.schema_name,
          table_name: draft.table_name,
          key_columns: draft.key_columns,
          feature_columns: draft.feature_columns,
          timestamp_column: draft.timestamp_column || null,
        },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(draft.id ? `Saved ${draft.name}` : `Created ${draft.name}`);
      setDraft(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(v: FeatureViewRow) {
    const ok = await confirmAsk({
      title: `Delete the feature view ${v.name}?`,
      body: "The table stays where it is. Any model serving from this view goes back to needing whole rows on every call.",
      actionLabel: "Delete view",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await deleteFn({ data: { accessToken: token, id: v.id } });
      if (!res.ok) return toast.error(res.error);
      if (res.detachedFrom.length) {
        toast.warning(`Deleted ${v.name}`, {
          description: `${res.detachedFrom.join(", ")} now needs whole rows again.`,
          duration: 10000,
        });
      } else toast.success(`Deleted ${v.name}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function runProbe(v: FeatureViewRow) {
    setBusy(true);
    setProbed(null);
    try {
      const key: Record<string, string> = {};
      for (const c of v.key_columns) key[c] = probe[c] ?? "";
      const res = await previewFn({ data: { accessToken: token, id: v.id, key } });
      if (!res.ok) return toast.error(res.error);
      if (!res.row) return toast.error("No row for that key");
      setProbed(res.row);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
          <div className="max-w-3xl space-y-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="h-4 w-4 text-primary" /> Feature views
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              A model trained on a table whose columns were built by SQL is normally scored by
              POSTing those same column names with values the caller computed itself. Nothing checks
              that its arithmetic matches the training set&apos;s, so the model gets numbers of the
              right shape and the wrong meaning, and answers confidently. A feature view removes
              that: name the table and the column that identifies a row, and serving takes a{" "}
              <strong>key</strong> and reads the features from the same table training read.
            </p>
          </div>
          <Button
            size="sm"
            disabled={tables.length === 0}
            onClick={() => {
              setProbed(null);
              setDraft({ ...empty });
            }}
            title={tables.length ? undefined : "No lakehouse tables to build a view over"}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> New view
          </Button>
        </CardContent>
      </Card>

      {draft ? (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="fv-name">Name</Label>
                <Input
                  id="fv-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="customer_features"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="fv-table">Table</Label>
                <select
                  id="fv-table"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={draft.schema_name ? `${draft.schema_name}.${draft.table_name}` : ""}
                  onChange={(e) => {
                    const [schema, ...rest] = e.target.value.split(".");
                    setDraft({
                      ...draft,
                      schema_name: schema ?? "",
                      table_name: rest.join(".") ?? "",
                      key_columns: [],
                      feature_columns: [],
                      timestamp_column: "",
                    });
                  }}
                >
                  <option value="">Pick a table…</option>
                  {tables.map((t) => (
                    <option key={`${t.schema}.${t.table}`} value={`${t.schema}.${t.table}`}>
                      {t.schema}.{t.table}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Usually a SQL model&apos;s output: its schedule keeps this fresh and its{" "}
                  <code className="font-mono">unique</code> test can assert the key.
                </p>
              </div>
            </div>

            {columnsOf.length > 0 ? (
              <>
                <ColumnPicker
                  label="Key — the column(s) that identify a row"
                  hint="What a caller sends instead of features."
                  columns={columnsOf}
                  chosen={draft.key_columns}
                  onToggle={(name) =>
                    setDraft({
                      ...draft,
                      key_columns: draft.key_columns.includes(name)
                        ? draft.key_columns.filter((c) => c !== name)
                        : [...draft.key_columns, name],
                      feature_columns: draft.feature_columns.filter((c) => c !== name),
                    })
                  }
                />
                <ColumnPicker
                  label="Features"
                  hint="Leave empty for every column that is not a key."
                  columns={columnsOf.filter((c) => !draft.key_columns.includes(c.name))}
                  chosen={draft.feature_columns}
                  onToggle={(name) =>
                    setDraft({
                      ...draft,
                      feature_columns: draft.feature_columns.includes(name)
                        ? draft.feature_columns.filter((c) => c !== name)
                        : [...draft.feature_columns, name],
                    })
                  }
                />
                <div className="space-y-1">
                  <Label htmlFor="fv-ts">Latest row wins, by</Label>
                  <select
                    id="fv-ts"
                    className="h-9 w-full max-w-sm rounded-md border bg-background px-2 text-sm"
                    value={draft.timestamp_column}
                    onChange={(e) => setDraft({ ...draft, timestamp_column: e.target.value })}
                  >
                    <option value="">
                      nothing — the key is unique, and a duplicate is an error
                    </option>
                    {columnsOf.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    Without one, a key matching two rows is refused rather than resolved. Picking
                    one of two arbitrarily is how a feature store starts lying.
                  </p>
                </div>
              </>
            ) : null}

            {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
            <div className="flex items-center gap-2">
              <Button onClick={() => void save()} disabled={busy || Boolean(problem)}>
                {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {draft.id ? "Save" : "Create"}
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : views.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No feature views yet. Models are scored by row until one exists.
        </p>
      ) : (
        <div className="space-y-3">
          {views.map((v) => (
            <Card key={v.id}>
              <CardContent className="space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">{v.name}</span>
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {v.schema_name}.{v.table_name}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      key {v.key_columns.join(" + ")}
                    </span>
                    {v.timestamp_column ? (
                      <span className="text-xs text-muted-foreground">
                        latest by {v.timestamp_column}
                      </span>
                    ) : null}
                    {(usedBy[v.id] ?? []).length ? (
                      <Badge className="bg-emerald-600 text-[10px] hover:bg-emerald-600">
                        serving {usedBy[v.id].join(", ")}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        not attached to a model
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setProbed(null);
                        setDraft({
                          id: v.id,
                          name: v.name,
                          description: v.description ?? "",
                          schema_name: v.schema_name,
                          table_name: v.table_name,
                          key_columns: v.key_columns,
                          feature_columns: v.feature_columns,
                          timestamp_column: v.timestamp_column ?? "",
                        });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={busy}
                      onClick={() => void remove(v)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {/* Look one key up, so an author can see exactly what serving
                    will see rather than trusting that it matches. */}
                <div className="flex flex-wrap items-end gap-2 border-t pt-2">
                  {v.key_columns.map((c) => (
                    <div key={c} className="space-y-1">
                      <Label className="text-[11px]">{c}</Label>
                      <Input
                        className="h-7 w-40 font-mono text-xs"
                        value={probe[c] ?? ""}
                        onChange={(e) => setProbe({ ...probe, [c]: e.target.value })}
                      />
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void runProbe(v)}
                  >
                    Look up
                  </Button>
                </div>
                {probed ? (
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <tbody>
                        {Object.entries(probed).map(([k, val]) => (
                          <tr key={k} className="border-t first:border-t-0">
                            <td className="px-2 py-1 font-medium">{k}</td>
                            <td className="px-2 py-1 font-mono">
                              {val === null ? "—" : String(val)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ColumnPicker({
  label,
  hint,
  columns,
  chosen,
  onToggle,
}: {
  label: string;
  hint: string;
  columns: { name: string; type: string }[];
  chosen: string[];
  onToggle: (name: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap gap-1.5 pt-1">
        {columns.map((c) => (
          <button
            key={c.name}
            type="button"
            onClick={() => onToggle(c.name)}
            className={cn(
              "rounded-md border px-2 py-1 font-mono text-[11px] transition",
              chosen.includes(c.name)
                ? "border-primary bg-primary/10 text-foreground"
                : "text-muted-foreground hover:border-primary/40",
            )}
            title={c.type}
          >
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Attach a model to a feature view, so it can be scored by key.
 *
 * Lives beside the serving controls because that is what it changes: with a
 * view attached, `/api/ml/predict` accepts `keys` and reads the features
 * itself; without one it keeps accepting whole rows, exactly as before.
 */
export function ModelFeatureView({
  token,
  modelId,
  featureViewId,
  shared,
  onChange,
}: {
  token: string;
  modelId: string;
  featureViewId: string | null;
  shared: boolean;
  onChange?: () => void;
}) {
  const listFn = useServerFn(featureViewsList);
  const setFn = useServerFn(mlModelSetFeatureView);
  const [views, setViews] = useState<FeatureViewRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState(featureViewId);

  useEffect(() => {
    void (async () => {
      const res = await listFn({ data: { accessToken: token } });
      if (res.ok) setViews(res.views);
    })();
  }, [listFn, token]);

  const view = views.find((v) => v.id === current) ?? null;

  async function pick(id: string | null) {
    setBusy(true);
    try {
      const res = await setFn({ data: { accessToken: token, modelId, featureViewId: id } });
      if (!res.ok) return toast.error(res.error);
      setCurrent(id);
      toast.success(id ? "Scored by key from now on" : "Back to scoring by row");
      onChange?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">Input</span>
            <Badge
              variant={view ? "default" : "secondary"}
              className={view ? "bg-emerald-600 hover:bg-emerald-600" : ""}
            >
              {view ? `by key from ${view.name}` : "whole rows"}
            </Badge>
          </div>
          {!shared ? (
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={current ?? ""}
              disabled={busy}
              onChange={(e) => void pick(e.target.value || null)}
            >
              <option value="">Caller sends whole rows</option>
              {views.map((v) => (
                <option key={v.id} value={v.id}>
                  by key from {v.name} ({v.key_columns.join(" + ")})
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {view ? (
            <>
              Callers may send <code className="font-mono">keys</code> like{" "}
              <code className="font-mono">
                {"{"}
                {view.key_columns.map((c) => `"${c}": …`).join(", ")}
                {"}"}
              </code>{" "}
              and the feature values are read from{" "}
              <code className="font-mono">
                {view.schema_name}.{view.table_name}
              </code>{" "}
              — the table this model trained on. They can still send whole rows instead.
            </>
          ) : (
            <>
              Every prediction needs the caller to supply the feature values, computed its own way.
              Attach a feature view and it can send a key instead, which is the only way to be sure
              serving and training agree on what a feature means.
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
