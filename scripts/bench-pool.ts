// Measures what a per-query connection actually costs, against a real
// database. Calls the REAL executeWarehouseQuery — a hand-rolled copy of the
// driver would measure the copy, not the product.
//
//   docker run -d --name as-bench-pg -e POSTGRES_PASSWORD=benchpw \
//     -e POSTGRES_DB=bench -p 55432:5432 postgres:16-alpine
//   npx vite-node scripts/bench-pool.ts
//
// Runs the same real driver twice — once with WAREHOUSE_POOL=off, once with
// pooling on — so the comparison is between two states of the product rather
// than between the product and a hand-written stand-in. Also asserts both
// paths return identical results, since a fast wrong answer is not a win.
import { closeAllPools } from "@/utils/warehouse/pool.server";
import { executeWarehouseQuery } from "@/utils/warehouse/drivers.server";
import type { WarehouseConfig } from "@/utils/warehouse/types";

const cfg = {
  provider: "postgres",
  host: process.env.BENCH_PG_HOST ?? "127.0.0.1",
  port: process.env.BENCH_PG_PORT ?? "55432",
  database: process.env.BENCH_PG_DB ?? "bench",
  username: process.env.BENCH_PG_USER ?? "postgres",
  password: process.env.BENCH_PG_PASSWORD ?? "benchpw",
} as unknown as WarehouseConfig;

const N = Number(process.env.BENCH_N ?? 30);
// Something with real columns and types, not just `SELECT 1` — the row-shaping
// path differs between the pooled and unpooled branches and must be compared.
//
// DETERMINISTIC ON PURPOSE. The first version used now(), so the two runs
// disagreed on the timestamp column and the comparison reported a divergence
// that was entirely the benchmark's own doing.
const SQL = `SELECT g AS n, g * 1.5 AS ratio, 'row-' || g AS label,
             (g % 2 = 0) AS even,
             TIMESTAMP '2026-01-01 00:00:00' - (g || ' days')::interval AS seen_at
             FROM generate_series(1, 25) g ORDER BY g`;

function stats(label: string, ms: number[]): number {
  const sorted = [...ms].sort((a, b) => a - b);
  const sum = ms.reduce((a, b) => a + b, 0);
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  console.log(
    `${label.padEnd(30)} n=${ms.length}  mean=${(sum / ms.length).toFixed(1)}ms  ` +
      `p50=${p(0.5).toFixed(1)}ms  p95=${p(0.95).toFixed(1)}ms`,
  );
  return sum / ms.length;
}

async function run(label: string, pooled: boolean) {
  process.env.WAREHOUSE_POOL = pooled ? "on" : "off";
  await executeWarehouseQuery(cfg, SQL, 100); // warm the dynamic import + pool
  const ms: number[] = [];
  let last: unknown;
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const r = await executeWarehouseQuery(cfg, SQL, 100);
    ms.push(performance.now() - t);
    last = { columns: r.columns, rows: r.rows, row_count: r.row_count, truncated: r.truncated };
  }
  return { mean: stats(label, ms), result: last };
}

async function main() {
  console.log(
    `\nPostgres @ ${process.env.BENCH_PG_HOST ?? "127.0.0.1"}:${process.env.BENCH_PG_PORT ?? "55432"}\n`,
  );

  const off = await run("WAREHOUSE_POOL=off", false);
  await closeAllPools();
  const on = await run("WAREHOUSE_POOL=on", true);
  await closeAllPools();

  // duration_ms is excluded above precisely because it differs — everything
  // else must be byte-identical or the pooled path is returning a different
  // answer, which no speed-up would justify.
  const same = JSON.stringify(off.result) === JSON.stringify(on.result);
  console.log(`\nidentical results: ${same ? "YES" : "NO — POOLED PATH DIVERGES"}`);
  if (!same) {
    console.log("unpooled:", JSON.stringify(off.result).slice(0, 400));
    console.log("pooled:  ", JSON.stringify(on.result).slice(0, 400));
    process.exit(1);
  }
  console.log(
    `speed-up: ${(off.mean / on.mean).toFixed(1)}x  ` +
      `(${off.mean.toFixed(1)}ms → ${on.mean.toFixed(1)}ms, saving ${(off.mean - on.mean).toFixed(1)}ms/query)\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
