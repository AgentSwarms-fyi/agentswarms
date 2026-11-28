// A numbered list keeps the number it starts at.
//
// FOUND FROM THE UI. Asked "what is 5+7", an agent answered "12." and the chat
// showed "1.". The model was right: its streamed answer was "12" then ".". In
// markdown a line that is only a number and a full stop is a numbered list
// with one empty item, starting at that number, and the chat's renderer drew
// <ol> without its `start`, so every such list began at 1. "10.", "8." and
// "11." all read "1.", while "12" (no full stop) read right, so the same agent
// looked right one time in ten. Any list starting past 1 ("3. … 4. …") was
// renumbered the same way.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BiTextBlock } from "@/components/bi/BiTextBlock";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { lastListNumber, numberedListIndent } from "@/lib/listIndent";

/** The rendered HTML, without classes or the list's indent, on one line. */
const chatHtml = (content: string) =>
  renderToStaticMarkup(createElement(MarkdownMessage, { content })).replace(/\n/g, "");
const chat = (content: string) =>
  chatHtml(content)
    .replace(/ class="[^"]*"/g, "")
    .replace(/ style="margin-left:[^"]*"/g, "");
const biText = (text: string) =>
  renderToStaticMarkup(createElement(BiTextBlock, { text, style: {} }))
    .replace(/ (class|style)="[^"]*"/g, "")
    .replace(/\n/g, "");

describe("an answer that is only a number and a full stop", () => {
  it("shows that number, not 1", () => {
    for (const answer of ["12.", "10.", "8.", "11."]) {
      expect(chat(answer), answer).toContain(`<ol start="${answer.slice(0, -1)}">`);
    }
  });

  it("without a full stop is a plain line, as it always was", () => {
    expect(chat("12")).toBe("<div><p>12</p></div>");
  });
});

describe("a numbered list", () => {
  it("in the chat keeps the number it starts at", () => {
    expect(chat("3. third\n4. fourth")).toContain(
      '<ol start="3"><li>third</li><li>fourth</li></ol>',
    );
  });

  it("starting at 1 is drawn as before", () => {
    expect(chat("1. one\n2. two")).toMatch(/<ol( start="1")?><li>one<\/li><li>two<\/li><\/ol>/);
  });

  it("in a BI text block keeps the number it starts at too", () => {
    expect(biText("3. third\n4. fourth")).toContain('<ol start="3">');
  });
});

// FOUND FROM THE UI, after the fix above: "10." then read "0.". A list's
// numbers sit in the space left of its items, which was 1.25rem: room for one
// digit. The "1" of "10." fell past the message's edge and was cut off.
describe("a numbered list's indent", () => {
  it("is the usual one while every number is one digit", () => {
    expect(numberedListIndent(9)).toBeUndefined();
    expect(numberedListIndent(1)).toBeUndefined();
    expect(numberedListIndent(0)).toBeUndefined();
  });

  it("grows with the digits of the widest number", () => {
    expect(numberedListIndent(10)).toBe("calc(3ch + 0.5rem)");
    expect(numberedListIndent(99)).toBe("calc(3ch + 0.5rem)");
    expect(numberedListIndent(100)).toBe("calc(4ch + 0.5rem)");
  });

  it("is sized for the last number, not the first", () => {
    const items = [1, 2, 3].map((i) => createElement("li", { key: i }));
    expect(lastListNumber(8, items)).toBe(10);
    expect(lastListNumber(undefined, items)).toBe(3);
    expect(lastListNumber(12, "\n")).toBe(12); // "12." alone: one empty item
  });

  it("is what the chat draws, so a two-digit answer keeps both digits", () => {
    expect(chatHtml("10.")).toContain('style="margin-left:calc(3ch + 0.5rem)"');
    expect(chatHtml("9. nine\n10. ten")).toContain('style="margin-left:calc(3ch + 0.5rem)"');
    expect(chatHtml("8.")).not.toContain("margin-left");
    expect(chatHtml("1. one\n2. two")).not.toContain("margin-left");
  });

  it("is what a BI text block draws too", () => {
    const html = renderToStaticMarkup(
      createElement(BiTextBlock, { text: "10. ten\n11. eleven", style: {} }),
    );
    expect(html).toContain("margin-left:calc(3ch + 0.5rem)");
  });
});
