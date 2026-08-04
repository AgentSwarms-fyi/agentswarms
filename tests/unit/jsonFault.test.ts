// Document generation failed roughly one run in six and said the model had
// "ignored the JSON-only instruction". It hadn't. The trace recorded HEAD and
// TAIL of the reply — 160 characters from each end of a 26KB document — and
// both ends were perfectly valid JSON, so the log looked like a contradiction
// and the advice it gave ("use a different model") was aimed at the wrong
// problem entirely.
//
// The actual fault, once the failing offset was printed, was a single stuttered
// token 11214 characters in:
//
//   { "type": "type": "table", ...
//
// A random generation glitch. These tests pin the diagnostic that can see such
// a thing: the parser's own message, the offset, and — critically — a window of
// text around it with control characters rendered visibly, because "raw newline
// inside a string" and "unescaped quote" are indistinguishable otherwise.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { describeJsonFault, repairJsonGlitches } from "@/utils/jsonFault";

const BI_ROUTE = readFileSync("src/routes/api/bi.ts", "utf8");

/** Parse for real, so the assertions run against V8's actual error text. */
function faultOf(text: string): string {
  try {
    JSON.parse(text);
    throw new Error("expected this payload to be invalid JSON");
  } catch (e) {
    return describeJsonFault(text, e);
  }
}

/** A long document, valid at both ends, broken only in the middle. */
function stutteredDocument(): string {
  const filler = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `    { "type": "paragraph", "text": "Section ${i} of the review." }`,
    ).join(",\n");
  return `{
  "title": "Quarterly Business Review",
  "blocks": [
${filler(60)},
    { "type": "type": "table", "table": { "columns": ["Metric"] } },
${filler(60)}
  ]
}`;
}

// Quotes inside the window arrive escaped — that is deliberate, and it is what
// makes a control character visible. Written out here so the expectations below
// read as the text a human sees in the trace.
const ESCAPED_STUTTER = '\\"type\\": \\"type\\"';

describe("describeJsonFault points at the fault, not the ends", () => {
  it("reports the offset and shows the stuttered token in context", () => {
    const doc = stutteredDocument();
    const out = faultOf(doc);

    // The offending text itself must appear — this is the whole point.
    expect(out).toContain(ESCAPED_STUTTER);
    // ...marked, so a reader knows which side of the window failed.
    expect(out).toContain("⟪FAULT⟫");
    // ...and located, both absolutely and against the total size.
    expect(out).toMatch(/NEAR position \d+ of \d+/);
  });

  it("shows a fault the old HEAD/TAIL logging could not have shown", () => {
    const doc = stutteredDocument();
    // Precondition: this document really is well-formed at both ends, which is
    // why 160 characters from each end explained nothing.
    const head = doc.slice(0, 160);
    const tail = doc.slice(-160);
    expect(head).not.toContain('"type": "type"');
    expect(tail).not.toContain('"type": "type"');

    expect(faultOf(doc)).toContain(ESCAPED_STUTTER);
  });

  it("renders control characters visibly so a raw newline is not invisible", () => {
    // A literal newline inside a string — illegal in JSON, and impossible to
    // see in a log that prints the excerpt raw.
    const out = faultOf('{"text": "line one\nline two"}');
    // Escaped in the output, not printed as an actual line break.
    expect(out).toContain("\\n");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("distinguishes an unescaped quote from a control character", () => {
    const out = faultOf('{"text": "the "flagship" product"}');
    // The parser stops AT the stray quote, so the marker lands between the
    // escaped quote and the word it preceded.
    expect(out).toContain('the \\"⟪FAULT⟫flagship');
    expect(out).not.toContain("\\n");
  });

  it("degrades to HEAD/TAIL rather than losing an error with no position", () => {
    const out = describeJsonFault("some payload", new Error("upstream exploded"));
    expect(out).toContain("upstream exploded");
    expect(out).toContain("HEAD:");
    expect(out).toContain("TAIL:");
  });

  it("survives a fault reported at the very end of a truncated payload", () => {
    // Truncation puts the offset AT text.length, where a naive slice would
    // read past the end.
    const truncated = '{"blocks": [{"text": "cut off mid-sentence';
    expect(() => faultOf(truncated)).not.toThrow();
    expect(faultOf(truncated)).toMatch(/NEAR position \d+ of \d+|HEAD:/);
  });

  it("keeps the whole report on one line so a trace row stays readable", () => {
    expect(faultOf(stutteredDocument()).split("\n")).toHaveLength(1);
  });
});

describe("repairJsonGlitches fixes the shape actually observed", () => {
  // Five consecutive failures, five different offsets, one shape — always the
  // block immediately before a table. Reproduced verbatim from the traces.
  const REAL = `{
  "title": "Quarterly Business Review",
  "blocks": [
    { "type": "paragraph", "text": "Product-level profitability should inform strategy." },
    { "type": "type": "table",
      "table": { "columns": ["Region", "Total Sales ($)"], "rows": [["EMEA", 1043887]] } }
  ]
}`;

  it("turns the real failing payload into the plan the model meant", () => {
    expect(() => JSON.parse(REAL)).toThrow();

    const fixed = repairJsonGlitches(REAL);
    expect(fixed).not.toBeNull();

    const plan = JSON.parse(fixed!);
    // The duplicated key is gone AND the intended value survived — a repair
    // that dropped the type would build a silently wrong document.
    expect(plan.blocks[1].type).toBe("table");
    expect(plan.blocks[1].table.columns).toEqual(["Region", "Total Sales ($)"]);
    expect(plan.blocks[1].table.rows).toEqual([["EMEA", 1043887]]);
    expect(plan.blocks[0].text).toContain("Product-level profitability");
  });

  it("leaves a correct table block completely alone", () => {
    // `"type": "table"` legitimately precedes a `"table"` KEY. Rewriting that
    // would break every well-formed plan.
    const good = '{"type": "table", "table": {"columns": ["A"], "rows": [[1]]}}';
    expect(repairJsonGlitches(good)).toBeNull();
    expect(JSON.parse(good).table.columns).toEqual(["A"]);
  });

  it("refuses to guess when the two keys are not actually the same", () => {
    // `"type": "heading": "table"` is broken too, but which token was intended
    // is unknowable. A rewrite that matched any key/value pair would silently
    // resolve it to `{"type": "table"}` — valid JSON carrying invented content,
    // which is worse than the visible failure it replaced.
    expect(repairJsonGlitches('{"type": "heading": "table"}')).toBeNull();
    expect(repairJsonGlitches('{"level": "1": "text"}')).toBeNull();
  });

  it("reports nothing to do when the fault is a different shape", () => {
    // Truncation, unescaped quotes, raw newlines — none are this bug, and
    // claiming a repair for them would mask them.
    expect(repairJsonGlitches('{"text": "the "flagship" product"}')).toBeNull();
    expect(repairJsonGlitches('{"blocks": [{"text": "cut off')).toBeNull();
    expect(repairJsonGlitches('{"a": 1, "b": 2}')).toBeNull();
  });

  it("removes a stray statement terminator, the second shape seen in traces", () => {
    // Observed on sonnet: the model closed a string value and then wrote a
    // semicolon, as if it were finishing a statement.
    const withSemicolon = `{
  "blocks": [
    { "type": "paragraph", "text": "...the widest margin variance.";
    },
    { "type": "paragraph", "text": "Key priorities for the coming quarter." }
  ]
}`;
    expect(() => JSON.parse(withSemicolon)).toThrow();

    const plan = JSON.parse(repairJsonGlitches(withSemicolon)!);
    expect(plan.blocks[0].text).toBe("...the widest margin variance.");
    expect(plan.blocks[1].text).toContain("Key priorities");
  });

  it("leaves semicolons that are genuinely inside prose alone", () => {
    // A semicolon is ordinary punctuation. Only one sitting between a closing
    // quote and a closing bracket has a single possible reading.
    const prose = '{"text": "first clause; second clause", "n": 1}';
    expect(repairJsonGlitches(prose)).toBeNull();
    expect(JSON.parse(prose).text).toBe("first clause; second clause");
  });

  it("does not treat an escaped quote as the end of a value", () => {
    // The hostile case: prose that ends with a quoted word, a semicolon and a
    // brace — `he said "go"; }` — reproduces the exact byte sequence the rule
    // looks for, while every one of those characters is inside the string.
    // Without the lookbehind this parses fine but quietly loses the semicolon
    // from the user's text.
    const escaped = '{"text": "he said \\"go\\"; }", "n": 1}';
    expect(repairJsonGlitches(escaped)).toBeNull();
    expect(JSON.parse(escaped).text).toBe('he said "go"; }');

    // ...and the ordinary case, where the semicolon is just punctuation.
    const plain = '{"text": "he said \\"go\\"; then left", "n": 1}';
    expect(repairJsonGlitches(plain)).toBeNull();
    expect(JSON.parse(plain).text).toBe('he said "go"; then left');
  });

  it("fixes every occurrence, not just the first", () => {
    const twice = '{"blocks":[{"type": "type": "table"},{"type": "type": "table"}]}';
    const plan = JSON.parse(repairJsonGlitches(twice)!);
    expect(plan.blocks.map((b: { type: string }) => b.type)).toEqual(["table", "table"]);
  });

  it("handles the same collision on a slide plan's layout key", () => {
    // Deck plans carry the identical hazard: layout/chart/table/diagram.
    const slide = '{"slides":[{"layout": "layout": "chart", "chart": {"type": "column"}}]}';
    const plan = JSON.parse(repairJsonGlitches(slide)!);
    expect(plan.slides[0].layout).toBe("chart");
    expect(plan.slides[0].chart.type).toBe("column");
  });
});

describe("the BI endpoint uses it, and retries the glitch", () => {
  it("tries the repair before spending a whole retry", () => {
    expect(BI_ROUTE).toContain("repairJsonGlitches(cleaned)");
  });

  it("never repairs silently", () => {
    // A repair nobody can see is an upstream defect nobody will ever fix.
    expect(BI_ROUTE).toContain("Repaired a duplicated JSON key from");
  });

  it("still parses the repaired text rather than trusting the rewrite", () => {
    expect(BI_ROUTE).toContain("const result = JSON.parse(repaired);");
  });

  it("diagnoses the parse failure with the fault window", () => {
    expect(BI_ROUTE).toContain("describeJsonFault(cleaned, firstErr)");
  });

  it("keeps the FIRST parse error, not the salvage attempts'", () => {
    // candidates[0] is what the model meant to send; the brace/bracket slices
    // after it are salvage, and their errors describe the salvage.
    expect(BI_ROUTE).toContain("if (firstErr === undefined) firstErr = e;");
  });

  it("retries a malformed reply instead of discarding the generation", () => {
    expect(BI_ROUTE).toMatch(/MAX_ATTEMPTS\s*=\s*2/);
    expect(BI_ROUTE).toContain("attempt < MAX_ATTEMPTS");
  });

  it("bounds every attempt by one shared deadline", () => {
    // Per-attempt deadlines would let a retry run past the client's own
    // timeout, so the specific server error would never arrive.
    expect(BI_ROUTE).toContain("const deadlineAt = startedAt + upstreamMs;");
    expect(BI_ROUTE).toContain("deadlineAt - Date.now()");
  });

  it("does not start an attempt that cannot finish in the remaining budget", () => {
    expect(BI_ROUTE).toContain("spent * 2 + 5_000 <= upstreamMs");
  });

  it("never claims a retry it did not actually run", () => {
    // The budget check can skip the retry. A message asserting "retrying it
    // once failed too" would then be exactly the untrue-but-plausible advice
    // this whole change exists to remove.
    expect(BI_ROUTE).toContain("attemptsMade");
    expect(BI_ROUTE).toContain("attemptsMade > 1");
    expect(BI_ROUTE).not.toContain("Retrying it once already failed too");
  });

  it("no longer blames the JSON-only instruction when usage is simply absent", () => {
    // The old test was `(usage?.tokensOut ?? 0) >= completionCap - 8`, so a
    // gateway that reported no usage made every failure look like a model
    // ignoring the prompt.
    expect(BI_ROUTE).not.toContain("(usage?.tokensOut ?? 0) >= completionCap");
    expect(BI_ROUTE).toContain("lastUsage != null && lastUsage.tokensOut >= completionCap - 8");
  });
});
