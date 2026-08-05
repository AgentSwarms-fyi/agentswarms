// Scheduled KB ingestion without duplicates.
//
// Two levels make a scheduled sync safe to run forever:
//   version skip  — unchanged provider marker ⇒ no download at all
//   hash skip     — same downloaded text ⇒ no re-embed (providers bump mtimes
//                   on moves/permission edits with the content untouched)
// diffRemoteItems is level one; the content_hash comparison inside
// syncKbSource is level two; the partial unique index on
// (source_id, external_id) is the backstop that makes duplicates impossible
// even if both levels are wrong.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { diffRemoteItems, sha256Hex } from "@/utils/kb/dedup";

const SYNC = readFileSync("src/utils/kb/sync.server.ts", "utf8");
const SCHEDULE = readFileSync("src/utils/kb/schedule.server.ts", "utf8");
const CONNECTORS = readFileSync("src/utils/kb/connectors.server.ts", "utf8");
const REFRESH = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
const SOURCES_ROUTE = readFileSync("src/routes/api/kb/sources.ts", "utf8");
const KNOWLEDGE_UI = readFileSync("src/routes/_authenticated/knowledge.tsx", "utf8");
const MIGRATION = readFileSync(
  "supabase/migrations/20260783000000_kb_connector_sources.sql",
  "utf8",
);

const item = (externalId: string, version: string) => ({ externalId, name: externalId, version });

describe("diffRemoteItems — the version-level skip", () => {
  it("skips an item whose provider marker is unchanged, without downloading", () => {
    const { toFetch, unchanged } = diffRemoteItems(
      [item("a", "v1")],
      [{ external_id: "a", version: "v1" }],
    );
    expect(unchanged.map((i) => i.externalId)).toEqual(["a"]);
    expect(toFetch).toEqual([]);
  });

  it("re-fetches when the marker changed", () => {
    const { toFetch, unchanged } = diffRemoteItems(
      [item("a", "v2")],
      [{ external_id: "a", version: "v1" }],
    );
    expect(toFetch.map((i) => i.externalId)).toEqual(["a"]);
    expect(unchanged).toEqual([]);
  });

  it("fetches new items and removes remotely-deleted ones", () => {
    const { toFetch, toRemoveExternalIds } = diffRemoteItems(
      [item("new", "v1")],
      [{ external_id: "gone", version: "v1" }],
    );
    expect(toFetch.map((i) => i.externalId)).toEqual(["new"]);
    expect(toRemoveExternalIds).toEqual(["gone"]);
  });

  it("an empty provider marker always re-fetches — never a false skip", () => {
    // A provider that returns no change marker gives level one nothing to
    // compare; skipping on "" == "" would freeze the document forever.
    const { toFetch, unchanged } = diffRemoteItems(
      [item("a", "")],
      [{ external_id: "a", version: "" }],
    );
    expect(toFetch.map((i) => i.externalId)).toEqual(["a"]);
    expect(unchanged).toEqual([]);
  });

  it("handles a mixed listing in one pass", () => {
    const { toFetch, unchanged, toRemoveExternalIds } = diffRemoteItems(
      [item("same", "v1"), item("changed", "v9"), item("brand-new", "v1")],
      [
        { external_id: "same", version: "v1" },
        { external_id: "changed", version: "v1" },
        { external_id: "deleted", version: "v1" },
        { external_id: null, version: null }, // legacy row without external_id
      ],
    );
    expect(unchanged.map((i) => i.externalId)).toEqual(["same"]);
    expect(toFetch.map((i) => i.externalId)).toEqual(["changed", "brand-new"]);
    expect(toRemoveExternalIds).toEqual(["deleted"]);
  });
});

describe("sha256Hex — the content-level skip's comparator", () => {
  it("is stable for identical text and differs for different text", () => {
    expect(sha256Hex("hello")).toBe(sha256Hex("hello"));
    expect(sha256Hex("hello")).not.toBe(sha256Hex("hello "));
    expect(sha256Hex("")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the sync engine honours both levels", () => {
  it("skips re-embedding when the downloaded text hashes unchanged", () => {
    expect(SYNC).toContain("prior.content_hash === hash");
    // ...and in that branch only the change marker is refreshed.
    expect(SYNC).toMatch(/content_hash === hash[\s\S]{0,900}stats\.unchanged \+= 1/);
  });

  it("updates documents in place so chunk replacement stays keyed by doc id", () => {
    expect(SYNC).toMatch(/\.update\(\{[\s\S]{0,400}content_hash: hash/);
  });

  it("embeds only the changed documents, never the full source", () => {
    expect(SYNC).toContain("if (docsToEmbed.length > 0)");
  });

  it("declines to guess ACLs the provider cannot supply", () => {
    expect(SYNC).toContain("acl_unavailable");
  });
});

describe("duplicates are impossible even if the code is wrong", () => {
  it("one document per (source, external item), enforced by the database", () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX[\s\S]{0,200}\(source_id, external_id\)[\s\S]{0,120}WHERE source_id IS NOT NULL AND external_id IS NOT NULL/,
    );
  });
});

describe("scheduling reuses the proven claim discipline", () => {
  it("claims by conditional update on next_sync_at (the saas pattern)", () => {
    // The `.lte` must be ON THE CLAIM UPDATE itself — the same expression also
    // appears in the due-listing select, which is not what makes the claim
    // atomic. Without the conditional on the update, two instances polling the
    // same second both "win" and the source syncs twice.
    expect(SCHEDULE).toMatch(
      /\.update\(\{ next_sync_at: nextSyncAt\(row\.sync_schedule\) \}\)[\s\S]{0,120}\.lte\("next_sync_at", nowIso\)/,
    );
  });

  it("is registered in the cron pass alongside the SaaS scheduler", () => {
    expect(REFRESH).toContain('import("@/utils/kb/schedule.server")');
    expect(REFRESH).toContain("processDueKbSyncs(force)");
  });

  it("the migration indexes exactly the scheduler's due query", () => {
    expect(MIGRATION).toMatch(/idx_kb_sources_due[\s\S]{0,120}WHERE sync_schedule <> 'manual'/);
  });
});

describe("credentials never travel to the browser", () => {
  it("the sources route returns explicit columns without credentials", () => {
    expect(SOURCES_ROUTE).toContain("const RETURN_COLUMNS");
    const decl = SOURCES_ROUTE.match(/const RETURN_COLUMNS =\s*"([^"]+)"/);
    expect(decl).not.toBeNull();
    expect(decl![1]).not.toContain("credentials");
  });

  it("the knowledge UI selects explicit columns without credentials", () => {
    // select("*") on kb_sources would ship ciphertext to the client.
    const kbSourceSelects =
      KNOWLEDGE_UI.match(/from\("kb_sources"\)[\s\S]{0,200}?\.select\([\s\S]*?\)/g) ?? [];
    expect(kbSourceSelects.length).toBeGreaterThan(0);
    for (const sel of kbSourceSelects) {
      expect(sel).not.toContain('select("*")');
      expect(sel).not.toContain("credentials");
    }
  });
});

describe("connector failures are loud, not empty", () => {
  it("HTTP errors throw with provider, status and body", () => {
    expect(CONNECTORS).toContain(
      "throw new Error(`${provider} ${res.status}: ${body.slice(0, 300)}`)",
    );
  });

  it("a silent [] on failure is designed out — the comment says why", () => {
    // "credentials revoked" must never present as "source is fine, zero
    // documents": every synced document would be deleted as remotely-removed.
    expect(CONNECTORS).toContain("deletes every synced document as remotely-removed");
  });
});
