// Deleting a chat on /playground asks first.
//
// REPORTED FROM USE. The trash icon in the chat sidebar deleted on the first
// click — no question, no undo, no trash to recover from. It sits one row away
// from the conversation you are working in, so the misclick that costs you an
// active session is a small one, and `messages.conversation_id` is
// ON DELETE CASCADE: the row takes every prompt and every answer with it.
//
// Same defect as [kbDeleteAsksFirst] — that file's header says a sweep for
// suppressible native confirms "could not have caught this, because it hunts
// confirmations that EXIST", and here it is again on a different page. So this
// pins BOTH halves: the question is asked, and cancelling really does nothing.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const PLAYGROUND = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");

/** Comments off: this fix's own comment explains the cascade in prose. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

function fnBody(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}(async )?function \w+\(/);
  return rest.slice(0, next === -1 ? undefined : next);
}

describe("deleting a chat", () => {
  const body = fnBody(code(PLAYGROUND), "deleteConversation");

  it("asks through the in-app dialog before the row is deleted", () => {
    const ask = body.indexOf("await confirmAsk({");
    const del = body.indexOf('.from("conversations").delete()');
    expect(ask, "confirmAsk is called").toBeGreaterThan(-1);
    expect(del, "the delete still happens").toBeGreaterThan(-1);
    expect(ask, "and the question comes first").toBeLessThan(del);
    // Cancelling must leave the chat alone: the guard returns, not continues.
    expect(body).toMatch(/!\(await confirmAsk\(\{[\s\S]*?\}\)\)\s*\)\s*return;/);
  });

  it("names the chat, and what goes with it", () => {
    // A dialog that says "Are you sure?" tells the reader nothing they did not
    // already know. Which chat, and what is lost, are the two facts that make
    // the answer different from a reflex.
    expect(body).toMatch(/conversations\.find\(/);
    expect(body).toMatch(/Every message in this chat goes with it/);
    expect(body).toMatch(/cannot be undone/i);
    expect(body).toMatch(/actionLabel: "Delete chat"/);
  });

  it("guards the operation, not one button", () => {
    // The sidebar is rendered twice — a Sheet on mobile, a column on desktop —
    // and both pass this same handler. Asking inside the handler covers both;
    // asking in the button would have covered whichever one I happened to
    // open. Pinned so a later refactor does not move the question outward.
    expect((PLAYGROUND.match(/onDelete=\{deleteConversation\}/g) ?? []).length).toBe(2);
  });

  it("uses the shared host, not a native dialog", () => {
    // window.confirm returns false with nothing shown once a browser offers
    // "prevent this page from creating additional dialogs" — see the header of
    // src/components/ui/confirm-dialog.tsx.
    expect(PLAYGROUND).toContain('from "@/components/ui/confirm-dialog"');
    expect(body).not.toMatch(/window\.confirm\(|[^a-zA-Z.]confirm\(/);
  });
});
