// Knowledge Bases: a delete that failed is said — with what it means — and
// never called "Deleted".
//
// FOUND FROM THE UI. With every DELETE to knowledge_documents rejected,
// "Document deleted" toasted and the list reloaded with the document still
// in it. Three deletes on the page dropped their error: the base, the
// document, and the documents of a source being removed. The forget-vectors
// call that precedes each is deliberately first (the rows that prove
// ownership must still exist), so a failed row delete leaves a row whose
// embeddings are gone — which the message now says.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("src/routes/_authenticated/knowledge.tsx", "utf8");

describe("the three deletes keep their error", () => {
  it("and no bare delete statement on the two tables remains", () => {
    expect(page).not.toMatch(
      /^\s*await supabase\.from\("(knowledge_bases|knowledge_documents)"\)\.delete\([^\n]*;\s*$/m,
    );
    expect(page).toContain(
      'const { error } = await supabase.from("knowledge_bases").delete().eq("id", id);',
    );
    expect(page).toContain(
      'const { error } = await supabase.from("knowledge_documents").delete().eq("id", id);',
    );
    expect(page).toContain("const { error: docsError } = await supabase");
  });

  it("say what the failure means, given that the embeddings went first", () => {
    for (const msg of [
      'toast.error("Could not delete the knowledge base"',
      'toast.error("Could not delete the document"',
      'toast.error("Could not remove the source\'s documents"',
    ]) {
      expect(page, msg).toContain(msg);
    }
    expect((page.match(/embeddings were already removed — re-index/g) ?? []).length).toBe(3);
  });

  it("return before 'Deleted' is said or the list is touched", () => {
    const base = page.slice(
      page.indexOf('const { error } = await supabase.from("knowledge_bases").delete()'),
    );
    expect(base.indexOf("return;")).toBeLessThan(base.indexOf('toast.success("Deleted")'));
    const doc = page.slice(
      page.indexOf('const { error } = await supabase.from("knowledge_documents").delete()'),
    );
    expect(doc.indexOf("return;")).toBeLessThan(doc.indexOf('toast.success("Document deleted")'));
    const srcBlock = page.slice(page.indexOf("const { error: docsError } = await supabase"));
    expect(srcBlock.indexOf("return;")).toBeLessThan(
      srcBlock.indexOf('.from("kb_sources").delete()'),
    );
  });

  it("keep the vectors-first order the ownership rule needs", () => {
    // The forget call must still precede each row delete.
    for (const [forget, del] of [
      ["forgetVectorsFn({ data: { knowledgeBaseIds: [id] } })", 'from("knowledge_bases").delete()'],
      [
        "forgetVectorsFn({ data: { documentIds: [id] } })",
        'from("knowledge_documents").delete().eq("id", id)',
      ],
      ["forgetVectorsFn({ data: { sourceIds: [src.id] } })", '.eq("source_id", src.id)'],
    ]) {
      expect(page.indexOf(forget), forget).toBeGreaterThan(0);
      expect(page.indexOf(forget), `${forget} before ${del}`).toBeLessThan(page.indexOf(del));
    }
  });
});
