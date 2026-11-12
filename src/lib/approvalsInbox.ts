// Opening the approvals inbox (the header's bell-side popover) from anywhere
// on the page. The inbox owns its open state; a page that wants it open asks.
export const OPEN_APPROVALS_EVENT = "agentswarms:open-approvals";

export function openApprovalsInbox(): void {
  window.dispatchEvent(new Event(OPEN_APPROVALS_EVENT));
}

/**
 * Which approvals in a fresh load to announce (R468): the pending ones this
 * user has not seen, that are routed to them. Every id in the list is marked
 * seen, so each approval is announced at most once however often the inbox
 * reloads (a Realtime event, a poll, the tab coming back into view). The first
 * load only marks what was already waiting when the page opened.
 *
 * Until R468 the announcement came from the Realtime INSERT event itself, so
 * where Realtime cannot run (Amazon RDS) nobody was ever told.
 */
export function approvalsToAnnounce<T extends { id: string; status: string }>(
  list: T[],
  seen: Set<string>,
  firstLoad: boolean,
  isMine: (approval: T) => boolean,
): T[] {
  const out: T[] = [];
  for (const approval of list) {
    if (seen.has(approval.id)) continue;
    seen.add(approval.id);
    if (!firstLoad && approval.status === "pending" && isMine(approval)) out.push(approval);
  }
  return out;
}
