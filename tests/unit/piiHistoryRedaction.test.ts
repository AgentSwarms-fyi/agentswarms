// The PII guardrail covers the whole conversation, not just the newest message
// (R351).
//
// FOUND FROM THE UI (R350). The R347 fixture agent redacts emails. On its
// first turn, "My email is r348.check@example.test…" reached the model as
// [REDACTED_EMAIL]. But the input check rewrote only the newest user message.
// The trace of the ninth turn after it still carried the raw sentence in its
// history, and the rolling summary, folded from the stored messages, read
// "User's email address is r348.check@example.test". The next turn's system
// prompt carried that. The raw prompt also went on to the knowledge-base
// search (embedded, searched, audited), the memory recall, and the memories
// written after the turn.
//
// redactHistoryPII holds every earlier message to the policy: user messages
// under the input side, assistant messages under the output side. The chat
// route, the embed widget, the summary and the memory blocks use it or its
// redactor.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGuardrails, piiRedactorFor, redactHistoryPII } from "@/utils/guardrails";

const EMAIL = "r348.check@example.test";
const conversation = () => [
  { role: "user", content: `My email is ${EMAIL}. Repeat back exactly the email address.` },
  { role: "assistant", content: "[REDACTED_EMAIL]" },
  {
    role: "user",
    content: "Remember this: my project codename is BLUE HERON. Reply with just OK.",
  },
  { role: "assistant", content: "OK." },
  { role: "user", content: "Filler 9. Reply with just OK." },
];

describe("a conversation under a redacting agent", () => {
  it("every earlier user message is redacted, not just the newest", () => {
    const { messages, counts } = redactHistoryPII(
      conversation(),
      parseGuardrails({ piiMode: "redact" }),
    );
    expect(messages[0].content).toBe(
      "My email is [REDACTED_EMAIL]. Repeat back exactly the email address.",
    );
    expect(JSON.stringify(messages)).not.toContain(EMAIL);
    expect(counts).toEqual({ email: 1 });
  });

  it("what holds nothing to redact comes back as the same objects", () => {
    const input = conversation().slice(2);
    const { messages, counts } = redactHistoryPII(input, parseGuardrails({ piiMode: "redact" }));
    messages.forEach((m, i) => expect(m).toBe(input[i]));
    expect(counts).toEqual({});
  });

  it("each side follows the policy's direction", () => {
    const both = [
      { role: "user", content: `mail ${EMAIL}` },
      { role: "assistant", content: `noted, ${EMAIL}` },
      { role: "system", content: `owner ${EMAIL}` },
    ];
    const text = (applyTo: string) =>
      redactHistoryPII(
        both,
        parseGuardrails({ piiMode: "redact", piiApplyTo: applyTo }),
      ).messages.map((m) => m.content);
    expect(text("input")).toEqual(["mail [REDACTED_EMAIL]", `noted, ${EMAIL}`, `owner ${EMAIL}`]);
    expect(text("output")).toEqual([`mail ${EMAIL}`, "noted, [REDACTED_EMAIL]", `owner ${EMAIL}`]);
    expect(text("both")).toEqual([
      "mail [REDACTED_EMAIL]",
      "noted, [REDACTED_EMAIL]",
      `owner ${EMAIL}`,
    ]);
  });

  it("with PII off nothing changes; the legacy switch alone redacts", () => {
    const off = redactHistoryPII(conversation(), parseGuardrails({}));
    expect(off.messages[0].content).toContain(EMAIL);
    const legacy = redactHistoryPII(conversation(), parseGuardrails({ blockPII: true }));
    expect(legacy.messages[0].content).not.toContain(EMAIL);
  });

  it("redacts the text parts of a message with an image, and leaves the image", () => {
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
    const { messages } = redactHistoryPII(
      [{ role: "user", content: [{ type: "text", text: `see ${EMAIL}` }, image] }],
      parseGuardrails({ piiMode: "redact" }),
    );
    expect(messages[0].content).toEqual([{ type: "text", text: "see [REDACTED_EMAIL]" }, image]);
  });

  it("the redactor answers for one side at a time", () => {
    const redact = piiRedactorFor(parseGuardrails({ piiMode: "redact", piiApplyTo: "input" }));
    expect(redact(`summary: ${EMAIL}`, "input").text).toBe("summary: [REDACTED_EMAIL]");
    expect(redact(`summary: ${EMAIL}`, "output").text).toBe(`summary: ${EMAIL}`);
  });
});

describe("where the conversation leaves the server", () => {
  const CHAT = readFileSync("src/routes/api/chat.ts", "utf8");
  const EMBED = readFileSync("src/routes/api/embed.chat.ts", "utf8");

  it("the chat route redacts the whole history in place, so the trace is redacted too", () => {
    expect(CHAT).toContain("const history = redactHistoryPII(body.messages, effectiveGuardrails);");
    expect(CHAT).toContain("body.messages[i].content = m.content;");
  });

  it("the search, the recall and the memory written after the turn read the guarded prompt", () => {
    expect(CHAT).toContain("const query = guardedPrompt;");
    expect(CHAT).toContain("userPrompt: guardedPrompt,");
    expect((CHAT.match(/userMessage: guardedPrompt,/g) ?? []).length).toBe(2);
    expect(CHAT).toContain("guardedPrompt = decision.outboundText;");
  });

  it("the summary and the recalled memories are redacted on their way into the prompt", () => {
    expect(CHAT).toContain('ltmBlock: redactMemory(loaded.ltmBlock, "input").text,');
    expect(CHAT).toContain('summaryBlock: redactMemory(loaded.summaryBlock, "input").text,');
  });

  it("the post-turn memory folds and extracts under the policy", () => {
    expect(
      (
        CHAT.match(
          /redact: \(text, side\) => piiRedactorFor\(effectiveGuardrails\)\(text, side\)\.text,/g,
        ) ?? []
      ).length,
    ).toBe(2);
    expect(CHAT).toContain("redact: ctx.redact,");
    expect(CHAT).toContain('userMessage: ctx.redact(ctx.userMessage, "input"),');
    expect(CHAT).toContain('assistantMessage: ctx.redact(assistantText, "output"),');
  });

  it("the embed widget redacts the visitor's whole conversation, and sends that", () => {
    expect(EMBED).toContain(
      "const guardedHistory = redactHistoryPII(history, cfg.guardrails).messages;",
    );
    // The redacted copy replaces what goes to the model.
    expect(EMBED).toContain("guardedHistory.forEach((m, i) => (history[i] = m));");
    const at = EMBED.indexOf("guardedHistory.forEach");
    expect(at).toBeLessThan(EMBED.indexOf("...history,", at));
  });
});
