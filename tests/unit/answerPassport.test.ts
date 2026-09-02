// The Answer Passport: one decision's provenance as a document someone keeps.
//
// The chain is the truth; the passport is what leaves the building. That makes
// two properties load-bearing, and both are tested against real bytes rather
// than asserted about the source.
//
//   CANONICAL. The signed bytes must be produced deterministically, or the
//   same decision signs differently on two runs and a verifier cannot tell
//   tampering from key-order. JSON.stringify preserves INSERTION order, so this
//   is a real hazard, not a theoretical one.
//
//   HONEST ABOUT ITSELF. A document that looked signed but was not would be
//   worse than no document at all. When no secret is configured the signature
//   is null AND the passport says so in its own notes, where a reader will see
//   it -- not only in a server log.
import { beforeEach, describe, expect, it, vi } from "vitest";

const CHAIN = {
  decision: {
    id: "dd3a53e5-1111-4222-8333-444444444444",
    user_id: "c8e0b22d-2e40-44b7-8df0-29d5980abd36",
    kind: "chat_turn" as const,
    root_ref: "dd3a53e5-1111-4222-8333-444444444444",
    lakehouse_snapshot_id: "167",
    created_at: "2026-09-03T02:05:15.000Z",
  },
  traces: [
    {
      id: "t1",
      agent_name: "Sample · Graph RAG Explorer",
      llm_provider: "openrouter",
      llm_model: "google/gemini-3-flash-preview",
      status: "ok",
      tokens_in: 815,
      tokens_out: 39,
      cost_usd: 0.0005,
      latency_ms: 7000,
      prompt: "What does the knowledge base say about Acme Corp?",
      tool_calls: [] as unknown,
      created_at: "2026-09-03T02:05:15.000Z",
    },
  ],
  events: [
    {
      id: "e1",
      action: "kb.search",
      resource_type: "knowledge_base",
      resource_name: "Acme Corp",
      detail: { via: "auto_rag", results: 0, tables: [] } as unknown,
      created_at: "2026-09-03T02:05:10.000Z",
    },
    {
      id: "e2",
      action: "warehouse.query",
      resource_type: "warehouse",
      resource_name: "prod",
      detail: { via: "agent_tool", tables: ["public.orders", "public.customers"] } as unknown,
      created_at: "2026-09-03T02:05:12.000Z",
    },
  ],
  reproducible: true,
};

async function subject() {
  return import("@/utils/provenance/passport.server");
}

describe("canonicalJson", () => {
  it("is stable under key order", async () => {
    // The whole point: JSON.stringify preserves insertion order, so a document
    // assembled differently would sign differently and a verifier could not
    // distinguish that from tampering.
    const { canonicalJson } = await subject();
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts at every level, not just the top", async () => {
    const { canonicalJson } = await subject();
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it("keeps array order, which is meaningful", async () => {
    // Sorting the reads would destroy the sequence the answer actually took.
    const { canonicalJson } = await subject();
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined rather than emitting it", async () => {
    const { canonicalJson } = await subject();
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("the document", () => {
  it("carries the decision, its snapshot, and whether it can be re-run", async () => {
    const { buildPassportDocument } = await subject();
    const doc = buildPassportDocument(CHAIN as never);
    expect(doc.format).toBe("agentswarms.answer-passport/1");
    expect(doc.decision.lakehouse_snapshot).toBe("167");
    expect(doc.decision.reproducible).toBe(true);
    expect(doc.notes.join(" ")).toMatch(/re-run as of that state/);
  });

  it("counts only actual reads as data reads", async () => {
    // FOUND FROM THE UI. agent.chat -- the row recording the answer itself --
    // was being counted and listed as a data read, so a decision with one
    // knowledge-base search reported "2 data reads" on screen AND in writing.
    // Overstating the evidence is the failure this feature exists to prevent.
    const { buildPassportDocument } = await subject();
    const doc = buildPassportDocument({
      ...CHAIN,
      events: [
        ...CHAIN.events,
        {
          id: "e3",
          action: "agent.chat",
          resource_type: "agent",
          resource_name: "Sample · Graph RAG Explorer",
          detail: {} as unknown,
          created_at: "2026-09-03T02:05:15.000Z",
        },
      ],
    } as never);
    expect(doc.totals.data_reads).toBe(2);
    expect(doc.data_reads.map((r) => r.action)).not.toContain("agent.chat");
    // Not dropped, though: it is part of what happened and is still exported.
    expect(doc.other_events.map((e) => e.action)).toContain("agent.chat");
  });

  it("classifies actions the same way the traces screen does", async () => {
    // One predicate, imported by both. Two copies is how a screen and a
    // document come to disagree about the same decision.
    const { isDataRead } = await import("@/utils/provenance/actions");
    for (const a of [
      "warehouse.query",
      "dataset.query",
      "metric.query",
      "bi.direct_query",
      "data.objectstore_query",
      "kb.search",
      "lakehouse.select",
    ])
      expect(isDataRead(a), a).toBe(true);
    for (const a of ["agent.chat", "secret.create", "data.objectstore_query_refused"])
      expect(isDataRead(a), a).toBe(false);
  });

  it("lists the data reads with their tables and how they were made", async () => {
    // "via" distinguishes an agent tool from automatic retrieval from the UI,
    // which is the difference between "the agent chose to look" and "the
    // platform looked for it".
    const { buildPassportDocument } = await subject();
    const doc = buildPassportDocument(CHAIN as never);
    expect(doc.data_reads).toHaveLength(2);
    expect(doc.data_reads[0]).toMatchObject({ action: "kb.search", via: "auto_rag" });
    expect(doc.data_reads[1].tables).toEqual(["public.orders", "public.customers"]);
    expect(doc.totals).toMatchObject({ model_turns: 1, data_reads: 2 });
  });

  it("says a non-reproducible answer cannot be regenerated", async () => {
    const { buildPassportDocument } = await subject();
    const doc = buildPassportDocument({
      ...CHAIN,
      decision: { ...CHAIN.decision, lakehouse_snapshot_id: null },
      reproducible: false,
    } as never);
    expect(doc.decision.reproducible).toBe(false);
    expect(doc.notes.join(" ")).toMatch(/cannot be regenerated/);
  });

  it("does not let an empty read list imply the answer used no data", async () => {
    // Absence of evidence. A passport that stayed silent here would invite the
    // reader to conclude something it has not established.
    const { buildPassportDocument } = await subject();
    const doc = buildPassportDocument({ ...CHAIN, events: [] } as never);
    expect(doc.notes.join(" ")).toMatch(/not evidence that the answer used no data/);
  });

  it("never claims to be a compliance certificate", async () => {
    const { buildPassportDocument } = await subject();
    expect(buildPassportDocument(CHAIN as never).notes.join(" ")).toMatch(
      /not a certificate of compliance/,
    );
  });
});

describe("signing", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("signs, and verifies its own signature", async () => {
    vi.stubEnv("PROVENANCE_SIGNING_SECRET", "a-secret-at-least-16-chars-long");
    vi.resetModules();
    const { buildPassportDocument, canonicalJson, verifyPassport } = await subject();
    const { createHmac } = await import("node:crypto");
    const canonical = canonicalJson(buildPassportDocument(CHAIN as never));
    const sig = createHmac("sha256", "a-secret-at-least-16-chars-long")
      .update(canonical)
      .digest("hex");
    expect(verifyPassport(canonical, sig)).toBe(true);
  });

  it("rejects a document altered after signing", async () => {
    // The property the whole artifact exists for.
    vi.stubEnv("PROVENANCE_SIGNING_SECRET", "a-secret-at-least-16-chars-long");
    vi.resetModules();
    const { buildPassportDocument, canonicalJson, verifyPassport } = await subject();
    const { createHmac } = await import("node:crypto");
    const doc = buildPassportDocument(CHAIN as never);
    const sig = createHmac("sha256", "a-secret-at-least-16-chars-long")
      .update(canonicalJson(doc))
      .digest("hex");
    doc.totals.cost_usd = 999;
    expect(verifyPassport(canonicalJson(doc), sig)).toBe(false);
  });

  it("refuses to verify when unsigned, rather than passing vacuously", async () => {
    vi.stubEnv("PROVENANCE_SIGNING_SECRET", "");
    vi.resetModules();
    const { verifyPassport } = await subject();
    expect(verifyPassport("{}", null)).toBe(false);
    expect(verifyPassport("{}", "deadbeef")).toBe(false);
  });

  it("rejects a too-short secret rather than signing weakly", async () => {
    vi.stubEnv("PROVENANCE_SIGNING_SECRET", "short");
    vi.resetModules();
    const { verifyPassport } = await subject();
    expect(verifyPassport("{}", "anything")).toBe(false);
  });
});
