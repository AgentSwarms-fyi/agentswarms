// The BI builder's pure logic.
//
// CHARACTERISATION TESTS, written to pin current behaviour before
// BiBuilderPane (2,700 lines, 59 useState) is split into per-mode children.
// A refactor without them is a rewrite you cannot check: these functions have
// no UI of their own, so a behaviour change would only show up as a chart that
// quietly joins on the wrong column.
//
// They call the real functions the component calls — the whole reason for
// moving them into lib/biBuilder first.
import { describe, expect, it } from "vitest";

import {
  detectJoinKey,
  groupCheckState,
  seedSql,
  selHas,
  toggleName,
  type SelOrAll,
} from "@/lib/biBuilder";

describe("selHas", () => {
  it('treats "all" as containing everything, including names nobody has loaded', () => {
    expect(selHas("all", "anything")).toBe(true);
  });

  it("consults the set otherwise", () => {
    expect(selHas(new Set(["a"]), "a")).toBe(true);
    expect(selHas(new Set(["a"]), "b")).toBe(false);
    expect(selHas(new Set(), "a")).toBe(false);
  });
});

describe("groupCheckState", () => {
  it("is unchecked when nothing is selected at all", () => {
    expect(groupCheckState(undefined, ["a", "b"])).toBe(false);
    expect(groupCheckState(new Set(), ["a", "b"])).toBe(false);
  });

  it('shows "all" as CHECKED even before the list loads', () => {
    // The case the whole SelOrAll type exists for. Showing unchecked here
    // tells the user their selection was lost when it is merely unresolved.
    expect(groupCheckState("all", null)).toBe(true);
    expect(groupCheckState("all", [])).toBe(true);
  });

  it("is checked when every loaded name is selected", () => {
    expect(groupCheckState(new Set(["a", "b"]), ["a", "b"])).toBe(true);
  });

  it("is indeterminate on a partial selection", () => {
    expect(groupCheckState(new Set(["a"]), ["a", "b"])).toBe("indeterminate");
  });

  it("is unchecked when the selection overlaps none of the loaded names", () => {
    expect(groupCheckState(new Set(["z"]), ["a", "b"])).toBe(false);
  });

  it("treats a non-empty selection against an unloaded list as checked", () => {
    // Same reasoning as "all": the list is pending, not empty.
    expect(groupCheckState(new Set(["a"]), null)).toBe(true);
  });
});

describe("toggleName", () => {
  it("adds a name to an explicit selection", () => {
    expect(toggleName(new Set(["a"]), ["a", "b"], "b")).toEqual(new Set(["a", "b"]));
  });

  it("removes a name that was selected", () => {
    expect(toggleName(new Set(["a", "b"]), ["a", "b"], "a")).toEqual(new Set(["b"]));
  });

  it('MATERIALISES "all" before removing one, keeping the rest', () => {
    // "all minus one" is not representable. Treating "all" as an empty set
    // here would clear every other member along with the one clicked.
    expect(toggleName("all", ["a", "b", "c"], "b")).toEqual(new Set(["a", "c"]));
  });

  it("starts from empty when nothing was selected", () => {
    expect(toggleName(undefined, ["a", "b"], "a")).toEqual(new Set(["a"]));
  });

  it("does not mutate the selection it was given", () => {
    // React state: mutating in place means no re-render.
    const before = new Set(["a"]);
    toggleName(before, ["a", "b"], "b");
    expect(before).toEqual(new Set(["a"]));
  });

  it("never returns the string form, so a toggled group is always explicit", () => {
    const out: SelOrAll = toggleName("all", ["a"], "a");
    expect(out).not.toBe("all");
  });
});

describe("detectJoinKey", () => {
  it("prefers a shared *_id over anything else", () => {
    expect(detectJoinKey(["name", "customer_id"], ["customer_id", "name"])).toBe("customer_id");
  });

  it("prefers a bare id over an arbitrary shared column", () => {
    expect(detectJoinKey(["name", "id"], ["id", "name"])).toBe("id");
  });

  it("falls back to any shared column, as a suggestion", () => {
    // Joining on a coincidentally shared `name` is usually wrong — it is
    // offered because the user edits the SQL, never because it is trusted.
    expect(detectJoinKey(["name", "colour"], ["name", "size"])).toBe("name");
  });

  it("matches case-insensitively, since dialects disagree", () => {
    expect(detectJoinKey(["Customer_ID"], ["customer_id"])).toBe("Customer_ID");
  });

  it("returns null when the tables share nothing", () => {
    expect(detectJoinKey(["a"], ["b"])).toBeNull();
    expect(detectJoinKey([], ["b"])).toBeNull();
  });
});

describe("seedSql", () => {
  it("is empty with no tables", () => {
    expect(seedSql([])).toBe("");
  });

  it("selects from a single table with a limit", () => {
    expect(seedSql([{ name: "orders", cols: ["id"] }])).toBe("SELECT *\nFROM orders\nLIMIT 50");
  });

  it("joins on the detected key", () => {
    const sql = seedSql([
      { name: "orders", cols: ["id", "customer_id"] },
      { name: "customers", cols: ["customer_id", "name"] },
    ]);
    expect(sql).toContain("JOIN customers ON orders.customer_id = customers.customer_id");
    expect(sql.endsWith("LIMIT 50")).toBe(true);
  });

  it("emits a PLACEHOLDER when no key is found, rather than guessing", () => {
    // The placeholder does not run. That is the point: a query that fails
    // obviously beats one that silently returns a cross-product.
    const sql = seedSql([
      { name: "a", cols: ["x"] },
      { name: "b", cols: ["y"] },
    ]);
    expect(sql).toContain("<join_key>");
  });

  it("joins every table back to the FIRST one", () => {
    // Chaining b→c instead would change which rows survive.
    const sql = seedSql([
      { name: "a", cols: ["id"] },
      { name: "b", cols: ["id"] },
      { name: "c", cols: ["id"] },
    ]);
    expect(sql).toContain("JOIN b ON a.id = b.id");
    expect(sql).toContain("JOIN c ON a.id = c.id");
  });
});
