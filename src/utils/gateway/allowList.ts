// An allow-list someone asked for, checked against what they may actually name.
//
// FOUND IN R247. A gateway key's `agent_ids` and `semantic_model_ids` are
// allow-lists where EMPTY MEANS EVERYTHING — the create dialog says so in as
// many words: "None ticked = every agent you own". The server filtered what
// was asked for down to what the owner may name, and stored the result. So a
// list that filtered down to nothing was stored as "all":
//
//   - an agent deleted while the dialog was open (driven on 2026-10-04: a key
//     ticked for one agent was stored as "Agents: all", and the page said
//     "Key created");
//   - the agents read failing, because its `error` was dropped and a failed
//     read filters everything out;
//   - a semantic model whose share was withdrawn, on create or on edit.
//
// The narrowing direction was never the danger; the widening one is, and it
// only takes the LAST permitted id to go. But "some of what you picked was
// quietly left off" is its own wrong answer about a security boundary, so
// this refuses whenever anything asked for cannot be honoured, and names how
// many. Picking again is one click; a key broader than its owner meant is
// found, if ever, by reading the key list.

export type AllowListCheck = { ok: true; ids: string[] } | { ok: false; error: string };

/**
 * @param requested What the caller ticked. Duplicates are ignored.
 * @param permitted What they may name, read successfully. A FAILED read must
 *                  never reach here as an empty list: that is the bug.
 * @param noun      "agent", "semantic model" — for the refusal.
 */
export function honorAllowList(
  requested: readonly string[],
  permitted: ReadonlySet<string>,
  noun: string,
): AllowListCheck {
  const ids = [...new Set(requested)];
  const missing = ids.filter((id) => !permitted.has(id));
  if (missing.length === 0) return { ok: true, ids };
  const n = missing.length;
  const all = n === ids.length;
  const which = all
    ? n === 1
      ? `The ${noun}`
      : `All ${n} ${noun}s`
    : `${n} of the ${ids.length} ${noun}s`;
  const gone = n === 1 ? "no longer exists or is not yours" : "no longer exist or are not yours";
  // The reason differs, and the reader should get the true one.
  const why = all
    ? `with none left, the key would have reached every ${noun} you have`
    : `the key would have reached less than you picked, without saying so`;
  return {
    ok: false,
    error: `${which} picked for this key ${gone}, so nothing was saved: ${why}. Pick again.`,
  };
}
