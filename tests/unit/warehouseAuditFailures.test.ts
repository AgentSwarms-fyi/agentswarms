// A refused warehouse query is the one an auditor most wants to see.
//
// The warehouse path itself is sound. Verified against the live Snowflake
// connection on this instance: a SELECT returned real rows in ~1.5s, and
// `DROP TABLE` was refused server-side with "Only read-only queries (SELECT /
// WITH / SHOW / DESCRIBE / EXPLAIN) are allowed".
//
// But auditEvent ran only AFTER a successful execute. Every failure — the
// read-only refusal included — fell into the catch and returned 400 with no
// audit row. So the trail recorded successful reads and nothing else:
//
//   before:  warehouse.query  SELECT … rows=5 tables=[tpcds_sf100tcl.reason]
//            (the DROP attempt: no row at all)
//
// "Someone pointed a DROP at the production warehouse and was stopped" is
// exactly the line the Audit Log page promises — "who did what, when …
// warehouse queries" — and exactly the one it did not have. Transient failures
// are recorded too, and are worth having: a connection that started refusing
// at 3am is the same question asked backwards.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const route = readFileSync(resolve("src/routes/api/warehouse/query.ts"), "utf8");

/** The catch block that handles a failed or refused query. */
function catchBlock(): string {
  const i = route.indexOf("} catch (e) {");
  expect(i, "the catch moved; this test needs re-anchoring").toBeGreaterThan(0);
  return route.slice(i, route.indexOf("return json(400", i) + 200);
}

describe("warehouse queries are audited whether or not they succeed", () => {
  it("CALLS auditEvent on failure, as a live statement", () => {
    // Anchored on a statement start, not on the identifier appearing
    // somewhere. Mutation testing earned this: replacing the call with
    // `void 0 && auditEvent({…})` left every text I was matching intact —
    // "auditEvent", `outcome: "failed"`, the sql and error fields — while the
    // call never ran, and the first version of this suite passed clean.
    expect(catchBlock()).toMatch(/^\s*auditEvent\(\{/m);
  });

  it("does not let the failure audit be short-circuited away", () => {
    expect(catchBlock()).not.toMatch(/(?:&&|\|\||\?)\s*auditEvent\(/);
  });

  it("records the outcome, so a refusal is distinguishable from a read", () => {
    expect(catchBlock()).toMatch(/outcome:\s*"failed"/);
  });

  it("records the SQL that was attempted and why it was refused", () => {
    const block = catchBlock();
    expect(block).toMatch(/sql:\s*body\.sql/);
    expect(block).toMatch(/error:\s*message/);
  });

  it("still audits the successful path with its tables and row count", () => {
    // The failure audit must not have displaced the one that already worked.
    const ok = route.slice(0, route.indexOf("} catch (e) {"));
    expect(ok).toContain("auditEvent");
    expect(ok).toMatch(/tables:\s*extractTableRefs/);
    expect(ok).toMatch(/rows:\s*result\.row_count/);
  });

  it("keeps the read-only guard as the thing that refuses", () => {
    // Auditing a refusal is worthless if the refusal stops happening. The
    // guard lives in executeWarehouseQuery; assert the route still calls it
    // rather than running SQL some other way.
    expect(route).toContain("executeWarehouseQuery");
  });
});
