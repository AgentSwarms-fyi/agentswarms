// Group membership changed: let the key hierarchy follow, in the background.
//
// Kept apart from the key code so the IAM and SCIM modules do not load the
// keyring and every key provider to call it: the sweep is imported when a
// change happens. The membership change has already succeeded when this
// runs, and its failure does not undo or fail it.
export function groupMembershipChanged(userIds: string[], why: string): void {
  if (userIds.length === 0) return;
  void (async () => {
    try {
      const { reconcileOwners } = await import("@/utils/providers/keyRotation.server");
      await reconcileOwners(userIds, why);
    } catch (e) {
      console.warn(`[kms] after ${why}: ${(e as Error).message}`);
    }
  })();
}
