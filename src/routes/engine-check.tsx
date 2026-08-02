// /engine-check — does the in-browser SQL engine work in THIS browser?
//
// Kept as a deployment diagnostic rather than deleted after the DuckDB-Wasm
// migration, because it answers a question nothing else can. The unit suite
// proves the code is right; the bundler proves the assets are emitted. Neither
// says whether WebAssembly instantiates behind a customer's Content-Security-
// Policy, whether a corporate proxy rewrote the .wasm, or whether the worker
// was blocked. Those failures happen on someone else's machine, and the answer
// has to come from that machine.
//
// The cases are the ones the OLD engine got wrong — measured by
// `evals/nl2sql/engine-gap.ts` before the swap — so a pass here is evidence of
// the specific defect being gone, not a generic smoke test:
//   * share of total   AlaSQL dropped the computed column entirely
//   * running total    AlaSQL returned 0 for every row
//   * top-N-per-group  AlaSQL returned a different row set
//   * RANK(), CTE-in-subquery   AlaSQL could not run them at all
//
// Deliberately unauthenticated and self-contained: it queries four fixture
// rows defined below and never touches a user's data, so it is safe to hit
// from a locked-down environment while diagnosing one.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { browserEngineBundle, registerBrowserTables, runBrowserSql } from "@/lib/browserDuckdb";
import { SqlEngineStatus, useSqlEngineStatus } from "@/components/data/SqlEngineStatus";

export const Route = createFileRoute("/engine-check")({ component: EngineCheck });

type Check = { name: string; expected: string; got: string; ok: boolean };

const ORDERS = [
  { id: 1, region: "EMEA", amount: 100, day: "2026-01-15" },
  { id: 2, region: "EMEA", amount: 250.5, day: "2026-02-01" },
  { id: 3, region: "AMER", amount: 310, day: "2026-03-02" },
  { id: 4, region: "APAC", amount: 40, day: "2026-04-01" },
];

function EngineCheck() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        await registerBrowserTables([
          {
            name: "orders",
            columns: [
              { name: "id", type: "number" },
              { name: "region", type: "string" },
              { name: "amount", type: "number" },
              { name: "day", type: "date" },
            ],
            rows: ORDERS,
          },
        ]);
        setBundle(browserEngineBundle());

        const run = async (sql: string) => JSON.stringify((await runBrowserSql(sql)).rows);
        const results: Check[] = [];
        const add = async (name: string, sql: string, expected: string) => {
          try {
            const got = await run(sql);
            results.push({ name, expected, got, ok: got === expected });
          } catch (e) {
            results.push({ name, expected, got: `ERROR ${(e as Error).message}`, ok: false });
          }
        };

        await add("basic count", "SELECT COUNT(*) AS n FROM orders", '[{"n":4}]');
        await add(
          "double-quoted identifier",
          'SELECT SUM("amount") AS total FROM orders',
          '[{"total":700.5}]',
        );
        // The three AlaSQL got SILENTLY WRONG.
        await add(
          "share of total (window)",
          "SELECT region, ROUND(SUM(amount) * 100.0 / SUM(SUM(amount)) OVER (), 2) AS pct FROM orders GROUP BY region ORDER BY region",
          '[{"region":"AMER","pct":44.25},{"region":"APAC","pct":5.71},{"region":"EMEA","pct":50.04}]',
        );
        await add(
          "running total (window)",
          "WITH d AS (SELECT day, SUM(amount) AS amt FROM orders GROUP BY day) " +
            "SELECT day, SUM(amt) OVER (ORDER BY day) AS cum FROM d ORDER BY day",
          '[{"day":"2026-01-15","cum":100},{"day":"2026-02-01","cum":350.5},{"day":"2026-03-02","cum":660.5},{"day":"2026-04-01","cum":700.5}]',
        );
        await add(
          "top-1-per-group (ROW_NUMBER)",
          "WITH r AS (SELECT region, id, ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) AS rn FROM orders) " +
            "SELECT region, id FROM r WHERE rn = 1 ORDER BY region",
          '[{"region":"AMER","id":3},{"region":"APAC","id":4},{"region":"EMEA","id":2}]',
        );
        // The two AlaSQL could not run at all.
        await add(
          "RANK()",
          "SELECT id, RANK() OVER (ORDER BY amount DESC) AS rnk FROM orders ORDER BY rnk",
          '[{"id":3,"rnk":1},{"id":2,"rnk":2},{"id":1,"rnk":3},{"id":4,"rnk":4}]',
        );
        await add(
          "CTE referenced in a subquery",
          "WITH per AS (SELECT region, SUM(amount) AS amt FROM orders GROUP BY region) " +
            "SELECT region FROM per WHERE amt > (SELECT AVG(amt) FROM per) ORDER BY region",
          '[{"region":"AMER"},{"region":"EMEA"}]',
        );
        // BigInt crossing: COUNT returns BIGINT and must arrive as a number.
        await add(
          "COUNT is a JS number, not a BigInt",
          "SELECT COUNT(*) AS n FROM orders WHERE amount > 50",
          '[{"n":3}]',
        );
        // The read-only guard must still refuse writes. Checked separately
        // because a refusal THROWS — comparing it to a result string would be
        // a test that can never pass and therefore proves nothing.
        try {
          await runBrowserSql("DELETE FROM orders");
          results.push({
            name: "write refused",
            expected: "throws",
            got: "IT RAN — the read-only guard is not applied",
            ok: false,
          });
        } catch {
          results.push({ name: "write refused", expected: "throws", got: "threw", ok: true });
        }
        // And the data must be untouched by the attempt.
        await add(
          "rows intact after refused write",
          "SELECT COUNT(*) AS n FROM orders",
          '[{"n":4}]',
        );

        setChecks(results);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  const passed = checks.filter((c) => c.ok).length;
  // Also exercises the status strip the workbench and BI show, so this page
  // verifies the loading UX and not only the SQL.
  const live = useSqlEngineStatus();

  // Every phase this page observed, in order. A cold load should show
  // loading (with bytes climbing) before ready; seeing only "ready" means the
  // browser served the wasm from cache, which is the normal second visit.
  const [seen, setSeen] = useState<string[]>([]);
  useEffect(() => {
    setSeen((prev) => {
      const label =
        live.phase === "loading" ? `loading ${live.bytesLoaded}/${live.bytesTotal}` : live.phase;
      return prev[prev.length - 1] === label ? prev : [...prev, label];
    });
  }, [live]);

  return (
    <div style={{ padding: 24, fontFamily: "monospace", fontSize: 13 }}>
      <h1 id="heading">
        engine-check: {checks.length === 0 && !error ? "running…" : `${passed}/${checks.length}`}
      </h1>
      <SqlEngineStatus className="my-3 max-w-2xl" />
      <p id="phase">phase: {live.phase}</p>
      <p id="transitions">
        transitions:{" "}
        {seen.length > 6
          ? `${seen[0]} … ${seen.length} updates … ${seen.at(-1)}`
          : seen.join(" → ")}
      </p>
      <p id="bundle">bundle: {bundle ?? "?"}</p>
      {error && <p id="fatal">FATAL: {error}</p>}
      <ul>
        {checks.map((c) => (
          <li key={c.name} style={{ marginBottom: 10 }}>
            <strong>{c.ok ? "PASS" : "FAIL"}</strong> — {c.name}
            {!c.ok && (
              <div style={{ color: "#b00" }}>
                <div>expected: {c.expected}</div>
                <div>got: {c.got}</div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
