// Deleting a knowledge base asks first.
//
// FOUND FROM THE UI, while cleaning up a test fixture: the per-base delete
// control removed the whole knowledge base -- every document, chunk and
// connected source -- on one click, with no question asked. Only sample bases
// were protected. The sweep that replaced every native confirm() in the app
// could not have caught this, because it hunts confirmations that EXIST and
// are suppressible, not confirmations that never existed. This test is the
// other half of that guard: a destructive action must ask, and must ask
// through the dialog the browser cannot switch off.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const KNOWLEDGE = readFileSync("src/routes/_authenticated/knowledge.tsx", "utf8");

/** Comments off: the fix's own comment says "confirm()" while explaining why. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

function fnBody(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  // Up to the next top-level function in the same component.
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}(async )?function \w+\(/);
  return rest.slice(0, next === -1 ? undefined : next);
}

describe("deleting a knowledge base", () => {
  const body = fnBody(code(KNOWLEDGE), "deleteBase");

  it("asks through the in-app dialog before the row is deleted", () => {
    const ask = body.indexOf("await confirmAsk({");
    const del = body.indexOf('.from("knowledge_bases").delete()');
    expect(ask, "confirmAsk is called").toBeGreaterThan(-1);
    expect(del, "the delete still happens").toBeGreaterThan(-1);
    expect(ask, "and the question comes first").toBeLessThan(del);
    // Cancelling must leave the base alone: the guard returns, not continues.
    expect(body).toMatch(/!\(await confirmAsk\(\{[\s\S]*?\}\)\)\s*\)\s*return;/);
  });

  it("names what will be lost, in the user's terms", () => {
    expect(body).toMatch(/Every document, chunk and connected source/);
    expect(body).toMatch(/actionLabel: "Delete knowledge base"/);
  });

  it("still refuses to delete a sample base", () => {
    // Pre-existing protection; the new question must not have replaced it.
    expect(body).toContain("Sample knowledge bases can't be deleted");
  });

  it("uses the shared host, not a native dialog", () => {
    expect(KNOWLEDGE).toContain('from "@/components/ui/confirm-dialog"');
    expect(body).not.toMatch(/window\.confirm\(|[^a-zA-Z.]confirm\(/);
  });
});
