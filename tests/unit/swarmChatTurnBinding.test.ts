// A swarm chat turn saves into the conversation it was sent in (R180).
//
// Before: leaving a conversation mid-turn aborted the turn, and the aborted
// turn's save followed whatever was on screen when it landed. After New chat
// (or reopening the dialog) it inserted a copy of the old conversation and
// bound the empty screen to it, so the next message wrote over that copy.
// After switching, a turn still inside a call that takes no abort signal
// saved its conversation over the one just opened, and that conversation's
// own exchange was gone. The dialog has no render harness here, so it is
// pinned by source, section by section.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/components/swarms/SwarmChatDialog.tsx", "utf8");
const between = (start: string, end: string) => {
  const a = SRC.indexOf(start);
  if (a < 0) throw new Error(`${start} not found`);
  const b = SRC.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`${end} not found after ${start}`);
  return SRC.slice(a, b);
};
const NEW_CHAT = between("const newChat = useCallback(", "}, []);");
const OPEN_EFFECT = between("if (open && swarmId) {", "}, [open, swarmId]);");
const SELECT = between("const selectChat = async (id: string) => {", "const deleteChat = async");
const SAVE_AWAY = between("const saveAway = async (", "const send = async () => {");
const SEND = between("const send = async () => {", "const stateEntries =");

describe("a turn knows where it was sent", () => {
  it("takes its screen, its conversation and its swarm when it starts", () => {
    const start = SEND.indexOf("abortRef.current = controller;");
    expect(start).toBeGreaterThan(0);
    const head = SEND.slice(start, SEND.indexOf("await runSwarm("));
    expect(head).toContain("const screen = screenRef.current;");
    expect(head).toContain("const turnChatId = chatIdRef.current;");
    expect(head).toContain("turnSwarmRef.current = swarmId;");
  });

  it("lands in its own conversation when its screen has gone, and touches nothing on screen", () => {
    const away = SEND.indexOf("if (screenRef.current !== screen) {");
    expect(away).toBeGreaterThan(SEND.indexOf("await runSwarm("));
    const branch = SEND.slice(away, SEND.indexOf("return;", away) + "return;".length);
    expect(branch).toMatch(/await saveAway\(\s*turnChatId,/);
    expect(branch).toMatch(/failure \? withUser : \[\.\.\.withUser, reply\]/);
    expect(branch).toMatch(/failure \? carriedState : carriedFrom\(finalSt\)/);
    expect(branch).not.toMatch(/\bset[A-Z]\w*\(/);
    // The branch comes before anything the screen shows is changed.
    expect(SEND.indexOf("setRunning(false);")).toBeGreaterThan(away);
    expect(SEND.indexOf("await persist(")).toBeGreaterThan(away);
  });

  it("saves away without selecting what it saved", () => {
    expect(SAVE_AWAY).toMatch(/await saveChat\(supabase, \{\s*chatId,/);
    expect(SAVE_AWAY).not.toMatch(/\bset[A-Z]\w*\(/);
    expect(SAVE_AWAY).not.toContain("chatIdRef.current =");
    expect(SAVE_AWAY).toContain("toast.error(");
  });
});

describe("the screen changes", () => {
  it("on New chat, which also forgets the turn it ended", () => {
    expect(NEW_CHAT).toMatch(
      /abortRef\.current\?\.abort\(\);\s*abortRef\.current = null;\s*screenRef\.current \+= 1;\s*chatIdRef\.current = null;/,
    );
  });

  it("on a switch, only once the conversation has been read", () => {
    const read = SELECT.indexOf("await openChat(supabase, id);");
    const failed = SELECT.indexOf("if (!opened.ok) {");
    const abort = SELECT.indexOf("abortRef.current?.abort();");
    expect(read).toBeGreaterThan(0);
    expect(abort).toBeGreaterThan(failed);
    expect(SELECT.slice(abort)).toMatch(
      /abortRef\.current\?\.abort\(\);\s*abortRef\.current = null;\s*screenRef\.current \+= 1;\s*chatIdRef\.current = id;/,
    );
    expect(SELECT.slice(0, read)).not.toContain("abort()");
  });

  it("not on a reopen while this swarm's turn is still running", () => {
    expect(OPEN_EFFECT).toMatch(
      /if \(!\(abortRef\.current && turnSwarmRef\.current === swarmId\)\) newChat\(\);/,
    );
  });
});
