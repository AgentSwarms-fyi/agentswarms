// Agent Chat across a selection change: the previous agent's conversations
// and the previous conversation's messages are cleared before the next read,
// a read that comes back for a selection no longer on screen is dropped, and
// a failed read does not leave the old rows under the new name.
//
// FOUND FROM THE SURVEY (R88) — the shape R76 fixed on Knowledge Bases.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");
const between = (start: string, end: string) =>
  src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const agentEffect = between("if (!selectedAgent) return;", "}, [selectedAgent]);");
const convoEffect = between("if (!activeConvo) return;", "}, [activeConvo]);");
const loadConversations = between(
  "async function loadConversations()",
  "async function loadMessages()",
);
const loadMessages = between("async function loadMessages()", "async function sendMessage");

describe("picking another agent", () => {
  it("clears its predecessor's conversations before reading this agent's", () => {
    expect(agentEffect).toContain("convoReq.current += 1;");
    expect(agentEffect).toContain("setConversations([]);");
    expect(agentEffect).toContain("setConvosLoaded(false);");
    expect(agentEffect.indexOf("setConversations([]);")).toBeLessThan(
      agentEffect.indexOf("loadConversations();"),
    );
  });

  it("drops a conversation read that comes back for another agent", () => {
    expect(loadConversations).toContain("const req = convoReq.current;");
    expect(loadConversations).toContain("if (req !== convoReq.current) return;");
  });
});

describe("picking another conversation", () => {
  it("clears its predecessor's messages before reading this one's", () => {
    expect(convoEffect).toContain("messageReq.current += 1;");
    expect(convoEffect).toContain("setMessages([]);");
    expect(convoEffect).toContain("setMessagesLoaded(false);");
    expect(convoEffect.indexOf("setMessages([]);")).toBeLessThan(
      convoEffect.indexOf("loadMessages();"),
    );
  });

  it("drops a message read that comes back for another conversation", () => {
    expect(loadMessages).toContain("const req = messageReq.current;");
    expect(loadMessages).toContain("if (req !== messageReq.current) return;");
  });

  it("marks both lists read on failure too, so neither waits for ever", () => {
    expect(loadConversations).toContain("setConvosLoaded(true);");
    expect(loadMessages).toContain("setMessagesLoaded(true);");
    // The failed branch marks it read before returning.
    const failed = loadMessages.slice(
      loadMessages.indexOf("Could not load this conversation's messages"),
    );
    expect(failed.indexOf("setMessagesLoaded(true);")).toBeLessThan(failed.indexOf("return;"));
  });
});

describe("the conversation's empty state", () => {
  it("says it is loading rather than inviting a first message over rows it has not read", () => {
    expect(src).toContain("Loading this conversation…");
    expect(src).toContain(
      "{messages.length === 0 && !messagesLoaded && !thinking && activeConvo && (",
    );
    expect(src).toContain(
      "{messages.length === 0 && (messagesLoaded || !activeConvo) && !thinking && (",
    );
  });
});
