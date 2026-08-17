// Several counts derived from one read, and what they may claim when it fails.
//
// lib/listClaim answers "how many rows do I have" for a list with an empty
// state. This answers the shape beside it: a header strip of stat badges whose
// numbers are all computed from the SAME rows — "1 connected", "7 tools
// available" — where none of them is the row count itself.
//
// That difference is why the defect survived on /mcp after three pages had
// already been converted. `servers` starts as `[]`, a failed read leaves it
// there, and both badges are derived, so neither is a `.length` any rule was
// looking for. They simply become 0.
//
// MEASURED on /mcp with the read 403'd and the interception recorded, against
// an account holding one connected server exposing seven tools and one errored
// server exposing three:
//
//   healthy   -> "1 connected"  "7 tools available"
//   injected  -> "0 connected"  "0 tools available"
//   ~10s in   -> "0 connected"  "0 tools available", toast gone, no error text
//
// Zero is the worst possible wrong answer here, because it is also a perfectly
// ordinary right answer. Nothing on the screen distinguished "you have no MCP
// servers" from "I could not find out".

import { UNKNOWN_COUNT } from "./listClaim";

export type CountReadState = {
  /** The read has returned, one way or the other. */
  loaded: boolean;
  /** Why it failed, or null if it succeeded. */
  error: string | null;
};

/**
 * Label every derived count from one read at once.
 *
 * They are done together rather than one at a time on purpose: they come from
 * the same rows, so they are true together or unknown together. Labelling them
 * separately is how a page ends up admitting the failure in one badge and
 * printing a confident 0 in the one beside it.
 */
export function countLabels<K extends string>(
  read: CountReadState,
  counts: Record<K, number>,
): Record<K, string> {
  const unknown = !!read.error || !read.loaded;
  const out = {} as Record<K, string>;
  for (const key of Object.keys(counts) as K[]) {
    out[key] = unknown ? UNKNOWN_COUNT : String(counts[key]);
  }
  return out;
}
