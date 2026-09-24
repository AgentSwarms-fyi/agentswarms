// How a swarm run's status reads in Recent runs, and what the panel may do
// with it.
//
// FOUND IN R108. The panel knew four statuses and showed any other as
// "Running". A run parked at a human approval is stored as "suspended"
// (swarmExecute.server.ts), so every parked run read "Running", with the
// running icon and a duration that grew by the minute ("1321m 35s"). It had
// no action that could end it, under a header saying a paused run can be
// cancelled there. The observability page, which prints the raw status, said
// "suspended" for the same runs.

export type RunTone = "active" | "waiting" | "success" | "error" | "muted";

export type RunStatusView = {
  label: string;
  tone: RunTone;
  /** Still moving on its own: worth polling, and its duration is time spent running. */
  live: boolean;
  /** The panel's Cancel can end it. */
  cancellable: boolean;
  /** Parked until someone decides its approval, which is what ends it. */
  awaitingDecision: boolean;
};

const VIEWS: Record<string, RunStatusView> = {
  running: {
    label: "Running",
    tone: "active",
    live: true,
    cancellable: true,
    awaitingDecision: false,
  },
  // A run in THIS tab waiting at an approval node: still in memory, so Cancel
  // reaches it.
  waiting: {
    label: "Awaiting approval",
    tone: "waiting",
    live: true,
    cancellable: true,
    awaitingDecision: false,
  },
  // A run parked on the server with a checkpoint. Nothing in this panel can
  // end it; approving or rejecting its approval does.
  suspended: {
    label: "Awaiting approval",
    tone: "waiting",
    live: false,
    cancellable: false,
    awaitingDecision: true,
  },
  success: {
    label: "Success",
    tone: "success",
    live: false,
    cancellable: false,
    awaitingDecision: false,
  },
  error: {
    label: "Error",
    tone: "error",
    live: false,
    cancellable: false,
    awaitingDecision: false,
  },
  cancelled: {
    label: "Cancelled",
    tone: "muted",
    live: false,
    cancellable: false,
    awaitingDecision: false,
  },
};

/** A status this panel does not know reads as itself, never as "Running". */
export function runStatusView(status: string): RunStatusView {
  return (
    VIEWS[status] ?? {
      label: status || "Unknown",
      tone: "muted",
      live: false,
      cancellable: false,
      awaitingDecision: false,
    }
  );
}

/**
 * What a parked run's approval requests say about it. "suspended" says only
 * that the run is parked; whether anyone can still move it is on the
 * approval row, which the executor writes with the run owner's id.
 */
export type ParkedApproval = "pending" | "decided" | "none" | "unknown";

export function parkedApproval(
  statuses: string[] | undefined,
  readFailed: boolean,
): ParkedApproval {
  if (readFailed) return "unknown";
  if (!statuses || statuses.length === 0) return "none";
  return statuses.includes("pending") ? "pending" : "decided";
}

export function parkedRunView(approval: ParkedApproval): RunStatusView {
  switch (approval) {
    case "pending":
      return VIEWS.suspended;
    // Decided, and still parked: the resume never took hold. R92's forked
    // resumes left rows like this, their work finished under another run.
    // The inbox no longer holds the request, so nothing points there.
    case "decided":
      return {
        label: "Decided, not resumed",
        tone: "error",
        live: false,
        cancellable: false,
        awaitingDecision: false,
      };
    // Parked with no request at all: nobody was ever asked (R90).
    case "none":
      return {
        label: "Parked, nobody asked",
        tone: "error",
        live: false,
        cancellable: false,
        awaitingDecision: false,
      };
    // The requests could not be read: claim only what the run row says, and
    // leave the inbox, where a decision would be, one click away.
    default:
      return {
        label: "Parked",
        tone: "waiting",
        live: false,
        cancellable: false,
        awaitingDecision: true,
      };
  }
}

/**
 * A duration is time spent running: a finished run's, or a live one's so
 * far. A parked run is neither, and the time since it started says nothing
 * about it ("45h 30m" on a run that stopped after 10 seconds of work).
 */
export function showsDuration(view: RunStatusView, finishedAt: number | null): boolean {
  return view.live || finishedAt !== null;
}

/** 42s, 7m 5s, 19h 35m. */
export function formatRunDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
