// Lineage joins on table names, on purpose: a Databricks edge names a catalog an
// asset elsewhere does not, and a pipeline's edge crosses sources. A metastore's
// edge does not. Found in the UI with Hive 3 and Hive 4 side by side: `orders`
// listed `order_summary` twice, once from a metastore it was never in.
import { describe, expect, it } from "vitest";

import { sourceLineageFor, type CatalogLineageEdge } from "@/lib/dataCatalog";

const edge = (over: Partial<CatalogLineageEdge>): CatalogLineageEdge => ({
  upstream_fqn: "sales.orders",
  downstream_fqn: "sales.order_summary",
  upstream_column: null,
  downstream_column: null,
  exact: true,
  ...over,
});

const dev = edge({ source_id: "dev", source_system: "hive" });
const prod = edge({ source_id: "prod", source_system: "hive" });

describe("lineage from a metastore", () => {
  it("stays inside the metastore that reported it", () => {
    const { downstream } = sourceLineageFor([dev, prod], "sales.orders", "prod");
    expect(downstream).toEqual([prod]);
  });

  it("is not shown for an asset from another source", () => {
    const glue = edge({ source_id: "g", source_system: "glue" });
    expect(sourceLineageFor([glue], "sales.orders", "warehouse").downstream).toEqual([]);
  });
});

describe("lineage that crosses sources", () => {
  it("still joins on the name", () => {
    const uc = edge({
      upstream_fqn: "main.sales.orders",
      source_id: "uc",
      source_system: "databricks",
    });
    expect(sourceLineageFor([uc], "sales.orders", "warehouse").downstream).toEqual([uc]);
    const etl = edge({ source_id: "pipeline", source_system: "etl" });
    expect(sourceLineageFor([etl], "sales.orders", "warehouse").downstream).toEqual([etl]);
  });

  it("does not list one edge twice", () => {
    const a = edge({ source_id: "a", source_system: "etl" });
    const b = edge({ source_id: "b", source_system: "etl" });
    expect(sourceLineageFor([a, b], "sales.orders", "warehouse").downstream).toHaveLength(1);
  });

  it("keeps edges that differ only by column", () => {
    const one = edge({ upstream_column: "id", downstream_column: "order_id" });
    const two = edge({ upstream_column: "amount", downstream_column: "amount" });
    expect(sourceLineageFor([one, two], "sales.orders").downstream).toHaveLength(2);
  });
});
