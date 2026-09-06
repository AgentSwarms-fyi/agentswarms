// What the editor offers when a node is added, and what a new node starts
// as. Pure, so a test can hold the two together: every type the menus offer
// must start as a node OF THAT TYPE. The editor once kept this beside the
// canvas, where the source switch's default answered "Custom Python" for any
// source type it did not name - and the lakehouse, platform-dataset and
// streamed-rows sources were named in a later switch it never reached, so
// adding "Lakehouse table" as a source produced a Python node with the
// lakehouse's label. Nobody could see a schema picker on it because it was
// not a lakehouse node.
import type {
  EtlNode,
  EtlSourceConfig,
  EtlTargetConfig,
  EtlTransformConfig,
} from "@/utils/etl/codegen";
import { defaultStreamConfig } from "@/utils/etl/streaming";

export const SOURCE_TYPES = [
  { type: "catalog_asset", label: "Data Catalog asset" },
  { type: "object_storage", label: "Object storage files" },
  { type: "database", label: "Database / warehouse" },
  { type: "http_api", label: "HTTP API (JSON)" },
  { type: "platform_dataset", label: "Platform dataset" },
  { type: "lakehouse", label: "Lakehouse table" },
  { type: "ingest", label: "Streamed rows (push)" },
  { type: "kafka", label: "Kafka / Redpanda topic" },
  { type: "kinesis", label: "Amazon Kinesis stream" },
  { type: "pubsub", label: "Google Pub/Sub subscription" },
  { type: "python", label: "Custom Python" },
] as const;

export const TRANSFORM_TYPES = [
  { type: "filter", label: "Filter rows" },
  { type: "select", label: "Select columns" },
  { type: "rename", label: "Rename columns" },
  { type: "derive", label: "Derive column" },
  { type: "join", label: "Join" },
  { type: "union", label: "Union" },
  { type: "aggregate", label: "Aggregate" },
  { type: "sort", label: "Sort" },
  { type: "dedupe", label: "Deduplicate" },
  { type: "fill_nulls", label: "Fill nulls" },
  { type: "drop_nulls", label: "Drop nulls" },
  { type: "limit", label: "Limit rows" },
  { type: "quality_gate", label: "Quality gate" },
  { type: "sql", label: "SQL" },
  { type: "python", label: "Custom Python" },
] as const;

export const TARGET_TYPES = [
  { type: "object_storage", label: "Object storage" },
  { type: "database", label: "Database / warehouse" },
  { type: "lakehouse", label: "Lakehouse table" },
  { type: "http_api", label: "HTTP API (reverse ETL)" },
] as const;

/** The menu label for a node's type, for the canvas card and the panel badge. */
export function typeLabel(node: EtlNode): string {
  const t = (node.config as { type: string }).type;
  const own = (
    node.kind === "source" ? SOURCE_TYPES : node.kind === "target" ? TARGET_TYPES : TRANSFORM_TYPES
  ) as readonly { type: string; label: string }[];
  const all = [...SOURCE_TYPES, ...TRANSFORM_TYPES, ...TARGET_TYPES] as readonly {
    type: string;
    label: string;
  }[];
  return (own.find((x) => x.type === t) ?? all.find((x) => x.type === t))?.label ?? t;
}

/**
 * The config a freshly added node starts with. Names are empty where a
 * picker fills them; only what the author must type (a URL, an expression)
 * carries a placeholder value.
 */
export function defaultNodeConfig(
  kind: EtlNode["kind"],
  type: string,
): EtlSourceConfig | EtlTransformConfig | EtlTargetConfig {
  if (kind === "source") {
    switch (type) {
      case "catalog_asset":
        return { type, asset_id: "", source_id: "", fqn: "" };
      case "object_storage":
        return { type, path: "", format: "csv" };
      case "database":
        return { type, mode: "table", table: "" };
      case "http_api":
        return { type, url: "https://", records_path: "" };
      case "platform_dataset":
        return { type, table_id: "" };
      case "lakehouse":
        return { type, schema: "", mode: "table", table: "" };
      case "ingest":
        return { type };
      case "kafka":
      case "kinesis":
      case "pubsub":
        return defaultStreamConfig(type);
      default:
        return { type: "python", code: "return [{'id': 1}]" };
    }
  }
  if (kind === "target") {
    switch (type) {
      case "http_api":
        return { type, url: "https://", method: "POST", batch_size: 500 };
      case "lakehouse":
        return { type, schema: "", table: "", write_mode: "replace" };
      case "database":
        return { type, dataset: "", table: "", write_mode: "replace" };
      default:
        return {
          type: "object_storage",
          dataset: "",
          table: "",
          format: "parquet",
          write_mode: "replace",
        };
    }
  }
  switch (type) {
    case "filter":
      return { type, expr: "amount > 0" };
    case "select":
      return { type, columns: [] };
    case "rename":
      return { type, mapping: {} };
    case "derive":
      return { type, column: "total", expr: "price * quantity" };
    case "join":
      return { type, how: "inner", left_on: ["id"], right_on: ["id"] };
    case "union":
      return { type };
    case "aggregate":
      return { type, group_by: [], aggs: [{ column: "id", fn: "count", as: "rows" }] };
    case "sort":
      return { type, by: [], descending: false };
    case "dedupe":
      return { type };
    case "fill_nulls":
      return { type, value: "0" };
    case "drop_nulls":
      return { type };
    case "limit":
      return { type, n: 1000 };
    case "sql":
      return { type, query: "SELECT * FROM t" };
    case "quality_gate":
      return { type, rules: [{ check: "not_null", column: "id", severity: "fail" }] };
    default:
      return { type: "python", code: "# df is the input frame\nreturn df" };
  }
}
