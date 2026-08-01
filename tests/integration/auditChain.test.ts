// The independent chain verifier, checked against rows the DATABASE wrote.
//
// tests/unit/auditChain.test.ts proves the verifier is self-consistent. Only
// this file proves it is CORRECT: it recomputes hashes that a Postgres trigger
// produced, using a separate implementation in a different language. If those
// agree on real rows, the NDJSON archive can be trusted as evidence off the
// box. If they do not, the archive is just a copy of the data.
//
// STRICTLY READ-ONLY. Inserting test events would pollute the trail, and
// DELETING them afterwards would leave a sequence gap that makes the chain look
// tampered with from then on — this suite must not be the thing that breaks the
// guarantee it checks.

import { describe, expect, it } from "vitest";

import { computeChainHash, verifyChain, type ChainEvent } from "@/lib/auditChain";
import { admin, hasSupabase } from "./setup";

const COLUMNS =
  "chain_seq, chain_hash, user_id, action, resource_type, resource_id, resource_name, detail";

async function loadChain(limit = 500): Promise<ChainEvent[]> {
  const { data, error } = await admin()
    .from("audit_events")
    .select(COLUMNS)
    .not("chain_seq", "is", null)
    .order("chain_seq", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ChainEvent[];
}

describe.skipIf(!hasSupabase)("audit hash chain, verified independently", () => {
  it("the live trail has a chain at all", async () => {
    const chain = await loadChain();
    // A trail with no hashes is not evidence of anything, and every assertion
    // below would pass vacuously.
    expect(chain.length).toBeGreaterThan(0);
    for (const e of chain.slice(0, 5)) {
      expect(String(e.chain_hash)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("every link in the live chain verifies", async () => {
    // The real assertion: a TypeScript reimplementation agrees with the SQL
    // trigger on every row the database actually wrote.
    const chain = await loadChain();
    const verdict = verifyChain(chain);
    if (!verdict.ok) {
      throw new Error(
        `chain broken at seq ${verdict.firstBrokenSeq} (${verdict.reason}) ` +
          `after ${verdict.checked} events. Either the trail was tampered with, ` +
          `or jsonbText() has drifted from Postgres's jsonb::text rendering.`,
      );
    }
    expect(verdict.checked).toBe(chain.length);
  });

  it("verifies from genesis when the first row is still present", async () => {
    const chain = await loadChain();
    if (Number(chain[0]?.chain_seq) !== 1) return; // retention has trimmed the head
    expect(verifyChain(chain, { genesis: true }).ok).toBe(true);
  });

  it("chain_seq is contiguous — no row has been deleted from the middle", async () => {
    const chain = await loadChain();
    const seqs = chain.map((e) => Number(e.chain_seq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i], `gap between ${seqs[i - 1]} and ${seqs[i]}`).toBe(seqs[i - 1] + 1);
    }
  });

  it("a tampered copy of a REAL row fails verification", async () => {
    // Proves the check has teeth against genuine data, not just fixtures. The
    // copy is in memory; nothing is written.
    const chain = await loadChain(50);
    if (chain.length < 3) return;
    const tampered = chain.map((e) => ({ ...e }));
    tampered[1] = { ...tampered[1], action: "totally.different" };
    const verdict = verifyChain(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("hash-mismatch");
  });

  it("recomputes a real row's hash exactly, field for field", async () => {
    // Narrower than verifyChain, so a failure points at computeChainHash rather
    // than at the walk.
    const chain = await loadChain(3);
    if (chain.length < 2) return;
    expect(computeChainHash(chain[0].chain_hash!, chain[1])).toBe(chain[1].chain_hash);
  });
});
