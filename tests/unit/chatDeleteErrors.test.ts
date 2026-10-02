// Agent Chat's deletes: a message or chat that could not be deleted comes
// back on screen and says so, and a regenerate or edit-and-resend that could
// not remove what it replaces stops rather than leaving both.
//
// FOUND FROM THE UI. With every DELETE to messages rejected, Delete on a
// bubble removed it from the screen, said nothing, and the message was back
// on the next reload.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");
const fn = (name: string, until: string) => {
  const i = page.indexOf(name);
  expect(i, name).toBeGreaterThanOrEqual(0);
  const j = page.indexOf(until, i);
  expect(j, until).toBeGreaterThan(i);
  return page.slice(i, j);
};

describe("the page's deletes keep their error", () => {
  it("and no bare delete statement on messages or conversations remains", () => {
    expect(page).not.toMatch(
      /^\s*await supabase\.from\("(messages|conversations)"\)\.delete\([^\n]*;\s*$/m,
    );
  });

  it("deleting a message that could not be deleted puts it back and says so", () => {
    const f = fn("async function deleteMessage(", "const currentAgent =");
    expect(f).toContain("const before = messages;");
    expect(f).toContain(
      'const { error } = await supabase.from("messages").delete().eq("id", dbId);',
    );
    expect(f).toContain("setMessages(before);");
    expect(f).toContain('toast.error("Could not delete the message"');
  });

  it("deleting a chat that could not be deleted leaves it and says so", () => {
    const f = fn('actionLabel: "Delete chat",', "function resolveDbId(");
    expect(f).toContain(
      'const { error } = await supabase.from("conversations").delete().eq("id", id);',
    );
    expect(f).toContain('toast.error("Could not delete the chat"');
    expect(f.indexOf("return;")).toBeLessThan(f.indexOf("loadConversations();"));
  });

  it("regenerating stops, with the old reply back, when the old reply could not be removed", () => {
    const f = fn("async function regenerateResponse(", "async function editAndResend(");
    expect(f).toContain("const before = messages;");
    expect(f).toContain(
      'const { error } = await supabase.from("messages").delete().eq("id", dbId);',
    );
    expect(f).toContain("setMessages(before);");
    expect(f).toContain('toast.error("Could not regenerate the reply"');
    // The error block itself RETURNS — earlier guards also return, so the block
    // is sliced out and checked on its own.
    const start = f.indexOf("if (error) {");
    const end = f.indexOf("\n    }\n", start);
    expect(end).toBeGreaterThan(start);
    expect(f.slice(start, end)).toContain("return;");
  });

  it("edit-and-resend stops, unchanged, when the later messages could not be removed", () => {
    const f = fn("async function editAndResend(", "async function deleteMessage(");
    expect(f).toContain("const before = messages;");
    expect(f).toContain(
      'const { error } = await supabase.from("messages").delete().in("id", toRemoveDbIds);',
    );
    expect(f).toContain("setMessages(before);");
    expect(f).toContain('toast.error("Could not resend the edited message"');
    expect(f.indexOf("return;")).toBeLessThan(f.indexOf("await persistMessage(editedMsg.id"));
  });
});
