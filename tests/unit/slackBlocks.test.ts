// Rendering an analyst answer for Slack.
//
// Slack truncates: a section over 3000 characters is rejected, a message over
// 50 blocks is rejected. So a long answer gets cut, and the only question is
// whether the reader is told. An answer that silently loses its last three
// findings is worse than one that says so, because the first looks complete.
//
// The other rule is the one the rest of this codebase runs on: Slack is a
// SUMMARY. A governed step is still labelled governed, a capped result still
// says it was capped, and every message links back to the rows and the SQL.
import { describe, expect, it } from "vitest";

import {
  SLACK_BLOCK_LIMIT,
  SLACK_TEXT_LIMIT,
  ackBlocks,
  analystAnswerBlocks,
  analystErrorBlocks,
  escapeSlackText,
  truncateForSlack,
} from "@/lib/slackBlocks";

const textOf = (blocks: Record<string, unknown>[]) => JSON.stringify(blocks);

describe("truncation says it truncated", () => {
  it("leaves a short string alone", () => {
    expect(truncateForSlack("hello")).toBe("hello");
  });

  it("marks a cut rather than just stopping", () => {
    // A paragraph that stops mid-thought reads as a complete short answer.
    const out = truncateForSlack("x".repeat(5000));
    expect(out).toMatch(/truncated/);
    expect(out).toMatch(/open in AgentSwarms/i);
  });

  it("stays inside the limit INCLUDING the marker", () => {
    // Appending the marker after cutting to the limit is the obvious bug: the
    // result is over the limit and Slack rejects the whole message.
    expect(truncateForSlack("x".repeat(5000)).length).toBeLessThanOrEqual(SLACK_TEXT_LIMIT);
  });
});

describe("mrkdwn escaping", () => {
  it("escapes exactly the three characters Slack requires", () => {
    expect(escapeSlackText('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
  });

  it("escapes ampersands before angle brackets, not after", () => {
    // Escaping < first then & would double-escape into &amp;lt;.
    expect(escapeSlackText("<")).toBe("&lt;");
    expect(escapeSlackText("&lt;")).toBe("&amp;lt;");
  });
});

describe("an answered question", () => {
  const blocks = analystAnswerBlocks({
    question: "What is monthly revenue?",
    answer: "Revenue grew 12% month over month, driven by EMEA.",
    steps: [
      { title: "Monthly revenue", summary: "Up 12%", governed: true },
      { title: "By region", truncatedRows: 1000 },
    ],
    url: "https://app.example.com/ai-analyst/t1",
    model: "gemini-2.5-flash",
  });

  it("leads with the question and the answer", () => {
    expect(textOf(blocks)).toContain("What is monthly revenue?");
    expect(textOf(blocks)).toContain("Revenue grew 12%");
  });

  it("keeps the governed label, so Slack is not where that distinction dies", () => {
    // Governed means the semantic layer compiled the SQL rather than the model
    // writing it. It is shown everywhere else.
    expect(textOf(blocks)).toContain("governed");
  });

  it("keeps a row cap visible", () => {
    expect(textOf(blocks)).toContain("first 1,000 rows only");
  });

  it("always links back, because this is a summary", () => {
    expect(textOf(blocks)).toContain("https://app.example.com/ai-analyst/t1");
  });

  it("names the model that answered", () => {
    expect(textOf(blocks)).toContain("gemini-2.5-flash");
  });

  it("says so when there is no link, rather than implying completeness", () => {
    const b = analystAnswerBlocks({ question: "q", answer: "a" });
    expect(textOf(b)).toMatch(/Open AgentSwarms/);
  });
});

describe("a long answer stays a valid Slack message", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ title: `Step ${i}` }));
  const blocks = analystAnswerBlocks({
    question: "q",
    answer: "a",
    steps: many,
    url: "https://x/y",
  });

  it("stays under Slack's block limit", () => {
    expect(blocks.length).toBeLessThanOrEqual(SLACK_BLOCK_LIMIT);
  });

  it("names how many steps it did not show", () => {
    expect(textOf(blocks)).toMatch(/more steps? not shown/);
  });

  it("still contains the link — the one element that must survive", () => {
    // Reserving room for the footer is why: a long step list must not push the
    // way back to the real answer off the message.
    expect(textOf(blocks)).toContain("https://x/y");
  });
});

describe("a failure says what happened", () => {
  it("includes the actual error, not just 'something went wrong'", () => {
    // A generic failure in a channel is how a broken integration goes
    // unreported for a week — nobody can tell it from a bad question.
    const b = analystErrorBlocks({ question: "q", error: "Binder Error: no such column FOO" });
    expect(textOf(b)).toContain("Binder Error: no such column FOO");
  });

  it("truncates a huge error rather than being rejected by Slack", () => {
    const b = analystErrorBlocks({ question: "q", error: "x".repeat(9000) });
    expect(JSON.stringify(b).length).toBeLessThan(4000);
  });
});

describe("the immediate ack", () => {
  it("names the question, so a busy channel can tell whose it is", () => {
    expect(textOf(ackBlocks("what is revenue"))).toContain("what is revenue");
  });
});
