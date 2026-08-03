// What leaves the building for a third-party observability collector.
//
// The exporter's header claimed "Prompt/response bodies are never put on spans,
// so this path carries no user content". The first half is true and enforced
// the right way — the SELECTs simply do not fetch prompt, request_payload or
// response_payload, so there is nothing to filter.
//
// The second half was not. error_message IS selected, on all three streams, and
// went onto the span status raw and unbounded. Provider errors quote the input
// that upset them often enough — "Invalid content in messages[0].content: …",
// moderation refusals echoing the prompt — that it is a real path by which user
// content reaches Datadog, Tempo or whoever else is on the other end.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { safeStatusMessage, spanStatus } from "@/utils/observability/otelExport.server";

describe("an error message is still useful", () => {
  it("keeps ordinary provider errors intact", () => {
    // Redacting everything would make the span undebuggable, which defeats
    // the point of exporting it.
    expect(safeStatusMessage("upstream 503: model overloaded")).toBe(
      "upstream 503: model overloaded",
    );
  });

  it("says something rather than nothing when there is no message", () => {
    // A span marked ERROR with an empty status reads as a bug in the exporter.
    for (const empty of [null, "", "   "]) {
      expect(safeStatusMessage(empty), JSON.stringify(empty)).toBe("error");
    }
  });
});

describe("content quoted back by a provider is masked", () => {
  it("masks an email the error echoed", () => {
    const out = safeStatusMessage("Invalid content in messages[0]: contact ada@example.com now");
    expect(out).not.toContain("ada@example.com");
    expect(out).toContain("Invalid content");
  });

  it("masks an API key a provider echoed back", () => {
    // The shape that turns a debugging convenience into a credential leak.
    const out = safeStatusMessage("auth failed for key AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("masks card and national-id numbers", () => {
    const out = safeStatusMessage("rejected: 4111 1111 1111 1111 and 123-45-6789");
    expect(out).not.toContain("4111 1111 1111 1111");
    expect(out).not.toContain("123-45-6789");
  });

  it("uses the guardrails redactor rather than a second copy of the rules", () => {
    // One implementation: the PII patterns are maintained in one place, and a
    // fix there reaches this path too.
    const src = readFileSync("src/utils/observability/otelExport.server.ts", "utf8");
    expect(src).toContain('from "@/utils/guardrails"');
    expect(src).toContain("redactPII(");
  });
});

describe("the message is bounded", () => {
  it("truncates a huge error instead of shipping it whole", () => {
    // Some providers echo the entire offending request. An unbounded status
    // message inflates the OTLP payload and can exceed the collector's own
    // attribute limit, which drops the span rather than trimming it.
    const out = safeStatusMessage("x".repeat(50_000));
    expect(out.length).toBeLessThanOrEqual(501);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not truncate something already short", () => {
    expect(safeStatusMessage("rate limited")).toBe("rate limited");
  });
});

describe("only failures carry a message at all", () => {
  it("attaches the message to an error span", () => {
    const s = spanStatus("error", "boom");
    expect(s.code).toBe(2);
    expect(s.message).toBe("boom");
  });

  it("attaches nothing to a successful or unset span", () => {
    // A success span has no reason to carry text that came from outside.
    expect(spanStatus("success", "should not appear")).toEqual({ code: 1 });
    expect(spanStatus("running", "should not appear")).toEqual({ code: 0 });
  });

  it("redacts on the error path, not merely on the way in", () => {
    const s = spanStatus("error", "failed for ada@example.com");
    expect(s.message).not.toContain("ada@example.com");
  });
});

describe("bodies are excluded by not being fetched", () => {
  const src = readFileSync("src/utils/observability/otelExport.server.ts", "utf8");

  it("never selects a prompt or payload column", () => {
    // The strongest form of the guarantee: there is nothing to leak because
    // the rows do not contain it. A filter applied after the fact would be one
    // forgotten attribute away from failing.
    const selects = [...src.matchAll(/\.select\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(selects.length).toBeGreaterThan(0);
    for (const cols of selects) {
      for (const forbidden of [
        "prompt",
        "request_payload",
        "response_payload",
        "output",
        "input",
      ]) {
        expect(cols.split(","), `${forbidden} is selected for export`).not.toContain(forbidden);
      }
    }
  });

  it("says where the one exception is, so the claim stays honest", () => {
    // The header previously asserted no user content reached this path at all,
    // which is what made error_message easy to miss.
    expect(src).toMatch(/ONE EXCEPTION/);
    expect(src).toContain("safeStatusMessage");
  });
});
