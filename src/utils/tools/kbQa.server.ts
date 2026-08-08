// Q&A-format indexing: turn a passage into question/answer pairs so the
// EMBEDDED text is a question.
//
// Why this exists: a user asks "How do I rotate an API key?" and the corpus
// contains "Rotation issues a replacement key and records what it superseded."
// Those are semantically close but grammatically different kinds of text, and
// that difference is a real part of the cosine distance. Embedding a generated
// question instead puts both sides of the comparison in the same form.
//
// The cost is honest and worth stating plainly: this makes an LLM call per
// passage at index time. It is opt-in per document for that reason.
import { OPENROUTER_CHAT_URL } from "@/utils/providers/openrouterDefault.server";
import { parseQaPairs, type QaPair } from "@/lib/kbRag";

export const QA_MODEL = "google/gemini-2.5-flash";

/** Passages longer than this are truncated — one call should not cost a book. */
const MAX_PASSAGE_CHARS = 12_000;

const SYSTEM =
  "You turn documentation into question/answer pairs for a retrieval index. You return only valid JSON.";

function prompt(passage: string): string {
  return `Read the passage and write the questions a real user would ask that this passage answers.

Rules:
- Every answer must be supported by the passage. Never add facts from outside it.
- Write questions the way a user would type them, not the way the document phrases things.
- One self-contained question per pair — no "it", "this" or "the above".
- The answer must stand alone without the question next to it.
- Cover the whole passage: aim for one pair per distinct fact, between 1 and 8 pairs.
- If the passage carries no answerable content (a heading, a table of contents, boilerplate), return [].

Return strictly a JSON array:
[{"question": "string", "answer": "string"}]

PASSAGE:
${passage.slice(0, MAX_PASSAGE_CHARS)}`;
}

export type QaGenerationResult = { ok: true; pairs: QaPair[] } | { ok: false; error: string };

/**
 * Generate Q&A pairs for one passage.
 *
 * Returns a result rather than throwing or silently degrading. A caller that
 * asked for Q&A indexing and got flat chunks instead would have a knowledge
 * base that does not match its own settings, and no way to find out.
 */
export async function generateQaPairs(
  passage: string,
  apiKey: string,
  model: string = QA_MODEL,
): Promise<QaGenerationResult> {
  const text = (passage || "").trim();
  if (!text) return { ok: true, pairs: [] };
  if (!apiKey) {
    return {
      ok: false,
      error: "Q&A indexing needs OPENROUTER_API_KEY — it generates pairs with a model.",
    };
  }

  let res: Response;
  try {
    res = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt(text) },
        ],
        temperature: 0.2,
      }),
    });
  } catch (err) {
    return { ok: false, error: `Q&A generation could not reach the model: ${String(err)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Q&A generation failed [${res.status}]: ${body.slice(0, 200)}` };
  }

  const json = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const content = json?.choices?.[0]?.message?.content ?? "";
  const pairs = parseQaPairs(content);
  // An empty result is reported as success: "this passage has no answerable
  // content" is a real and correct outcome for a heading or a table of
  // contents, and treating it as a failure would abort a whole document.
  return { ok: true, pairs };
}
