// A blocked prompt must not leave its PII in the trace.
//
// The PII guardrail works: driven through the real /api/chat with an agent
// configured piiMode=block, a card number and email were refused with 422 and
// a message naming the entities found. The model never saw them.
//
// The database did. trace.promptText is captured from the raw request before
// guardrails run, and the trace row is written on BOTH paths — including the
// refusal. Measured on this instance, in block AND redact mode:
//
//   execution_traces.prompt = "My card is 4111 1111 1111 1111 and my email is
//                              bob@example.com — file it."
//
// which is queryable in Postgres, rendered on Traces & Logs, and shipped by
// the OTEL exporter to whatever backend it points at. The mode whose own
// comment reads "for data that must never transit" was the one persisting it,
// under a refusal that told the user it had not been sent anywhere.
//
// The redacted text was already computed on that path and discarded.
// `safeText` keeps it, and the caller writes that instead.
import { describe, expect, it } from "vitest";

import { DEFAULT_GUARDRAILS, evaluateInputGuardrails, type Guardrails } from "@/utils/guardrails";

const CARD = "4111 1111 1111 1111";
const EMAIL = "bob@example.com";
const DIRTY = `My card is ${CARD} and my email is ${EMAIL} — file it.`;

const withPii = (mode: "block" | "redact", extra: Partial<Guardrails> = {}): Guardrails => ({
  ...DEFAULT_GUARDRAILS,
  piiMode: mode,
  piiApplyTo: "both",
  ...extra,
});

describe("safeText — what the caller is allowed to write down", () => {
  it("is redacted when the turn is BLOCKED for PII", () => {
    const d = evaluateInputGuardrails(DIRTY, withPii("block"));
    expect(d.allowed).toBe(false);
    expect(d.safeText).not.toContain(CARD);
    expect(d.safeText).not.toContain(EMAIL);
    expect(d.safeText).toMatch(/REDACTED/);
  });

  it("is redacted when the turn is ALLOWED with redaction", () => {
    const d = evaluateInputGuardrails(DIRTY, withPii("redact"));
    expect(d.allowed).toBe(true);
    expect(d.safeText).not.toContain(CARD);
    // In redact mode the model sees the same safe text.
    expect(d.outboundText).not.toContain(CARD);
  });

  it("is redacted even when a DIFFERENT rule refuses first", () => {
    // The earlier rules return before the PII branch is reached. A message
    // that trips the topic denylist and also carries a card number was
    // persisting the number in full, with "not allowed to discuss…" beside it.
    const d = evaluateInputGuardrails(`${DIRTY} Also, crypto mining?`, {
      ...withPii("redact"),
      enableInputFilters: true,
      topicRestrictions: "crypto mining",
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/crypto mining/i);
    expect(d.safeText).not.toContain(CARD);
    expect(d.safeText).not.toContain(EMAIL);
  });

  it("leaves a clean prompt exactly as written", () => {
    // Redaction must not rewrite text that has nothing to redact, or every
    // trace becomes a lossy copy of what the user typed.
    const clean = "What is 2 + 2?";
    expect(evaluateInputGuardrails(clean, withPii("block")).safeText).toBe(clean);
  });

  it("leaves the prompt alone when no PII policy is set", () => {
    // The default is off; a trace should still record what was actually said.
    const d = evaluateInputGuardrails(DIRTY, { ...DEFAULT_GUARDRAILS, enableInputFilters: true });
    expect(d.safeText).toBe(DIRTY);
  });

  it("still refuses, and still says which entities it found", () => {
    // Redacting the stored copy must not soften the refusal itself.
    const d = evaluateInputGuardrails(DIRTY, withPii("block"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/email/);
    expect(d.reason).toMatch(/credit card/);
  });
});
