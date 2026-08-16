// A connector-synced dataset should be filed under the connection it came from.
//
// REPORTED: after connecting Salesforce, all seven synced tables appeared in
// the Data Catalog under "Local tables". That was true about their storage —
// sync and upload share one ingest path on purpose — and useless as an answer
// to "where did this come from".
//
// These tests cover the mapping, and in particular the case where the source
// CANNOT be named: an asset filed under a source with no rail entry vanishes
// from every filter except "All", so it falls back to Local rather than to a
// category that does not exist.
import { describe, expect, it } from "vitest";

import {
  LOCAL_SOURCE_ID,
  SAAS_SOURCE_PREFIX,
  datasetSourceIds,
  isSaasSourceId,
  saasSourceId,
  saasSourcesFrom,
  type SaasAttributionRow,
  type SaasConnectionRow,
} from "@/lib/catalogSources";

const SF: SaasConnectionRow = { id: "conn-sf", name: "sftest", provider: "salesforce" };
const HS: SaasConnectionRow = { id: "conn-hs", name: "acme-hubspot", provider: "hubspot" };

/** The shape reloadLocal ends up with: map hit, or the local catch-all. */
const fileUnder = (map: Map<string, string>, tableId: string) =>
  map.get(tableId) ?? LOCAL_SOURCE_ID;

describe("source ids are namespaced", () => {
  it("prefixes a connection id", () => {
    expect(saasSourceId("conn-sf")).toBe(`${SAAS_SOURCE_PREFIX}conn-sf`);
  });

  it("cannot be confused with a crawled source id", () => {
    // Crawled sources are catalog_sources rows keyed by bare uuid, and both
    // kinds share one source_id field and one rail.
    expect(isSaasSourceId("8f0e1d2c-3b4a-5968-8776-a5b4c3d2e1f0")).toBe(false);
    expect(isSaasSourceId(LOCAL_SOURCE_ID)).toBe(false);
    expect(isSaasSourceId(saasSourceId("conn-sf"))).toBe(true);
  });

  it("presents each connection as a source the rail can render", () => {
    expect(saasSourcesFrom([SF, HS])).toEqual([
      { id: "saas:conn-sf", name: "sftest", provider: "salesforce", connectionId: "conn-sf" },
      { id: "saas:conn-hs", name: "acme-hubspot", provider: "hubspot", connectionId: "conn-hs" },
    ]);
  });

  it("keeps the bare connection id, so actions need not unparse the prefix", () => {
    // The rail's re-sync and reschedule address the CONNECTION. Recovering
    // that by slicing the prefix off the source id would reintroduce exactly
    // the string-parsing this module replaced.
    const [sf] = saasSourcesFrom([SF]);
    expect(sf.connectionId).toBe(SF.id);
    expect(sf.id).toBe(saasSourceId(SF.id));
  });
});

describe("attributing datasets to connections", () => {
  const rows: SaasAttributionRow[] = [
    { id: "t-accounts", saas_connection_id: "conn-sf" },
    { id: "t-opps", saas_connection_id: "conn-sf" },
    { id: "t-deals", saas_connection_id: "conn-hs" },
    { id: "t-upload", saas_connection_id: null },
  ];
  const map = datasetSourceIds(rows, [SF, HS]);

  it("files a synced table under its connection", () => {
    expect(fileUnder(map, "t-deals")).toBe("saas:conn-hs");
  });

  it("groups every table of one connection together", () => {
    expect(fileUnder(map, "t-accounts")).toBe("saas:conn-sf");
    expect(fileUnder(map, "t-opps")).toBe("saas:conn-sf");
  });

  it("does not cross-attribute between connections", () => {
    expect(fileUnder(map, "t-deals")).not.toBe("saas:conn-sf");
  });

  it("leaves an upload in the local bucket", () => {
    expect(fileUnder(map, "t-upload")).toBe(LOCAL_SOURCE_ID);
  });

  it("leaves a table it has never heard of in the local bucket", () => {
    expect(fileUnder(map, "t-not-in-attribution")).toBe(LOCAL_SOURCE_ID);
  });
});

describe("a source that cannot be named is not invented", () => {
  it("falls back to local when the connection row is missing", () => {
    // ON DELETE SET NULL covers a deleted connection, but this read can also
    // come back short: RLS, an error, a stale id. The asset must stay
    // reachable, and "stored locally" is the one thing still true about it.
    const map = datasetSourceIds([{ id: "t-orphan", saas_connection_id: "conn-gone" }], [SF]);
    expect(fileUnder(map, "t-orphan")).toBe(LOCAL_SOURCE_ID);
  });

  it("files nothing at all when the connection read comes back empty", () => {
    const map = datasetSourceIds([{ id: "t-accounts", saas_connection_id: "conn-sf" }], []);
    expect(map.size).toBe(0);
    expect(fileUnder(map, "t-accounts")).toBe(LOCAL_SOURCE_ID);
  });

  it("survives both reads being empty", () => {
    expect(datasetSourceIds([], []).size).toBe(0);
    expect(saasSourcesFrom([])).toEqual([]);
  });
});
