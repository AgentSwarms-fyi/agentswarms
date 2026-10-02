// A failed access check is not a refusal.
//
// `accessibleSchemas` asked the database which lakehouse schemas an account
// may use, DROPPED the error, and returned `data ?? []`. A blip therefore came
// back as "this account can reach no schema at all", and five callers report
// that as a fact about the account rather than about the read:
//
//   ETL preflight   no access to lakehouse schema "analytics" — it doesn't
//                   exist, or nobody shared it with this pipeline's owner
//   SQL path        No access to schema "analytics" — it doesn't exist, or
//                   nobody shared it with you
//   matviews        the same, when refreshing a view
//   Iceberg         the same, when publishing a table
//
// Each invites the reader to fix it by granting access they already have.
//
// Caught on a live run rather than by reading: a Kafka pipeline wrote
// analytics.kafka_orders successfully, and a later run of the SAME pipeline
// was refused for having no access to `analytics` — while the same owner
// queried that very table in the SQL editor seconds afterwards and got its 90
// rows. This is the defect class the adversarial log calls the dominant one,
// found for the sixteenth time.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const core = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");

/** The body of accessibleSchemas, and only that. */
function body(): string {
  const at = core.indexOf("export async function accessibleSchemas");
  expect(at, "accessibleSchemas was renamed; re-anchor this test").toBeGreaterThan(-1);
  const end = core.indexOf("\nexport ", at + 10);
  const slice = core.slice(at, end > -1 ? end : core.length);
  expect(slice.length).toBeGreaterThan(200);
  return slice;
}

describe("asking which schemas an account may use", () => {
  it("keeps the error instead of dropping it", () => {
    const fn = body();
    expect(fn).toContain("const { data, error } = await supabaseAdmin.rpc(");
    expect(fn).toMatch(/if \(error\) \{/);
  });

  it("says the check failed, not that access was refused", () => {
    const fn = body();
    // The wording matters more than usual here: the whole defect is a sentence
    // that sounds like a permissions answer when it is a read failure.
    expect(fn).toContain("Could not read which lakehouse schemas");
    expect(fn).toMatch(/failure to check access, not a refusal/);
    // And it carries the database's own message, so the cause is visible.
    expect(fn).toContain("${error.message}");
  });

  it("still returns an empty list when the read SUCCEEDS and finds nothing", () => {
    // An account genuinely granted nothing is a real state, and must keep
    // reading as one — the fix is about telling the two apart, not about
    // refusing to answer.
    const fn = body();
    expect(fn).toContain("return (data ?? []) as SchemaRow[];");
    // The fallback comes AFTER the error check, or it swallows again.
    expect(fn.indexOf("if (error)")).toBeLessThan(fn.indexOf("return (data ?? [])"));
  });
});

describe("what the callers do with it", () => {
  it("every one of them turns an empty list into a refusal", () => {
    // This is why one swallowed error had five faces. Listed here so that a
    // caller added later is a deliberate choice rather than a surprise.
    const etl = readFileSync("src/utils/etl/service.server.ts", "utf8");
    expect(etl).toContain("no access to lakehouse schema");
    expect(core).toContain('No access to schema "${schema}"');
    const matviews = readFileSync("src/utils/lakehouse/matviews.server.ts", "utf8");
    expect(matviews).toContain("accessibleSchemas");
    const iceberg = readFileSync("src/utils/icebergCatalogs.functions.ts", "utf8");
    expect(iceberg).toContain("accessibleSchemas");
  });
});
