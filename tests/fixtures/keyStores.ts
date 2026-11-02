// In-memory key stores for the user-key and customer-key tests: the same
// contract as src/utils/kms/keyStore.server.ts (unique live key per user,
// unique fingerprints, compare-and-set re-wrap), with no database.
import {
  KeyStoreMissingError,
  type CustomerKeyRow,
  type KeyStore,
  type Membership,
  type UserKeyRow,
} from "@/utils/kms/keyHierarchy.server";

/** A store whose tables are not there yet: the migration is not applied. */
export function missingKeyStore(): KeyStore {
  const missing = async (): Promise<never> => {
    throw new KeyStoreMissingError("user_keys is not in the database yet");
  };
  return {
    userKeyByKid: missing,
    activeUserKey: missing,
    insertUserKey: missing,
    rewrapUserKey: missing,
    customerKey: missing,
    memberships: missing,
  };
}

export type MemoryKeyStore = ReturnType<typeof memoryKeyStore>;

export function memoryKeyStore() {
  const userKeys: UserKeyRow[] = [];
  const customerKeys = new Map<string, CustomerKeyRow>();
  const members: Array<{ customerKeyId: string; userId?: string; groupId?: string }> = [];
  const groups = new Map<string, { name: string; users: Set<string> }>();
  const calls = { insert: 0, rewrap: 0, memberships: 0, userKeyByKid: 0, customerKey: 0 };
  let seq = 0;

  const store: KeyStore = {
    async userKeyByKid(kid) {
      calls.userKeyByKid++;
      return structuredClone(userKeys.find((k) => k.kid === kid) ?? null);
    },
    async activeUserKey(userId) {
      return structuredClone(userKeys.find((k) => k.user_id === userId && !k.erased_at) ?? null);
    },
    async insertUserKey(row) {
      calls.insert++;
      if (userKeys.some((k) => k.kid === row.kid)) return "conflict";
      if (userKeys.some((k) => k.user_id === row.user_id && !k.erased_at)) return "conflict";
      const full: UserKeyRow = {
        ...row,
        id: `uk-${++seq}`,
        created_at: new Date(1_700_000_000_000 + seq).toISOString(),
        erased_at: null,
      };
      userKeys.push(full);
      return structuredClone(full);
    },
    async rewrapUserKey(id, from, to) {
      calls.rewrap++;
      const k = userKeys.find((x) => x.id === id);
      if (
        !k ||
        k.erased_at ||
        k.wrapped_by !== from.wrapped_by ||
        k.customer_key_id !== from.customer_key_id
      ) {
        return false;
      }
      Object.assign(k, to);
      return true;
    },
    async customerKey(id) {
      calls.customerKey++;
      return structuredClone(customerKeys.get(id) ?? null);
    },
    async memberships(userId) {
      calls.memberships++;
      const out: Membership[] = [];
      for (const m of members) {
        const key = customerKeys.get(m.customerKeyId);
        const keyName = key?.name ?? m.customerKeyId;
        if (m.userId === userId) {
          out.push({ via: "user", customerKeyId: m.customerKeyId, customerKeyName: keyName });
        } else if (m.groupId && groups.get(m.groupId)?.users.has(userId)) {
          out.push({
            via: "group",
            customerKeyId: m.customerKeyId,
            customerKeyName: keyName,
            groupId: m.groupId,
            groupName: groups.get(m.groupId)!.name,
          });
        }
      }
      return out;
    },
  };

  return {
    store,
    userKeys,
    customerKeys,
    members,
    groups,
    calls,
    assignUser(customerKeyId: string, userId: string) {
      members.push({ customerKeyId, userId });
    },
    assignGroup(customerKeyId: string, groupId: string) {
      members.push({ customerKeyId, groupId });
    },
    unassign(
      predicate: (m: { customerKeyId: string; userId?: string; groupId?: string }) => boolean,
    ) {
      for (let i = members.length - 1; i >= 0; i--) if (predicate(members[i])) members.splice(i, 1);
    },
    group(id: string, name: string, users: string[]) {
      groups.set(id, { name, users: new Set(users) });
    },
    /** What destroy_customer_key does, in one step. */
    destroy(customerKeyId: string) {
      this.unassign((m) => m.customerKeyId === customerKeyId);
      for (const k of userKeys) {
        if (k.customer_key_id === customerKeyId && !k.erased_at) {
          k.material = null;
          k.iv = null;
          k.erased_at = new Date().toISOString();
        }
      }
      const c = customerKeys.get(customerKeyId)!;
      c.material = null;
      c.iv = null;
      c.destroyed_at = new Date().toISOString();
    },
    erase(userId: string) {
      const k = userKeys.find((x) => x.user_id === userId && !x.erased_at);
      if (!k) return null;
      k.material = null;
      k.iv = null;
      k.erased_at = new Date().toISOString();
      return k;
    },
  };
}
