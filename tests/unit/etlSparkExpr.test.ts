// pandas query/eval → Spark SQL: what is carried over unchanged, what is
// rewritten, and what is refused at save time in words.
import { describe, expect, it } from "vitest";

import { toSparkSql } from "@/utils/etl/sparkExpr";

const t = (e: string) => toSparkSql(e, "Filter x");

describe("toSparkSql — the shared subset passes through", () => {
  it("arithmetic, comparisons, parentheses, names", () => {
    expect(t("price * quantity")).toBe("price * quantity");
    expect(t("(a + b) / 2 - c % 3")).toBe("(a + b) / 2 - c % 3");
    expect(t("amount > 0 and country == 'DE'")).toBe("amount > 0 AND country == 'DE'");
    expect(t("x != 1 or not y <= 2.5")).toBe("x != 1 OR NOT y <= 2.5");
    expect(t("`Order Id` >= 10")).toBe("`Order Id` >= 10");
  });

  it("numbers as typed, underscores dropped, exponents kept", () => {
    expect(t("n > 1_000")).toBe("n > 1000");
    expect(t("v < 1.5e3")).toBe("v < 1.5e3");
    expect(t("v < .5")).toBe("v < .5");
  });

  it("string literals in either quote, escapes kept for Spark", () => {
    expect(t('name == "Bob"')).toBe("name == 'Bob'");
    expect(t("name == 'O\\'Brien'")).toBe("name == 'O\\'Brien'");
    expect(t('name == "it\'s"')).toBe("name == 'it\\'s'");
    expect(t("path == 'a\\\\b'")).toBe("path == 'a\\\\b'");
  });

  it("function calls pass through — Spark has pandas' arithmetic helpers by name", () => {
    expect(t("abs(delta) > 1")).toBe("abs(delta) > 1");
    expect(t("round(price * 1.2, 2)")).toBe("round(price * 1.2, 2)");
    expect(t("sqrt(x) + log(y)")).toBe("sqrt(x) + log(y)");
  });
});

describe("toSparkSql — pandas spellings rewritten", () => {
  it("bitwise-as-logical operators become AND / OR / NOT", () => {
    expect(t("(a > 1) & (b < 2)")).toBe("(a > 1) AND (b < 2)");
    expect(t("(a > 1) | ~(b < 2)")).toBe("(a > 1) OR NOT (b < 2)");
  });

  it("membership lists become IN (...)", () => {
    expect(t("status in ['new', 'paid']")).toBe("status IN ('new', 'paid')");
    expect(t("status not in ['x']")).toBe("status NOT IN ('x')");
    expect(t("n in (1, 2, 3)")).toBe("n IN (1, 2, 3)");
  });

  it("True / False / None", () => {
    expect(t("flag == True")).toBe("flag == true");
    expect(t("flag != False")).toBe("flag != false");
    expect(t("x == None")).toBe("x == null");
  });

  it("floor division", () => {
    expect(t("a // b")).toBe("a div b");
  });

  it("null checks, abs, round, fillna, astype on a column or a group", () => {
    expect(t("region.isnull()")).toBe("(region IS NULL)");
    expect(t("~region.isna()")).toBe("NOT (region IS NULL)");
    expect(t("email.notnull() and email != ''")).toBe("(email IS NOT NULL) AND email != ''");
    expect(t("delta.abs() > 2")).toBe("abs(delta) > 2");
    expect(t("price.round(2)")).toBe("round(price, 2)");
    expect(t("price.round()")).toBe("round(price, 0)");
    expect(t("qty.fillna(0) * price")).toBe("coalesce(qty, 0) * price");
    expect(t("(a - b).abs()")).toBe("abs((a - b))");
    expect(t("id.astype('str')")).toBe("CAST(id AS STRING)");
    expect(t("v.astype(float)")).toBe("CAST(v AS DOUBLE)");
    expect(t("v.astype('int64') + 1")).toBe("CAST(v AS BIGINT) + 1");
  });

  it("the common .str accessors", () => {
    expect(t("name.str.len() > 3")).toBe("length(name) > 3");
    expect(t("name.str.lower() == 'ann'")).toBe("lower(name) == 'ann'");
    expect(t("name.str.upper().str.strip()")).toBe("trim(upper(name))");
    expect(t("email.str.contains('@x')")).toBe("(email RLIKE '@x')");
    expect(t("sku.str.startswith('A-')")).toBe("startswith(sku, 'A-')");
    expect(t("sku.str.endswith('-Z')")).toBe("endswith(sku, '-Z')");
    expect(t("name.str.replace('-', ' ')")).toBe("regexp_replace(name, '-', ' ')");
    expect(t("name.str.title()")).toBe("initcap(name)");
  });

  it("the common .dt accessors", () => {
    expect(t("order_ts.dt.year == 2026")).toBe("year(order_ts) == 2026");
    expect(t("order_ts.dt.month")).toBe("month(order_ts)");
    expect(t("order_ts.dt.date")).toBe("to_date(order_ts)");
    expect(t("ts.dt.hour >= 9 and ts.dt.dayofweek < 5")).toBe(
      "hour(ts) >= 9 AND dayofweek(ts) < 5",
    );
  });
});

describe("toSparkSql — refusals name the construct and the fix", () => {
  it.each([
    ["amount > @limit", /`@variable` references are not available/],
    ["a ** 2", /`\*\*` is not available.*power\(a, b\)/],
    ["a = 1", /`=` assigns in pandas/],
    ["1 < x < 5", /chained comparisons.*a < x and x < b/],
    ["x is None", /`is None`.*isnull/],
    ["a if b else c", /`if`.*CASE WHEN/],
    ["col.str.extract('(a)')", /\.str\.extract\(\) is not available.*SQL step/],
    ["col.rolling(3)", /\.rolling\(\) is not available.*SQL step/],
    ["col.dt.tz", /\.dt\.tz is not available/],
    ["col[0]", /indexing with \[\.\.\.\]/],
    ["v.astype('category')", /astype\(category\) is not available/],
    ["(a > 1", /unbalanced parentheses/],
    ["a > 1)", /unbalanced parentheses/],
    ["'open", /unterminated string literal/],
    ["a, b", /stray comma/],
    ["", /the expression is empty/],
    ["   ", /the expression is empty/],
    ["a $ b", /unexpected character "\$"/],
    ["a == 'x'\nimport os", /`import` follows a value with no operator/],
    ["a b", /`b` follows a value with no operator/],
    ["(a) (b)", /`\(` follows a value with no operator/],
  ])("%s", (expr, msg) => {
    expect(() => t(expr)).toThrow(msg);
    expect(() => t(expr)).toThrow(/^Filter x: /);
  });

  it("a newline inside the expression is not a second statement", () => {
    // Whitespace, so the tokens join into one SQL expression — there is no
    // statement boundary to smuggle code across.
    expect(t("a == 'x'\n and b == 1")).toBe("a == 'x' AND b == 1");
  });
});
