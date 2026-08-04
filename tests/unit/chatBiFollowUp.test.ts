// Visual BI was on, the data was loaded, the SQL had already run — and asking
// for a bar chart produced no chart. The BI analyst is stateless: it receives
// ONE question string plus the dataset schemas, never the conversation. So a
// follow-up arrives with no subject, the planner cannot write SQL, the turn
// produces nothing, and "produced nothing" is indistinguishable from "was
// never a data question" — the code falls through to the plain agent, which
// answers by explaining how to build the chart by hand on /data-sql.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BI_FELL_THROUGH_NOTE } from "@/lib/chatBi";
import { needsConversationContext } from "@/lib/chatBiSplit";

describe("a follow-up is recognised as needing the conversation", () => {
  it("catches the question that actually failed", () => {
    // Verbatim from the report. It carries no referring word at all — the
    // subject is simply absent — which is why a pronoun check alone misses it.
    expect(needsConversationContext("show me using a bar chart from BI")).toBe(true);
  });

  it("catches referring expressions", () => {
    for (const q of [
      "show me this as a bar chart",
      "chart that result",
      "plot the above by month",
      "can you visualise it",
      "same thing but as a pie",
      "show me the previous query as a graph",
    ]) {
      expect(needsConversationContext(q), `missed: ${q}`).toBe(true);
    }
  });

  it("catches a bare restyle with no subject", () => {
    for (const q of [
      "as a bar chart",
      "now make it a pie chart",
      "give me a line graph",
      "turn into a chart",
    ]) {
      expect(needsConversationContext(q), `missed: ${q}`).toBe(true);
    }
  });
});

describe("a self-contained question is left alone", () => {
  it("does not fire on a question that names its own subject", () => {
    // These reach the analyst unchanged today and work. Rewriting them would
    // spend a call and risk replacing the user's wording with the model's.
    for (const q of [
      "total sales by region as a bar chart",
      "show me revenue by month",
      "which product had the highest margin last quarter",
      "compare headcount and cost across departments",
      "top 10 customers by lifetime value as a bar chart",
    ]) {
      expect(needsConversationContext(q), `false positive: ${q}`).toBe(false);
    }
  });

  it("ignores an empty question", () => {
    expect(needsConversationContext("   ")).toBe(false);
  });
});

describe("the fix is wired end to end", () => {
  const CHAT_BI = readFileSync("src/lib/chatBi.ts", "utf8");
  const PLAYGROUND = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");

  it("condenses before splitting", () => {
    // A follow-up asking for two charts has to know what "those" were before
    // it can be split; splitting first yields two subject-less questions.
    const condenseAt = CHAT_BI.indexOf("needsConversationContext(question)");
    const splitAt = CHAT_BI.indexOf("wantsMultipleVisuals(resolved)");
    expect(condenseAt, "condense call missing").toBeGreaterThan(-1);
    expect(splitAt, "split no longer reads the resolved question").toBeGreaterThan(-1);
    expect(condenseAt, "the split runs before the referent is resolved").toBeLessThan(splitAt);
  });

  it("splits the RESOLVED question, not the raw one", () => {
    // Passing `question` here would resolve the referent and then throw the
    // result away — the exact silent-degradation shape this codebase keeps
    // hitting: the call is present, the wiring is gone, nothing goes red.
    expect(CHAT_BI).toMatch(/wantsMultipleVisuals\(resolved\)/);
    expect(CHAT_BI).toMatch(/splitQuestion\(resolved, opts\.model\)/);
    expect(CHAT_BI).toMatch(/:\s*\[resolved\]/);
  });

  it("degrades to the original question rather than to nothing", () => {
    // Same rule splitQuestion follows: a broken rewrite must leave today's
    // behaviour intact, never blank the question.
    const fn = CHAT_BI.slice(CHAT_BI.indexOf("async function condenseQuestion"));
    expect(fn).toMatch(/catch \{\s*return question;/);
    expect(fn, "an empty rewrite is used as-is").toMatch(/rewritten\.length > 0/);
  });

  it("the playground actually passes history", () => {
    // The whole fix is inert without this argument.
    expect(PLAYGROUND).toMatch(/history: opts\.historySnapshot/);
  });

  it("excludes the current question from the history it sends", () => {
    // Otherwise the condenser is asked to resolve a question using itself as
    // context, which is where a model invents a subject to satisfy the prompt.
    expect(PLAYGROUND).toMatch(/filter\(\(m\) => m !== lastUserMsg/);
  });
});

describe("when BI falls through, the agent is told", () => {
  const PLAYGROUND = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");

  it("forbids sending the user elsewhere to draw a chart", () => {
    // The reported answer was a numbered list telling the user to open
    // /data-sql and click a chart icon, while the Visual BI toggle sat lit
    // underneath the message box.
    expect(BI_FELL_THROUGH_NOTE).toMatch(/Do NOT tell them to open another page/);
  });

  it("forbids drawing a fake chart out of text", () => {
    // The first version of this note said only "do not claim you cannot draw
    // charts". The agent complied by rendering bars out of block characters,
    // labelling it "Bar Chart", and closing with "the visual bar chart clearly
    // shows...". Forbidding the refusal without forbidding the forgery just
    // moved the failure from unhelpful to dishonest.
    expect(BI_FELL_THROUGH_NOTE).toMatch(/Do NOT draw a chart yourself out of text/);
    expect(BI_FELL_THROUGH_NOTE).toMatch(/block characters/);
    expect(BI_FELL_THROUGH_NOTE).toMatch(/ASCII art/);
  });

  it("tells it to admit no chart was produced", () => {
    // The honest ending. Without it, "do not say you cannot draw charts" and
    // "do not draw one" together leave the model no sanctioned way out.
    expect(BI_FELL_THROUGH_NOTE).toMatch(/a chart could not be generated/);
    expect(BI_FELL_THROUGH_NOTE).toMatch(/answer the question with the real figures/);
  });

  it("leaves a trail when it gives up", () => {
    // Every exit was silent, so "BI failed" and "the question was not about
    // data" looked identical from outside. Two rounds of this bug were
    // diagnosed by reading code because there was nothing else to read.
    const CHAT_BI = readFileSync("src/lib/chatBi.ts", "utf8");
    expect(CHAT_BI, "the bare catch is back").not.toMatch(/\}\s*catch\s*\{\s*\n\s*return EMPTY_BI/);
    expect(CHAT_BI).toMatch(/biTrace\("threw", e\)/);
    expect(CHAT_BI).toMatch(/biTrace\("no datasets hydrated/);
    expect(CHAT_BI).toMatch(/biTrace\("every turn was skipped/);
    // The one that distinguishes a bad rewrite from a bad plan.
    expect(CHAT_BI).toMatch(/condensed to \$\{JSON\.stringify\(resolved\)\}/);
  });

  it("says BI already ran, not merely that it exists", () => {
    // "Visual BI is available" invites the agent to suggest turning it on.
    // The useful fact is that it ran, for THIS question, and came back empty.
    expect(BI_FELL_THROUGH_NOTE).toMatch(/ALREADY run/);
    expect(BI_FELL_THROUGH_NOTE).toMatch(/could not produce a chart/);
  });

  it("says whose job the chart is", () => {
    // The agent reached for ASCII art because nothing told it that drawing is
    // not its job. Naming the renderer removes the reason to improvise one.
    expect(BI_FELL_THROUGH_NOTE).toMatch(/rendered by the application, not written by you/);
  });

  it("appends rather than replacing the agent's own prompt", () => {
    // Overwriting it would silently drop the agent's configured behaviour on
    // exactly the turns where BI failed.
    expect(PLAYGROUND).toMatch(
      /requestBody\.systemPrompt\s*\n?\s*\?\s*`\$\{requestBody\.systemPrompt\}\\n\\n\$\{BI_FELL_THROUGH_NOTE\}`/,
    );
  });

  it("only fires after a BI attempt actually returned nothing", () => {
    // Before the generateChatWidget call it would be a lie, and outside the
    // biVisuals branch it would reach turns where BI never ran at all.
    const biCall = PLAYGROUND.indexOf("await generateChatWidget(");
    const note = PLAYGROUND.indexOf("requestBody.systemPrompt = requestBody.systemPrompt");
    const successReturn = PLAYGROUND.indexOf("return { ok: true };", biCall);
    expect(biCall).toBeGreaterThan(-1);
    expect(note, "the note is not wired").toBeGreaterThan(-1);
    expect(note, "the note is set before BI has run").toBeGreaterThan(biCall);
    expect(note, "the note is set on the success path too").toBeGreaterThan(successReturn);
  });
});
