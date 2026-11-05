// The counts of a pass that seals approval requests and notifications kept
// before R450, as the stored-files pass's audit row and the Customer keys card
// carry them. Pure: the card uses it too.

export type InboxPass = {
  approvals: number;
  notifications: number;
  /** Rows whose owner's key cannot be had now: left as they are. */
  unreadable: number;
  /** Rows that would have been sealed past the pass's limit. */
  left: boolean;
  /** Older swarm requests are left until migration 20261108000000 is applied. */
  needsMigration: boolean;
  failed: number;
  errors: string[];
};

/** The pass's counts, for the stored-files pass's audit detail (one row for all of them). */
export function inboxPassDetail(p: InboxPass): Record<string, unknown> {
  return {
    ...(p.approvals ? { approvals_sealed: p.approvals } : {}),
    ...(p.notifications ? { notifications_sealed: p.notifications } : {}),
    ...(p.unreadable ? { inbox_unreadable: p.unreadable } : {}),
    ...(p.left ? { inbox_left: true } : {}),
    ...(p.needsMigration ? { approvals_need_migration: true } : {}),
    ...(p.failed ? { inbox_failed: p.failed } : {}),
    ...(p.errors.length ? { inbox_errors: p.errors } : {}),
  };
}
