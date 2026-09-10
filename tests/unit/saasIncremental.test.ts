// Incremental SaaS sync: following a source instead of re-reading it.
//
// Every sync used to be a full refresh — page the whole source, replace the
// dataset. That is right for a spreadsheet and untenable for a Salesforce org:
// re-reading millions of records hourly burns the customer's rate limit for no
// new information and eventually takes longer than the interval it runs on.
//
// The decisions worth pinning are the ones that go wrong SILENTLY. A cursor
// that moves when it should not skips rows for ever and nothing reports it; a
// merge without a primary key turns every edit into a duplicate row; a cursor
// written before the rows are committed loses a whole window on the next run.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  advanceCursor,
  cursorAdvances,
  SYNC_MODES,
  type IncrementalSpec,
} from "@/utils/saas/types";

const rd = (p: string) => readFileSync(p, "utf8");

const ISO: IncrementalSpec = { cursorField: "updated", primaryKey: "id", compare: "iso" };
const NUM: IncrementalSpec = { cursorField: "seq", primaryKey: "id", compare: "number" };

describe("the cursor only ever moves forward", () => {
  it("advances from nothing to anything", () => {
    expect(cursorAdvances(null, "2026-01-01T00:00:00Z", "iso")).toBe(true);
    expect(cursorAdvances("", "5", "number")).toBe(true);
  });

  it("does not advance on a tie", () => {
    // An API that returns records with the same timestamp across a page
    // boundary would otherwise lose every one after the first.
    expect(cursorAdvances("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "iso")).toBe(false);
    expect(cursorAdvances("5", "5", "number")).toBe(false);
  });

  it("does not go backwards", () => {
    expect(cursorAdvances("2026-06-01T00:00:00Z", "2026-01-01T00:00:00Z", "iso")).toBe(false);
    expect(cursorAdvances("10", "9", "number")).toBe(false);
  });

  it("compares numbers as numbers, not as text", () => {
    // "9" > "10" as strings. A numeric cursor compared lexically walks
    // BACKWARDS at every power of ten, re-reading everything for ever.
    expect(cursorAdvances("9", "10", "number")).toBe(true);
    expect(cursorAdvances("10", "9", "number")).toBe(false);
  });

  it("refuses to advance on a value it cannot read", () => {
    // Refusing is the safe half of the mistake: it re-reads rather than skips.
    expect(cursorAdvances("2026-01-01T00:00:00Z", "not a date", "iso")).toBe(false);
    expect(cursorAdvances("5", "banana", "number")).toBe(false);
    expect(cursorAdvances(null, null, "iso")).toBe(false);
    expect(cursorAdvances("5", "", "number")).toBe(false);
  });

  it("takes the highest in a batch, whatever order it arrives in", () => {
    const rows = [
      { id: "a", updated: "2026-03-01T00:00:00Z" },
      { id: "b", updated: "2026-05-01T00:00:00Z" },
      { id: "c", updated: "2026-04-01T00:00:00Z" },
    ];
    expect(advanceCursor(null, rows, ISO)).toBe("2026-05-01T00:00:00Z");
    // An API that does not sort is not a reason to lose ground.
    expect(advanceCursor("2026-06-01T00:00:00Z", rows, ISO)).toBe("2026-06-01T00:00:00Z");
  });

  it("ignores rows with no cursor value rather than resetting", () => {
    // A record the API returned without the field must not drag the mark back
    // to null, which would re-read the source from the beginning next time.
    const rows = [{ id: "a" }, { id: "b", updated: null }, { id: "c", updated: undefined }];
    expect(advanceCursor("2026-01-01T00:00:00Z", rows, ISO)).toBe("2026-01-01T00:00:00Z");
    // And a mixed batch still takes the one real value in it.
    const mixed = [{ id: "a" }, { id: "b", updated: "2026-02-01T00:00:00Z" }];
    expect(advanceCursor("2026-01-01T00:00:00Z", mixed, ISO)).toBe("2026-02-01T00:00:00Z");
  });

  it("handles a numeric batch", () => {
    const rows = [
      { id: "a", seq: 3 },
      { id: "b", seq: 41 },
      { id: "c", seq: 9 },
    ];
    expect(advanceCursor("2", rows, NUM)).toBe("41");
  });
});

describe("what a connector must declare to sync incrementally", () => {
  it("offers exactly two modes", () => {
    expect([...SYNC_MODES]).toEqual(["full_refresh", "incremental"]);
  });

  it("every declared spec names a key AND a cursor, with a comparison", async () => {
    // A spec missing the primary key can only append, so an edited record
    // arrives as a SECOND row and the dataset grows duplicates silently.
    const { connectorFor } = await import("@/utils/saas/sync.server");
    const { SAAS_PROVIDERS } = await import("@/utils/saas/types");
    let declared = 0;
    for (const provider of SAAS_PROVIDERS) {
      const connector = connectorFor(provider);
      if (!connector.incremental) continue;
      const streams = STREAM_IDS[provider] ?? [];
      expect(streams.length, `no stream ids listed for ${provider}`).toBeGreaterThan(0);
      for (const stream of streams) {
        const spec = connector.incremental(stream);
        if (!spec) continue;
        declared += 1;
        expect(spec.cursorField, `${provider}.${stream} cursorField`).toBeTruthy();
        expect(spec.primaryKey, `${provider}.${stream} primaryKey`).toBeTruthy();
        expect(["iso", "number"]).toContain(spec.compare);
      }
    }
    expect(declared, "no connector declares incremental support").toBeGreaterThan(0);
  });

  it("says no for a stream it does not know", async () => {
    const { connectorFor } = await import("@/utils/saas/sync.server");
    expect(connectorFor("salesforce").incremental?.("not_a_stream")).toBeNull();
    expect(connectorFor("stripe").incremental?.("not_a_stream")).toBeNull();
  });

  it("leaves a mutable Stripe object on full refresh, deliberately", () => {
    // `customers` and `subscriptions` are edited in place and their `created`
    // never moves, so following it would miss every edit.
    const src = rd("src/utils/saas/stripe.server.ts");
    const table = src.slice(
      src.indexOf("const INCREMENTAL"),
      src.indexOf("export function stripeIncremental"),
    );
    expect(table).toContain("charges:");
    expect(table).not.toContain("customers:");
    expect(table).not.toContain("subscriptions:");
  });

  it("follows Salesforce's SystemModstamp, not LastModifiedDate", () => {
    // LastModifiedDate reflects user edits only. SystemModstamp also moves on
    // a merge, a cascade or a bulk update — the changes nobody notices missing.
    const src = rd("src/utils/saas/salesforce.server.ts");
    expect(src).toContain('cursorField: "SystemModstamp"');
    expect(src).not.toMatch(/cursorField: "LastModifiedDate"/);
    // Ordered, or paging past the first page returns arbitrary records.
    expect(src).toContain("ORDER BY SystemModstamp ASC");
  });

  it("asks Stripe for a closed interval, so a boundary row is not dropped", () => {
    // `gt` would drop any record sharing the exact second of the last one
    // seen; `gte` re-reads it and the primary key folds it away.
    const src = rd("src/utils/saas/stripe.server.ts");
    expect(src).toContain("created[gte]");
    expect(src).not.toContain("created[gt]:");
  });
});

/** The streams each connector offers, for the conformance sweep above. */
const STREAM_IDS: Record<string, string[]> = {
  stripe: [
    "charges",
    "customers",
    "invoices",
    "subscriptions",
    "payment_intents",
    "products",
    "prices",
    "refunds",
    "payouts",
    "balance_transactions",
  ],
  salesforce: ["accounts", "contacts", "leads", "opportunities", "cases", "campaigns", "users"],
};

describe("the runner cannot lose or skip a window", () => {
  const runner = () => rd("src/utils/saas/sync.server.ts");

  it("writes the cursor only after the rows are committed", () => {
    // Advanced first and then lost to a failed ingest, the next run skips
    // everything in that window and nothing ever says so.
    const src = runner();
    const ingest = src.indexOf("const result = await ingestRows");
    const write = src.indexOf("await writeStreamState");
    expect(ingest).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(ingest);
  });

  it("replaces rather than merges on the FIRST pass", () => {
    // With no cursor the connector reads everything, so merging into a stale
    // dataset would leave rows the source has since deleted, for ever.
    const src = runner();
    expect(src).toContain("const merging = Boolean(spec && since);");
    expect(src).toContain("...(merging && spec ? { mergeKey: spec.primaryKey } : {})");
  });

  it("tracks the high-water mark as rows stream past, not afterwards", () => {
    // The generator is consumed once by ingestRows and cannot be replayed.
    const src = runner();
    expect(src).toMatch(/for await \(const row of connector\.fetchRows[\s\S]{0,200}?advanceCursor/);
  });

  it("passes the stored cursor to the connector, and nothing when full", () => {
    const src = runner();
    expect(src).toContain("const since = state?.cursor ?? undefined;");
    expect(src).toContain("args.fullRefresh ? null : (connector.incremental?.(args.streamId)");
  });

  it("offers a way to forget the cursor", () => {
    // The escape hatch for what a cursor cannot see: records changed without
    // moving their cursor field, or a backfill predating the connection.
    expect(runner()).toContain("export async function resetStreamCursor");
  });
});

describe("the merge is a database statement, and it is owner-safe", () => {
  const sql = () => rd("supabase/migrations/20260897000000_saas_incremental.sql");

  it("refuses to splice one owner's rows into another's dataset", () => {
    expect(sql()).toContain("datasets have different owners");
  });

  it("is not callable by a signed-in client", () => {
    // A client that could set its own cursor could skip rows it did not want
    // synced, or force a full re-read of somebody's paid API quota.
    const s = sql();
    expect(s).toMatch(
      /REVOKE ALL ON FUNCTION public\.merge_dataset_rows[\s\S]{0,80}?authenticated/,
    );
    expect(s).toContain('CREATE POLICY "Users read own stream state"');
    expect(s).not.toMatch(/saas_stream_state FOR (INSERT|UPDATE|ALL)/);
  });

  it("does not let one keyless row delete the others", () => {
    // A NULL key matches nothing, so it can only ever be an insert.
    expect(sql()).toContain("(row ->> p_key) IS NOT NULL");
  });

  it("refuses a dataset with no owner, which is what a sample is", () => {
    // `user_data_tables.user_id` is NULLABLE because sample datasets belong to
    // nobody. Treating NULL as "matches any owner" would let a connector merge
    // into the shared samples every deployment ships with.
    const s = sql();
    expect(s).toContain("unknown or unowned dataset");
    expect(s).toContain("IF v_owner IS NULL OR v_staging_owner IS NULL THEN");
  });

  it("counts updates and inserts separately", () => {
    const s = sql();
    expect(s).toContain("RETURNS TABLE (updated integer, inserted integer)");
  });

  it("keys the high-water mark per stream, not per connection", () => {
    // One Stripe connection syncing charges and customers has two independent
    // marks; one stream failing must not rewind the other.
    expect(sql()).toContain("PRIMARY KEY (connection_id, stream)");
  });
});

describe("the ingest path still replaces for everything else", () => {
  it("only the connector call site can merge", () => {
    // An upload has no cursor and must keep replacing.
    const src = rd("src/utils/data/ingest.server.ts");
    expect(src.match(/mergeKey: args\.mergeKey/g)?.length).toBe(1);
    expect(src).toContain("if (args.mergeKey) {");
  });

  it("snapshots the dataset before either path touches it", () => {
    // The recovery story for a sync that pulls a truncated source.
    const src = rd("src/utils/data/ingest.server.ts");
    const snap = src.indexOf("snapshotDatasetQuiet");
    const merge = src.indexOf("merge_dataset_rows");
    expect(snap).toBeGreaterThan(0);
    expect(merge).toBeGreaterThan(snap);
  });
});

describe("it is operable, and the costly half is the owner's", () => {
  it("shows the mode for EVERY selected stream, not just followed ones", () => {
    // A stream on full refresh has no state row, and is exactly the one
    // somebody is looking for when they ask why a sync takes an hour.
    const fns = rd("src/utils/saas.functions.ts");
    expect(fns).toContain("states: conn.streams.map((stream)");
    expect(fns).toContain("connector.incremental?.(stream)");
  });

  it("lets a grantee look but not spend the owner's quota", () => {
    // Triggering a sync is shared; a full re-read is charged to the owner's
    // API limit and can take hours.
    const fns = rd("src/utils/saas.functions.ts");
    const reset = fns.slice(fns.indexOf("export const resetSaasCursor"));
    expect(reset).toContain("allowShared: false");
    const states = fns.slice(
      fns.indexOf("export const saasStreamStates"),
      fns.indexOf("export const resetSaasCursor"),
    );
    expect(states).toContain("allowShared: true");
  });

  it("audits a reset, because it spends something", () => {
    // "Why did we hit Salesforce's API ceiling on Tuesday" is a question this
    // answers.
    const fns = rd("src/utils/saas.functions.ts");
    expect(fns).toContain('action: "saas_connection.cursor_reset"');
    expect(fns).toMatch(/cursor_reset[\s\S]{0,400}?streams:/);
  });

  it("hides Start over from a grantee, rather than letting it always fail", () => {
    const ui = rd("src/components/integrations/StreamStateDialog.tsx");
    expect(ui).toContain('s.mode === "incremental" && !shared');
    // And says why, instead of showing nothing.
    expect(ui).toContain("Shared source — starting over is the owner's to decide.");
  });

  it("no longer tells everyone that a sync always replaces", () => {
    // The card said "A sync REPLACES that dataset" — true of every source
    // until this milestone, and now only half the story. A claim the product
    // makes about itself is the first thing an operator believes.
    const tab = rd("src/components/integrations/SaasSourcesTab.tsx");
    expect(tab).not.toContain("A sync REPLACES that dataset");
    expect(tab).toContain("it got to last time");
    expect(tab).toContain("is re-read in full, replacing the dataset");
  });

  it("distinguishes 'nothing changed' from 'never followed'", () => {
    // The two look identical from outside and mean opposite things.
    const ui = rd("src/components/integrations/StreamStateDialog.tsx");
    expect(ui).toContain("Not followed yet");
    expect(ui).toContain("Caught up to");
  });
});
