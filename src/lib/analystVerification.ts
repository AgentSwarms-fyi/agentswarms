// Verified answers: a human saying "I checked this one", in a way that
// cannot outlive what was checked.
//
// WHY A FINGERPRINT. The obvious implementation stores a flag on the turn,
// and the flag then survives everything: edit a step's SQL, let the
// self-check rewrite it, and the green tick still sits above numbers nobody
// verified. That is worse than having no verification at all — an unverified
// answer is read with ordinary caution, and a falsely verified one is read
// with none. So a verdict is pinned to a FINGERPRINT of the steps it was
// given, and any change to them voids it. Voided is shown, not hidden: the
// reader needs to know a verdict existed and no longer applies.
//
// WHY THE PRIOR VERDICT IS OFFERED, NOT APPLIED. When the same question comes
// round again it is tempting to serve the verified answer straight back. But
// the data has moved since, and nothing here can know by how much. The prior
// verdict is surfaced — "you verified this on the 3rd" — and the user decides
// whether to reuse it or ask again. Answering from it automatically would
// turn a human's one-time check into a standing claim about data they have
// not seen.
import type { AnalystStep, AnalystTurn } from "@/lib/aiAnalyst";

export type VerificationState = "verified" | "wrong";

export type TurnVerification = {
  state: VerificationState;
  /** Required for "wrong": a flag with no reason helps nobody. */
  note?: string;
  at: string;
  by?: string;
  /** What was checked. A mismatch against the turn's current steps voids it. */
  fingerprint: string;
};

/**
 * What a verdict was given ABOUT: the SQL of each step, in order, plus the
 * governed model where one compiled it.
 *
 * Deliberately NOT the results — the same SQL over changed data is still the
 * same analysis, and re-verification on every refresh would make the mark
 * meaningless. Deliberately not the prose either: a rewritten write-up over
 * identical queries is the same checked work.
 */
export function fingerprintSteps(steps: AnalystStep[]): string {
  return (steps ?? [])
    .map((s) => `${s.governed?.model ?? ""}|${(s.sql ?? "").replace(/\s+/g, " ").trim()}`)
    .join("\n~~\n");
}

/** A verdict, pinned to the steps it was given. */
export function markTurn(args: {
  turn: AnalystTurn;
  state: VerificationState;
  note?: string;
  by?: string;
  at: string;
}): AnalystTurn | null {
  const note = (args.note ?? "").trim();
  // "This is wrong" with no reason leaves the next reader exactly where they
  // started, and leaves the analyst nothing to correct.
  if (args.state === "wrong" && !note) return null;
  // Nothing to vouch for: a turn that never produced steps has no analysis to
  // have checked.
  if (!args.turn.steps?.length) return null;
  return {
    ...args.turn,
    verification: {
      state: args.state,
      ...(note ? { note } : {}),
      at: args.at,
      ...(args.by ? { by: args.by } : {}),
      fingerprint: fingerprintSteps(args.turn.steps),
    },
  };
}

export type VerificationStatus =
  | { kind: "none" }
  | { kind: "active"; verification: TurnVerification }
  /** A verdict exists but the steps have changed since it was given. */
  | { kind: "void"; verification: TurnVerification };

export function verificationStatus(turn: AnalystTurn): VerificationStatus {
  const v = turn.verification;
  if (!v) return { kind: "none" };
  return fingerprintSteps(turn.steps) === v.fingerprint
    ? { kind: "active", verification: v }
    : { kind: "void", verification: v };
}

/**
 * Questions are "the same" when they differ only in punctuation, case and
 * spacing.
 *
 * Deliberately crude. Anything cleverer — stemming, embeddings — starts
 * matching questions that merely resemble each other, and a verdict shown
 * against the wrong question is a false claim that someone checked it. A
 * miss just means no prior verdict is offered, which costs nothing.
 */
export function normaliseQuestion(q: string): string {
  return (q ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type PriorVerdict = {
  question: string;
  verification: TurnVerification;
  /** Which thread it lives in, so the UI can offer to open it. */
  threadId: string;
  threadTitle: string;
};

/**
 * The most recent still-valid verdict on this question, across the analyst's
 * loaded analyses.
 *
 * Only ACTIVE verdicts are returned: offering a voided one would present a
 * check of different SQL as a check of this question. Ordering is by when the
 * verdict was given, newest first — a later "actually this is wrong" must
 * beat an earlier "verified".
 */
export function findPriorVerdict(
  question: string,
  threads: Array<{ id: string; title: string; turns: AnalystTurn[] }>,
): PriorVerdict | null {
  const want = normaliseQuestion(question);
  if (!want) return null;
  const hits: PriorVerdict[] = [];
  for (const t of threads ?? []) {
    for (const turn of t.turns ?? []) {
      if (normaliseQuestion(turn.question) !== want) continue;
      const status = verificationStatus(turn);
      if (status.kind !== "active") continue;
      hits.push({
        question: turn.question,
        verification: status.verification,
        threadId: t.id,
        threadTitle: t.title,
      });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => (a.verification.at < b.verification.at ? 1 : -1));
  return hits[0];
}

/** One line for the report and the badge tooltip. */
export function describeVerification(status: VerificationStatus): string {
  if (status.kind === "none") return "";
  const v = status.verification;
  const who = v.by ? ` by ${v.by}` : "";
  const when = v.at.slice(0, 10);
  if (status.kind === "void") {
    return (
      `A verdict of "${v.state}" was recorded${who} on ${when}, but a step has changed ` +
      `since — it no longer applies to the queries above.`
    );
  }
  return v.state === "verified"
    ? `Verified${who} on ${when}.${v.note ? ` ${v.note}` : ""}`
    : `Flagged as wrong${who} on ${when}. ${v.note ?? ""}`.trim();
}
