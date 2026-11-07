// FOUND IN R458: dropping a materialized view's table, or its schema, left the
// view's definition behind, and nothing in the app could remove one. A
// schedule then rebuilt a table its owner had dropped, or, with the schema
// gone, failed on every run with no table to show the failure on.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  filters: [] as [string, string, string][],
  audited: [] as Record<string, unknown>[],
  rows: [{ id: "v1", schema_name: "sales", table_name: "big_eu" }] as Record<string, unknown>[],
}));

vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: Record<string, unknown>) => calls.audited.push(e),
}));
vi.mock("@/integrations/supabase/client.server", () => {
  const chain: Record<string, unknown> = {};
  const filter = (op: string) => (col: string, val: string) => {
    calls.filters.push([op, col, val]);
    return chain;
  };
  Object.assign(chain, {
    delete: () => chain,
    eq: filter("eq"),
    ilike: filter("ilike"),
    select: async () => ({ data: calls.rows, error: null }),
  });
  return { supabaseAdmin: { from: () => chain } };
});

const { forgetMatviewsFor } = await import("@/utils/lakehouse/matviews.server");

beforeEach(() => {
  calls.filters = [];
  calls.audited = [];
});

describe("a dropped table's or schema's views", () => {
  it("are forgotten for their owner only, by name and without case", async () => {
    expect(await forgetMatviewsFor("owner-1", [{ schema: "sales", table: "big_eu" }])).toBe(1);
    expect(calls.filters).toEqual([
      ["eq", "user_id", "owner-1"],
      ["ilike", "schema_name", "sales"],
      // An underscore is a LIKE wildcard: escaped, so big_eu cannot match bigXeu.
      ["ilike", "table_name", "big\\_eu"],
    ]);
    expect(calls.audited[0]).toMatchObject({
      action: "lakehouse.matview.delete",
      resourceName: "sales.big_eu",
      detail: { reason: "its table was dropped" },
    });
  });

  it("are all forgotten when the schema goes", async () => {
    await forgetMatviewsFor("owner-1", [{ schema: "sales" }]);
    expect(calls.filters.map(([, col]) => col)).toEqual(["user_id", "schema_name"]);
    expect(calls.audited[0]).toMatchObject({ detail: { reason: "its schema was dropped" } });
  });

  it("go with both ways a table or schema is dropped", () => {
    const core = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");
    const after = core.slice(core.indexOf('if (classified.verb === "DROP TABLE") {'));
    expect(after.slice(0, 700)).toContain("await forgetMatviewsFor(userId, dropped)");
    const fns = readFileSync("src/utils/lakehouse.functions.ts", "utf8");
    const drop = fns.slice(fns.indexOf("export const dropLakehouseSchema"));
    expect(drop.slice(0, drop.indexOf("return { ok: true };"))).toContain(
      "await forgetMatviewsFor(userId, [{ schema: data.name }]);",
    );
  });

  it("can be stopped from the table's tab, keeping the table", () => {
    const page = readFileSync("src/routes/_authenticated/lakehouse.tsx", "utf8");
    expect(page).toContain('data-testid="matview-forget"');
    expect(page).toContain("await forgetMvFn({ data: { access_token: token, id: matview.id } });");
  });
});
