// The audit trail's tamper-evidence, checked independently of the database.
//
// audit_chain_verify() lets the database check its own chain, which is the
// weaker half of the guarantee: whoever can rewrite rows can usually re-run the
// trigger too. The property that matters is that the NDJSON archive shipped off
// the box can be verified by a DIFFERENT implementation. These tests are that
// implementation's proof.
//
// The value that must never regress here is the jsonb rendering. The trigger
// hashes `detail::text`, and JSON.stringify does not produce it — so a
// plausible-looking verifier reports a perfectly intact trail as entirely
// tampered with, which is the worst possible failure for this feature: it
// destroys trust in the evidence rather than in the attacker.

import { describe, expect, it } from "vitest";

import { computeChainHash, jsonbText, verifyChain, type ChainEvent } from "@/lib/auditChain";

describe("jsonbText", () => {
  it("orders object keys by LENGTH first, then bytewise", () => {
    // Postgres jsonb's ordering. Neither insertion order nor plain alphabetical
    // — and getting it wrong changes every hash.
    expect(jsonbText({ bbb: 1, a: 2, cc: 3 })).toBe('{"a": 2, "cc": 3, "bbb": 1}');
    expect(jsonbText({ b: 1, a: 2 })).toBe('{"a": 2, "b": 1}');
  });

  it("puts a space after the colon and the comma", () => {
    expect(jsonbText({ a: 1, b: 2 })).toBe('{"a": 1, "b": 2}');
    expect(jsonbText([1, 2])).toBe("[1, 2]");
  });

  it("differs from JSON.stringify — the trap this module exists for", () => {
    const v = { bb: 1, a: 2 };
    expect(jsonbText(v)).not.toBe(JSON.stringify(v));
  });

  it("renders scalars and null the way Postgres does", () => {
    expect(jsonbText(null)).toBe("null");
    expect(jsonbText(undefined)).toBe("null");
    expect(jsonbText("x")).toBe('"x"');
    expect(jsonbText(12)).toBe("12");
    expect(jsonbText(true)).toBe("true");
  });

  it("nests", () => {
    expect(jsonbText({ outer: { bb: 1, a: 2 } })).toBe('{"outer": {"a": 2, "bb": 1}}');
  });

  it("escapes strings", () => {
    expect(jsonbText({ a: 'he said "hi"' })).toBe('{"a": "he said \\"hi\\""}');
  });
});

describe("computeChainHash", () => {
  const event: ChainEvent = {
    chain_seq: 1,
    user_id: "u1",
    action: "agent.chat",
    resource_type: "agent",
    resource_id: "r1",
    resource_name: "Support bot",
    detail: { model: "haiku" },
  };

  it("produces a sha256 hex digest", () => {
    expect(computeChainHash(null, event)).toMatch(/^[0-9a-f]{64}$/);
  });

  // NOTHING IN THIS FILE proves the algorithm matches Postgres. Every test
  // here would pass just as happily against a self-consistent but wrong
  // implementation, and a wrong one is worse than none: it would report an
  // intact trail as tampered with. That check lives in
  // tests/integration/auditChain.test.ts, which recomputes hashes the database
  // trigger actually wrote. Run it after touching jsonbText.

  it("is deterministic", () => {
    expect(computeChainHash(null, event)).toBe(computeChainHash(null, event));
  });

  it("changes when ANY hashed field changes", () => {
    const base = computeChainHash("prev", event);
    const mutations: Partial<ChainEvent>[] = [
      { chain_seq: 2 },
      { user_id: "u2" },
      { action: "agent.delete" },
      { resource_type: "dataset" },
      { resource_id: "r2" },
      { resource_name: "Other" },
      { detail: { model: "opus" } },
    ];
    for (const m of mutations) {
      expect(computeChainHash("prev", { ...event, ...m }), JSON.stringify(m)).not.toBe(base);
    }
  });

  it("changes when the PREVIOUS hash changes — that is the chain", () => {
    expect(computeChainHash("a", event)).not.toBe(computeChainHash("b", event));
  });

  it("treats a null detail as {}, matching the trigger's COALESCE", () => {
    const withNull = { ...event, detail: null };
    const withEmpty = { ...event, detail: {} };
    expect(computeChainHash(null, withNull)).toBe(computeChainHash(null, withEmpty));
  });
});

/** Build a valid chain of n events. */
function chainOf(n: number, start = 1): ChainEvent[] {
  const out: ChainEvent[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const e: ChainEvent = {
      chain_seq: start + i,
      user_id: `u${i}`,
      action: "test.action",
      resource_type: "thing",
      resource_id: `r${i}`,
      resource_name: `Thing ${i}`,
      detail: { i },
    };
    e.chain_hash = computeChainHash(i === 0 ? null : prev, e);
    prev = e.chain_hash;
    out.push(e);
  }
  return out;
}

describe("verifyChain", () => {
  it("accepts an intact chain", () => {
    expect(verifyChain(chainOf(5))).toEqual({ ok: true, checked: 5 });
  });

  it("accepts an empty range", () => {
    expect(verifyChain([])).toEqual({ ok: true, checked: 0 });
  });

  it("detects an EDITED event", () => {
    // The headline case: somebody quietly changes what an event says.
    const chain = chainOf(5);
    chain[2].action = "something.else";
    const v = verifyChain(chain);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("hash-mismatch");
      expect(v.firstBrokenSeq).toBe(3);
    }
  });

  it("detects a DELETED event by the gap it leaves", () => {
    const chain = chainOf(5);
    chain.splice(2, 1);
    const v = verifyChain(chain);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("sequence-gap");
  });

  it("detects an event whose hash was blanked", () => {
    const chain = chainOf(3);
    chain[1].chain_hash = null;
    const v = verifyChain(chain);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("missing-hash");
  });

  it("detects a re-hashed edit that did not fix the FOLLOWING link", () => {
    // A half-competent tamper: recompute the edited row's own hash but leave
    // its successor's alone. The chain is what catches this.
    const chain = chainOf(4);
    chain[1].action = "tampered";
    chain[1].chain_hash = computeChainHash(chain[0].chain_hash!, chain[1]);
    const v = verifyChain(chain);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.firstBrokenSeq).toBe(3);
  });

  it("does NOT check the first event's predecessor by default", () => {
    // Retention deletes the oldest rows, so the earliest remaining event's
    // predecessor is legitimately gone. Treating that as tampering would make
    // every instance report a broken trail a day after the first purge.
    const chain = chainOf(4).slice(2);
    expect(verifyChain(chain).ok).toBe(true);
  });

  it("DOES check the head when told the range starts at genesis", () => {
    const full = chainOf(3);
    expect(verifyChain(full, { genesis: true }).ok).toBe(true);

    // A forged head: valid-looking chain, wrong first hash.
    const forged = chainOf(3);
    forged[0].chain_hash = "0".repeat(64);
    expect(verifyChain(forged, { genesis: true }).ok).toBe(false);
  });

  it("reports how many events it checked before failing", () => {
    const chain = chainOf(6);
    chain[3].detail = { tampered: true };
    const v = verifyChain(chain);
    expect(v.checked).toBe(4);
  });

  it("accepts chain_seq as a string, as JSON round-tripping can produce", () => {
    const chain = chainOf(3).map((e) => ({ ...e, chain_seq: String(e.chain_seq) }));
    expect(verifyChain(chain).ok).toBe(true);
  });
});
