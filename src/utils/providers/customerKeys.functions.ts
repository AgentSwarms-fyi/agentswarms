// Superadmin-gated server functions for customer keys and user keys: the
// "Customer keys" card on Admin → IAM → Settings.
//
// The keys themselves are keyHierarchy.server's; this file adds the gate, the
// checks an admin's input needs, the audit trail, and a shape the card can
// render. Every change that moves users between keys runs the owner sweep at
// once, so what the card says is covered is covered when it says so.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSuperadmin } from "@/utils/iam.server";
import { auditEvent } from "@/utils/audit.server";
import type { CustomerKeyProvider } from "@/utils/kms/keyHierarchy.server";
import {
  addCustomerKeyMember,
  destroyCustomerKeyRow,
  eraseUserKeyRow,
  groupMembers,
  insertCustomerKey,
  listCustomerKeyMembers,
  listCustomerKeys,
  removeCustomerKeyMember,
} from "@/utils/kms/keyStore.server";
import { keyRefProvider, type ProbeResult } from "@/utils/kms/types";
import { customerKeyProvider, keyHierarchy } from "./crypto.server";
import {
  expectedCustomerKeys,
  keyContext,
  reEncryptOwners,
  type SweepResult,
  type UserKeySummary,
} from "./keyRotation.server";

type Fail = { ok: false; error: string };

const token = z.object({ access_token: z.string().min(1) });
const uuid = z.string().uuid();

export type CustomerKeyView = {
  id: string;
  name: string;
  provider: CustomerKeyProvider;
  keyRef: string | null;
  endpoint: string | null;
  kid: string;
  createdAt: string;
  destroyedAt: string | null;
  members: Array<{ id: string; kind: "user" | "group"; principalId: string }>;
  /** Users the assignments cover (a direct assignment elsewhere, or a conflict, excluded). */
  coveredUsers: number;
  /** Live user keys it wraps. */
  userKeys: number;
  /** Covered users whose user key is not under it yet, or users under it no longer covered. */
  toMove: number;
};

export type CustomerKeysPayload = {
  ok: true;
  /** False until migration 20261105000000 is applied: the card says so. */
  enabled: boolean;
  keys: CustomerKeyView[];
  /** Users whose groups name two customer keys: nothing new is stored for them. */
  conflicts: Array<{ userId: string; keyIds: string[] }>;
  /** Live user keys, per user: what the erase control lists. */
  userKeys: Array<{ userId: string; kid: string; customerKeyId: string | null; createdAt: string }>;
  summary: UserKeySummary;
};

/** Read-only: every customer key, who it covers, and the user keys. */
export const getCustomerKeys = createServerFn({ method: "POST" })
  .validator((input: unknown) => token.parse(input))
  .handler(async ({ data }): Promise<CustomerKeysPayload | Fail> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return { ok: false, error: guard.error };
    try {
      const ctx = await keyContext();
      if (!ctx.summary.enabled) {
        if (ctx.summary.error) return { ok: false, error: ctx.summary.error };
        return {
          ok: true,
          enabled: false,
          keys: [],
          conflicts: [],
          userKeys: [],
          summary: ctx.summary,
        };
      }
      const members = await listCustomerKeyMembers();
      const live = ctx.userKeys.filter((k) => !k.erased_at);
      const keys = ctx.customerKeys.map((c): CustomerKeyView => {
        const covered = [...ctx.expected].filter(
          ([, e]) => "customerKeyId" in e && e.customerKeyId === c.id,
        );
        const coveredIds = new Set(covered.map(([u]) => u));
        const under = live.filter((k) => k.customer_key_id === c.id);
        const toMove =
          live.filter((k) => coveredIds.has(k.user_id) && k.customer_key_id !== c.id).length +
          under.filter((k) => !coveredIds.has(k.user_id)).length;
        return {
          id: c.id,
          name: c.name,
          provider: c.provider,
          keyRef: c.key_ref,
          endpoint: c.endpoint,
          kid: c.kid,
          createdAt: c.created_at,
          destroyedAt: c.destroyed_at,
          members: members
            .filter((m) => m.customer_key_id === c.id)
            .map((m) => ({
              id: m.id,
              kind: m.user_id ? ("user" as const) : ("group" as const),
              principalId: (m.user_id ?? m.group_id) as string,
            })),
          coveredUsers: covered.length,
          userKeys: under.length,
          toMove,
        };
      });
      const conflicts = [...ctx.expected]
        .filter(([, e]) => "conflict" in e)
        .map(([userId, e]) => ({ userId, keyIds: "conflict" in e ? e.conflict : [] }));
      return {
        ok: true,
        enabled: true,
        keys,
        conflicts,
        userKeys: live.map((k) => ({
          userId: k.user_id,
          kid: k.kid,
          customerKeyId: k.customer_key_id,
          createdAt: k.created_at,
        })),
        summary: ctx.summary,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/** An https origin and nothing else: what an OCI vault's crypto endpoint is. */
function originOnly(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

const CreateSchema = token.extend({
  name: z.string().trim().min(1, "Name the customer key").max(80, "At most 80 characters"),
  where: z.enum(["app", "kms"]),
  key_ref: z.string().trim().max(500).optional(),
  endpoint: z.string().trim().max(300).optional(),
});

/**
 * Create a customer key: held by the app (wrapped by the deployment's key),
 * or in the customer's own KMS (wrapped there, by a key the app's identity
 * may use). The key is proven to unwrap before anything is stored. Nobody is
 * assigned to it yet.
 */
export const createCustomerKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => CreateSchema.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; id: string; kid: string } | Fail> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return { ok: false, error: guard.error };
    try {
      let provider: CustomerKeyProvider = "app";
      let keyRef: string | null = null;
      let endpoint: string | null = null;
      if (data.where === "kms") {
        keyRef = (data.key_ref ?? "").trim();
        const kind = keyRef ? keyRefProvider(keyRef) : null;
        if (!kind) {
          return {
            ok: false,
            error:
              "Enter the customer's key: an AWS KMS key ARN, an Azure Key Vault key identifier (https://<vault>.vault.azure.net/keys/<name>), a Cloud KMS key's resource name (projects/…/cryptoKeys/<key>), an OCI Vault key's OCID, or a Vault Transit key (transit/keys/<name>)",
          };
        }
        if (keyRef === (process.env.KMS_KEY_REF ?? "").trim()) {
          return {
            ok: false,
            error:
              "That is this deployment's own key (KMS_KEY_REF). A customer key in a KMS is a key the customer controls; for one the app holds, choose Held by the app.",
          };
        }
        provider = kind;
        if (kind === "oci") {
          endpoint = originOnly(data.endpoint ?? "");
          if (!endpoint) {
            return {
              ok: false,
              error:
                "An OCI Vault key needs its vault's cryptographic endpoint, https://<vault>-crypto.kms.<region>.oraclecloud.com (the vault's details show it)",
            };
          }
        }
      }
      const id = crypto.randomUUID();
      const material = await keyHierarchy().makeCustomerKeyMaterial({
        id,
        name: data.name,
        provider,
        keyRef,
        endpoint,
      });
      const row = await insertCustomerKey({
        id,
        name: data.name,
        provider,
        key_ref: keyRef,
        endpoint,
        ...material,
        created_by: guard.userId,
      });
      auditEvent({
        userId: guard.userId,
        actorEmail: guard.email,
        action: "security.customer_key.create",
        resourceType: "security",
        resourceName: row.name,
        resourceId: row.id,
        detail: { provider: row.provider, key_ref: row.key_ref, kid: row.kid },
      });
      return { ok: true, id: row.id, kid: row.kid };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

export type CheckPayload = { ok: true; detail: string; facts: ProbeResult["facts"] };

/**
 * Unwrap the customer key now, past the cache, and for one in a KMS read what
 * the provider says about the key: the card's "Check".
 */
export const checkCustomerKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => token.extend({ id: uuid }).parse(input))
  .handler(async ({ data }): Promise<CheckPayload | Fail> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return { ok: false, error: guard.error };
    try {
      const row = (await listCustomerKeys()).find((c) => c.id === data.id);
      if (!row) return { ok: false, error: "That customer key does not exist" };
      await keyHierarchy().checkCustomerKey(row);
      if (row.provider === "app") {
        return {
          ok: true,
          detail: `Unwrapped under the deployment key ${row.wrapped_by}`,
          facts: [],
        };
      }
      const probe = await customerKeyProvider(row).probe();
      return {
        ok: true,
        detail: probe.ok
          ? `Unwrapped by ${row.key_ref}; ${probe.detail}`
          : `Unwrapped by ${row.key_ref}, but the provider's own check says: ${probe.detail}`,
        facts: probe.facts ?? [],
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

function sweepDetail(r: SweepResult) {
  return {
    user_keys_rewrapped: r.userKeysRewrapped,
    values_reencrypted: r.totalMigrated,
    values_failed: r.totalFailed,
    owners_failed: r.ownerFailures.length,
  };
}

export type MembershipPayload = {
  ok: true;
  users: number;
  userKeysRewrapped: number;
  valuesReEncrypted: number;
  valuesFailed: number;
  ownerFailures: SweepResult["ownerFailures"];
};

const membershipResult = (users: number, r: SweepResult): MembershipPayload => ({
  ok: true,
  users,
  userKeysRewrapped: r.userKeysRewrapped,
  valuesReEncrypted: r.totalMigrated,
  valuesFailed: r.totalFailed,
  ownerFailures: r.ownerFailures,
});

/**
 * Assign a user or an IAM group to a customer key, then move everyone it
 * covers: their user keys are re-wrapped by it, and anything of theirs still
 * on the deployment's key is re-encrypted onto their user key. Refused when it
 * would put a user under two customer keys.
 */
export const assignCustomerKey = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    token
      .extend({ id: uuid, principal_type: z.enum(["user", "group"]), principal_id: uuid })
      .parse(input),
  )
  .handler(async ({ data }): Promise<MembershipPayload | Fail> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return { ok: false, error: guard.error };
    try {
      const keys = await listCustomerKeys();
      const key = keys.find((c) => c.id === data.id);
      if (!key) return { ok: false, error: "That customer key does not exist" };
      if (key.destroyed_at) return { ok: false, error: "That customer key was destroyed" };
      const isUser = data.principal_type === "user";
      const members = await listCustomerKeyMembers();
      const groupIds = [
        ...new Set(
          [...members.map((m) => m.group_id), isUser ? null : data.principal_id].filter(
            (g): g is string => !!g,
          ),
        ),
      ];
      const usersOf = await groupMembers(groupIds);
      const affected = isUser ? [data.principal_id] : (usersOf.get(data.principal_id) ?? []);
      // What the assignments would say with this one added: a user whose
      // groups would then name two customer keys is refused here, with names.
      const after = expectedCustomerKeys(
        [
          ...members,
          {
            customer_key_id: key.id,
            user_id: isUser ? data.principal_id : null,
            group_id: isUser ? null : data.principal_id,
          },
        ],
        usersOf,
      );
      const clashes = affected.filter((u) => {
        const e = after.get(u);
        return !!e && "conflict" in e;
      });
      if (clashes.length > 0) {
        const names = new Map<string, string>(keys.map((c) => [c.id, c.name]));
        const other = new Set<string>();
        for (const u of clashes) {
          const e = after.get(u);
          if (e && "conflict" in e) for (const k of e.conflict) if (k !== key.id) other.add(k);
        }
        return {
          ok: false,
          error: `${clashes.length} of this group's members are already covered through another group by ${[
            ...other,
          ]
            .map((k) => `"${names.get(k) ?? k}"`)
            .join(
              ", ",
            )}. Assign those users directly to one key, or remove the other group's assignment.`,
        };
      }
      const member = await addCustomerKeyMember({
        customerKeyId: key.id,
        userId: isUser ? data.principal_id : undefined,
        groupId: isUser ? undefined : data.principal_id,
        addedBy: guard.userId,
      });
      const swept = await reEncryptOwners(affected);
      auditEvent({
        userId: guard.userId,
        actorEmail: guard.email,
        action: "security.customer_key.assign",
        resourceType: "security",
        resourceName: key.name,
        resourceId: key.id,
        detail: {
          member_id: member.id,
          [isUser ? "user_id" : "group_id"]: data.principal_id,
          users: affected.length,
          ...sweepDetail(swept),
        },
      });
      return membershipResult(affected.length, swept);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/**
 * Remove an assignment, then move the users it covered back under the key
 * their remaining membership says (the deployment's, when none).
 */
export const unassignCustomerKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => token.extend({ member_id: uuid }).parse(input))
  .handler(async ({ data }): Promise<MembershipPayload | Fail> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return { ok: false, error: guard.error };
    try {
      const removed = await removeCustomerKeyMember(data.member_id);
      if (!removed) return { ok: false, error: "That assignment does not exist" };
      const affected = removed.user_id
        ? [removed.user_id]
        : ((await groupMembers([removed.group_id as string])).get(removed.group_id as string) ??
          []);
      const swept = await reEncryptOwners(affected);
      const key = (await listCustomerKeys()).find((c) => c.id === removed.customer_key_id);
      auditEvent({
        userId: guard.userId,
        actorEmail: guard.email,
        action: "security.customer_key.unassign",
        resourceType: "security",
        resourceName: key?.name ?? removed.customer_key_id,
        resourceId: removed.customer_key_id,
        detail: {
          [removed.user_id ? "user_id" : "group_id"]: removed.user_id ?? removed.group_id,
          users: affected.length,
          ...sweepDetail(swept),
        },
      });
      return membershipResult(affected.length, swept);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/**
 * Destroy a customer key: its assignments go, every user key it wraps is
 * erased, and its own material is deleted, in one transaction. What its
 * members stored is unreadable from then on. The name is typed to confirm.
 */
export const destroyCustomerKey = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    token.extend({ id: uuid, confirm_name: z.string().max(80) }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; userKeysErased: number } | Fail> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return { ok: false, error: guard.error };
    try {
      const row = (await listCustomerKeys()).find((c) => c.id === data.id);
      if (!row) return { ok: false, error: "That customer key does not exist" };
      if (row.destroyed_at) return { ok: false, error: "That customer key is already destroyed" };
      if (data.confirm_name.trim() !== row.name) {
        return { ok: false, error: `Type the key's name, ${row.name}, to destroy it` };
      }
      const erased = await destroyCustomerKeyRow(row.id, guard.userId);
      keyHierarchy().forgetCustomer(row.id);
      auditEvent({
        userId: guard.userId,
        actorEmail: guard.email,
        action: "security.customer_key.destroy",
        resourceType: "security",
        resourceName: row.name,
        resourceId: row.id,
        detail: {
          provider: row.provider,
          key_ref: row.key_ref,
          kid: row.kid,
          user_keys_erased: erased,
        },
      });
      return { ok: true, userKeysErased: erased };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/**
 * Erase one user's key. Everything they stored is unreadable from then on;
 * their next save makes them a new key. The user's email is typed to confirm.
 */
export const eraseUserKey = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    token.extend({ user_id: uuid, confirm_email: z.string().max(320) }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; kid: string } | Fail> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return { ok: false, error: guard.error };
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: u, error } = await supabaseAdmin.auth.admin.getUserById(data.user_id);
      if (error || !u?.user) return { ok: false, error: "That user does not exist" };
      const email = (u.user.email ?? "").toLowerCase();
      if (!email || data.confirm_email.trim().toLowerCase() !== email) {
        return {
          ok: false,
          error: `Type the user's email, ${u.user.email ?? ""}, to erase their key`,
        };
      }
      const row = await eraseUserKeyRow(data.user_id, guard.userId);
      if (!row) return { ok: false, error: "This user has no key to erase" };
      keyHierarchy().forgetUserKey(row.kid);
      auditEvent({
        userId: guard.userId,
        actorEmail: guard.email,
        action: "security.user_key.erase",
        resourceType: "security",
        resourceName: u.user.email ?? data.user_id,
        resourceId: data.user_id,
        detail: { kid: row.kid, customer_key_id: row.customer_key_id },
      });
      return { ok: true, kid: row.kid };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
