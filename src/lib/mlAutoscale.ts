// How many copies of a model should be answering right now.
//
// NO IMPORTS, like the other src/lib/ml*.ts modules, so the scheduler, the
// panel and the tests read one set of rules.
//
// A warm endpoint used to be one sandbox. One sandbox is one Python process
// scoring one request at a time, so the second caller waits for the first —
// and at that point the twenty seconds a warm endpoint saved are being spent
// again in the queue. More copies is the answer; the question is how many, and
// the two ways to get that wrong are both expensive.
//
//   TOO SLOW TO ADD and the queue is the product. Scaling up therefore has no
//   cooldown: the moment the arithmetic says another copy is needed, one is
//   started.
//
//   TOO EAGER TO REMOVE and the endpoint FLAPS — drops a copy, immediately
//   needs it again, pays another cold start, drops it again. That costs more
//   than the memory it was trying to save and it makes latency unpredictable
//   in a way a steady over-provision never does. So removing a copy is
//   deliberately reluctant: it needs the load to have fallen well clear of the
//   line, a cooldown since the last change, and a copy that has actually been
//   idle.
//
// Everything here is arithmetic on numbers the platform measured. Nothing
// decides policy — the minimum, the maximum and the target are the owner's.

/** What the scheduler knows when it has to decide. */
export type MlScaleInput = {
  /** Requests a minute across the whole endpoint, measured between passes. */
  requestsPerMinute: number;
  /** Copies answering now. */
  replicasReady: number;
  /** Copies asked for and still loading. They will answer shortly. */
  replicasStarting: number;
  min: number;
  max: number;
  /** Requests a minute one copy is expected to carry. */
  targetPerReplica: number;
  /** Since the last change either way, so a decision cannot chase itself. */
  secondsSinceChange: number;
  cooldownSeconds: number;
  /**
   * How long the least recently used copy has gone unused. Null when there is
   * nothing to remove. A copy that scored a moment ago may still be inside
   * that request, and stopping its sandbox would take the answer with it.
   */
  idlestReplicaIdleSeconds: number | null;
};

export type MlScaleAction = "up" | "down" | "hold";

export type MlScaleDecision = {
  action: MlScaleAction;
  /** Copies that should exist after this decision. */
  desired: number;
  /** Plain words, recorded on the deployment so a reader can see why. */
  reason: string;
};

/**
 * Removing a copy needs the load to be clear of the line, not merely at it.
 *
 * At exactly the target, dropping a copy puts the remaining ones over it and
 * the next pass adds one back. The margin is what turns that oscillation into
 * a decision that sticks.
 */
export const SCALE_DOWN_MARGIN = 0.8;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** The copies load alone would ask for, before any policy is applied. */
export function replicasForLoad(requestsPerMinute: number, targetPerReplica: number): number {
  if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) return 0;
  if (!Number.isFinite(targetPerReplica) || targetPerReplica <= 0) return 1;
  return Math.ceil(requestsPerMinute / targetPerReplica);
}

export function scaleDecision(input: MlScaleInput): MlScaleDecision {
  const min = Math.max(0, Math.trunc(input.min));
  const max = Math.max(min, Math.trunc(input.max));
  const ready = Math.max(0, Math.trunc(input.replicasReady));
  const starting = Math.max(0, Math.trunc(input.replicasStarting));
  // Copies that will be answering shortly count as present. Without this a
  // burst starts one copy per pass until the first finishes loading, and an
  // endpoint that needed two ends up with six.
  const live = ready + starting;

  const wanted = clamp(
    Math.max(replicasForLoad(input.requestsPerMinute, input.targetPerReplica), min),
    min,
    max,
  );

  if (live < wanted) {
    return {
      action: "up",
      desired: wanted,
      reason:
        live < min
          ? `below the minimum of ${min}`
          : `${input.requestsPerMinute.toFixed(1)} requests a minute over ${live} ${live === 1 ? "copy" : "copies"}, above the ${input.targetPerReplica} each is sized for`,
    };
  }

  if (live > wanted) {
    // Everything below is a reason NOT to remove one. Each is a way this has
    // been got wrong before rather than a hypothetical.
    if (input.secondsSinceChange < input.cooldownSeconds) {
      return {
        action: "hold",
        desired: live,
        reason: `${Math.round(input.secondsSinceChange)}s since the last change, inside the ${input.cooldownSeconds}s cooldown`,
      };
    }
    // The load has to be clear of what the smaller number could carry, not
    // merely at it, or the next pass adds the copy straight back.
    const headroom = input.targetPerReplica * (live - 1) * SCALE_DOWN_MARGIN;
    if (input.requestsPerMinute > headroom) {
      return {
        action: "hold",
        desired: live,
        reason: `${input.requestsPerMinute.toFixed(1)} requests a minute is too close to what ${live - 1} ${live - 1 === 1 ? "copy" : "copies"} could carry`,
      };
    }
    if (input.idlestReplicaIdleSeconds === null) {
      return { action: "hold", desired: live, reason: "no copy is idle enough to stop" };
    }
    if (input.idlestReplicaIdleSeconds < input.cooldownSeconds) {
      return {
        action: "hold",
        desired: live,
        // Stopping a sandbox takes any request still inside it.
        reason: `the quietest copy was used ${Math.round(input.idlestReplicaIdleSeconds)}s ago`,
      };
    }
    return {
      action: "down",
      // `wanted` is already clamped to at least `min` above; a second Math.max
      // here read like a floor and was unreachable. A mutation check removed
      // it and nothing changed, which is the definition of a line to delete.
      desired: wanted,
      reason: `${input.requestsPerMinute.toFixed(1)} requests a minute needs ${wanted} of ${live}`,
    };
  }

  return {
    action: "hold",
    desired: live,
    reason:
      live === 0
        ? "nothing to serve"
        : `${live} ${live === 1 ? "copy is" : "copies are"} right for the load`,
  };
}

/**
 * Requests a minute between two readings of the same counter.
 *
 * Null when there is no earlier reading to subtract, or when the counter has
 * gone BACKWARDS — which means the endpoint was restarted and its count reset,
 * and inventing a rate from that would ask for copies nobody needs.
 */
export function ratePerMinute(
  previousCount: number | null,
  previousAt: string | null,
  currentCount: number,
  now: Date = new Date(),
): number | null {
  if (previousCount === null || previousAt === null) return null;
  const then = new Date(previousAt).getTime();
  if (!Number.isFinite(then)) return null;
  const minutes = (now.getTime() - then) / 60_000;
  if (minutes <= 0) return null;
  const delta = currentCount - previousCount;
  if (delta < 0) return null;
  return delta / minutes;
}

/**
 * Which copy to stop: the one unused longest.
 *
 * Least-recently-used rather than newest or oldest, because it is the one
 * least likely to be inside a request right now — and because on a
 * round-robin it is also the one the next request is least likely to pick.
 */
export function replicaToStop<T extends { id: string; last_used_at: string | null }>(
  replicas: T[],
): T | null {
  if (replicas.length === 0) return null;
  const at = (r: T) => (r.last_used_at ? new Date(r.last_used_at).getTime() : 0);
  return [...replicas].sort((a, b) => at(a) - at(b))[0];
}

/**
 * Which copy should answer next: the one unused longest.
 *
 * The same rule as the one above, and deliberately so — a copy is either the
 * quietest or it is not, and two different notions of "quietest" would have
 * the scorer and the scaler disagreeing about the same endpoint. Spreading
 * work this way keeps every copy's idle clock honest, which is what the
 * scale-down safety check reads.
 */
export function replicaToScore<T extends { id: string; last_used_at: string | null }>(
  replicas: T[],
): T | null {
  return replicaToStop(replicas);
}

/** How long a copy has been unused, for the scale-down safety check. */
export function idleSeconds(lastUsedAt: string | null, now: Date = new Date()): number | null {
  if (!lastUsedAt) return null;
  const t = new Date(lastUsedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now.getTime() - t) / 1000);
}
