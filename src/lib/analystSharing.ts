// Sharing an analyst, and being honest about what that does not share.
//
// The analysts migration made both tables owner-only for a stated reason: an
// analyst runs with ITS OWNER's data access, so a naive share would imply
// handing over that access. Sharing here deliberately does NOT do that. A
// grant lets someone OPEN and USE the analyst; every query they then run is
// authorised as THEM — their dataset grants, their warehouse access, their
// row filters and column masks.
//
// WHICH MEANS A SHARED ANALYST CAN ANSWER DIFFERENTLY FOR DIFFERENT PEOPLE,
// and that is the single most important thing the share dialog has to say. A
// reader who assumes they are seeing the owner's numbers, and is actually
// seeing their own filtered subset, has been misled by the feature rather
// than by the data.
//
// THE "ALL LOCAL DATASETS" CASE IS THE SHARP ONE. An analyst scoped to every
// local dataset is not scoped to a fixed list of tables — it resolves against
// whoever is asking. Shared, it points at the recipient's datasets, not the
// owner's. That is not a bug to fix by copying data around; it is a fact to
// state plainly before the grant is made.
//
// AND CONVERSATIONS ARE NOT SHARED. Saved threads hold result samples that
// were fetched under the owner's access. Exposing them to a recipient with
// narrower access would leak exactly the rows their row filters exist to
// withhold, so threads stay per-user: a recipient opens the analyst and
// starts their own.
import type { AnalystSource } from "@/lib/aiAnalyst";

/** One thing the person sharing needs to know before they share. */
export type ShareCaveat = {
  /**
   * `blocking` — the recipient cannot use the analyst at all until something
   * else is done. `advisory` — it works, but not the way the sharer may assume.
   */
  severity: "blocking" | "advisory";
  text: string;
};

/**
 * What sharing this analyst will and will not give the recipient.
 *
 * Returned as a list rather than a paragraph so the dialog can rank blocking
 * problems above advisory ones, and so each statement is individually
 * testable — a disclosure that is assembled by string concatenation tends to
 * lose a clause without anything failing.
 */
export function shareCaveats(args: {
  source: AnalystSource;
  /** Datasets the recipients already hold a grant on, if known. */
  grantedTables?: string[];
}): ShareCaveat[] {
  const out: ShareCaveat[] = [];
  const src = args.source;

  if (src.kind === "warehouse") {
    out.push({
      severity: "blocking",
      text:
        "Recipients need their own access to this warehouse connection. " +
        "Queries run under their credentials, not yours.",
    });
  } else if (src.tables.length === 0) {
    // The sharp case: the scope is "whatever the reader has", so the shared
    // analyst is not pointed at the same data at all.
    out.push({
      severity: "advisory",
      text:
        "This analyst is scoped to ALL local datasets, which resolves per " +
        "reader — recipients will be asking questions of their own datasets, " +
        "not yours.",
    });
  } else {
    const granted = new Set((args.grantedTables ?? []).map((t) => t.toLowerCase()));
    const missing = src.tables.filter((t) => !granted.has(t.toLowerCase()));
    if (missing.length > 0) {
      out.push({
        severity: "blocking",
        text: `Recipients also need access to these datasets: ${missing.join(", ")}.`,
      });
    }
  }

  out.push({
    severity: "advisory",
    text:
      "Row filters and column masks resolve for each reader, so a shared " +
      "analyst can return different numbers to different people.",
  });
  out.push({
    severity: "advisory",
    text: "Your saved analyses stay yours. Recipients start their own.",
  });
  return out;
}

/** Blocking caveats first — a dialog that buries them has not disclosed them. */
export function rankCaveats(caveats: ShareCaveat[]): ShareCaveat[] {
  return [
    ...caveats.filter((c) => c.severity === "blocking"),
    ...caveats.filter((c) => c.severity !== "blocking"),
  ];
}

/**
 * Whether a group may use a model, given its own IAM rules.
 *
 * IAM is DEFAULT-ALLOW at group level: a group with no rules of its own is
 * unrestricted and must never block a share. Getting this backwards refuses
 * every share in a workspace that has not configured model rules, which is
 * most of them — so it lives here, where it can be tested, rather than inside
 * the server function where only its text could be pinned.
 */
export function groupAllowsModel(
  rules: { provider: string; model_pattern: string }[] | undefined,
  allowedByRules: () => boolean,
): boolean {
  if (!rules || rules.length === 0) return true;
  return allowedByRules();
}

/**
 * Which of the requested groups may not use this analyst's pinned model.
 *
 * The analyst thinks with ONE model. Granting it to a group whose IAM rules
 * exclude that model produces an analyst they can open and never run, which
 * looks like a broken feature rather than a policy decision — so the grant is
 * refused with the reason, the same way BI dashboard sharing does it.
 *
 * Pure: the caller supplies the rule evaluation, because the rules live in
 * the database and this has to stay testable.
 */
export function groupsBlocked(
  groups: { id: string; name: string }[],
  allows: (groupId: string) => boolean,
): string[] {
  return groups.filter((g) => !allows(g.id)).map((g) => g.name);
}

/** The refusal a blocked share produces. Names the model and every group. */
export function describeBlockedShare(model: string, blockedNames: string[]): string | null {
  if (blockedNames.length === 0) return null;
  return (
    `IAM model rules do not allow this analyst's model (${model}) for: ` +
    `${blockedNames.join(", ")}. Allow the model for those groups in Admin → IAM, ` +
    "or pick a different model for this analyst."
  );
}
