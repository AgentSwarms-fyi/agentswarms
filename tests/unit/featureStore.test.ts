// The online feature store's rules, away from any server.
//
// Everything here decides ONE question: may the store answer this lookup? Get
// it wrong in the permissive direction and a model is scored on numbers from a
// table that has since changed, which looks exactly like a model that has
// started being wrong for no reason.
import { describe, expect, it } from "vitest";

import {
  ageMinutes,
  completenessNote,
  isComplete,
  keyTtlSeconds,
  metaKey,
  nextPageRows,
  onlineKey,
  refusalMessage,
  shouldContinue,
  storeRefusal,
  viewDefinition,
  viewKeyPattern,
  type OnlineMeta,
} from "@/lib/featureStore";

const view = {
  schema_name: "analytics",
  table_name: "customer_features",
  key_columns: ["customer_id"],
  feature_columns: ["orders_30d", "days_since_signup"],
  timestamp_column: null as string | null,
};

const meta = (over: Partial<OnlineMeta> = {}): OnlineMeta => ({
  refreshed_at: "2026-09-14T12:00:00.000Z",
  rows: 100,
  source_rows: 100,
  def: viewDefinition(view),
  ...over,
});

describe("what the stored rows were built from", () => {
  it("changes when anything about the view changes", () => {
    const base = viewDefinition(view);
    expect(viewDefinition({ ...view, table_name: "other" })).not.toBe(base);
    expect(viewDefinition({ ...view, key_columns: ["account_id"] })).not.toBe(base);
    expect(viewDefinition({ ...view, feature_columns: ["orders_30d"] })).not.toBe(base);
    expect(viewDefinition({ ...view, timestamp_column: "as_of" })).not.toBe(base);
  });

  it("and treats a reordered key as a different key, because it is", () => {
    // (region, plan) and (plan, region) fingerprint their rows differently, so
    // a store built under one cannot answer for the other. Sorting the columns
    // here would have quietly declared them the same view.
    const a = viewDefinition({ ...view, key_columns: ["region", "plan"] });
    const b = viewDefinition({ ...view, key_columns: ["plan", "region"] });
    expect(a).not.toBe(b);
  });
});

describe("whether the store may answer at all", () => {
  const now = new Date("2026-09-14T12:30:00.000Z");
  const def = viewDefinition(view);

  it("not before anything has been written", () => {
    expect(storeRefusal(null, def, now, 60)).toBe("no-meta");
  });

  it("not when the view has changed since the refresh", () => {
    const other = viewDefinition({ ...view, feature_columns: ["orders_30d"] });
    expect(storeRefusal(meta({ def: other }), def, now, 60)).toBe("definition-changed");
  });

  it("not when the rows are older than the limit", () => {
    expect(storeRefusal(meta(), def, now, 60)).toBeNull();
    expect(storeRefusal(meta(), def, now, 29)).toBe("stale");
  });

  it("and a changed view is reported as changed, not as stale", () => {
    // Both are true of an old store whose view was edited. Reporting staleness
    // sends its owner to refresh on a schedule for ever; reporting the change
    // tells them the one thing that actually fixes it.
    const old = meta({
      refreshed_at: "2020-01-01T00:00:00.000Z",
      def: viewDefinition({ ...view, table_name: "other" }),
    });
    expect(storeRefusal(old, def, now, 60)).toBe("definition-changed");
  });

  it("exactly at the limit it is still trusted", () => {
    // 30 minutes old with a 30-minute limit. A boundary decided by `>` rather
    // than `>=` on purpose: the alternative refuses a store the moment it
    // reaches its own setting, which reads as the setting being off by one.
    expect(storeRefusal(meta(), def, now, 30)).toBeNull();
    expect(storeRefusal(meta(), def, now, 29)).toBe("stale");
  });
});

describe("how old the rows are", () => {
  it("is measured in minutes", () => {
    expect(ageMinutes(meta(), new Date("2026-09-14T12:30:00.000Z"))).toBe(30);
  });

  it("never goes negative when the clocks disagree", () => {
    // The refresher and the reader can be different machines. A negative age
    // would pass every staleness check for ever, which is the worst direction
    // for a clock problem to fail in.
    expect(ageMinutes(meta(), new Date("2026-09-14T11:00:00.000Z"))).toBe(0);
  });

  it("and an unparseable timestamp is infinitely old, not zero", () => {
    expect(ageMinutes({ refreshed_at: "not a date" }, new Date())).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("whether the store holds the whole view", () => {
  it("knows when it does", () => {
    expect(isComplete({ rows: 100, source_rows: 100 })).toBe(true);
    expect(completenessNote({ rows: 100, source_rows: 100 })).toBeNull();
  });

  it("and says so plainly when it does not", () => {
    expect(completenessNote({ rows: 40, source_rows: 100 })).toContain("40 of 100");
  });

  it("a refresh that stopped at the cap is not complete, even at a round number", () => {
    // source_rows null means the scan never reached the end. Treating "wrote
    // 500,000" as complete would claim the whole view on exactly the store
    // most likely to be missing keys.
    expect(isComplete({ rows: 500_000, source_rows: null })).toBe(false);
    expect(completenessNote({ rows: 500_000, source_rows: null })).toContain("500,000");
  });

  it("and groups digits the same way wherever the server is", () => {
    // toLocaleString would render a million as "10,00,000" on an en-IN host,
    // and this string is read by whoever opens the panel, not by the machine
    // that wrote it. The same reason the parallel-training warnings group by
    // hand.
    expect(completenessNote({ rows: 1_000_000, source_rows: 2_500_000 })).toContain(
      "1,000,000 of 2,500,000",
    );
  });
});

describe("the keys the store uses", () => {
  it("namespace a view's rows under the view", () => {
    expect(onlineKey("v1", '["c-1"]')).toBe('fv:v1:k:["c-1"]');
    expect(metaKey("v1")).toBe("fv:v1:meta");
    expect(viewKeyPattern("v1")).toBe("fv:v1:*");
  });

  it("and the pattern that drops a view covers its meta as well as its rows", () => {
    // Leaving the meta behind would leave a view that says it was refreshed
    // and holds nothing.
    const pattern = viewKeyPattern("v1").replace("*", "");
    expect(onlineKey("v1", "x").startsWith(pattern)).toBe(true);
    expect(metaKey("v1").startsWith(pattern)).toBe(true);
  });
});

describe("the refresh's own accounting", () => {
  it("stops at the end of the table", () => {
    expect(shouldContinue({ written: 10, pages: 1, reachedEnd: true }, 1000)).toBe(false);
  });

  it("stops at the key cap", () => {
    expect(shouldContinue({ written: 1000, pages: 5, reachedEnd: false }, 1000)).toBe(false);
    expect(shouldContinue({ written: 999, pages: 5, reachedEnd: false }, 1000)).toBe(true);
  });

  it("and never asks for more rows than the cap leaves room for", () => {
    // Asking for a full page when 3 keys remain would write past a limit the
    // operator set, on the one path where the limit is what protects a bounded
    // server from a huge table.
    expect(nextPageRows({ written: 997, pages: 1, reachedEnd: false }, 1000, 50_000)).toBe(3);
    expect(nextPageRows({ written: 0, pages: 0, reachedEnd: false }, 1000, 50_000)).toBe(1000);
    expect(nextPageRows({ written: 1000, pages: 1, reachedEnd: false }, 1000, 50_000)).toBe(0);
  });
});

describe("what a key's own lifetime is", () => {
  it("outlives the staleness limit, so expiry is not what enforces it", () => {
    // The read path refuses stale rows itself. The TTL is only there so an
    // abandoned view stops occupying the store, and a key that vanished while
    // its meta still said fresh would cost a fallback rather than an error.
    expect(keyTtlSeconds(60)).toBe(7200);
    expect(keyTtlSeconds(60)).toBeGreaterThan(60 * 60);
  });

  it("and is never zero, whatever the setting", () => {
    expect(keyTtlSeconds(0)).toBeGreaterThanOrEqual(60);
  });
});

describe("what an operator is told", () => {
  it("names the view and says where lookups are going instead", () => {
    for (const r of ["no-meta", "definition-changed", "stale", "miss"] as const) {
      const m = refusalMessage(r, "order_features");
      expect(m).toContain("order_features");
      expect(m.toLowerCase()).toContain("lakehouse");
    }
  });
});
