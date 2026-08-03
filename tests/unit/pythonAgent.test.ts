// What a notebook cell prints when it runs a saved agent.
//
// /api/chat answers as SSE and this collapses it to the reply. The fallback for
// a non-SSE body was `out || raw`, which cannot tell "this body was not SSE"
// from "this SSE stream carried no text" — so a guardrail-blocked answer, a
// citations-only answer, or an empty completion printed the raw protocol
// transcript into the cell.
import { describe, expect, it } from "vitest";

import { collapseSse } from "@/routes/api/python-agent";

const sse = (...lines: string[]) => lines.join("\n") + "\n\n";
const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;

describe("collapsing an SSE answer", () => {
  it("joins streamed deltas in order", () => {
    expect(collapseSse(sse(delta("Hello"), delta(", "), delta("world"), "data: [DONE]"))).toBe(
      "Hello, world",
    );
  });

  it("reads a non-streamed message frame too", () => {
    const body = sse(
      `data: ${JSON.stringify({ choices: [{ message: { content: "Complete answer" } }] })}`,
      "data: [DONE]",
    );
    expect(collapseSse(body)).toBe("Complete answer");
  });

  it("ignores keep-alives, custom events and unparseable frames", () => {
    const body = sse(
      ": keep-alive",
      "event: citations",
      `data: ${JSON.stringify({ citations: [{ index: 1, documentName: "policy.pdf" }] })}`,
      delta("The answer"),
      "data: {not json",
      "data: [DONE]",
    );
    expect(collapseSse(body)).toBe("The answer");
  });

  it("keeps whitespace inside the answer", () => {
    // Trimming each frame would glue words together across chunk boundaries.
    expect(collapseSse(sse(delta("one "), delta("two"), "data: [DONE]"))).toBe("one two");
  });
});

describe("a stream that carried no text", () => {
  it("returns nothing rather than the protocol transcript", () => {
    // THE BUG. Reachable whenever the answer has frames but no content: a
    // blocked answer, a citations-only answer, an empty completion.
    const body = sse(
      ": keep-alive",
      "event: citations",
      `data: ${JSON.stringify({ citations: [{ index: 1, documentName: "policy.pdf" }] })}`,
      "data: [DONE]",
    );
    const out = collapseSse(body);
    expect(out).toBe("");
    expect(out).not.toContain("keep-alive");
    expect(out).not.toContain("policy.pdf");
  });

  it("returns nothing for a bare DONE", () => {
    expect(collapseSse("data: [DONE]\n\n")).toBe("");
    // Deleting the explicit `payload === "[DONE]"` skip survives mutation
    // testing, and correctly so: "[DONE]" is not valid JSON, so JSON.parse
    // throws and the catch ignores the frame either way. The check is kept for
    // clarity and to avoid a throw per stream, not for behaviour — noted here
    // so the surviving mutant reads as equivalence rather than a missing test.
  });

  it("does not leak an event: line either", () => {
    expect(collapseSse("event: widget\n\n")).toBe("");
  });
});

describe("a body that is not SSE at all", () => {
  it("passes a plain JSON answer through, which is what the fallback is for", () => {
    expect(collapseSse('{"output":"hi"}')).toBe('{"output":"hi"}');
  });

  it("passes plain text through", () => {
    expect(collapseSse("just text")).toBe("just text");
  });

  it("passes an empty body through", () => {
    expect(collapseSse("")).toBe("");
  });

  it("does not mistake prose that mentions data: for a stream", () => {
    // The SSE test is anchored to the start of a line, so an answer discussing
    // "data: " mid-sentence is still returned.
    expect(collapseSse("the field is data: foo")).toBe("the field is data: foo");
  });
});
