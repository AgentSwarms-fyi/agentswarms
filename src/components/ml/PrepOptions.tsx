// Data preparation and tuning controls, shared by the wizard and the retrain
// dialog. Everything here is declarative and pinned into the version, so what
// a model learned from can be stated later without re-reading the table.
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ML_TUNING_LABEL,
  ML_TUNINGS,
  type MlPrepConfig,
  type MlTask,
  type MlTuning,
} from "@/utils/ml/types";

export type PrepCheck = { ok: boolean; rows?: number; error?: string };

export function PrepOptions({
  task,
  value,
  onChange,
  tuning,
  onTuningChange,
  onCheck,
  compact,
}: {
  task: MlTask;
  value: MlPrepConfig;
  onChange: (next: MlPrepConfig) => void;
  tuning: MlTuning;
  onTuningChange: (next: MlTuning) => void;
  /** Runs the filter or SQL against the table and reports how many rows match. */
  onCheck?: (prep: MlPrepConfig) => Promise<PrepCheck>;
  compact?: boolean;
}) {
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<PrepCheck | null>(null);
  const set = (patch: Partial<MlPrepConfig>) => {
    setCheck(null);
    onChange({ ...value, ...patch });
  };
  const useSql = typeof value.sql === "string";
  const impute = value.impute ?? {};

  const runCheck = async () => {
    if (!onCheck) return;
    setChecking(true);
    try {
      setCheck(await onCheck(value));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className={cn("space-y-4", compact ? "" : "rounded-lg border bg-muted/30 p-4")}>
      <div>
        <p className="text-sm font-medium">Prepare the data</p>
        <p className="text-xs text-muted-foreground">
          Optional. Narrow the rows, decide how gaps are filled, and how columns are encoded. The
          choices are recorded on the version.
        </p>
      </div>

      {!useSql ? (
        <div className="space-y-1">
          <Label className="text-xs">Row filter (SQL WHERE)</Label>
          <div className="flex gap-2">
            <Input
              className="font-mono text-xs"
              placeholder="region = 'EU' AND net_usd > 0"
              value={value.where ?? ""}
              onChange={(e) => set({ where: e.target.value || undefined })}
            />
            {onCheck ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={checking}
                onClick={() => void runCheck()}
              >
                {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Check"}
              </Button>
            ) : null}
          </div>
          <CheckLine check={check} />
        </div>
      ) : (
        <div className="space-y-1">
          <Label className="text-xs">Custom SELECT (advanced)</Label>
          <Textarea
            className="font-mono text-xs"
            rows={4}
            placeholder="SELECT *, net_usd / NULLIF(payment_rows, 0) AS avg_payment FROM analytics.revenue_facts WHERE status = 'paid'"
            value={value.sql ?? ""}
            onChange={(e) => set({ sql: e.target.value })}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Any single SELECT over tables you can read. It must return the target column; joins
              and derived columns are fine.
            </p>
            {onCheck ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={checking}
                onClick={() => void runCheck()}
              >
                {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Check"}
              </Button>
            ) : null}
          </div>
          <CheckLine check={check} />
        </div>
      )}
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={useSql}
          onChange={(e) =>
            set(e.target.checked ? { sql: value.sql ?? "", where: undefined } : { sql: undefined })
          }
        />
        Use a custom SELECT instead of a filter
      </label>

      {task !== "recommendation" ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Missing numbers</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={impute.numeric ?? "median"}
                onChange={(e) =>
                  set({
                    impute: {
                      ...impute,
                      numeric: e.target.value as "median" | "mean" | "constant",
                    },
                  })
                }
              >
                <option value="median">fill with the median</option>
                <option value="mean">fill with the mean</option>
                <option value="constant">fill with 0</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Missing categories</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={impute.categorical ?? "most_frequent"}
                onChange={(e) =>
                  set({
                    impute: {
                      ...impute,
                      categorical: e.target.value as "most_frequent" | "constant",
                    },
                  })
                }
              >
                <option value="most_frequent">fill with the most frequent</option>
                <option value="constant">treat as its own category</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Categories</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={value.encoding ?? "onehot"}
                onChange={(e) => set({ encoding: e.target.value as "onehot" | "ordinal" })}
              >
                <option value="onehot">one-hot (one column per value)</option>
                <option value="ordinal">ordinal (one integer column)</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Numbers</Label>
              <label className="flex h-9 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={value.scale !== false}
                  onChange={(e) => set({ scale: e.target.checked })}
                />
                standardise (zero mean, unit variance)
              </label>
            </div>
          </div>
        </>
      ) : null}

      {task === "classification" ? (
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.class_weight === "balanced"}
            onChange={(e) => set({ class_weight: e.target.checked ? "balanced" : "none" })}
          />
          Balance classes
          <span className="text-xs text-muted-foreground">
            — weight rare classes up so a 95/5 split does not train a model that always says 95.
          </span>
        </label>
      ) : null}
      {task === "regression" ? (
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Array.isArray(value.target_clip)}
              onChange={(e) => set({ target_clip: e.target.checked ? [1, 99] : null })}
            />
            Clip target outliers
            <span className="text-xs text-muted-foreground">
              — winsorise the target to a percentile range for training.
            </span>
          </label>
          {Array.isArray(value.target_clip) ? (
            <div className="flex items-center gap-2 text-xs">
              <Input
                type="number"
                min={0}
                max={50}
                className="h-8 w-20"
                value={value.target_clip[0]}
                onChange={(e) =>
                  set({ target_clip: [Number(e.target.value), value.target_clip![1]] })
                }
              />
              <span>to</span>
              <Input
                type="number"
                min={50}
                max={100}
                className="h-8 w-20"
                value={value.target_clip[1]}
                onChange={(e) =>
                  set({ target_clip: [value.target_clip![0], Number(e.target.value)] })
                }
              />
              <span className="text-muted-foreground">percentile</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {task === "classification" || task === "regression" ? (
        <div className="space-y-2">
          <Label className="text-xs">Hyperparameter tuning</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            {ML_TUNINGS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTuningChange(t)}
                className={cn(
                  "rounded-lg border p-2.5 text-left text-xs transition-colors",
                  tuning === t ? "border-primary bg-background" : "hover:border-primary/40",
                )}
              >
                <p className="font-medium">{ML_TUNING_LABEL[t]}</p>
                <p className="mt-0.5 text-muted-foreground">
                  {t === "none"
                    ? "Each algorithm with its defaults."
                    : t === "quick"
                      ? "Six random trials, 3-fold, on the two best candidates."
                      : "Twenty random trials, 5-fold, on the two best candidates."}
                </p>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Tuning runs only while at least 40% of the time budget remains and keeps the tuned model
            only when it beats the untuned one on the holdout.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function CheckLine({ check }: { check: PrepCheck | null }) {
  if (!check) return null;
  return check.ok ? (
    <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
      {check.rows?.toLocaleString()} rows match
    </p>
  ) : (
    <p className="text-[11px] text-red-600 dark:text-red-400">{check.error}</p>
  );
}
