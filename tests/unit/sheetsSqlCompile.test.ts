// Sheets: a table sheet's calculated columns are Excel formulas compiled to
// DuckDB SQL. Every case here runs the compiled SQL on a real engine, so the
// assertion is about the answer a person sees, not the text of the SQL.
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CompileError,
  compileColumnFormula,
  kindOfSqlType,
  strftimePattern,
  type CompileContext,
  type SheetColumn,
} from "@/lib/sheets/sql/compile";

let instance: DuckDBInstance;
let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;

const ORDERS: SheetColumn[] = [
  { name: "id", kind: "number" },
  { name: "region", kind: "text" },
  { name: "customer", kind: "text" },
  { name: "amount", kind: "number" },
  { name: "qty", kind: "number" },
  { name: "day", kind: "date" },
  { name: "paid", kind: "bool" },
  { name: "code", kind: "text" },
];

const cx: CompileContext = {
  columns: ORDERS,
  self: "orders",
  row: "p",
  selfName: "Orders",
  table: (name) =>
    name.toLowerCase() === "customers"
      ? {
          from: "customers",
          columns: [
            { name: "cid", kind: "text" },
            { name: "name", kind: "text" },
            { name: "tier", kind: "text" },
          ],
        }
      : name.toLowerCase() === "rates"
        ? {
            from: "rates",
            columns: [
              { name: "floor", kind: "number" },
              { name: "band", kind: "text" },
            ],
          }
        : undefined,
};

beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:");
  conn = await instance.connect();
  await conn.run(`CREATE TABLE orders AS SELECT * FROM (VALUES
    (1, 'West', 'alice', 10.5::DOUBLE, 2::INTEGER, DATE '2024-01-31', TRUE, 'A1'),
    (2, 'east', 'bob', 20.0, 3, DATE '2024-02-15', FALSE, '5'),
    (3, 'West', 'alice', NULL, 1, NULL, NULL, NULL),
    (4, 'North', 'carol', -4.0, 1, DATE '2023-12-31', TRUE, 'x*y')
  ) v(id, region, customer, amount, qty, day, paid, code)`);
  await conn.run(`CREATE TABLE customers AS SELECT * FROM (VALUES
    ('alice', 'Alice A', 'gold'), ('BOB', 'Bob B', 'silver')) v(cid, name, tier)`);
  await conn.run(`CREATE TABLE rates AS SELECT * FROM (VALUES
    (0::DOUBLE, 'low'), (10, 'mid'), (20, 'high')) v(floor, band)`);
});
afterAll(() => conn?.closeSync());

/** The column the formula computes, one value per order (in id order). */
async function column(formula: string): Promise<unknown[]> {
  const { sql } = compileColumnFormula(formula, cx);
  const r = await conn.runAndReadAll(`SELECT p.id, ${sql} AS v FROM orders p ORDER BY p.id`);
  return r.getRowObjectsJson().map((row) => row.v);
}

describe("arithmetic reads a blank as 0 and division by zero as a blank", () => {
  it("multiplies columns, with the blank amount as 0", async () => {
    expect(await column("=[@amount]*[@qty]")).toEqual([21, 60, 0, -4]);
  });

  it("gives a blank, not Infinity or a failed query, for a division by zero", async () => {
    expect(await column("=[@amount]/([@qty]-1)")).toEqual([10.5, 10, null, null]);
  });

  it("keeps Excel's precedence and MOD's sign", async () => {
    expect(await column("=-2^2")).toEqual([4, 4, 4, 4]);
    expect(await column('=MOD(-7,3)&"/"&MOD(7,-3)')).toEqual(["2/-2", "2/-2", "2/-2", "2/-2"]);
  });

  it("does not overflow on integer columns (Excel numbers are doubles)", async () => {
    expect(await column("=[@qty]*2147483647*4")).toEqual([
      2 * 2147483647 * 4,
      3 * 2147483647 * 4,
      2147483647 * 4,
      2147483647 * 4,
    ]);
  });

  it("turns sqrt of a negative into a blank for that row only", async () => {
    const v = await column("=ROUND(SQRT([@amount]),3)");
    expect(v).toEqual([3.24, 4.472, 0, null]);
  });
});

describe("text", () => {
  it("& writes numbers the way a cell shows them", async () => {
    expect(await column('=[@customer]&"-"&[@qty]')).toEqual([
      "alice-2",
      "bob-3",
      "alice-1",
      "carol-1",
    ]);
    expect(await column('=0.5&"|"&3&"|"&[@amount]')).toEqual([
      "0.5|3|10.5",
      "0.5|3|20",
      "0.5|3|0",
      "0.5|3|-4",
    ]);
  });

  it('compares text without case, and a blank equals ""', async () => {
    expect(await column('=[@region]="west"')).toEqual([true, false, true, false]);
    expect(await column('=[@amount]=""')).toEqual([false, false, true, false]);
    expect(await column('=[@code]<>""')).toEqual([true, true, false, true]);
  });

  it("text functions", async () => {
    expect(await column('=PROPER("hello big WORLD")')).toEqual(Array(4).fill("Hello Big World"));
    expect(await column('=TRIM("  a   b ")')).toEqual(Array(4).fill("a b"));
    expect(await column("=LEFT([@customer],2)&MID([@customer],2,2)&LEN([@customer])")).toEqual([
      "alli5",
      "boob3",
      "alli5",
      "caar5",
    ]);
    expect(await column('=SUBSTITUTE([@region],"West","W")')).toEqual(["W", "east", "W", "North"]);
    expect(await column('="it\'s "&"quoted"')).toEqual(Array(4).fill("it's quoted"));
  });

  it("TEXT formats numbers and dates, rounding half away from zero", async () => {
    expect(await column('=TEXT([@amount],"#,##0.00")')).toEqual([
      "10.50",
      "20.00",
      "0.00",
      "-4.00",
    ]);
    expect(await column('=TEXT(2.5,"0")&TEXT(0.125,"0.0%")')).toEqual(Array(4).fill("312.5%"));
    expect(await column('=TEXT([@day],"yyyy-mm")')).toEqual([
      "2024-01",
      "2024-02",
      null,
      "2023-12",
    ]);
  });

  it("a text column that holds a number matches a number", async () => {
    expect(await column("=[@code]=5")).toEqual([false, true, false, false]);
  });
});

describe("dates", () => {
  it("DATE rolls over and EOMONTH lands on the last day", async () => {
    expect(await column("=DATE(2024,13,1)")).toEqual(Array(4).fill("2025-01-01"));
    expect(await column("=EOMONTH([@day],1)")).toEqual([
      "2024-02-29",
      "2024-03-31",
      null,
      "2024-01-31",
    ]);
  });

  it("adds days and subtracts dates as Excel's serial numbers do", async () => {
    expect(await column("=[@day]+1")).toEqual(["2024-02-01", "2024-02-16", null, "2024-01-01"]);
    expect(await column("=[@day]-DATE(2024,1,1)")).toEqual([30, 45, null, -1]);
  });

  it("compares a date column with a date written as text", async () => {
    expect(await column('=[@day]>="2024-02-01"')).toEqual([false, true, null, false]);
  });

  it("YEAR, WEEKDAY and DATEDIF", async () => {
    expect(await column("=YEAR([@day])")).toEqual([2024, 2024, null, 2023]);
    // 2024-01-31 was a Wednesday: 4 counting from Sunday.
    expect(await column("=WEEKDAY([@day])")).toEqual([4, 5, null, 1]);
    expect(await column('=DATEDIF(DATE(2024,1,31),[@day],"M")')).toEqual([0, 0, null, -1]);
  });
});

describe("whole columns and conditional totals", () => {
  it("divides by a column total", async () => {
    const v = (await column("=ROUND([@amount]/SUM([amount]),4)")) as number[];
    expect(v).toEqual([0.3962, 0.7547, 0, -0.1509]);
  });

  it("SUMIFS with this row's value as the criterion", async () => {
    expect(await column("=SUMIFS([amount],[customer],[@customer])")).toEqual([10.5, 20, 10.5, -4]);
  });

  it("an operator in front of this row's value", async () => {
    // Blank amounts never pass a numeric test, as COUNTIF skips blank cells…
    expect(await column('=COUNTIFS([amount],">"&[@amount])')).toEqual([1, 0, 2, 2]);
    // …except "<>", which a blank satisfies.
    expect(await column('=COUNTIFS([amount],"<>"&[@qty])')).toEqual([4, 4, 4, 4]);
  });

  it("criteria strings: wildcards, <>, numbers, blanks", async () => {
    expect(await column('=COUNTIF([region],"w*")')).toEqual(Array(4).fill(2));
    expect(await column('=COUNTIF([region],"<>west")')).toEqual(Array(4).fill(2));
    expect(await column('=COUNTIF([amount],">=10")')).toEqual(Array(4).fill(2));
    expect(await column('=COUNTIF([code],"")')).toEqual(Array(4).fill(1));
    expect(await column('=COUNTIF([code],"x~*y")')).toEqual(Array(4).fill(1));
    expect(await column('=SUMIF([region],"West",[qty])')).toEqual(Array(4).fill(3));
  });

  it("SUM of this row's values is arithmetic, not an aggregate", async () => {
    expect(await column("=SUM([@amount],[@qty])")).toEqual([12.5, 23, 1, -3]);
    expect(await column("=MAX([@amount],[@qty])")).toEqual([10.5, 20, 1, 1]);
  });

  it("MAX of a date column is a date", async () => {
    const r = compileColumnFormula("=MAX([day])", cx);
    expect(r.kind).toBe("date");
    expect(await column("=MAX([day])")).toEqual(Array(4).fill("2024-02-15"));
  });
});

describe("lookups into another table sheet", () => {
  it("XLOOKUP matches without case and falls back when nothing matches", async () => {
    expect(await column('=XLOOKUP([@customer], Customers[cid], Customers[name], "none")')).toEqual([
      "Alice A",
      "Bob B",
      "Alice A",
      "none",
    ]);
  });

  it("VLOOKUP exact, by column number", async () => {
    expect(await column("=VLOOKUP([@customer], Customers, 3, FALSE)")).toEqual([
      "gold",
      "silver",
      "gold",
      null,
    ]);
  });

  it("VLOOKUP's default is an approximate match: the largest key not above", async () => {
    expect(await column("=VLOOKUP([@amount], Rates, 2)")).toEqual(["mid", "high", "low", null]);
  });

  it("INDEX(MATCH()) is the same lookup", async () => {
    expect(await column("=INDEX(Customers[tier], MATCH([@customer], Customers[cid], 0))")).toEqual([
      "gold",
      "silver",
      "gold",
      null,
    ]);
  });
});

describe("mixed kinds and errors", () => {
  it("IF with a number and a text branch gives text", async () => {
    const r = compileColumnFormula('=IF([@qty]>1,[@qty],"small")', cx);
    expect(r.kind).toBe("text");
    expect(await column('=IF([@qty]>1,[@qty],"small")')).toEqual(["2", "3", "small", "small"]);
  });

  it("IFERROR fills what would have been an error", async () => {
    expect(await column('=IFERROR(1/([@qty]-1),"n/a")')).toEqual(["1", "0.5", "n/a", "n/a"]);
  });

  it("an error the engine raises blanks that row instead of failing the whole sheet", async () => {
    // A year no date can hold: DuckDB throws, and one bad row must not take
    // every other row of the page down with it.
    expect(await column("=DATE([@qty]*99999999,1,1)")).toEqual([null, null, null, null]);
  });

  it("refuses what has no sound translation, and says what to write instead", () => {
    const why = (f: string) => {
      try {
        compileColumnFormula(f, cx);
        return "compiled";
      } catch (e) {
        expect(e).toBeInstanceOf(CompileError);
        return (e as Error).message;
      }
    };
    expect(why("=A1*2")).toMatch(/grid cells like A1/);
    expect(why("=[@nope]")).toMatch(/no column "nope".*id, region, customer/);
    expect(why("=MATCH(1,[qty],0)")).toMatch(/no fixed order/);
    expect(why("=UNIQUE([region])")).toMatch(/one per row/);
    expect(why("=Customers[name]")).toMatch(/whole column of another table/);
    expect(why("=Nowhere[x]")).toMatch(/no table sheet named "Nowhere"/);
    expect(why("=ISERROR([@qty])")).toMatch(/IFERROR/);
    expect(why("[@qty]")).toMatch(/starts with =/);
    expect(why("=SUM(")).not.toBe("compiled");
    expect(why("=CUBEVALUE(1)")).toMatch(/not available in a table column/);
    expect(why('=TEXT([@amount],"[Red]0")')).toMatch(/not available/);
  });

  it("quotes identifiers and strings, so names and text cannot break out", async () => {
    await conn.run(`CREATE TABLE odd AS SELECT 1 AS "we""ird"`);
    const odd: CompileContext = {
      columns: [{ name: 'we"ird', kind: "number" }],
      self: "odd",
      row: "p",
    };
    const { sql } = compileColumnFormula(`=[@we"ird]+1&"'); DROP TABLE odd; --"`, odd);
    const r = await conn.runAndReadAll(`SELECT ${sql} AS v FROM odd p`);
    expect(r.getRowObjectsJson()[0].v).toBe("2'); DROP TABLE odd; --");
    const still = await conn.runAndReadAll(`SELECT count(*) AS n FROM odd`);
    expect(Number(still.getRowObjectsJson()[0].n)).toBe(1);
  });
});

describe("helpers", () => {
  it("maps engine types to kinds", () => {
    expect(kindOfSqlType("DECIMAL(18,2)")).toBe("number");
    expect(kindOfSqlType("BIGINT")).toBe("number");
    expect(kindOfSqlType("VARCHAR")).toBe("text");
    expect(kindOfSqlType("TIMESTAMP WITH TIME ZONE")).toBe("datetime");
    expect(kindOfSqlType("DATE")).toBe("date");
    expect(kindOfSqlType("BOOLEAN")).toBe("bool");
    expect(kindOfSqlType("STRUCT(a INTEGER)")).toBe("other");
  });

  it("reads Excel date codes, minutes after hours included", () => {
    expect(strftimePattern("yyyy-mm-dd")).toBe("%Y-%m-%d");
    expect(strftimePattern("hh:mm")).toBe("%H:%M");
    expect(strftimePattern("mmm d, yyyy")).toBe("%b %-d, %Y");
    expect(strftimePattern('"Q"yyyy')).toBe("Q%Y");
    expect(strftimePattern("[h]")).toBeNull();
  });
});
