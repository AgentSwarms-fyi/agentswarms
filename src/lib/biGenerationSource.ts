// Which data a "generate with AI" run reads, and where its SQL will run.
//
// Both generators — the whole-dashboard one and the paginated-report planner —
// used to read `ctx.datasets` and nothing else, so neither could be pointed at
// a warehouse or at the built-in lakehouse. That was a gap in two dialogs
// rather than in the platform: the manual chart builder has always offered
// warehouses, `runBiTurn` already accepts an `execute` override and a
// `dialect`, and `widgetFromBiTurn` already stores whichever source it is
// given. Only the dialogs never asked.
//
// The awkward part of pointing a generator at a warehouse is not the SQL, it
// is everything that silently assumes local tables: semantic entries and saved
// metrics are keyed to local dataset ids, and handing a warehouse table a
// local table's metric definitions would put a confident, wrong number on a
// dashboard. So this resolves ALL of it in one place rather than leaving each
// dialog to remember — and returns a reason when the chosen source cannot be
// generated from yet, because "the schema is still loading" and "this
// connection is broken" are different problems and a generator that starts
// anyway produces neither widgets nor an explanation.
import type { SavedMetric, SemanticEntry } from "@/lib/biAgent";
import type { BiWidgetSource } from "@/lib/biDashboards";
import type { DatasetMeta } from "@/lib/sqlEngine";
import { warehouseTablesAsDatasets } from "@/lib/warehouseClient";
import {
  WAREHOUSE_LABELS,
  type WarehouseConnectionSummary,
  type WarehouseTable,
} from "@/utils/warehouse/types";

/** The local engine, as the source picker names it. */
export const LOCAL_SOURCE_KEY = "local";

export type GenerationSource = {
  /** Tables the planner may propose widgets over. */
  datasets: DatasetMeta[];
  /** Semantic entries that actually describe those tables. */
  semantics: Map<string, SemanticEntry>;
  /** Saved metrics that actually belong to those tables. */
  metrics: SavedMetric[];
  /** Human SQL dialect for the prompt; undefined means the built-in engine. */
  dialect?: string;
  /** Where a generated widget's SQL will run, stored on the widget. */
  source: BiWidgetSource;
  /** The picked warehouse, or null when generating from local datasets. */
  warehouse: WarehouseConnectionSummary | null;
  /**
   * Why this source cannot be generated from yet, or null when it can.
   *
   * A generator that starts without a schema asks the model to write SQL
   * against columns it was never shown, which fails later and further away.
   */
  notReady: string | null;
};

/**
 * Resolve a source key into everything a generation run needs.
 *
 * Pure on purpose: the dialogs keep the React (the Select, `ensureSchema`, the
 * `execute` closure that needs `ctx.runSql`), and the decisions that can be
 * wrong live here where they can be tested.
 */
export function generationSource(args: {
  /** `"local"`, or a warehouse connection id. */
  sourceKey: string;
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
  warehouses: WarehouseConnectionSummary[];
  whTables: Record<string, WarehouseTable[] | "loading" | "error">;
  userId: string | null;
  /** Why the local list could not be READ, when that is why it is empty. */
  datasetsError?: string | null;
}): GenerationSource {
  const local: GenerationSource = {
    datasets: args.datasets,
    semantics: args.semantics,
    metrics: args.metrics,
    source: { kind: "local" },
    warehouse: null,
    // MEASURED with the table list rejected: the dialog said "upload data on
    // the Data & SQL page first" — advice to upload, over a read that failed.
    // An empty list with a reason says the reason.
    notReady: args.datasets.length
      ? null
      : args.datasetsError
        ? `Local datasets could not be read — ${args.datasetsError}`
        : "No local datasets — upload data on the Data & SQL page first.",
  };
  if (args.sourceKey === LOCAL_SOURCE_KEY) return local;

  const warehouse = args.warehouses.find((w) => w.id === args.sourceKey);
  if (!warehouse) {
    // The connection was deleted or deactivated while the dialog was open.
    // Falling back to local silently would generate a dashboard over the
    // wrong data and look like it worked — and offering the local TABLES
    // under a warehouse selection is the same lie one step earlier, so the
    // list is empty too.
    return {
      ...local,
      datasets: [],
      notReady: "That connection is no longer available — pick another source.",
    };
  }

  const label = WAREHOUSE_LABELS[warehouse.provider] ?? warehouse.provider;
  const base: Omit<GenerationSource, "datasets" | "notReady"> = {
    // A warehouse table has no semantic entry and no saved metric here: both
    // are keyed to LOCAL dataset ids, so passing them through would offer the
    // planner another table's definitions for this one's columns.
    semantics: new Map(),
    metrics: [],
    dialect: label,
    source: {
      kind: "warehouse",
      connection_id: warehouse.id,
      connection_name: warehouse.name,
      provider: warehouse.provider,
    },
    warehouse,
  };

  const tables = args.whTables[warehouse.id];
  if (tables === undefined || tables === "loading") {
    return { ...base, datasets: [], notReady: `Reading the ${label} schema…` };
  }
  if (tables === "error") {
    return {
      ...base,
      datasets: [],
      notReady: `Could not read the ${label} schema — open the connection and test it.`,
    };
  }
  const datasets = warehouseTablesAsDatasets(warehouse.id, tables, args.userId);
  return {
    ...base,
    datasets,
    notReady: datasets.length ? null : `${warehouse.name} has no tables to generate from.`,
  };
}

/** The options a source picker offers, local first. */
export function generationSourceOptions(
  warehouses: WarehouseConnectionSummary[],
): { key: string; label: string }[] {
  return [
    { key: LOCAL_SOURCE_KEY, label: "Local & prepared datasets" },
    ...warehouses.map((w) => ({
      key: w.id,
      label: `${w.name} — ${WAREHOUSE_LABELS[w.provider] ?? w.provider}`,
    })),
  ];
}
