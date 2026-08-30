// Marketing mocks for the Data platform section of the landing page. Pure
// CSS/SVG (no screenshots), theme-aware via design tokens, and deliberately
// echoing the real surfaces: the lakehouse object explorer and query editor
// on one side, an ETL graph on the other.

const SCHEMAS = [
  {
    name: "analytics",
    badge: null as string | null,
    tables: [
      { name: "orders", meta: "1.2M · 41 MB", tag: null as string | null },
      { name: "daily_revenue", meta: "730 · 96 KB", tag: "view" },
      { name: "customers", meta: "84k · 6 MB", tag: "secured" },
    ],
  },
  { name: "raw_lake", badge: "lake", tables: [] },
];

const RESULTS = [
  ["initech", "412,900.00", "1,204"],
  ["acme", "318,455.75", "986"],
  ["globex", "204,180.00", "740"],
];

/** The lakehouse: object explorer, governed SQL, columnar results. */
export function LakehouseMock() {
  return (
    <div className="glow-card relative overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-2xl">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold tracking-tight text-foreground">Lakehouse</span>
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[9px] font-semibold text-primary">
            Parquet · your bucket
          </span>
        </div>
        <span className="hidden rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[9px] text-muted-foreground sm:inline">
          snapshot v128
        </span>
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        {/* Object explorer */}
        <div className="col-span-4 rounded-xl border border-border/60 bg-background/60 p-2.5">
          <p className="mb-2 text-[8px] font-bold uppercase tracking-widest text-muted-foreground">
            Object explorer
          </p>
          <div className="space-y-1.5">
            {SCHEMAS.map((s) => (
              <div key={s.name}>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-semibold text-foreground">{s.name}</span>
                  {s.badge && (
                    <span className="rounded border border-border/60 px-1 text-[7px] text-muted-foreground">
                      {s.badge}
                    </span>
                  )}
                </div>
                {s.tables.map((t) => (
                  <div key={t.name} className="mt-1 flex items-center justify-between gap-1 pl-2.5">
                    <span className="flex items-center gap-1 truncate font-mono text-[9px] text-muted-foreground">
                      {t.name}
                      {t.tag && (
                        <span className="rounded bg-primary/10 px-1 text-[7px] text-primary">
                          {t.tag}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-[7px] tabular-nums text-muted-foreground/70">
                      {t.meta}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Query + results */}
        <div className="col-span-8 space-y-2.5">
          <div className="rounded-xl border border-border/60 bg-background/60 p-2.5">
            <pre className="overflow-hidden font-mono text-[9px] leading-[1.5] text-foreground/85">
              {`SELECT customer, sum(amount) AS total, count(*) AS orders
FROM analytics.orders
WHERE placed_at >= DATE '2026-01-01'
GROUP BY 1 ORDER BY total DESC`}
            </pre>
            <div className="mt-2 flex items-center gap-1.5">
              <span className="rounded-md bg-primary px-2 py-0.5 text-[8px] font-semibold text-primary-foreground">
                Run
              </span>
              <span className="rounded-md border border-border/60 px-2 py-0.5 text-[8px] text-muted-foreground">
                Explain
              </span>
              <span className="rounded-md border border-border/60 px-2 py-0.5 text-[8px] text-muted-foreground">
                Save as view
              </span>
              <span className="ml-auto font-mono text-[8px] tabular-nums text-muted-foreground">
                3 rows · 41 ms
              </span>
              <span className="rounded bg-muted px-1 text-[7px] text-muted-foreground">cached</span>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-border/60 bg-background/60">
            <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
              {["customer", "total", "orders"].map((c) => (
                <span
                  key={c}
                  className="flex-1 font-mono text-[8px] font-semibold text-muted-foreground"
                >
                  {c}
                </span>
              ))}
            </div>
            {RESULTS.map((row) => (
              <div key={row[0]} className="flex items-center gap-2 px-2.5 py-1">
                {row.map((cell, i) => (
                  <span
                    key={i}
                    className={`flex-1 font-mono text-[9px] ${i === 0 ? "text-foreground" : "tabular-nums text-muted-foreground"}`}
                  >
                    {cell}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Partition / governance strip */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {[
          "partitioned by placed_at",
          "row filter: region = @me",
          "salary masked",
          "20 snapshots",
        ].map((t) => (
          <span
            key={t}
            className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 font-mono text-[8px] text-muted-foreground"
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
