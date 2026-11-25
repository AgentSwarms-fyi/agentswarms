// Which models can be exported to, or imported from, MLflow (R533): the tasks
// that score rows. Forecasts and recommendations answer from what they
// stored. Its own module so the page can ask without the YAML parser that
// src/lib/mlflowFormat.ts brings.
export const MLFLOW_TASKS = ["classification", "regression", "clustering", "anomaly"] as const;

/**
 * The flavor a version was imported from, or null when it was trained here.
 * An imported version has no training rows, so the page says where it came
 * from instead of "trained on 0 rows".
 */
export function importedFlavor(config: unknown): string | null {
  const imp = (config as { import?: { format?: unknown; flavor?: unknown } } | null)?.import;
  if (!imp || imp.format !== "mlflow") return null;
  return typeof imp.flavor === "string" && imp.flavor ? imp.flavor : "MLflow";
}

/**
 * For a version imported from a skops file (R536): the types admitted to
 * open it beyond skops' own (often none), or null when it was not a skops
 * import or its job has not finished.
 */
export function importedSkops(config: unknown): string[] | null {
  const imp = (
    config as {
      import?: { format?: unknown; serialization?: unknown; skops_trusted?: unknown };
    } | null
  )?.import;
  if (!imp || imp.format !== "mlflow" || imp.serialization !== "skops") return null;
  if (!Array.isArray(imp.skops_trusted)) return null;
  return imp.skops_trusted.filter((t): t is string => typeof t === "string");
}
