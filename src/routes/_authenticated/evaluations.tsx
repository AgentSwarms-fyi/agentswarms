// /evaluations — batch evaluations for swarms.
//
// Datasets of test cases run headlessly against a swarm, each output scored by
// an evaluator (LLM judge or deterministic check), results stored as
// comparable runs. The BATCH is driven from this page: a small concurrent loop
// of runEvalCase server calls — cancel and resume are therefore natural (the
// server refuses cases for cancelled runs and skips already-scored ones).
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FlaskConical,
  Loader2,
  Plus,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { parseCsv } from "@/lib/sqlEngine";
import {
  compareRuns,
  DEFAULT_JUDGE_METRICS,
  DEFAULT_JUDGE_THRESHOLD,
  type EvalEvaluator,
  type EvalResultLite,
} from "@/lib/evalScoring";
import {
  addEvalCases,
  cancelEvalRun,
  createEvalDataset,
  runEvalCase,
  startEvalRun,
} from "@/utils/evals.functions";

export const Route = createFileRoute("/_authenticated/evaluations")({
  component: EvaluationsPage,
  head: () => ({ meta: [{ title: "Evaluations — AgentSwarms" }] }),
});

type Dataset = { id: string; name: string; description: string | null; created_at: string };
type Case = {
  id: string;
  dataset_id: string;
  sort: number;
  name: string;
  input: string;
  input_state: Record<string, string>;
  expected: string | null;
};
type Run = {
  id: string;
  swarm_id: string | null;
  swarm_name: string;
  dataset_id: string | null;
  dataset_name: string;
  label: string;
  evaluator: EvalEvaluator;
  status: "running" | "done" | "error" | "cancelled";
  case_count: number;
  done_count: number;
  pass_count: number;
  fail_count: number;
  error_count: number;
  avg_score: number | null;
  total_cost_usd: number;
  created_at: string;
};
type ResultRow = {
  id: string;
  case_id: string | null;
  case_name: string;
  case_input: string;
  case_expected: string | null;
  status: "pass" | "fail" | "error";
  score: number | null;
  judge: { metrics: Record<string, { score: number; reason?: string }>; summary?: string } | null;
  output: string;
  error: string | null;
  swarm_run_id: string | null;
  duration_ms: number;
  cost_usd: number;
};
type SwarmLite = { id: string; name: string };

const JUDGE_MODELS = [
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash (default)" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "openai/gpt-5-mini", label: "GPT-5 Mini" },
  { id: "openai/gpt-5.2", label: "GPT-5.2" },
];
const CONCURRENCY = 2;

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const fmtScore = (s: number | null) => (s === null ? "—" : s.toFixed(2));
const fmtUsd = (n: number) => (n > 0 ? `$${n.toFixed(4)}` : "$0");

function statusBadge(s: ResultRow["status"] | Run["status"]) {
  const styles: Record<string, string> = {
    pass: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    fail: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
    error: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    running: "bg-primary/15 text-primary",
    done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    cancelled: "bg-muted text-muted-foreground",
  };
  return <Badge className={cn("border-0 font-medium", styles[s])}>{s}</Badge>;
}

function EvaluationsPage() {
  const { user } = useAuth();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [swarms, setSwarms] = useState<SwarmLite[]>([]);
  const [sel, setSel] = useState<{ kind: "dataset" | "run"; id: string } | null>(null);

  const loadLists = useCallback(async () => {
    const [d, r, s] = await Promise.all([
      supabase
        .from("eval_datasets")
        .select("id, name, description, created_at")
        .order("created_at", { ascending: false }),
      supabase.from("eval_runs").select("*").order("created_at", { ascending: false }).limit(50),
      supabase
        .from("swarms")
        .select("id, name")
        .order("updated_at", { ascending: false })
        .limit(100),
    ]);
    setDatasets((d.data as Dataset[]) ?? []);
    setRuns((r.data as unknown as Run[]) ?? []);
    setSwarms((s.data as SwarmLite[]) ?? []);
  }, []);
  useEffect(() => {
    if (user?.id) void loadLists();
  }, [user?.id, loadLists]);

  const selDataset = sel?.kind === "dataset" ? datasets.find((d) => d.id === sel.id) : undefined;
  const selRun = sel?.kind === "run" ? runs.find((r) => r.id === sel.id) : undefined;

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const newDataset = async () => {
    if (!newName.trim()) return toast.error("Give the dataset a name.");
    setCreating(true);
    try {
      const row = (await createEvalDataset({
        data: { name: newName.trim(), description: newDesc.trim() || undefined },
      })) as Dataset;
      await loadLists();
      setSel({ kind: "dataset", id: row.id });
      setNewOpen(false);
      setNewName("");
      setNewDesc("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-[1500px] px-4 py-6 md:px-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">Experiment</p>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <FlaskConical className="h-6 w-6 text-primary" /> Evaluations
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Run a dataset of test cases through a swarm and score every output — an LLM judge or a
            deterministic check. Compare runs to catch regressions before your users do.
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> New dataset
        </Button>
      </div>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New eval dataset</DialogTitle>
            <DialogDescription>
              A named collection of test cases to run swarms against.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ds-name">Name</Label>
              <Input
                id="ds-name"
                placeholder="e.g. Support answers · golden set"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void newDataset()}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ds-desc">Description (optional)</Label>
              <Input id="ds-desc" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void newDataset()} disabled={creating}>
              {creating && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-5">
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Datasets
            </h2>
            <div className="space-y-1.5">
              {datasets.length === 0 && (
                <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                  No datasets yet — create one and add test cases.
                </p>
              )}
              {datasets.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setSel({ kind: "dataset", id: d.id })}
                  className={cn(
                    "w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                    selDataset?.id === d.id && "border-primary/50 bg-primary/5",
                  )}
                >
                  <span className="font-medium">{d.name}</span>
                </button>
              ))}
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Runs
            </h2>
            <div className="space-y-1.5">
              {runs.length === 0 && (
                <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                  Launch a run from a dataset.
                </p>
              )}
              {runs.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSel({ kind: "run", id: r.id })}
                  className={cn(
                    "w-full rounded-lg border px-3 py-2 text-left transition-colors hover:bg-accent",
                    selRun?.id === r.id && "border-primary/50 bg-primary/5",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{r.label || r.swarm_name}</span>
                    {statusBadge(r.status)}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {r.dataset_name} · {r.done_count}/{r.case_count} ·{" "}
                    {pct(r.pass_count, r.done_count)}% pass
                  </p>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <div className="min-w-0">
          {selDataset && (
            <DatasetPanel
              dataset={selDataset}
              swarms={swarms}
              onChanged={loadLists}
              onRunStarted={(id) => {
                void loadLists();
                setSel({ kind: "run", id });
              }}
            />
          )}
          {selRun && <RunPanel run={selRun} runs={runs} onChanged={loadLists} />}
          {!selDataset && !selRun && (
            <div className="flex min-h-[300px] items-center justify-center rounded-xl border border-dashed">
              <p className="text-sm text-muted-foreground">
                Select a dataset to edit cases, or a run to inspect results.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

// ── Dataset panel ────────────────────────────────────────────────────────────

function DatasetPanel({
  dataset,
  swarms,
  onChanged,
  onRunStarted,
}: {
  dataset: Dataset;
  swarms: SwarmLite[];
  onChanged: () => void;
  onRunStarted: (runId: string) => void;
}) {
  const [cases, setCases] = useState<Case[]>([]);
  const [draft, setDraft] = useState({ name: "", input: "", expected: "" });
  const [runOpen, setRunOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("eval_cases")
      .select("*")
      .eq("dataset_id", dataset.id)
      .order("sort");
    setCases((data as unknown as Case[]) ?? []);
  }, [dataset.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const addCase = async () => {
    if (!draft.input.trim()) return toast.error("The case needs an input.");
    try {
      await addEvalCases({
        data: {
          datasetId: dataset.id,
          cases: [
            {
              name: draft.name.trim(),
              input: draft.input,
              input_state: {},
              expected: draft.expected.trim() || null,
            },
          ],
        },
      });
      setDraft({ name: "", input: "", expected: "" });
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const importCsv = async (file: File) => {
    try {
      const parsed = await parseCsv(file);
      if (parsed.rows.length === 0) return toast.error("The CSV has no rows.");
      const reserved = new Set(["name", "input", "expected"]);
      const rows = parsed.rows.slice(0, 500).map((r) => {
        const state: Record<string, string> = {};
        for (const [k, v] of Object.entries(r)) {
          if (!reserved.has(k.toLowerCase()) && v != null && String(v).trim() !== "")
            state[k] = String(v);
        }
        const get = (key: string) => {
          const hit = Object.keys(r).find((k) => k.toLowerCase() === key);
          return hit ? String(r[hit] ?? "") : "";
        };
        return {
          name: get("name"),
          input: get("input"),
          input_state: state,
          expected: get("expected").trim() || null,
        };
      });
      await addEvalCases({ data: { datasetId: dataset.id, cases: rows } });
      toast.success(`Imported ${rows.length} case${rows.length === 1 ? "" : "s"}`);
      await load();
    } catch (e) {
      toast.error(`Import failed: ${(e as Error).message}`);
    }
  };

  const deleteCase = async (id: string) => {
    await supabase.from("eval_cases").delete().eq("id", id);
    await load();
  };

  const deleteDataset = async () => {
    if (
      !window.confirm(`Delete dataset "${dataset.name}" and its cases? Past run results are kept.`)
    )
      return;
    await supabase.from("eval_datasets").delete().eq("id", dataset.id);
    onChanged();
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{dataset.name}</h2>
          <p className="text-xs text-muted-foreground">
            {cases.length} case{cases.length === 1 ? "" : "s"} · columns beyond name / input /
            expected become typed start-form values
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importCsv(f);
              e.currentTarget.value = "";
            }}
          />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload className="mr-1.5 h-3.5 w-3.5" /> Import CSV
          </Button>
          <Button variant="outline" size="sm" onClick={deleteDataset} aria-label="Delete dataset">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" onClick={() => setRunOpen(true)} disabled={cases.length === 0}>
            <FlaskConical className="mr-1.5 h-3.5 w-3.5" /> New eval run
          </Button>
        </div>
      </div>

      <Card className="divide-y overflow-hidden">
        {cases.map((c, i) => (
          <div key={c.id} className="flex items-start gap-3 p-3">
            <span className="mt-0.5 w-6 shrink-0 text-right text-xs text-muted-foreground">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{c.name || `Case ${i + 1}`}</p>
              <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                {c.input}
              </p>
              {c.expected && (
                <p className="mt-1 line-clamp-1 text-xs">
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">
                    expected:
                  </span>{" "}
                  <span className="text-muted-foreground">{c.expected}</span>
                </p>
              )}
              {Object.keys(c.input_state ?? {}).length > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  form:{" "}
                  {Object.entries(c.input_state)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(" · ")}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              aria-label={`Delete case ${c.name || i + 1}`}
              onClick={() => void deleteCase(c.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <div className="space-y-2 bg-muted/40 p-3">
          <div className="grid gap-2 md:grid-cols-2">
            <Input
              placeholder="Case name (optional)"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Input
              placeholder="Expected answer / reference (optional)"
              value={draft.expected}
              onChange={(e) => setDraft({ ...draft, expected: e.target.value })}
            />
          </div>
          <Textarea
            placeholder="Input — what gets sent to the swarm"
            rows={2}
            value={draft.input}
            onChange={(e) => setDraft({ ...draft, input: e.target.value })}
          />
          <Button size="sm" variant="outline" onClick={() => void addCase()}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add case
          </Button>
        </div>
      </Card>

      <NewRunDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        dataset={dataset}
        swarms={swarms}
        onStarted={onRunStarted}
      />
    </section>
  );
}

// ── New run dialog ───────────────────────────────────────────────────────────

function NewRunDialog({
  open,
  onOpenChange,
  dataset,
  swarms,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  dataset: Dataset;
  swarms: SwarmLite[];
  onStarted: (runId: string) => void;
}) {
  const [swarmId, setSwarmId] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<EvalEvaluator["kind"]>("llm_judge");
  const [threshold, setThreshold] = useState(DEFAULT_JUDGE_THRESHOLD);
  const [judgeModel, setJudgeModel] = useState(JUDGE_MODELS[0].id);
  const [rubric, setRubric] = useState("");
  const [containsValue, setContainsValue] = useState("");
  const [regexPattern, setRegexPattern] = useState("");
  const [rejectApprovals, setRejectApprovals] = useState(true);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (!swarmId) return toast.error("Pick a swarm to evaluate.");
    const evaluator: EvalEvaluator =
      kind === "llm_judge"
        ? {
            kind,
            metrics: DEFAULT_JUDGE_METRICS,
            threshold,
            model: judgeModel,
            rubric: rubric.trim() || undefined,
          }
        : kind === "contains"
          ? { kind, value: containsValue.trim() || undefined }
          : kind === "exact"
            ? { kind }
            : { kind, pattern: regexPattern };
    setBusy(true);
    try {
      const run = (await startEvalRun({
        data: { swarmId, datasetId: dataset.id, label, evaluator, rejectApprovals },
      })) as unknown as Run;
      onOpenChange(false);
      onStarted(run.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New eval run · {dataset.name}</DialogTitle>
          <DialogDescription>
            Every case runs headlessly through the swarm, then its output is scored.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Swarm</Label>
            <Select value={swarmId} onValueChange={setSwarmId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a swarm…" />
              </SelectTrigger>
              <SelectContent>
                {swarms.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {swarms.length === 0 && (
              <p className="text-xs text-muted-foreground">
                You have no saved swarms yet — build one on the canvas first.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eval-label">Label (optional)</Label>
            <Input
              id="eval-label"
              placeholder="e.g. after prompt tweak v2"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Evaluator</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as EvalEvaluator["kind"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="llm_judge">
                  LLM judge — correctness, completeness, clarity
                </SelectItem>
                <SelectItem value="contains">Contains expected text</SelectItem>
                <SelectItem value="exact">Exactly equals expected</SelectItem>
                <SelectItem value="regex">Matches a regex</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === "llm_judge" && (
            <>
              <div className="space-y-1.5">
                <Label>Judge model</Label>
                <Select value={judgeModel} onValueChange={setJudgeModel}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {JUDGE_MODELS.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>
                  Pass threshold: <span className="font-mono">{threshold.toFixed(2)}</span>
                </Label>
                <Slider
                  value={[threshold]}
                  min={0}
                  max={1}
                  step={0.05}
                  onValueChange={(v) => setThreshold(v[0] ?? DEFAULT_JUDGE_THRESHOLD)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="eval-rubric">Extra rubric (optional)</Label>
                <Textarea
                  id="eval-rubric"
                  rows={2}
                  placeholder="Domain-specific instructions for the judge…"
                  value={rubric}
                  onChange={(e) => setRubric(e.target.value)}
                />
              </div>
            </>
          )}
          {kind === "contains" && (
            <div className="space-y-1.5">
              <Label htmlFor="eval-contains">
                Fallback text (used when a case has no expected)
              </Label>
              <Input
                id="eval-contains"
                value={containsValue}
                onChange={(e) => setContainsValue(e.target.value)}
              />
            </div>
          )}
          {kind === "regex" && (
            <div className="space-y-1.5">
              <Label htmlFor="eval-regex">Pattern</Label>
              <Input
                id="eval-regex"
                placeholder="e.g. ^\\s*APPROVED"
                value={regexPattern}
                onChange={(e) => setRegexPattern(e.target.value)}
              />
            </div>
          )}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Auto-reject approval nodes</p>
              <p className="text-xs text-muted-foreground">
                Keeps batch runs side-effect-safe; swarms that require approval will error instead.
              </p>
            </div>
            <Switch checked={rejectApprovals} onCheckedChange={setRejectApprovals} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void start()} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Start run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Run panel (driver + results + compare) ───────────────────────────────────

function RunPanel({ run, runs, onChanged }: { run: Run; runs: Run[]; onChanged: () => void }) {
  const [results, setResults] = useState<ResultRow[]>([]);
  const [driving, setDriving] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string>("");
  const [compareResults, setCompareResults] = useState<EvalResultLite[] | null>(null);
  const stopRef = useRef(false);
  // Reentrancy guard. `driving` is React state and updates asynchronously, so
  // two calls in the same tick both saw `false` and started duplicate drivers
  // (which then raced on the same case).
  const drivingRef = useRef(false);

  const loadResults = useCallback(async () => {
    const { data } = await supabase
      .from("eval_results")
      .select("*")
      .eq("eval_run_id", run.id)
      .order("created_at");
    setResults((data as unknown as ResultRow[]) ?? []);
  }, [run.id]);
  useEffect(() => {
    void loadResults();
  }, [loadResults]);

  // The batch driver: pending cases through runEvalCase, CONCURRENCY at a time.
  const drive = useCallback(async () => {
    if (drivingRef.current) return;
    drivingRef.current = true;
    setDriving(true);
    stopRef.current = false;
    try {
      const { data: allCases } = await supabase
        .from("eval_cases")
        .select("id")
        .eq("dataset_id", run.dataset_id ?? "")
        .order("sort");
      const { data: doneRows } = await supabase
        .from("eval_results")
        .select("case_id")
        .eq("eval_run_id", run.id);
      const scored = new Set((doneRows ?? []).map((r) => r.case_id));
      const queue = ((allCases ?? []) as { id: string }[]).filter((c) => !scored.has(c.id));
      let idx = 0;
      const worker = async () => {
        for (;;) {
          if (stopRef.current) return;
          const mine = idx++;
          if (mine >= queue.length) return;
          try {
            await runEvalCase({ data: { runId: run.id, caseId: queue[mine].id } });
          } catch (e) {
            toast.error(`Case failed to execute: ${(e as Error).message}`);
          }
          await loadResults();
          onChanged();
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } finally {
      drivingRef.current = false;
      setDriving(false);
      await loadResults();
      onChanged();
    }
  }, [run.id, run.dataset_id, loadResults, onChanged]);

  // Fresh running run with nothing scored → start driving automatically.
  useEffect(() => {
    if (run.status === "running" && run.done_count === 0 && !drivingRef.current) void drive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  const cancel = async () => {
    stopRef.current = true;
    await cancelEvalRun({ data: { runId: run.id } });
    onChanged();
  };

  const loadCompare = useCallback(async (otherId: string) => {
    setCompareId(otherId);
    if (!otherId) return setCompareResults(null);
    const { data } = await supabase
      .from("eval_results")
      .select("case_id, case_name, case_input, status, score")
      .eq("eval_run_id", otherId);
    setCompareResults((data as unknown as EvalResultLite[]) ?? []);
  }, []);

  const deltas = useMemo(() => {
    if (!compareResults) return null;
    // Baseline = the OTHER (usually earlier) run; candidate = this run.
    return compareRuns(compareResults, results as unknown as EvalResultLite[]);
  }, [compareResults, results]);

  // Same dataset AND same evaluator kind. Comparing a `contains` run (scores
  // are 0 or 1) against a judge run (continuous 0-1) would produce score
  // deltas that mean nothing — the scales are different, not the swarm.
  const comparable = runs.filter(
    (r) =>
      r.id !== run.id &&
      r.dataset_id === run.dataset_id &&
      r.evaluator?.kind === run.evaluator?.kind,
  );
  const pending = run.case_count - run.done_count;
  const judge = run.evaluator.kind === "llm_judge" ? run.evaluator : null;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            {run.label || `${run.swarm_name} · ${run.dataset_name}`}
          </h2>
          <p className="text-xs text-muted-foreground">
            {run.swarm_name} × {run.dataset_name} · evaluator: {run.evaluator.kind}
            {judge ? ` (threshold ${judge.threshold})` : ""} ·{" "}
            {new Date(run.created_at).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {run.status === "running" && pending > 0 && !driving && (
            <Button size="sm" onClick={() => void drive()}>
              Run remaining {pending}
            </Button>
          )}
          {run.status === "running" && (
            <Button size="sm" variant="outline" onClick={() => void cancel()}>
              <Square className="mr-1.5 h-3.5 w-3.5" /> Cancel
            </Button>
          )}
          {statusBadge(run.status)}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Progress</p>
          <p className="mt-1 text-xl font-semibold">
            {run.done_count}/{run.case_count}
            {driving && <Loader2 className="ml-2 inline h-4 w-4 animate-spin text-primary" />}
          </p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Pass rate</p>
          <p className="mt-1 text-xl font-semibold">
            {pct(run.pass_count, run.done_count)}%
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {run.pass_count} pass · {run.fail_count} fail · {run.error_count} error
            </span>
          </p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Avg score</p>
          <p className="mt-1 text-xl font-semibold">{fmtScore(run.avg_score)}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Model spend</p>
          <p className="mt-1 text-xl font-semibold">{fmtUsd(Number(run.total_cost_usd))}</p>
        </Card>
      </div>

      {comparable.length > 0 && (
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Compare against</Label>
          <Select value={compareId} onValueChange={(v) => void loadCompare(v)}>
            <SelectTrigger className="h-8 w-[320px]">
              <SelectValue placeholder="Pick a baseline run on this dataset…" />
            </SelectTrigger>
            <SelectContent>
              {comparable.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {(r.label || r.swarm_name) + " · " + new Date(r.created_at).toLocaleString()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {deltas && (
        <Card className="overflow-hidden">
          <div className="border-b bg-muted/40 px-3 py-2 text-xs font-medium">
            vs baseline: {deltas.filter((d) => d.change === "improved").length} improved ·{" "}
            {deltas.filter((d) => d.change === "regressed").length} regressed ·{" "}
            {deltas.filter((d) => d.change === "same").length} unchanged
          </div>
          <div className="divide-y">
            {deltas.map((d) => (
              <div key={d.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span
                  className={cn(
                    "w-20 shrink-0 text-xs font-semibold",
                    d.change === "improved" && "text-emerald-600 dark:text-emerald-400",
                    d.change === "regressed" && "text-rose-600 dark:text-rose-400",
                    (d.change === "same" || d.change.startsWith("only")) && "text-muted-foreground",
                  )}
                >
                  {d.change}
                </span>
                <span className="min-w-0 flex-1 truncate">{d.case_name || d.case_input}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {d.a ? `${d.a.status} ${fmtScore(d.a.score)}` : "—"} →{" "}
                  {d.b ? `${d.b.status} ${fmtScore(d.b.score)}` : "—"}
                  {d.scoreDelta !== null && (
                    <span
                      className={cn(
                        "ml-1",
                        d.scoreDelta > 0 && "text-emerald-600 dark:text-emerald-400",
                        d.scoreDelta < 0 && "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      ({d.scoreDelta > 0 ? "+" : ""}
                      {d.scoreDelta.toFixed(2)})
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="divide-y overflow-hidden">
        {results.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            {run.status === "running" ? "Executing cases…" : "No results."}
          </p>
        )}
        {results.map((r) => (
          <div key={r.id}>
            <button
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent/50"
              onClick={() => setOpen(open === r.id ? null : r.id)}
              aria-expanded={open === r.id}
            >
              {open === r.id ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">{r.case_name || r.case_input}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {fmtScore(r.score === null ? null : Number(r.score))}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {(r.duration_ms / 1000).toFixed(1)}s · {fmtUsd(Number(r.cost_usd))}
              </span>
              {statusBadge(r.status)}
            </button>
            {open === r.id && (
              <div className="space-y-3 border-t bg-muted/30 px-4 py-3 text-sm">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Input
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{r.case_input}</p>
                </div>
                {r.case_expected && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Expected
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">{r.case_expected}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Output
                  </p>
                  <p className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap">
                    {r.output || <span className="text-muted-foreground">(empty)</span>}
                  </p>
                </div>
                {r.error && (
                  <div role="alert">
                    <p className="text-xs font-semibold uppercase tracking-wider text-amber-600">
                      Error
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-amber-700 dark:text-amber-400">
                      {r.error}
                    </p>
                  </div>
                )}
                {r.judge && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Judge scorecard
                    </p>
                    <div className="mt-1 space-y-1">
                      {Object.entries(r.judge.metrics).map(([id, m]) => (
                        <p key={id} className="text-xs">
                          <span className="font-mono font-medium">{id}</span>{" "}
                          <span className="font-mono">{m.score.toFixed(2)}</span>
                          {m.reason && <span className="text-muted-foreground"> — {m.reason}</span>}
                        </p>
                      ))}
                      {r.judge.summary && (
                        <p className="text-xs italic text-muted-foreground">{r.judge.summary}</p>
                      )}
                    </div>
                  </div>
                )}
                {r.swarm_run_id && (
                  <button
                    className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                    onClick={() => {
                      void navigator.clipboard.writeText(r.swarm_run_id!);
                      toast.success("Trace run id copied — find it under Swarm Traces");
                    }}
                  >
                    <Copy className="h-3 w-3" /> Copy trace id
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </Card>
    </section>
  );
}
