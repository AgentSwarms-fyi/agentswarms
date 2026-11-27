// What the assistant may ask to have done, and only ask (R553).
//
// The assistant reads and explains (R518, R552). Asked to run one of the
// reader's workflows now, or to pause one's schedule, it could only say where
// to press. Now it may PROPOSE one of a few changes; the proposal waits in the
// reader's approvals inbox, and nothing happens until they approve it there.
//
// The catalogue is small on purpose — each change is one the page already
// offers, undone by the opposite one, and carried out as the owner through
// the page's own path: run a workflow or a pipeline now; pause or resume its
// schedule. An approval's text is built here from the thing's own name and
// fixed words only, never the model's prose (approval text is read by the
// owner's approvers, and a model's words can carry what someone else wrote).
//
// Pure: the server reads the thing and the database; this decides.

export const ASSISTANT_ACTION = "assistant.action";

/** How the tool's answer starts when it filed nothing; the loop reads it. */
export const NOT_PROPOSED = "Not proposed: ";

export const ACTION_KINDS = ["workflow", "etl_pipeline"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTIONS = ["run_now", "pause", "resume"] as const;
export type AssistantActionId = (typeof ACTIONS)[number];

export type ProposedAction = {
  kind: ActionKind;
  id: string;
  action: AssistantActionId;
  /** The thing's name when proposed, for the approval's text. */
  name: string;
};

/** What the server read about the thing, as its owner. */
export type ActionTarget = {
  name: string;
  /** Runs on a schedule (anything but "manual"). */
  scheduled: boolean;
  isActive: boolean;
};

const KIND_WORD: Record<ActionKind, string> = { workflow: "workflow", etl_pipeline: "pipeline" };

export const isActionKind = (v: unknown): v is ActionKind =>
  typeof v === "string" && (ACTION_KINDS as readonly string[]).includes(v);
export const isAction = (v: unknown): v is AssistantActionId =>
  typeof v === "string" && (ACTIONS as readonly string[]).includes(v);

/** Whether the change makes sense for the thing as it is now, or why not. */
export function checkAction(
  action: AssistantActionId,
  kind: ActionKind,
  target: ActionTarget,
): { ok: true } | { ok: false; error: string } {
  const what = KIND_WORD[kind];
  if (action === "run_now") return { ok: true };
  if (!target.scheduled) {
    return {
      ok: false,
      error: `That ${what} has no schedule to ${action}: it runs only when started.`,
    };
  }
  if (action === "pause" && !target.isActive) {
    return { ok: false, error: `That ${what}'s schedule is already paused.` };
  }
  if (action === "resume" && target.isActive) {
    return { ok: false, error: `That ${what}'s schedule is not paused.` };
  }
  return { ok: true };
}

const quoted = (name: string) => `“${name.replace(/[“”"]/g, "").slice(0, 120) || "untitled"}”`;

/** The approval's title: fixed words and the thing's name. */
export function actionTitle(p: ProposedAction): string {
  const what = KIND_WORD[p.kind];
  if (p.action === "run_now") return `Run the ${what} ${quoted(p.name)} now`;
  // Not "“X”'s schedule": a possessive after a closing quote reads as a typo.
  if (p.action === "pause") return `Pause the schedule of the ${what} ${quoted(p.name)}`;
  return `Resume the schedule of the ${what} ${quoted(p.name)}`;
}

/** What approving it does, in fixed words. */
export function actionLines(p: ProposedAction): string[] {
  if (p.action === "run_now") {
    return [
      "Starts one run now, as Run now on its page does.",
      "Its schedule is not changed.",
      "Proposed by the assistant; nothing happens until you approve.",
    ];
  }
  if (p.action === "pause") {
    return [
      "Stops its scheduled runs until it is resumed.",
      "A run already going is not stopped, and it can still be run by hand.",
      "Proposed by the assistant; nothing happens until you approve.",
    ];
  }
  return [
    "Starts its scheduled runs again, from its next scheduled time.",
    "Proposed by the assistant; nothing happens until you approve.",
  ];
}

/** A proposal back from an approval's payload, or null for anything else. */
export function actionFromPayload(payload: unknown): ProposedAction | null {
  const p = (payload as { action?: unknown } | null)?.action as Partial<ProposedAction> | undefined;
  if (!p || !isActionKind(p.kind) || !isAction(p.action) || typeof p.id !== "string" || !p.id) {
    return null;
  }
  return {
    kind: p.kind,
    id: p.id,
    action: p.action,
    name: typeof p.name === "string" ? p.name : "",
  };
}

/** Where the thing opens, as a route: its list page, opened on it. */
export function actionRoute(p: Pick<ProposedAction, "kind" | "id">): {
  to: "/workflows" | "/etl";
  open: string;
} {
  return { to: p.kind === "workflow" ? "/workflows" : "/etl", open: p.id };
}

/** The same, as a path, for the approval's payload and the answer. */
export function actionLink(p: Pick<ProposedAction, "kind" | "id">): string {
  const r = actionRoute(p);
  return `${r.to}?open=${r.open}`;
}
