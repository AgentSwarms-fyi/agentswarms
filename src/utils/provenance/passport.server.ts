// The Answer Passport: one decision's provenance as a portable, verifiable
// document.
//
// The chain (decision.server.ts) is the truth; this renders it as something a
// person can keep, send to an auditor, and check later without access to this
// instance. Two properties matter and neither is decoration:
//
//   CANONICAL. The signed bytes are produced deterministically -- sorted keys,
//   no incidental whitespace -- so the same decision always signs to the same
//   value and a verifier can reproduce the digest without guessing how we
//   serialise.
//
//   HONEST ABOUT ITSELF. A passport says whether the answer is reproducible,
//   and whether it is signed. An unsigned document that looked signed would be
//   worse than no document, so when no signing secret is configured the
//   signature is null and the reason is stated in the passport itself rather
//   than only in a log nobody reads.
//
// It is evidence, not compliance. No document grants that.
import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "./canonical";
import { getDecisionChain, isDataRead, type DecisionChain } from "./decision.server";

export { canonicalJson };

export type PassportDocument = {
  /** Bumped when the document's SHAPE changes, so an old signature is still checkable. */
  format: "agentswarms.answer-passport/1";
  decision: {
    id: string;
    kind: string;
    at: string;
    /** The lakehouse snapshot this answer saw, or null. */
    lakehouse_snapshot: string | null;
    /** Whether the questions below can be re-run against the data as it was. */
    reproducible: boolean;
  };
  model_turns: {
    at: string;
    provider: string;
    model: string;
    status: string;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    latency_ms: number;
  }[];
  data_reads: {
    at: string;
    action: string;
    resource: string | null;
    /** Tables named by the read, when it named any. */
    tables: string[];
    /** How the read was made: an agent tool, automatic retrieval, the UI. */
    via: string | null;
  }[];
  /**
   * Everything else recorded against the decision -- the answer's own audit
   * row, an approval, a refusal. Exported because it is part of what happened,
   * kept separate because calling it a data read would overstate the evidence.
   */
  other_events: { at: string; action: string; resource: string | null }[];
  totals: { model_turns: number; data_reads: number; cost_usd: number };
  /** Stated in the document because a reader must not have to assume it. */
  notes: string[];
};

export type Passport = {
  document: PassportDocument;
  /** Hex HMAC-SHA256 over the canonical bytes, or null when unsigned. */
  signature: string | null;
  algorithm: "HMAC-SHA256" | null;
  /** Exactly what was signed, so a verifier need not re-derive it. */
  canonical: string;
};

function signingSecret(): string | null {
  const s = process.env.PROVENANCE_SIGNING_SECRET;
  return s && s.length >= 16 ? s : null;
}

/** Read a string field out of an audit row's free-form detail. */
function detailString(detail: unknown, key: string): string | null {
  const d = (detail ?? {}) as Record<string, unknown>;
  return typeof d[key] === "string" ? (d[key] as string) : null;
}

function detailTables(detail: unknown): string[] {
  const d = (detail ?? {}) as Record<string, unknown>;
  const t = d.tables;
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

export function buildPassportDocument(chain: DecisionChain): PassportDocument {
  // A data read is a read of data. The answer's own audit row is not one, and
  // counting it as one inflated every passport by exactly one read.
  const reads = chain.events.filter((e) => isDataRead(e.action));
  const others = chain.events.filter((e) => !isDataRead(e.action));
  const notes: string[] = [];
  notes.push(
    chain.reproducible
      ? `The lakehouse snapshot in force was ${chain.decision.lakehouse_snapshot_id}; queries against it can be re-run as of that state.`
      : "No lakehouse snapshot was recorded, so this answer is documented but cannot be regenerated as of the moment it was given.",
  );
  if (reads.length === 0) {
    notes.push(
      "No data reads were recorded for this decision. That means none were made, or none were instrumented — it is not evidence that the answer used no data.",
    );
  }
  notes.push(
    "This document is evidence of what happened. It is not a certificate of compliance, and it covers only what was recorded from the day recording began.",
  );

  return {
    format: "agentswarms.answer-passport/1",
    decision: {
      id: chain.decision.id,
      kind: chain.decision.kind,
      at: chain.decision.created_at,
      lakehouse_snapshot: chain.decision.lakehouse_snapshot_id,
      reproducible: chain.reproducible,
    },
    model_turns: chain.traces.map((t) => ({
      at: t.created_at,
      provider: t.llm_provider,
      model: t.llm_model,
      status: t.status,
      tokens_in: Number(t.tokens_in ?? 0),
      tokens_out: Number(t.tokens_out ?? 0),
      cost_usd: Number(t.cost_usd ?? 0),
      latency_ms: Number(t.latency_ms ?? 0),
    })),
    data_reads: reads.map((e) => ({
      at: e.created_at,
      action: e.action,
      resource: e.resource_name,
      tables: detailTables(e.detail),
      via: detailString(e.detail, "via"),
    })),
    other_events: others.map((e) => ({
      at: e.created_at,
      action: e.action,
      resource: e.resource_name,
    })),
    totals: {
      model_turns: chain.traces.length,
      data_reads: reads.length,
      cost_usd: chain.traces.reduce((sum, t) => sum + Number(t.cost_usd ?? 0), 0),
    },
    notes,
  };
}

/** Build and (if configured) sign the passport for one decision, for its owner. */
export async function getPassport(userId: string, decisionId: string): Promise<Passport | null> {
  const chain = await getDecisionChain(userId, decisionId);
  if (!chain) return null;
  const document = buildPassportDocument(chain);
  if (!signingSecret()) {
    document.notes.push(
      "UNSIGNED: no PROVENANCE_SIGNING_SECRET is configured on this instance, so this document carries no tamper-evidence.",
    );
  }
  const canonical = canonicalJson(document);
  const secret = signingSecret();
  return {
    document,
    canonical,
    signature: secret ? createHmac("sha256", secret).update(canonical).digest("hex") : null,
    algorithm: secret ? "HMAC-SHA256" : null,
  };
}

/**
 * Check a passport against this instance's secret.
 *
 * Exported so the signature is verifiable in-process (and by tests) rather than
 * only by an operator with openssl. Constant-time, and false whenever anything
 * is missing — an unsigned document must never verify as valid.
 */
export function verifyPassport(canonical: string, signature: string | null): boolean {
  const secret = signingSecret();
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(canonical).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
