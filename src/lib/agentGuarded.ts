// Whether an agent's list card says "Guarded" (R347).
//
// The card used to check four fields of the stored guardrails itself: input
// filters, output filters, `blockPII`, and a content-safety level other than
// "off". The enforcer reads the same JSON through parseGuardrails, and its own
// test of "anything configured" is isAnyGuardrailActive. They disagreed:
// - An agent whose only guardrail was a PII mode (the Agent Builder sets
//   `blockPII` with it, an imported agent file need not) had every email in
//   its prompts redacted, and was listed as unguarded.
// - A guardrails object without a content-safety level (`{}`) was listed as
//   guarded, since a missing level is not "off", while nothing was enforced.
// The card now asks the enforcer's question of the enforcer's reading.
import { recordOf } from "@/lib/jsonRecord";
import { isAnyGuardrailActive, parseGuardrails } from "@/utils/guardrails";

/** True when the enforcer would act on this agent's stored guardrails. */
export function agentIsGuarded(tools: unknown): boolean {
  return isAnyGuardrailActive(parseGuardrails(recordOf(tools).guardrails));
}
