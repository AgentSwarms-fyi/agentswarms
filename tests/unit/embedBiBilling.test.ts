// The embed BI widget plans its chart with a real LLM call, on a route where
// the question comes from an ANONYMOUS visitor. That call ran untraced.
//
// Month-to-date spend is a SUM over execution_traces (budgetGuard.server.ts),
// so a call that never inserts a row can never accumulate. embed.chat.ts
// checks the budget before generating a widget and then never charged for
// what generating cost — the cap was permanently evaluated against a figure
// that excluded every widget ever drawn.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/utils/embedBi.server.ts", "utf8");
const FORM = readFileSync("src/components/agents/AgentForm.tsx", "utf8");

describe("the planning call is billed to the owner", () => {
  it("records a gateway call", () => {
    expect(SRC).toContain("recordGatewayCall");
    expect(SRC).toMatch(/surface: "Embed BI: Plan"/);
  });

  it("bills the OWNER, not an anonymous visitor", () => {
    // There is no visitor identity to bill, and the data and the API key are
    // the owner's. Attributing it anywhere else would leave it unattributed.
    expect(SRC).toMatch(/userId: ownerId/);
  });

  it("passes the provider through so the price lookup is not guessed", () => {
    // recordGatewayCall defaults provider to "openrouter". The embed runs on
    // whatever provider the agent is configured for, and the same model costs
    // different amounts on different backends.
    expect(SRC).toMatch(/recordGatewayCall\(\{[\s\S]{0,300}provider,/);
  });

  it("prefers the provider's own token counts over the chars/4 estimate", () => {
    expect(SRC).toContain("extractUsage");
    expect(SRC).toMatch(/tokensIn: usage\?\.tokensIn/);
    expect(SRC).toMatch(/promptText: usage \? undefined :/);
  });

  it("still records when the model returns nothing", () => {
    // A failed plan costs input tokens. Recording only on success reintroduces
    // a smaller version of the same hole.
    expect(SRC).toMatch(/status: content \? "success" : "error"/);
    // The CALL SITE, not the import on line 8 — indexOf("recordGatewayCall")
    // matches the import first and makes this comparison vacuously true.
    const recordAt = SRC.indexOf("await recordGatewayCall({");
    const bailAt = SRC.indexOf("if (!content) return null;");
    expect(recordAt, "no recordGatewayCall call site").toBeGreaterThan(-1);
    expect(bailAt, "the early return moved").toBeGreaterThan(-1);
    expect(recordAt, "an empty response returns before it is billed").toBeLessThan(bailAt);
  });
});

/**
 * The <p> under the toggle's Label — the sentence a user actually reads.
 *
 * Anchored on the rendered element rather than on indexOf("Visual BI answers"),
 * which matches a code comment 500 lines earlier and made this assert against
 * a region of the file the user never sees. Both said the wrong thing, so the
 * test failed for the right reason by luck rather than by aim.
 */
function toggleCopy(): string {
  const label = FORM.indexOf("Visual BI answers", FORM.indexOf("<BarChart3"));
  expect(label, "the toggle label moved").toBeGreaterThan(-1);
  const open = FORM.indexOf("<p ", label);
  const close = FORM.indexOf("</p>", open);
  expect(open, "no <p> after the label").toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return FORM.slice(open, close);
}

describe("the toggle describes both surfaces it actually drives", () => {
  it("names chat AND embeds", () => {
    // Both work, by two unrelated code paths. Searching for the embed's
    // `event: widget` consumer finds nothing in the app and reads as proof
    // that in-app BI is dead; it is not. playground.tsx calls
    // generateChatWidget against /api/bi and renders BiWidgetCard from
    // message.metadata.widgets. This test exists because that inference was
    // made and the copy was "corrected" to a claim that was false.
    const copy = toggleCopy();
    expect(copy).toMatch(/in chat and in embeds/);
  });

  it("both surfaces are wired", () => {
    // The claim above is only true while both paths exist. Assert the
    // producers rather than the prose.
    expect(readFileSync("src/routes/_authenticated/playground.tsx", "utf8")).toContain(
      "generateChatWidget",
    );
    expect(readFileSync("src/routes/api/embed.chat.ts", "utf8")).toContain("generateEmbedWidget");
  });

  it("says the charts cost money", () => {
    // Turning this on adds a second billed model call to every answer.
    expect(toggleCopy()).toMatch(/budget/);
  });
});
