// Opening the approvals inbox (the header's bell-side popover) from anywhere
// on the page. The inbox owns its open state; a page that wants it open asks.
export const OPEN_APPROVALS_EVENT = "agentswarms:open-approvals";

export function openApprovalsInbox(): void {
  window.dispatchEvent(new Event(OPEN_APPROVALS_EVENT));
}
