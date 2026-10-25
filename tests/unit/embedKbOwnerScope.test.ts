// A public embed must not retrieve a knowledge base its owner does not own.
//
// VA-2026-10-25-10. The embed chat path runs with the SERVICE-ROLE client and
// RLS off; `scopeUserId` is the only tenant boundary on which KBs it will read.
// The agent's wired `knowledgeBaseIds` (cfg.kbIds) are attacker-chosen — an
// embed owner can type any KB id into their config, including one they merely
// learned the id of. Marking the visitor anonymous (`principal`) only drops
// per-document 'private'/'source_acl' content; it does NOT drop a whole foreign
// KB. The ownership filter does, and it runs only when `scopeUserId` is set.
//
// These exercise retrieveCitationsReport's guard directly. The seam: when the
// guard drops every id it returns `{ searched: 0 }` BEFORE the next DB touch,
// which is a select of "id, retrieval_settings". So "dropped" vs "proceeded"
// is observable without embeddings — we watch which selects the client sees.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const OWN_KB = "11111111-1111-4000-8000-000000000001";
const FOREIGN_KB = "22222222-2222-4000-8000-000000000002";
const SAMPLE_KB = "33333333-3333-4000-8000-000000000003";
const GRANTED_KB = "44444444-4444-4000-8000-000000000004";

// The IAM grant lookup is the second half of the allow-set; the test drives it.
const granted = new Set<string>();
vi.mock("@/utils/iam.server", () => ({
  resolveGrantedResourceIds: async () => granted,
}));

type KbRow = { id: string; user_id: string; is_sample: boolean };

/**
 * A Supabase stand-in that is also a thenable query builder. Every builder
 * method returns the same object so any chain (.select().in().limit()…) works,
 * and awaiting it resolves to a configured result. It records each select's
 * columns so the test can see how far past the guard execution reached.
 */
function makeSb(ownerRows: KbRow[]) {
  const selects: string[] = [];
  const build = (table: string) => {
    let cols = "";
    const p: Record<string, unknown> = {};
    const self = () => p;
    Object.assign(p, {
      select: (c: string) => {
        cols = c;
        selects.push(`${table}:${c}`);
        return p;
      },
      in: self,
      eq: self,
      limit: self,
      range: self,
      order: self,
      not: self,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      // Thenable: `await chain` / Promise.all resolve here.
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        if (table === "knowledge_bases" && cols === "id, user_id, is_sample") {
          resolve({ data: ownerRows, error: null });
        } else {
          resolve({ data: [], error: null });
        }
      },
    });
    return p;
  };
  const sb = {
    from: (t: string) => build(t),
    rpc: async () => ({ data: [], error: null }),
  };
  return { sb, selects };
}

// The retrieval_settings select is the first DB touch AFTER the ownership
// guard, so its presence means the guard let at least one KB through.
const PROCEEDED = "knowledge_bases:id, retrieval_settings";

async function run(args: { sb: unknown; extraKbIds: string[]; scopeUserId?: string }) {
  const { retrieveCitationsReport } = await import("@/utils/tools/kb.server");
  return retrieveCitationsReport({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sb: args.sb as any,
    query: "anything",
    extraKbIds: args.extraKbIds,
    scopeUserId: args.scopeUserId,
    // The embed path always marks the visitor anonymous; userId stays null so
    // the test never reaches provider-credential resolution.
    userId: null,
    principal: { anonymous: true },
  });
}

beforeEach(() => {
  granted.clear();
});

describe("with scopeUserId set, the guard bounds KBs to the owner's reach", () => {
  it("drops a KB owned by someone else before any search runs", async () => {
    const { sb, selects } = makeSb([{ id: FOREIGN_KB, user_id: OTHER, is_sample: false }]);
    const res = await run({ sb, extraKbIds: [FOREIGN_KB], scopeUserId: OWNER });
    expect(res.searched).toBe(0);
    expect(res.citations).toEqual([]);
    expect(selects).not.toContain(PROCEEDED);
  });

  it("keeps the owner's own KB and proceeds to search", async () => {
    const { sb, selects } = makeSb([{ id: OWN_KB, user_id: OWNER, is_sample: false }]);
    await run({ sb, extraKbIds: [OWN_KB], scopeUserId: OWNER });
    expect(selects).toContain(PROCEEDED);
  });

  it("keeps a public sample KB even though the owner does not own it", async () => {
    const { sb, selects } = makeSb([{ id: SAMPLE_KB, user_id: OTHER, is_sample: true }]);
    await run({ sb, extraKbIds: [SAMPLE_KB], scopeUserId: OWNER });
    expect(selects).toContain(PROCEEDED);
  });

  it("keeps a KB shared to the owner by an IAM grant", async () => {
    granted.add(GRANTED_KB);
    const { sb, selects } = makeSb([{ id: GRANTED_KB, user_id: OTHER, is_sample: false }]);
    await run({ sb, extraKbIds: [GRANTED_KB], scopeUserId: OWNER });
    expect(selects).toContain(PROCEEDED);
  });

  it("drops the foreign KB from a mixed list but keeps the owned one", async () => {
    const { sb, selects } = makeSb([
      { id: OWN_KB, user_id: OWNER, is_sample: false },
      { id: FOREIGN_KB, user_id: OTHER, is_sample: false },
    ]);
    const res = await run({ sb, extraKbIds: [OWN_KB, FOREIGN_KB], scopeUserId: OWNER });
    // One survived, so the search proceeds — but only over the owned id.
    expect(selects).toContain(PROCEEDED);
    expect(res.searched).not.toBe(0);
  });
});

describe("the gap this closes", () => {
  it("WITHOUT scopeUserId, an anonymous visitor still reaches a foreign KB", async () => {
    // This is the bug: the embed path marked visitors anonymous but passed no
    // scopeUserId, so a wired foreign KB id was searched. The anonymous flag
    // alone does not drop a whole KB — only per-document ACL content.
    const { sb, selects } = makeSb([{ id: FOREIGN_KB, user_id: OTHER, is_sample: false }]);
    await run({ sb, extraKbIds: [FOREIGN_KB] });
    expect(selects).toContain(PROCEEDED);
  });
});

describe("the embed route wires the owner scope", () => {
  const EMBED_CHAT = readFileSync("src/routes/api/embed.chat.ts", "utf8");

  it("passes scopeUserId: keyRow.user_id into retrieveCitationsServer", () => {
    // Without this line the guard above never runs on the embed path, whatever
    // the function itself does.
    expect(EMBED_CHAT).toContain("scopeUserId: keyRow.user_id");
  });

  it("still marks the visitor anonymous (per-document ACL stays enforced)", () => {
    expect(EMBED_CHAT).toContain("principal: { anonymous: true }");
  });
});
