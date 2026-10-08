// An agent with no knowledge base is not told one was searched (R348).
//
// FOUND FROM THE UI (R347). The R347 fixture agent has no knowledge base.
// Asked to repeat an email back, it answered "I could not find the information
// you are looking for in the available documents." Its trace held why: the
// effective system prompt ended "A knowledge base is attached to this assistant
// and was searched for this question. It returned no matching passages. If
// answering would require information from those documents, say plainly that
// you could not find it…".
//
// /api/chat runs its knowledge-base search for every agent turn, and
// retrieveCitationsReport answered { citations: [], degraded: [] } both when
// the agent had no knowledge base and when its knowledge bases had no match.
// The route then passed `searched: true` regardless, and audited a kb.search
// on every turn of every agent. The kb_search tool did the same with "No
// matching documents in any connected knowledge base." The report now says how
// many knowledge bases it covered, and both use it.
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import { buildGroundingPrompt, retrieveCitationsReport } from "@/utils/tools/kb.server";

/** A client that answers the agent read with `agent`, and refuses any other read. */
function clientWith(agent: unknown) {
  const reads: string[] = [];
  const sb = {
    from(table: string) {
      reads.push(table);
      if (table !== "agents") throw new Error(`the search went on to read ${table}`);
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: agent, error: null }),
      };
      return q;
    },
  } as unknown as SupabaseClient<Database>;
  return { sb, reads };
}

describe("retrieveCitationsReport, for an agent with no knowledge base", () => {
  it("searched none, and says so", async () => {
    const { sb, reads } = clientWith({ knowledge_base_id: null, tools: { guardrails: {} } });
    const report = await retrieveCitationsReport({ sb, agentId: "a1", query: "hi", userId: "u1" });
    expect(report).toEqual({ citations: [], degraded: [], searched: 0 });
    expect(reads).toEqual(["agents"]);
  });

  it("an agent row that is not there searched none either", async () => {
    const { sb } = clientWith(null);
    const report = await retrieveCitationsReport({ sb, agentId: "gone", query: "hi" });
    expect(report.searched).toBe(0);
  });

  it("an agent with knowledge bases searches them, and counts each once", async () => {
    // The fake refuses every read after the agent's, so this search finds
    // nothing and says why; what matters here is that it ran, over two.
    const { sb, reads } = clientWith({
      knowledge_base_id: "kb1",
      tools: { knowledgeBaseIds: ["kb2", "kb1"] },
    });
    const report = await retrieveCitationsReport({ sb, agentId: "a1", query: "hi", userId: "u1" });
    expect(report.searched).toBe(2);
    expect(reads.length).toBeGreaterThan(1);
    expect(report.degraded.length).toBeGreaterThan(0);
  });

  it("so the model is given the agent's own prompt, with no word of a search", () => {
    const report = { citations: [], degraded: [], searched: 0 };
    expect(
      buildGroundingPrompt(report.citations, "You are a helpful assistant.", {
        searched: report.searched > 0,
        degraded: report.degraded,
      }),
    ).toBe("You are a helpful assistant.");
  });
});

describe("the callers", () => {
  const KB = readFileSync("src/utils/tools/kb.server.ts", "utf8");
  const CHAT = readFileSync("src/routes/api/chat.ts", "utf8");
  const REG = readFileSync("src/utils/tools/registry.server.ts", "utf8");

  it("a search that ran reports the knowledge bases it covered, on both of its returns", () => {
    expect(KB.match(/searched: kbIds\.length,/g) ?? []).toHaveLength(2);
    expect(KB.match(/return \{ citations: \[\], degraded, searched: 0 \};/g) ?? []).toHaveLength(2);
  });

  it("the chat route tells the model of a search, and audits one, only when one ran", () => {
    expect(CHAT).toContain("searched: report.searched > 0,");
    expect(CHAT).toContain("if (userId && report.searched > 0)");
  });

  it("the kb_search tool says no knowledge base is wired, before it audits a search", () => {
    const start = REG.indexOf("export async function runKbSearch(");
    const fn = REG.slice(start, REG.indexOf("\nexport ", start + 1));
    const at = fn.indexOf("if (searched === 0)");
    expect(at).toBeGreaterThan(0);
    expect(fn.slice(at, at + 200)).toContain("No knowledge base wired — kb_search unavailable");
    expect(at).toBeLessThan(fn.indexOf("auditEvent({"));
  });
});
