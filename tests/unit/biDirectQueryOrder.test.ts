// R503: a Direct-query widget wrapped as SELECT … FROM (<sql>) AS _dq lost
// its own ORDER BY — a live daily line on a detail page came back with its
// days shuffled. The wrapper now says the order again, by output column.
import { describe, expect, it } from "vitest";

import { buildDirectQuerySql, carriedOrderBy } from "@/lib/biDirectQuery";

const daily = `SELECT d.ride_date, s.station_name, SUM(d.started_electric + d.started_classic) AS rides
FROM bikeshare.bike_station_days d JOIN bikeshare.bike_stations s ON s.station_id = d.station_id
GROUP BY 1, 2
ORDER BY 1`;
const cols = ["ride_date", "station_name", "rides"];

describe("carriedOrderBy", () => {
  it("reads positions, names, qualified and quoted names, and directions", () => {
    expect(carriedOrderBy(daily, cols)).toEqual([{ column: "ride_date", dir: "ASC" }]);
    expect(carriedOrderBy("SELECT a, b FROM t ORDER BY 2 DESC, a", ["a", "b"])).toEqual([
      { column: "b", dir: "DESC" },
      { column: "a", dir: "ASC" },
    ]);
    expect(carriedOrderBy('SELECT x.a FROM t x ORDER BY x."a" desc nulls last', ["a"])).toEqual([
      { column: "a", dir: "DESC", nulls: "LAST" },
    ]);
    expect(carriedOrderBy("SELECT A FROM t ORDER BY `a`;", ["A"])).toEqual([
      { column: "A", dir: "ASC" },
    ]);
  });

  it("stops at the first term it cannot name outside, keeping the prefix", () => {
    expect(
      carriedOrderBy("SELECT a, b FROM t ORDER BY a, lower(b), b", ["a", "b"]).map((o) => o.column),
    ).toEqual(["a"]);
    // A column the query does not return.
    expect(carriedOrderBy("SELECT a FROM t ORDER BY z, a", ["a"])).toEqual([]);
    expect(carriedOrderBy("SELECT a FROM t ORDER BY 3", ["a"])).toEqual([]);
  });

  it("reads only the outer query's ORDER BY, up to LIMIT", () => {
    const sql = `SELECT a, b, row_number() OVER (ORDER BY b) AS n
      FROM (SELECT a, b FROM t ORDER BY b) s -- ORDER BY nonsense
      WHERE a <> 'ORDER BY x' ORDER BY a DESC LIMIT 10`;
    expect(carriedOrderBy(sql, ["a", "b", "n"])).toEqual([{ column: "a", dir: "DESC" }]);
    expect(carriedOrderBy("SELECT a FROM (SELECT a FROM t ORDER BY a) s", ["a"])).toEqual([]);
    expect(carriedOrderBy("SELECT a FROM t", ["a"])).toEqual([]);
  });

  it("never repeats a name that is not a plain column", () => {
    expect(carriedOrderBy('SELECT 1 AS "a b" FROM t ORDER BY 1', ["a b"])).toEqual([]);
  });
});

describe("buildDirectQuerySql keeps the query's order", () => {
  it("on the plain wrapper, after the filters and before the LIMIT", () => {
    const sql = buildDirectQuerySql({
      baseSql: daily,
      columns: cols,
      filters: [{ column: "station_name", kind: "select", values: ["W 21 St & 6 Ave"] }],
      rowCap: 500,
      dialect: "duckdb",
    });
    expect(sql).toMatch(
      /AS _dq WHERE station_name IN \('W 21 St & 6 Ave'\) ORDER BY "ride_date" ASC LIMIT 500$/,
    );
  });

  it("on a grouped wrapper, while the grouped rows still have the column", () => {
    const sql = buildDirectQuerySql({
      baseSql: daily,
      columns: cols,
      filters: [{ column: "station_name", kind: "select", values: ["W 21 St & 6 Ave"] }],
      agg: { dims: ["ride_date", "station_name"], measures: [{ field: "rides", agg: "sum" }] },
      rowCap: 500,
      dialect: "duckdb",
    });
    expect(sql).toMatch(/GROUP BY "ride_date", "station_name" ORDER BY "ride_date" ASC LIMIT 500$/);

    // Ordered by the measure, descending — the bars stay largest first.
    const byRides = buildDirectQuerySql({
      baseSql: "SELECT area, SUM(n) AS rides FROM t GROUP BY 1 ORDER BY 2 DESC",
      columns: ["area", "rides"],
      agg: { dims: ["area"], measures: [{ field: "rides", agg: "sum" }] },
      dialect: "mysql",
    });
    expect(byRides).toContain("GROUP BY `area` ORDER BY `rides` DESC LIMIT");

    // The grouped rows no longer carry `ride_date`: no order rather than a wrong one.
    const lost = buildDirectQuerySql({
      baseSql: daily,
      columns: cols,
      agg: { dims: ["station_name"], measures: [{ field: "rides", agg: "sum" }] },
    });
    expect(lost.split(") AS _dq")[1]).not.toContain("ORDER BY");
  });

  it("adds nothing to a query with no order, or to a scalar aggregate", () => {
    expect(buildDirectQuerySql({ baseSql: "SELECT a FROM t", columns: ["a"] })).toBe(
      "SELECT * FROM (SELECT a FROM t) AS _dq LIMIT 50000",
    );
    const scalar = buildDirectQuerySql({
      baseSql: "SELECT a, n FROM t ORDER BY a",
      columns: ["a", "n"],
      agg: { dims: [], measures: [{ field: "n", agg: "sum" }] },
    });
    expect(scalar.split(") AS _dq")[1]).not.toContain("ORDER BY");
  });
});
