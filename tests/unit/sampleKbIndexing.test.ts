// A sample knowledge base could not be indexed. Not "had not been" — could not.
//
// Four independent barriers, each invisible on its own:
//
//   1. Both embed server functions selected with `.eq("user_id", userId)`, and
//      every shipped sample document has user_id = NULL — a comparison NULL
//      never satisfies. Zero rows came back, so the handler returned
//      { documentsProcessed: 0 }, which the UI reported to the user as
//      "All documents are already indexed."
//   2. kb_chunks' INSERT policy requires `is_sample = false` AND a knowledge
//      base owned by the caller. Sample bases also have user_id = NULL, so even
//      with rows in hand the write was refused.
//   3. kb_chunks.user_id is NOT NULL, and the row builder copied the
//      document's user_id straight through — NULL, for a sample.
//   4. The Index button was rendered only in the owner branch; a sample showed
//      the words "Read-only sample knowledge base" in its place.
//
// Measured before the fix: 0 rows in kb_chunks across all 17 shipped
// collections and their 49 documents. Measured after, on "Sample · Notebook RAG
// Lab": "Indexed 3 document(s) into 7 chunks", all 7 rows is_sample = true, and
// three paraphrased questions that avoid each document's own vocabulary now
// retrieve the right one:
//
//   "tall metal structure in the French capital"  -> Eiffel Tower (never says "Eiffel")
//   "how ancient Rome moved drinking water"       -> Three Topics (never says "aqueduct")
//   "toolkit to chain calls to language models"   -> LangChain    (never says "LangChain")
//
// Barrier 2 is NOT fixed by relaxing the policy, and this file guards that: on
// a multi-user instance a client that can write is_sample rows can put text of
// its choosing in front of every other user's retrieval. That is a prompt
// injection channel. The server function already controls the content — it
// reads it out of the sample document — so it writes with the service role and
// the policy stays shut.
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

const fns = readFileSync(resolve("src/utils/tools/kbEmbed.functions.ts"), "utf8");

/** Comments quote the old code to explain it; only the code should be matched. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}
const writer = readFileSync(resolve("src/utils/tools/embedding.server.ts"), "utf8");
const page = readFileSync(resolve("src/routes/_authenticated/knowledge.tsx"), "utf8");

describe("the embed functions can see sample documents", () => {
  it("no longer filters them out with an equality on a NULL column", () => {
    const code = codeOnly(fns);
    // Guard on the guard: if codeOnly ever ate the whole file this would pass
    // vacuously, so prove the code it kept is the code being asserted about.
    expect(code).toContain("backfillKbEmbeddings");
    expect(code).not.toMatch(/\.eq\("user_id", userId\)/);
  });

  it("selects documents the caller owns OR samples, in both entry points", () => {
    expect(fns).toMatch(/const OWNED_OR_SAMPLE =/);
    const uses = fns.match(/\.or\(OWNED_OR_SAMPLE\(userId\)\)/g) ?? [];
    // embedKbDocuments (fresh uploads) and backfillKbEmbeddings (the button).
    expect(uses).toHaveLength(2);
  });
});

describe("sample chunks are written by the server, not by the client", () => {
  it("routes a batch containing samples to the service role", () => {
    expect(fns).toMatch(/const writerFor =/);
    expect(fns).toMatch(/docs\.some\(\(d\) => d\.is_sample\) \? supabaseAdmin : userClient/);
  });

  it("uses that writer for the chunk write, the probe and the metadata stamp", () => {
    // Any one of these left on the user client fails silently under RLS —
    // no error, no rows, and a success toast.
    expect(fns).toMatch(/sb: writerFor\(docs, supabase\)/);
    expect(fns).toMatch(/sb: writer,/);
    expect(fns).toMatch(/writer\.from\("kb_chunks"/);
    expect(fns).toMatch(/await writer\s*\n?\s*\.from\("knowledge_documents"\)/);
  });

  it("still passes the user client when nothing in the batch is a sample", () => {
    // The service role must be the exception, not the new default — an
    // unconditional supabaseAdmin would silently drop RLS for every write.
    expect(fns).not.toMatch(/sb: supabaseAdmin/);
    expect(fns).toMatch(/writerFor\(docs, supabase\)/);
  });
});

describe("a chunk row survives a document that belongs to nobody", () => {
  it("falls back to the indexing user, because the column is NOT NULL", () => {
    const uses = writer.match(/user_id: d\.user_id \?\? opts\.userId \?\? null/g) ?? [];
    // The chunk row and the parent row both carry it.
    expect(uses).toHaveLength(2);
  });

  it("keeps is_sample on the row, which is what makes it readable by everyone", () => {
    // SELECT policy: `is_sample = true OR auth.uid() = user_id`. Drop this and
    // the shared corpus becomes one user's private index.
    //
    // Counted, not merely found: the flag is set in TWO places (the chunk row
    // and the parent row) and a single toMatch was satisfied by either. A
    // mutation that hard-coded the chunk row to `false` survived — parent rows
    // alone kept the assertion true while every child chunk went private.
    const uses = writer.match(/is_sample: !!d\.is_sample/g) ?? [];
    expect(uses).toHaveLength(2);
  });
});

describe("the insert policy stays shut to clients", () => {
  /**
   * Every migration that touches the kb_chunks INSERT policy, with SQL
   * comments stripped.
   *
   * Stripping is the whole point. A mutation that commented the clause out —
   * `-- AND is_sample = false` — left the text in the file, so a plain match
   * found it and the policy check passed while the policy no longer had it.
   * Same failure this campaign already hit with `void 0 && auditEvent({…})`.
   */
  function insertPolicySql(): string {
    const dir = resolve("supabase/migrations");
    const defining = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) => /CREATE POLICY "Insert own chunks"/.test(readFileSync(join(dir, f), "utf8")));
    // ONLY THE LAST ONE. Migrations run in filename order and each redefinition
    // drops the previous policy, so an earlier version of it says nothing about
    // what is in force. Joining them all was a real hole: a mutation that
    // commented the clause out of the current migration still passed, because
    // the superseded 2026-05-19 copy supplied the text being matched.
    const latest = defining.at(-1);
    if (!latest) return "";
    return readFileSync(join(dir, latest), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ");
  }

  it("still requires is_sample = false for a client-side insert", () => {
    // If a later migration relaxes this, sample indexing would "work" from the
    // browser — and so would writing anything else into the shared index.
    const sql = insertPolicySql();
    expect(sql, "the insert policy migration moved").not.toBe("");
    expect(sql).toMatch(/is_sample\s*=\s*false/);
  });

  it("still requires the knowledge base to belong to the caller", () => {
    expect(insertPolicySql()).toMatch(/kb\.user_id\s*=\s*auth\.uid\(\)/);
  });
});

describe("the button is reachable on the collections that need it", () => {
  it("offers indexing for samples as well as for what you own", () => {
    expect(page).toMatch(
      /const canIndexSelected =\s*\n?\s*!!selectedBase && \(selectedBase\.is_sample \|\| selectedBase\.user_id === user\?\.id\)/,
    );
  });

  it("does not offer it on a collection someone else shared with you", () => {
    // Those chunks belong to the owner and the insert policy refuses them, so
    // the button could only ever fail. The shared branch stays a plain note —
    // sliced from the start of its ternary arm to the start of the next, so a
    // neighbouring branch's button cannot be mistaken for this one's.
    const start = page.indexOf("selectedBase.user_id !== user?.id ? (");
    expect(start, "the shared branch moved").toBeGreaterThan(0);
    const arm = page.slice(start, page.indexOf(") : (", start));
    expect(arm).toContain("Shared with you (read-only)");
    expect(arm).not.toContain("indexButton");
  });

  it("labels the resting state as an action, not as a progress report", () => {
    expect(page).toMatch(/Index \$\{indexCoverage\.total\} document/);
    expect(page).toMatch(/"Re-index"/);
  });

  it("puts the action inside the not-indexed warning, not only in the header", () => {
    const i = page.indexOf("Nothing in this collection is indexed yet");
    expect(i).toBeGreaterThan(0);
    expect(page.slice(i, i + 1200)).toContain("{indexButton}");
  });

  it("stops claiming the whole collection is read-only", () => {
    // Content is read-only; indexing is not. The old wording is why nobody
    // looked for a button.
    expect(page).not.toContain("Read-only sample knowledge base");
  });
});
