// What the builder's Fields mode builds from (R499): the source's tables with
// their declared column types, the SQL dialect to write, and a runner for the
// sample query that tells field kinds apart. Kept out of BiBuilderPane, which
// only wires the result into its own state.
import { useCallback, useMemo } from "react";
import type { FieldsTable } from "@/components/bi/BiFieldsBuilder";
import { sourceFromKey, type BiDataContext } from "@/components/bi/biDataContext";
import type { SqlDialect } from "@/lib/semanticLayer";

export function useFieldSources(ctx: BiDataContext, sourceKey: string) {
  const tables: FieldsTable[] = useMemo(() => {
    if (sourceKey === "local") {
      return ctx.datasets.map((d) => ({
        name: d.name,
        cols: d.columns.map((c) => c.name),
        types: Object.fromEntries(d.columns.map((c) => [c.name, c.type])),
      }));
    }
    const t = ctx.whTables[sourceKey];
    if (!Array.isArray(t)) return [];
    return t.map((x) => ({
      name: `${x.schema}.${x.name}`,
      cols: x.columns.map((c) => c.name),
      types: Object.fromEntries(x.columns.map((c) => [c.name, c.type])),
    }));
  }, [sourceKey, ctx.datasets, ctx.whTables]);

  // Local datasets run on DuckDB; a warehouse's provider id names its dialect
  // (the same reading the server's refresh takes), ANSI where it is unknown.
  const dialect: SqlDialect =
    sourceKey === "local"
      ? "duckdb"
      : ((ctx.warehouses.find((w) => w.id === sourceKey)?.provider ?? "postgres") as SqlDialect);

  const runSql = useCallback(
    (q: string) => ctx.runSql(sourceFromKey(sourceKey, ctx.warehouses), q),
    [ctx, sourceKey],
  );

  return { tables, dialect, runSql };
}
