// Retrieval that could not be checked or completed says so.
//
// retrieveCitationsServer answered a bare Citation[]. A failed vector search
// was folded into keyword mode with a warn; a failed keyword scan was a bare
// warn; the document scan dropped its errors and stopped at the first short
// page; and the ACL filter's catch — written for one state, a database that
// predates the connector migration — caught EVERY failure and kept the
// unfiltered candidates, so a transient failure of the ACL read showed
// restricted documents to whoever asked. Every caller then told the model
// "it returned no matching passages — say plainly you could not find it" over
// a search that had failed.
//
// The grounding prompt is pure, so its half is behavioural. The retrieval
// function needs embeddings and an RPC; its half is source-anchored, and the
// tool and the route with it.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildGroundingPrompt } from "@/utils/tools/kb.server";

const KB = readFileSync("src/utils/tools/kb.server.ts", "utf8");
const REG = readFileSync("src/utils/tools/registry.server.ts", "utf8");
const CHAT = readFileSync("src/routes/api/chat.ts", "utf8");

function between(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  expect(i, `${what}: start anchor gone`).toBeGreaterThan(0);
  const j = src.indexOf(end, i);
  expect(j, `${what}: end anchor gone`).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe("buildGroundingPrompt, when the search fell short", () => {
  it("with nothing back, tells the model the search could not be completed", () => {
    const p = buildGroundingPrompt([], "You help with policies.", {
      searched: true,
      degraded: ["document access could not be checked, 3 candidate document(s) withheld: timeout"],
    });
    expect(p).toMatch(/the search could not be completed: document access could not be checked/);
    expect(p).toMatch(/Do not say the documents lack the information/);
    expect(p).not.toMatch(/It returned no matching passages/);
    expect(p.startsWith("You help with policies.")).toBe(true);
  });

  it("with nothing back and nothing wrong, still says the documents had no match", () => {
    const p = buildGroundingPrompt([], "", { searched: true, degraded: [] });
    expect(p).toMatch(/It returned no matching passages/);
    expect(p).not.toMatch(/could not be completed/);
  });

  it("with citations back but a partial search, says the retrieval was partial", () => {
    const cite = {
      index: 1,
      documentId: "d1",
      documentName: "Handbook",
      knowledgeBaseId: "k1",
      knowledgeBaseName: "HR",
      snippet: "Leave is 25 days.",
    };
    const p = buildGroundingPrompt([cite], "", {
      searched: true,
      degraded: ["vector search failed, keyword search only: 502"],
    });
    expect(p).toMatch(/Retrieval was partial — vector search failed, keyword search only: 502/);
    expect(p).toMatch(/\[1\] Handbook/);
  });

  it("unchanged when nothing fell short", () => {
    const p = buildGroundingPrompt([], "", { searched: true });
    expect(p).toMatch(/It returned no matching passages/);
  });
});

describe("retrieveCitationsReport", () => {
  const fn = between(
    KB,
    "export async function retrieveCitationsReport(",
    "export async function retrieveCitationsServer(",
    "report function",
  );

  it("exists, and the old name delegates to it", () => {
    expect(KB).toMatch(
      /export type RetrievalReport = \{ citations: Citation\[\]; degraded: string\[\] \};/,
    );
    expect(KB).toMatch(
      /export async function retrieveCitationsServer\(opts: RetrievalOpts\): Promise<Citation\[\]> \{\s*return \(await retrieveCitationsReport\(opts\)\)\.citations;/,
    );
  });

  it("records a failed vector search and a failed keyword scan", () => {
    expect(fn).toMatch(/degraded\.push\(`vector search failed, keyword search only: \$\{msg\}`\);/);
    expect(fn).toMatch(
      /degraded\.push\(`keyword search over un-embedded documents failed: \$\{msg\}`\);/,
    );
  });

  it("reads the error of the embedded-documents list and pages the scan with the checked pager", () => {
    expect(fn).toMatch(
      /if \(chunkedErr\) throw new Error\(`could not list embedded documents: \$\{chunkedErr\.message\}`\);/,
    );
    expect(fn).toMatch(/await selectAllPages<DocRow>\(/);
    expect(fn).not.toMatch(/if \(page\.length < KEYWORD_PAGE\) break;/);
    expect(fn).not.toMatch(/const \{ data: page \} = await sb/);
  });

  it("keeps the legacy ACL path for the pre-migration error only, and fails closed otherwise", () => {
    const acl = between(
      fn,
      "} catch (err) {\n      const msg",
      "if (reranker && merged.length > 1",
      "ACL catch",
    );
    expect(acl).toMatch(/if \(\/does not exist\|42703\/i\.test\(msg\)\) \{/);
    expect(acl).toMatch(/merged = \[\];/);
    expect(acl).toMatch(
      /degraded\.push\(\s*`document access could not be checked, \$\{merged\.length\} candidate document\(s\) withheld: \$\{msg\}`/,
    );
  });

  it("returns the degraded list with the citations on both paths", () => {
    expect(fn).toMatch(
      /if \(ranked\) return \{ citations: applyGroundingBudget\(ranked, groundingMaxChars\(\)\), degraded \};/,
    );
    expect(fn).toMatch(
      /return \{\s*citations: applyGroundingBudget\([\s\S]{0,200}?\),\s*degraded,\s*\};/,
    );
  });
});

describe("the kb_search tool and the chat route", () => {
  it("the tool says the search could not be completed instead of 'no matching documents'", () => {
    expect(REG).toMatch(
      /const \{ citations: cits, degraded \} = await retrieveCitationsReport\(\{/,
    );
    expect(REG).toMatch(
      /note: degraded\.length\s*\?\s*`The search could not be completed — \$\{degraded\.join\("; "\)\}\./,
    );
    expect(REG).toMatch(/return JSON\.stringify\(\{\s*degraded,\s*results: cits\.map/);
  });

  it("the route passes the report to the grounding prompt, and its own catch tells the model too", () => {
    expect(CHAT).toMatch(/const report = await retrieveCitationsReport\(\{/);
    expect(CHAT).toMatch(/citations = report\.citations;/);
    expect(CHAT).toMatch(/searched: true,\s*degraded: report\.degraded,/);
    expect(CHAT).toMatch(
      /console\.error\("RAG retrieval failed:", err\);[\s\S]{0,600}?buildGroundingPrompt\(\[\], body\.systemPrompt, \{\s*searched: true,\s*degraded: \[\s*`retrieval failed: /,
    );
  });
});
