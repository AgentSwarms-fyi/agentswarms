// The SQL name for a file in an object store.
//
// Shared because BOTH sides need it and they must agree: the Catalog seeds
// `SELECT * FROM orders LIMIT 10` in the browser, and the server resolves
// `orders` back to `data/orders.parquet` when the query runs. Two copies of
// this rule would drift, and the symptom would be a seeded query that returns
// "that query does not reference any file" — a dead button with a confusing
// message.
import { safeTableName } from "@/lib/datasetParse";

/**
 * `data/orders.parquet` -> `orders`, `sales/*.parquet` -> `sales`.
 *
 * The basename without its extension, because that is what somebody types.
 * A crawled folder of same-format files has a fqn ending in `/*.parquet`; its
 * name comes from the folder, which is also what the catalog displays.
 */
export function objectSqlName(fqn: string): string {
  const trimmed = fqn.replace(/\/\*\.[a-z0-9]+$/i, "");
  const base = (trimmed.split("/").pop() ?? trimmed).replace(/\.[a-z0-9]+$/i, "");
  return safeTableName(base || "object");
}
