// Trimming a value down to something safe to store as a trace payload.
//
// Extracted from routes/api/chat so it can be tested: it walks CLIENT-SUPPLIED
// structure. A chat message's `content` is typed
// `string | Array<Record<string, unknown>>`, so the nesting depth and the key
// count are both chosen by whoever sent the request.

/** Longest string kept in a trace before it is elided. */
export const MAX_TRACE_STRING = 4000;

/** Data URLs are elided far earlier — they are megabytes of base64. */
export const MAX_TRACE_DATA_URL = 120;

/**
 * How deep the walk will go before it stops descending.
 *
 * WITHOUT THIS THE FUNCTION WAS UNBOUNDED RECURSION over attacker-chosen
 * structure. Measured: JSON.parse builds a 20,000-level structure from a
 * request body without complaint, and a plain recursive walk over that dies
 * with "RangeError: Maximum call stack size exceeded".
 *
 * THE CONSEQUENCE IS NOT A CRASH — it is a silent hole in the billing record.
 * The RangeError is caught by recordTrace's own try/catch, so the request
 * succeeds and only a console line marks the failure. But the trace row is
 * never inserted, and getBudgetDecision computes month-to-date spend by
 * summing cost_usd over execution_traces. A caller who nests JSON inside their
 * message content therefore makes that call's cost invisible to their own
 * budget cap, and invisible to the audit trail, without anything failing
 * visibly. Cheaper to exploit than it is to notice.
 *
 * Ten is far past anything a real payload has; the deepest genuine shape here
 * is a message → content part → nested object, which is three.
 */
export const MAX_TRACE_DEPTH = 10;

/** How many keys or elements are kept at any one level. */
export const MAX_TRACE_ENTRIES = 200;

/**
 * Conversation ceilings for /api/chat, matching what /api/embed/chat has
 * enforced since it shipped.
 *
 * More generous than the embed's 60 / 200k because a signed-in workspace chat
 * legitimately runs longer than an embedded widget — but bounded, because an
 * unbounded body is both a cost multiplier and the input to every walk
 * downstream of it.
 *
 * A FUNCTION RATHER THAN AN INLINE CONDITION so it can be tested for what it
 * does. As an expression in the route it could only be checked by grepping the
 * source for the constant names, and mutation testing showed that passing
 * happily with the comparison replaced by `false`.
 */
export const MAX_MESSAGES = 200;
export const MAX_BODY_CHARS = 500_000;

export function isConversationTooLarge(messages: unknown[]): boolean {
  if (messages.length > MAX_MESSAGES) return true;
  return JSON.stringify(messages).length > MAX_BODY_CHARS;
}

/**
 * Reduce `value` to something bounded in depth, breadth and string length.
 *
 * Truncation is always ANNOUNCED — an elided string says how long it was, a
 * truncated container says how many entries it had. A trace that silently
 * drops data is worse than no trace, because it is read as evidence.
 */
export function sanitizeTraceValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:image/") && value.length > MAX_TRACE_DATA_URL) {
      return `${value.slice(0, 80)}…[${value.length} chars]`;
    }
    return value.length > MAX_TRACE_STRING
      ? `${value.slice(0, MAX_TRACE_STRING)}…[${value.length} chars]`
      : value;
  }

  if (value === null || typeof value !== "object") return value;

  if (depth >= MAX_TRACE_DEPTH) {
    return Array.isArray(value)
      ? `[…${value.length} items, nesting too deep to record]`
      : "[…nesting too deep to record]";
  }

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_TRACE_ENTRIES).map((v) => sanitizeTraceValue(v, depth + 1));
    if (value.length > MAX_TRACE_ENTRIES) {
      kept.push(`…[${value.length - MAX_TRACE_ENTRIES} more of ${value.length} items]`);
    }
    return kept;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, nested] of entries.slice(0, MAX_TRACE_ENTRIES)) {
    out[key] = sanitizeTraceValue(nested, depth + 1);
  }
  if (entries.length > MAX_TRACE_ENTRIES) {
    out["…truncated"] = `${entries.length - MAX_TRACE_ENTRIES} more of ${entries.length} keys`;
  }
  return out;
}
