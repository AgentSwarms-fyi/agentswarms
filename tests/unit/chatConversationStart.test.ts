// Agent Chat when no conversation can be started (R206).
//
// FOUND IN R206, driven on the real image a4f99b7a55be with the browser's
// fault injector: the agent's conversations read empty and the insert of a
// first one refused. No toast, no conversation, the message box disabled,
// and the centre still read "Ask a question, share a task, or try a starter
// below." New Chat refused the same way and did nothing at all: it read
// `error` and never looked at it. The page could not be used and said nothing.
// Pinned by source, as R191's reads: both writes live in the route file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");

const between = (from: string, to: string) => {
  const a = SRC.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = SRC.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  return SRC.slice(a, b);
};

describe("the first conversation", () => {
  it("says when it could not be created, and goes no further", () => {
    const auto = between("// Auto-create a first conversation", "async function loadMessages");
    expect(auto).toContain("const { data: newConvo, error: insertError } = await supabase");
    expect(auto).toMatch(
      /if \(insertError \|\| !newConvo\) \{[\s\S]*?setConvoError\(why\);[\s\S]*?toast\.error\("Could not start a conversation", \{ description: why \}\);[\s\S]*?return;/,
    );
    expect(auto).toContain("setConvoError(null);");
  });
});

describe("New Chat", () => {
  it("looks at its insert's error", () => {
    const create = between(
      "async function createConversation()",
      "async function renameConversation",
    );
    expect(create).toMatch(
      /if \(error \|\| !data\) \{[\s\S]*?setConvoError\(why\);[\s\S]*?toast\.error\("Could not start a new chat", \{ description: why \}\);[\s\S]*?return;/,
    );
  });
});

describe("a message sent while New Chat is starting (R352)", () => {
  // FOUND FROM THE UI (R350, R352). New Chat awaited its insert before it
  // switched to the new conversation. A message sent in that moment was saved
  // to the chat on screen, and answered there with that chat's history, while
  // the new chat showed only the reply. The R350 check's first turn, the one
  // that held its codename, landed in another conversation that way.
  const create = () =>
    between("async function createConversation()", "async function renameConversation");

  it("leaves the chat on screen before the insert, so the composer is disabled", () => {
    const fn = create();
    const insert = fn.indexOf('.from("conversations")');
    expect(fn.indexOf('setActiveConvo("");')).toBeGreaterThan(0);
    expect(fn.indexOf('setActiveConvo("");')).toBeLessThan(insert);
    expect(fn.indexOf("setMessages([]);")).toBeLessThan(insert);
    expect(fn.indexOf("const previous = activeConvo;")).toBeLessThan(
      fn.indexOf('setActiveConvo("");'),
    );
  });

  it("goes back to that chat if the new one cannot be made", () => {
    expect(create()).toMatch(
      /if \(error \|\| !data\) \{[\s\S]*?setActiveConvo\(previous\);\s*return;/,
    );
  });

  it("a send with no conversation active cannot happen", () => {
    expect(SRC).toContain(
      'disabled={(!activeConvo && !armedDoc) || thinking || docPhase !== "idle"}',
    );
    expect(SRC).toContain(
      "if ((!input.trim() && attachments.length === 0) || !activeConvo || !user) return;",
    );
  });
});

describe("the empty chat", () => {
  it("says why there is nowhere to write, and offers to try again", () => {
    expect(SRC).toContain(
      "{currentAgent && !activeConvo && convoError\n                      ? `A conversation could not be started, so there is nowhere to write yet:",
    );
    expect(SRC).toMatch(
      /\{currentAgent && !activeConvo && convoError && \(\s*<Button[\s\S]*?onClick=\{\(\) => void createConversation\(\)\}[\s\S]*?Try again/,
    );
  });
});
