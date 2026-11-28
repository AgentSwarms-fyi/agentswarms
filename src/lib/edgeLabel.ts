// A connection's name on the swarm canvas: the label on the line between two
// nodes, set by clicking the line. A Router node offers its outgoing lines'
// names to the model as its routes, and a Condition node reads them as its
// branches, so a name is a short word or two ("billing", "yes", "route-1").
//
// It had no limit: a name of any length was drawn on the line across the
// canvas, over the nodes, and offered whole to the model as a route. It now
// holds at most 20 characters.
import { nameLength } from "@/lib/visibleName";

export const EDGE_LABEL_MAX_LENGTH = 20;

/** How long a connection's name is, as you see it, without the spaces around it. */
export function edgeLabelLength(typed: string): number {
  return nameLength(typed.trim());
}

/** Why a connection cannot have this name, or null when it can (empty clears it). */
export function edgeLabelProblem(typed: string): string | null {
  return edgeLabelLength(typed) > EDGE_LABEL_MAX_LENGTH
    ? `A connection's name holds at most ${EDGE_LABEL_MAX_LENGTH} characters.`
    : null;
}
