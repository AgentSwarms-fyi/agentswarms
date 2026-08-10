// Re-syncing a source must update documents, not replace them.
//
// The URL and GitHub ingest routes did this:
//
//     await admin.from("knowledge_documents").delete().eq("source_id", id);
//     await admin.from("knowledge_documents").insert(docs);
//
// which is only visibly wrong on the SECOND sync. Measured on github/gitignore
// before the fix: all four documents came back with new ids (959c1544 →
// fa5fb09b), fresh created_at, content_hash still null, last_sync_stats null.
//
// Three consequences:
//   * anything keyed to a document id is orphaned — including acl_principals,
//     the per-document access control, so a re-sync silently drops who could
//     see what;
//   * every document is re-embedded whether or not its text changed, against
//     docs/knowledge's explicit promise that "Embedding spend follows actual
//     content change, nothing else";
//   * the source card's "+added ~updated =unchanged −removed" line has nothing
//     to render.
//
// After the fix, same repo, ingest then re-sync with nothing changed upstream:
//
//     document ids            identical
//     kb_chunks rows          identical (12 → 12), response reported chunks: 0
//     last_sync_stats         {added:4} then {unchanged:4}
//
// The connector engine already reconciled correctly, but it is built around
// listItems/fetchItem, which these routes do not implement. So the shared piece
// is the reconciliation, not the fetching.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const reconcile = readFileSync(resolve("src/utils/kb/reconcileDocs.server.ts"), "utf8");
const gh = readFileSync(resolve("src/routes/api/kb/ingest-github.ts"), "utf8");
const url = readFileSync(resolve("src/routes/api/kb/ingest-url.ts"), "utf8");

/** Comments quote the old code to explain it; only the code should be matched. */
function codeOnly(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

describe("neither ingest route wipes its documents", () => {
  for (const [name, src] of [
    ["ingest-github", gh],
    ["ingest-url", url],
  ] as const) {
    it(`${name} no longer deletes by source_id before inserting`, () => {
      const code = codeOnly(src);
      expect(code, "file came back empty").toMatch(/\S/);
      expect(code).not.toMatch(/from\("knowledge_documents"\)\s*\.delete\(\)\s*\.eq\("source_id"/);
    });

    it(`${name} reconciles instead`, () => {
      expect(src).toMatch(/await reconcileSourceDocuments\(admin, \{/);
      expect(src).toMatch(
        /import \{ reconcileSourceDocuments, type IncomingDoc \} from "@\/utils\/kb\/reconcileDocs\.server"/,
      );
    });

    it(`${name} records the sync stats the source card renders`, () => {
      expect(src).toMatch(/last_sync_stats: stats/);
    });
  }

  it("each route supplies a stable external id for the remote item", () => {
    // The repo path and the URL respectively — without these every item looks
    // new on every sync and reconciliation degrades to insert-everything.
    expect(gh).toMatch(/externalId: b\.path/);
    expect(url).toMatch(/externalId: body\.url/);
  });
});

describe("the reconciler preserves identity and skips unchanged text", () => {
  it("hashes with the shared helper rather than its own", () => {
    expect(reconcile).toMatch(/import \{ sha256Hex \} from "\.\/dedup"/);
    expect(reconcile).toMatch(/const hash = sha256Hex\(item\.content\)/);
  });

  it("returns early for identical content without touching the chunks", () => {
    const i = reconcile.indexOf("prior.content_hash === hash");
    expect(i, "the unchanged branch moved").toBeGreaterThan(0);
    const branch = reconcile.slice(i, reconcile.indexOf("if (prior) {", i));
    // It refreshes the display name, and does NOT write content or the hash.
    expect(branch).toMatch(/stats\.unchanged \+= 1/);
    expect(branch).not.toMatch(/content: item\.content/);
    expect(branch).toMatch(/continue;/);
  });

  it("updates a changed document in place, keeping its id", () => {
    const i = reconcile.indexOf("if (prior) {");
    expect(i).toBeGreaterThan(0);
    const branch = reconcile.slice(i, reconcile.indexOf("const { data: inserted", i));
    expect(branch).toMatch(/\.update\(\{/);
    expect(branch).toMatch(/\.eq\("id", prior\.id\)/);
    // An update, never a delete-then-insert.
    expect(branch).not.toMatch(/\.delete\(\)/);
    expect(branch).not.toMatch(/\.insert\(/);
  });

  it("only returns changed documents for embedding", () => {
    // toEmbed is what the caller pays to embed. The unchanged branch must not
    // push into it — that was the whole cost of the old behaviour.
    const unchanged = reconcile.slice(
      reconcile.indexOf("prior.content_hash === hash"),
      reconcile.indexOf("if (prior) {"),
    );
    expect(unchanged).not.toMatch(/toEmbed\.push/);
    // …while both the changed and new branches do.
    expect(reconcile.match(/toEmbed\.push\(/g) ?? []).toHaveLength(2);
  });

  it("removes items that disappeared upstream", () => {
    expect(reconcile).toMatch(/stats\.removed = stale\.length/);
    expect(reconcile).toMatch(/\.in\("external_id", stale\)/);
  });

  it("writes external_id and content_hash on insert, so the next sync can diff", () => {
    const i = reconcile.indexOf("const { data: inserted");
    const insert = reconcile.slice(i, reconcile.indexOf("stats.added += 1", i));
    expect(insert).toMatch(/external_id: item\.externalId/);
    expect(insert).toMatch(/content_hash: hash/);
  });
});
