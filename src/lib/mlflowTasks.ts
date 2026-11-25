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
