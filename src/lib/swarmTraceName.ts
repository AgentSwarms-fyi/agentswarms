// What a swarm node's model call is called on its trace and its audit row.
//
// The chat route names a turn "Playground" unless something names it, and a
// swarm node named nothing: every node of every swarm run, from the canvas or
// from the deployed API and schedules, was listed in Traces and Analytics as
// "Playground", beside (and indistinguishable from) the turns typed in Agent
// Chat.
//
// A node's call is named after its swarm, in the form the Traces page already
// uses for what is not an agent ("Gateway: <key>", "KB: Embedding", "Embed:
// <name>"). Both runners call it the same, so one swarm reads the same
// wherever it ran. Without a name (a canvas swarm never saved, or a name that
// could not be read) it is still "Swarm", never "Playground".
import { clampName, hasVisibleName } from "@/lib/visibleName";

export const SWARM_TRACE_NAME = "Swarm";

export function swarmTraceName(swarmName: unknown): string {
  return hasVisibleName(swarmName)
    ? clampName(`${SWARM_TRACE_NAME}: ${swarmName.trim()}`)
    : SWARM_TRACE_NAME;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The trace name of a canvas swarm node's turn. A browser may not name its own
 * trace (the name reaches the audit log), so it sends the swarm's id and the
 * chat route reads the name with `readName`, under the caller's own token:
 * row-level security decides which swarm an id may name, so a trace can only
 * be named after a swarm its caller can see. Only a label: no id, an id that
 * is not one, or a read that fails gives "Swarm", and the turn runs either way.
 */
export async function swarmTraceNameFor(
  swarmId: unknown,
  readName: ((id: string) => PromiseLike<unknown>) | null | undefined,
): Promise<string> {
  if (!readName || typeof swarmId !== "string" || !UUID_RE.test(swarmId)) {
    return SWARM_TRACE_NAME;
  }
  try {
    return swarmTraceName(await readName(swarmId));
  } catch {
    return SWARM_TRACE_NAME;
  }
}
