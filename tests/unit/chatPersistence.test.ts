// Agent Chat: a message whose save failed is marked and said, not shown as
// saved and lost on the next reload.
//
// FOUND FROM THE UI. With every insert to `messages` rejected, a probe turn
// appeared on screen like any other — "You: R65 probe…", "Assistant: OK" —
// with no toast and no mark, and was gone after a reload. Five of the page's
// six message inserts dropped their error; the sixth (documents) already
// warned "built, but not saved". Every insert now goes through one helper.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");

describe("every message insert goes through persistMessage", () => {
  it("and none inserts on its own any more", () => {
    // The document save keeps its own warning path; every other insert is the helper's.
    const own = page.match(/\.from\("messages"\)\s*\.insert\(/g) ?? [];
    expect(own.length).toBe(2); // the helper itself + the document save
    expect((page.match(/await persistMessage\(/g) ?? []).length).toBe(6);
  });

  it("marks the on-screen message and says why when the save fails", () => {
    const helper = page.slice(
      page.indexOf("async function persistMessage("),
      page.indexOf("dbIdMap.current.set(localId, data.id);"),
    );
    expect(helper).toContain(
      'const { data, error } = await supabase.from("messages").insert(row).select("id").single();',
    );
    expect(helper).toContain("if (error || !data?.id) {");
    expect(helper).toContain("{ ...m, unsaved: why }");
    expect(helper).toContain('toast.warning("This message was not saved to the conversation"');
    expect(helper).toContain("It will not be here after a reload.");
  });

  it("remembers the real id only when one came back", () => {
    expect(page).toContain("dbIdMap.current.set(localId, data.id);");
    expect(page).not.toMatch(/if \(inserted\w*\?\.id\) dbIdMap\.current\.set/);
  });
});

describe("the bubble shows the mark", () => {
  it("under the sender's name, with the reason on hover", () => {
    expect(page).toContain("unsaved?: string;");
    expect(page).toContain("{message.unsaved ? (");
    expect(page).toContain("not saved — it will not be here after a reload");
    expect(page).toContain("title={message.unsaved}");
  });
});

describe("the conversation reads keep their error", () => {
  it("and a failed conversations read creates no 'New Chat'", () => {
    const load = page.slice(
      page.indexOf("async function loadConversations()"),
      page.indexOf("async function loadMessages()"),
    );
    expect(load).toContain("const { data, error } = await supabase");
    expect(load).toContain("Could not load this agent's conversations");
    // The error return comes BEFORE the branch that would auto-create a chat.
    expect(load).toContain("if (error) {");
    expect(load.indexOf("if (error) {")).toBeLessThan(
      load.indexOf("Auto-create a first conversation"),
    );
  });

  it("and a failed messages read is said, not shown as empty", () => {
    const load = page.slice(
      page.indexOf("async function loadMessages()"),
      page.indexOf("async function createConversation()"),
    );
    expect(load).toContain("const { data, error } = await supabase");
    expect(load).toContain("Could not load this conversation's messages");
  });
});
