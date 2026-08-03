// Trimming a value into a trace payload.
//
// This walks CLIENT-SUPPLIED structure: a chat message's `content` is typed
// `string | Array<Record<string, unknown>>`, so depth and key count are chosen
// by whoever sent the request. It had no bound on either.
//
// MEASURED, not assumed:
//   - JSON.parse builds a 20,000-level structure from a request body without
//     complaint.
//   - A plain recursive walk over that dies: "RangeError: Maximum call stack
//     size exceeded".
//
// THE CONSEQUENCE IS A HOLE IN THE BILLING RECORD, NOT A CRASH. The RangeError
// is caught by recordTrace's own try/catch, so the request succeeds and only a
// console line marks it. But the trace row is never inserted, and
// getBudgetDecision computes month-to-date spend by summing cost_usd over
// execution_traces. Nesting JSON inside your own message content therefore
// makes that call's cost invisible to your own budget cap and to the audit
// trail, with nothing failing visibly.
import { describe, expect, it } from "vitest";

import {
  MAX_BODY_CHARS,
  MAX_MESSAGES,
  MAX_TRACE_DEPTH,
  isConversationTooLarge,
  MAX_TRACE_ENTRIES,
  MAX_TRACE_STRING,
  sanitizeTraceValue,
} from "@/utils/observability/traceSanitize";

/** n levels of nested arrays, as JSON.parse would build from a request body. */
const deep = (n: number) => JSON.parse("[".repeat(n) + "1" + "]".repeat(n));

describe("survives structure the client chose", () => {
  it("does not overflow on nesting that a plain walk cannot survive", () => {
    expect(() => sanitizeTraceValue(deep(20_000))).not.toThrow();
  });

  it("stops descending at the depth limit", () => {
    const out = JSON.stringify(sanitizeTraceValue(deep(50)));
    expect(out).toContain("nesting too deep to record");
  });

  it("announces the cut on OBJECT nesting too, not only arrays", () => {
    // The first version of this test only nested arrays, so the object branch
    // of the depth guard was never executed — replacing its message with null
    // survived every assertion.
    let obj: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < MAX_TRACE_DEPTH + 5; i++) obj = { nested: obj };
    expect(JSON.stringify(sanitizeTraceValue(obj))).toContain("nesting too deep to record");
  });

  it("says the nesting was cut rather than dropping it silently", () => {
    // A trace is read as evidence. Truncation that does not announce itself is
    // worse than no trace at all.
    const out = JSON.stringify(sanitizeTraceValue(deep(MAX_TRACE_DEPTH + 5)));
    expect(out).toMatch(/too deep/);
  });

  it("keeps shapes shallower than the limit exactly as they are", () => {
    // The deepest genuine payload here is message -> content part -> object.
    const real = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
    expect(sanitizeTraceValue(real)).toEqual(real);
  });
});

describe("bounds breadth as well as depth", () => {
  it("caps a huge array and reports what it dropped", () => {
    const out = sanitizeTraceValue(Array.from({ length: 5_000 }, (_, i) => i)) as unknown[];
    expect(out.length).toBe(MAX_TRACE_ENTRIES + 1);
    expect(String(out.at(-1))).toMatch(/more of 5000 items/);
  });

  it("caps an object with too many keys and reports the count", () => {
    const wide = Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`k${i}`, i]));
    const out = sanitizeTraceValue(wide) as Record<string, unknown>;
    expect(Object.keys(out).length).toBe(MAX_TRACE_ENTRIES + 1);
    expect(String(out["…truncated"])).toMatch(/more of 1000 keys/);
  });

  it("leaves normal-sized containers alone", () => {
    const small = { a: [1, 2, 3], b: { c: "d" } };
    expect(sanitizeTraceValue(small)).toEqual(small);
  });
});

describe("string handling is unchanged", () => {
  it("elides a long string and says how long it was", () => {
    const out = sanitizeTraceValue("x".repeat(MAX_TRACE_STRING + 500)) as string;
    expect(out).toMatch(/…\[4500 chars\]$/);
    expect(out.length).toBeLessThan(MAX_TRACE_STRING + 40);
  });

  it("elides data: image URLs far earlier, since they are base64 megabytes", () => {
    const out = sanitizeTraceValue(`data:image/png;base64,${"A".repeat(5_000)}`) as string;
    expect(out.length).toBeLessThan(140);
    expect(out).toMatch(/chars\]$/);
  });

  it("passes short strings and primitives straight through", () => {
    expect(sanitizeTraceValue("hello")).toBe("hello");
    expect(sanitizeTraceValue(42)).toBe(42);
    expect(sanitizeTraceValue(null)).toBe(null);
    expect(sanitizeTraceValue(undefined)).toBe(undefined);
    expect(sanitizeTraceValue(true)).toBe(true);
  });
});

describe("the endpoint that spends money bounds its input", () => {
  // TESTED AS A FUNCTION, not by grepping the route. The first version asserted
  // that chat.ts mentioned MAX_MESSAGES, MAX_BODY_CHARS and 413 — all of which
  // survive with the comparison replaced by `false`, and mutation testing
  // showed exactly that.
  const msg = (n: number, text = "hi") =>
    Array.from({ length: n }, () => ({ role: "user", content: text }));

  it("allows an ordinary conversation", () => {
    expect(isConversationTooLarge(msg(20))).toBe(false);
  });

  it("rejects too many messages", () => {
    expect(isConversationTooLarge(msg(MAX_MESSAGES + 1))).toBe(true);
  });

  it("allows exactly the message limit", () => {
    expect(isConversationTooLarge(msg(MAX_MESSAGES))).toBe(false);
  });

  it("rejects an oversized body even with few messages", () => {
    // One enormous message is the same cost problem as many small ones.
    expect(
      isConversationTooLarge([{ role: "user", content: "x".repeat(MAX_BODY_CHARS + 1) }]),
    ).toBe(true);
  });

  it("is wired into the route", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chat = require("node:fs").readFileSync("src/routes/api/chat.ts", "utf8") as string;
    expect(chat).toContain("isConversationTooLarge(body.messages)");
    expect(chat).toContain('from "@/utils/observability/traceSanitize"');
    expect(chat, "an inline sanitiser is back").not.toContain("function sanitizeTraceValue(");
  });

  it("the public embed still caps too", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const embed = require("node:fs").readFileSync("src/routes/api/embed.chat.ts", "utf8") as string;
    expect(embed).toContain("messages.length > 60");
  });
});
