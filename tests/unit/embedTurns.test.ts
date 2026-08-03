// Turn bookkeeping for the public embed chat.
//
// Both defects here are SECOND-MESSAGE bugs: the first exchange looks perfect
// and the damage only appears on the next send. That is why they survived in a
// shipped, public, unauthenticated page.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { historyForModel, settleTurns, withNotice, type EmbedTurn } from "@/lib/embedTurns";

const user = (content: string): EmbedTurn => ({ role: "user", content });
const bot = (content: string): EmbedTurn => ({ role: "assistant", content });

describe("what gets sent back to the model", () => {
  it("carries a normal exchange forward", () => {
    expect(historyForModel([user("hi"), bot("hello")], "and now?")).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "and now?" },
    ]);
  });

  it("does not send a failure notice as something the model said", () => {
    // THE BUG. The catch replaced the pending assistant turn with
    // `⚠️ <message>` and left it in state, so the next send transmitted
    // "⚠️ Failed to fetch" to the model as a prior assistant message. One
    // network blip poisoned every later turn in the conversation.
    const afterFailure = withNotice([user("hi"), bot("")], "⚠️ Failed to fetch");
    const sent = historyForModel(afterFailure, "try again");
    expect(sent).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "try again" },
    ]);
    expect(JSON.stringify(sent)).not.toContain("⚠️");
  });

  it("drops an empty assistant turn rather than sending a blank message", () => {
    // Some providers reject an empty assistant message outright.
    expect(historyForModel([user("hi"), bot("   ")], "next")).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "next" },
    ]);
  });

  it("keeps a real answer that merely mentions a warning sign", () => {
    // Filtering on the ⚠️ CHARACTER rather than on the notice flag would eat
    // genuine answers. The flag is the signal, not the text.
    const answered: EmbedTurn[] = [user("what does ⚠️ mean?"), bot("⚠️ means warning.")];
    expect(historyForModel(answered, "thanks")).toHaveLength(3);
  });
});

describe("replacing the pending turn with a notice", () => {
  it("replaces the placeholder instead of appending after it", () => {
    const out = withNotice([user("hi"), bot("")], "⚠️ boom");
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ role: "assistant", content: "⚠️ boom", notice: true });
  });

  it("appends when there is no placeholder to replace", () => {
    // resolveEmbed can fail before any turn exists. A notice that lands
    // nowhere is worse than one in the wrong place.
    const out = withNotice([user("hi")], "⚠️ boom");
    expect(out).toHaveLength(2);
    expect(out[1].content).toBe("⚠️ boom");
  });

  it("never overwrites the user's own message", () => {
    expect(withNotice([user("hi")], "x")[0]).toEqual(user("hi"));
    expect(withNotice([], "x")).toHaveLength(1);
  });
});

describe("settling a stream that ended", () => {
  it("explains an answer that produced no tokens", () => {
    // THE OTHER BUG. Empty content renders as a spinner, and `busy` is already
    // false by then — so a stream closing early (proxy timeout, empty
    // completion) left a spinner turning forever with nothing to explain it.
    const out = settleTurns([user("hi"), bot("")]);
    expect(out[1].content).toMatch(/no response/i);
    expect(out[1].notice).toBe(true);
  });

  it("leaves a real answer completely alone", () => {
    const done: EmbedTurn[] = [user("hi"), bot("hello there")];
    expect(settleTurns(done)).toBe(done);
  });

  it("is safe to run twice", () => {
    // It runs in a finally that also runs after the catch has already put a
    // notice there.
    const once = settleTurns(withNotice([user("hi"), bot("")], "⚠️ boom"));
    expect(settleTurns(once)).toEqual(once);
    expect(once[1].content).toBe("⚠️ boom");
  });

  it("does nothing to an empty conversation or a trailing user turn", () => {
    expect(settleTurns([])).toEqual([]);
    expect(settleTurns([user("hi")])).toEqual([user("hi")]);
  });
});

describe("the route actually calls them", () => {
  // ADDED BECAUSE A MUTATION SURVIVED: deleting `setTurns(settleTurns)` from
  // the route broke nothing above. Every test here passed against a page that
  // had stopped using the code entirely — extracted, tested, and not called.
  //
  // A source assertion is the right tool for WIRING specifically. It says
  // nothing about behaviour (the tests above do that); it only answers "is
  // this reachable from the page", which otherwise needs a full render.
  const route = readFileSync("src/routes/embed.agent.$key.tsx", "utf8");

  it("builds history through historyForModel, not from raw turns", () => {
    expect(route).toContain("historyForModel(turns, q)");
    expect(route, "raw turn mapping is back").not.toMatch(/turns\.map\(\(\{ role, content \}\)/);
  });

  it("routes the catch through withNotice", () => {
    expect(route).toContain("withNotice(prev,");
  });

  it("settles the stream when it ends", () => {
    expect(route).toContain("setTurns(settleTurns)");
  });
});
