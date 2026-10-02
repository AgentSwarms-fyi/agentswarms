// A model card: one Markdown document that says what a version is, what it
// learned from, how well it does, what it relies on, what it warns about and
// how it is governed - assembled from the registry rows, never typed by hand,
// so it cannot drift from what actually shipped.
import { ML_METRIC_LABEL, ML_PRIMARY_METRIC, ML_TASK_LABEL, type MlTask } from "./types";
import type { MlModelRow, MlVersionRow } from "./access.server";

type SchemaEntry = {
  name: string;
  dtype: string;
  role: string;
  reason?: string;
  categories?: string[];
  min?: number | null;
  max?: number | null;
  median?: number | null;
};
type LeaderboardRow = {
  algorithm: string;
  metric: string;
  value: number | null;
  status: string;
  fit_seconds?: number;
  note?: string;
};
type Importance = { feature: string; importance: number };
type Cluster = { cluster: number; size: number; share: number; profile: Record<string, unknown> };

const num = (v: unknown, d = 4) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—";
const cell = (v: unknown) =>
  String(v ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
const table = (headers: string[], rows: unknown[][]) =>
  [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");

export function buildModelCard(args: {
  model: MlModelRow;
  version: MlVersionRow;
  origin: string;
  sharedWith?: number;
}): string {
  const { model, version } = args;
  const task = model.task as MlTask;
  const source = model.source as { schema: string; table: string };
  const metrics = (version.metrics ?? {}) as Record<string, unknown>;
  const schema = (version.feature_schema ?? []) as SchemaEntry[];
  const leaderboard = (version.leaderboard ?? []) as LeaderboardRow[];
  const importance = (version.feature_importance ?? []) as Importance[];
  const warnings = (version.warnings ?? []) as string[];
  const config = (version.config ?? {}) as {
    tuning?: string;
    max_rows?: number;
    time_budget_minutes?: number;
    prep?: Record<string, unknown>;
    external?: boolean;
  };
  const prep = (model.prep ?? config.prep ?? {}) as Record<string, unknown>;
  const primary = ML_PRIMARY_METRIC[task];
  const features = schema.filter((e) => e.role === "feature");
  const dropped = schema.filter((e) => e.role === "dropped");
  const clusters = Array.isArray(metrics.clusters) ? (metrics.clusters as Cluster[]) : [];
  const scalar = Object.entries(metrics).filter(
    ([k, v]) => (typeof v === "number" || v === null) && k !== "holdout_periods",
  ) as [string, number | null][];

  const what =
    task === "recommendation"
      ? `Recommends **${model.item_column}** to **${model.user_column}**`
      : task === "clustering"
        ? "Groups rows into clusters"
        : task === "anomaly"
          ? "Flags unusual rows"
          : `Predicts **${model.target_column}**`;

  const lines: string[] = [];
  lines.push(`# Model card: ${model.name} (v${version.version})`);
  lines.push("");
  lines.push(
    `${what} from \`${source.schema}.${source.table}\` · ${ML_TASK_LABEL[task]} · ${version.algorithm ?? "—"} · stage **${version.stage}**` +
      (config.external ? " · registered externally" : ""),
  );
  lines.push("");
  lines.push("## Intended use");
  lines.push("");
  lines.push(
    model.description?.trim() || "_No description was given. Rename the model to add one._",
  );
  lines.push("");
  lines.push("## Training data");
  lines.push("");
  lines.push(
    table(
      ["Property", "Value"],
      [
        ["Source", `\`${source.schema}.${source.table}\``],
        ["Rows used", version.training_rows ?? "—"],
        ["Rows in the table", version.training_total_rows ?? "—"],
        ["Sampled", version.training_sampled ? "yes (reservoir)" : "no"],
        ["Lakehouse snapshot", version.training_snapshot_id ?? "—"],
        ["Decision id", version.decision_id ?? "—"],
        ["Trained", version.trained_at ?? "—"],
        ...(model.time_column ? [["Time column", model.time_column]] : []),
        ...(model.horizon
          ? [["Horizon", `${model.horizon} periods (${model.aggregation ?? "sum"})`]]
          : []),
        ...(model.n_clusters ? [["Groups", model.n_clusters]] : []),
        ...(model.contamination
          ? [["Expected anomalies", `${(model.contamination * 100).toFixed(1)}%`]]
          : []),
      ],
    ),
  );
  lines.push("");
  lines.push("## Preparation");
  lines.push("");
  const prepRows: unknown[][] = [];
  if (typeof prep.where === "string" && prep.where)
    prepRows.push(["Row filter", `\`${prep.where}\``]);
  if (typeof prep.sql === "string" && prep.sql)
    prepRows.push(["Custom SELECT", "yes (see the model's preparation)"]);
  const impute = prep.impute as { numeric?: string; categorical?: string } | undefined;
  prepRows.push(["Missing numbers", impute?.numeric ?? "median"]);
  prepRows.push(["Missing categories", impute?.categorical ?? "most frequent"]);
  prepRows.push(["Numbers standardised", prep.scale === false ? "no" : "yes"]);
  prepRows.push(["Encoding", (prep.encoding as string) ?? "one-hot"]);
  if (prep.class_weight) prepRows.push(["Class weights", "balanced"]);
  if (typeof prep.target_clip === "number")
    prepRows.push(["Target winsorised", `${prep.target_clip * 100}% each side`]);
  prepRows.push(["Hyperparameter tuning", config.tuning ?? "none"]);
  prepRows.push([
    "Time budget",
    config.time_budget_minutes ? `${config.time_budget_minutes} min` : "—",
  ]);
  lines.push(table(["Setting", "Value"], prepRows));
  lines.push("");
  lines.push("## Features");
  lines.push("");
  lines.push(
    features.length
      ? table(
          ["Column", "Type", "Notes"],
          features.map((e) => [
            e.name,
            e.dtype,
            e.dtype === "categorical"
              ? `${e.categories?.length ?? 0} categories`
              : e.dtype === "numeric"
                ? `${num(e.min, 2)} – ${num(e.max, 2)}, median ${num(e.median, 2)}`
                : "",
          ]),
        )
      : "_No feature columns recorded._",
  );
  if (dropped.length) {
    lines.push("");
    lines.push("Dropped before training:");
    lines.push("");
    for (const e of dropped) lines.push(`- \`${e.name}\` — ${e.reason ?? "not selected"}`);
  }
  lines.push("");
  lines.push("## Evaluation");
  lines.push("");
  lines.push(
    scalar.length
      ? table(
          ["Metric", "Value"],
          [
            ...scalar
              .filter(([k]) => k === primary)
              .map(([k, v]) => [`**${ML_METRIC_LABEL[k] ?? k}** (primary)`, num(v)]),
            ...scalar
              .filter(([k]) => k !== primary)
              .map(([k, v]) => [ML_METRIC_LABEL[k] ?? k, num(v)]),
          ],
        )
      : "_No metrics recorded._",
  );
  if (leaderboard.length) {
    lines.push("");
    lines.push("Every candidate tried, on the same holdout:");
    lines.push("");
    lines.push(
      table(
        ["Candidate", "Metric", "Value", "Status", "Fit (s)"],
        leaderboard.map((r) => [
          r.algorithm,
          r.metric,
          num(r.value),
          r.status,
          r.fit_seconds ?? "—",
        ]),
      ),
    );
  }
  if (importance.length) {
    lines.push("");
    lines.push("## What the model relies on");
    lines.push("");
    lines.push(
      "Permutation importance on the holdout: how much the score drops when a column is shuffled.",
    );
    lines.push("");
    lines.push(
      table(
        ["Column", "Importance"],
        importance.slice(0, 15).map((r) => [r.feature, num(r.importance)]),
      ),
    );
  }
  if (clusters.length) {
    lines.push("");
    lines.push("## Groups");
    lines.push("");
    const keys = Array.from(new Set(clusters.flatMap((c) => Object.keys(c.profile)))).slice(0, 8);
    lines.push(
      table(
        ["Group", "Rows", "Share", ...keys],
        clusters.map((c) => [
          `Group ${c.cluster}`,
          c.size,
          `${(c.share * 100).toFixed(1)}%`,
          ...keys.map((k) =>
            typeof c.profile[k] === "number" ? num(c.profile[k], 2) : c.profile[k],
          ),
        ]),
      ),
    );
  }
  lines.push("");
  lines.push("## Limitations and warnings");
  lines.push("");
  if (warnings.length) for (const w of warnings) lines.push(`- ${w}`);
  else lines.push("- The trainer reported no warnings.");
  if (version.training_sampled)
    lines.push("- Trained on a sample of the table; rare patterns may be under-represented.");
  if (task === "forecast")
    lines.push("- Served from its training forecast; retrain to move the horizon.");
  if (task === "recommendation")
    lines.push("- A user without history receives the most popular items.");
  lines.push("");
  lines.push("## Governance");
  lines.push("");
  lines.push(
    table(
      ["Property", "Value"],
      [
        ["Model id", model.id],
        ["Version id", version.id],
        ["Owner-only actions", "train, promote, rename, delete, publish"],
        [
          "Shared with",
          typeof args.sharedWith === "number"
            ? `${args.sharedWith} grantee(s) via IAM`
            : "see Admin → IAM",
        ],
        ["Audited by trigger", "ml_model.create / update / delete"],
        [
          "Audited by the server",
          "ml.train.*, ml.version.promote, ml.predict_query (with a result digest), ml.api_key.*, ml.schedule.*",
        ],
        [
          "Artifact",
          version.artifact_uri
            ? `${version.artifact_uri} (sha256 ${version.artifact_sha256 ?? "—"})`
            : "—",
        ],
        ["Artifact bytes", version.artifact_bytes ?? "—"],
      ],
    ),
  );
  lines.push("");
  lines.push("## How to call it");
  lines.push("");
  lines.push("```bash");
  lines.push(`curl -X POST ${args.origin}/api/ml/predict -H "Authorization: Bearer mlk_…" \\`);
  lines.push(
    `  -H "Content-Type: application/json" -d '{"rows":[{${features
      .slice(0, 3)
      .map(
        (e) =>
          `"${e.name}": ${e.dtype === "numeric" ? num(e.median, 2) : `"${e.categories?.[0] ?? "…"}"`}`,
      )
      .join(", ")}}]}'`,
  );
  lines.push("```");
  lines.push("");
  lines.push(`_Generated ${new Date().toISOString()} from the AgentSwarms model registry._`);
  return lines.join("\n");
}
