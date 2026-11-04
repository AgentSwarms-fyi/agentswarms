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
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  checkStoreUnderKey,
  customerKeyFilesView,
  filesPassDetail,
  lakehouseSseMode,
  lakehouseStore,
  reEncryptFilesAfterMove,
  reEncryptLakehouseFiles,
  type FilesPassResult,
} from "@/utils/lakehouse/customerKeyFiles.server";
import { storeKeyProvider } from "@/utils/lakehouse/customerKeyFiles";
import {
  sealOlderStoredFiles,
  STORED_FILES_PASS,
  storedFilesPassDetail,
  type StoredFilesPass,
} from "@/utils/storage/storedFiles.server";
import type { MemoryPass } from "@/utils/memory/memoryPass";
import type { ChatPass } from "@/utils/chat/chatPass";
import {
  runPassDetail,
  tracePassDetail,
  type RunPass,
  type TracePass,
} from "@/utils/observability/tracePass";
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
  /**
   * Its members' lakehouse files: under the customer's KMS key, or why not
   * (R440); their models' artifacts follow the same key (R442).
   */
  lakehouseFiles: { kmsKeyId: string | null; why: string | null; schemas: number; models: number };
};

export type LakehouseFilesState = {
  /** The store encrypts files under customer keys, and why (LAKEHOUSE_SSE_KMS). */
  on: boolean;
  why: string;
  /** Schemas left as they are: their owner's groups name two customer keys. */
  conflictedSchemas: number;
  /**
   * On Cloud Storage, whether the store took the key's name on the engine's
   * requests; until it has, new files are written under its own (R443).
   */
  engine?: { ok: boolean; why: string | null };
  /** The last re-encrypt pass, from the audit trail. */
  lastPass: AuditedPass | null;
  error?: string;
};

/** A pass from the audit trail: when, by whom, and its counts. */
export type AuditedPass = {
  at: string;
  by: string | null;
  detail: Record<string, string | number | boolean>;
};

/** Generated documents and dataset copies, sealed by the app under their owner's key (R441). */
export type StoredFilesState = {
  /** The last pass over them, from the audit trail. */
  lastPass: AuditedPass | null;
  error?: string;
};

export type CustomerKeysPayload = {
  ok: true;
  /** False until migration 20261105000000 is applied: the card says so. */
  enabled: boolean;
  keys: CustomerKeyView[];
  lakehouseFiles: LakehouseFilesState;
  storedFiles: StoredFilesState;
  /** Users whose groups name two customer keys: nothing new is stored for them. */
  conflicts: Array<{ userId: string; keyIds: string[] }>;
  /** Live user keys, per user: what the erase control lists. */
  userKeys: Array<{ userId: string; kid: string; customerKeyId: string | null; createdAt: string }>;
  summary: UserKeySummary;
};

const FILES_PASS = "security.lakehouse_files.reencrypt";

/** The last audited pass of `action`; a trail that cannot be read is said, not shown as none. */
async function lastAuditedPass(
  action: string,
): Promise<{ lastPass: AuditedPass | null; error?: string }> {
  const { data: rows, error } = await supabaseAdmin
    .from("audit_events")
    .select("created_at, actor_email, detail")
    .eq("action", action)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    return {
      lastPass: null,
      error: `The last pass could not be read from the audit trail: ${error.message}`,
    };
  }
  const last = rows?.[0] as
    { created_at: string; actor_email?: string | null; detail: unknown } | undefined;
  if (!last) return { lastPass: null };
  return {
    lastPass: {
      at: last.created_at,
      by: last.actor_email ?? null,
      // The counts and the reason only: what the card prints (and serialisable).
      detail: Object.fromEntries(
        Object.entries((last.detail ?? {}) as Record<string, unknown>).filter(
          (e): e is [string, string | number | boolean] =>
            ["string", "number", "boolean"].includes(typeof e[1]),
        ),
      ),
    },
  };
}

/** The store's mode, what each key does for files, and the last pass. */
async function lakehouseFilesState(): Promise<{
  state: LakehouseFilesState;
  perKey: Awaited<ReturnType<typeof customerKeyFilesView>>["perKey"];
}> {
  const view = await customerKeyFilesView();
  const { lastPass, error: auditError } = await lastAuditedPass(FILES_PASS);
  return {
    state: {
      on: view.mode.on,
      why: view.mode.why,
      conflictedSchemas: view.conflictedSchemas,
      ...(view.engine ? { engine: view.engine } : {}),
      lastPass,
      // A last pass that could not be read is said, not shown as none.
      ...(view.error ? { error: view.error } : auditError ? { error: auditError } : {}),
    },
    perKey: view.perKey,
  };
}

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
          lakehouseFiles: (await lakehouseFilesState()).state,
          storedFiles: await lastAuditedPass(STORED_FILES_PASS),
          conflicts: [],
          userKeys: [],
          summary: ctx.summary,
        };
      }
      const files = await lakehouseFilesState();
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
          lakehouseFiles: files.perKey.get(c.id) ?? {
            kmsKeyId: null,
            why: files.state.error ?? files.state.why,
            schemas: 0,
            models: 0,
          },
        };
      });
      const conflicts = [...ctx.expected]
        .filter(([, e]) => "conflict" in e)
        .map(([userId, e]) => ({ userId, keyIds: "conflict" in e ? e.conflict : [] }));
      return {
        ok: true,
        enabled: true,
        keys,
        lakehouseFiles: files.state,
        storedFiles: await lastAuditedPass(STORED_FILES_PASS),
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
      // A key that covers lakehouse files: the store is asked to use it too.
      const store = await checkStoreUnderKey(row).catch(
        (e): Awaited<ReturnType<typeof checkStoreUnderKey>> => ({
          covered: true,
          ok: false,
          detail: `The lakehouse store could not be checked: ${(e as Error).message}`,
        }),
      );
      return {
        ok: true,
        detail:
          (probe.ok
            ? `Unwrapped by ${row.key_ref}; ${probe.detail}`
            : `Unwrapped by ${row.key_ref}, but the provider's own check says: ${probe.detail}`) +
          (store.covered ? ` ${store.detail}` : ""),
        facts: [
          ...(probe.facts ?? []),
          {
            label: "Lakehouse files",
            value: store.covered
              ? store.ok
                ? "Encrypted by the store under this key"
                : "The store did not encrypt under this key"
              : store.why,
          },
        ],
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
  /** Their lakehouse files are put under the key they now belong under, in the background. */
  lakehouseFilesFollow: boolean;
};

const membershipResult = (
  users: number,
  r: SweepResult,
  lakehouseFilesFollow: boolean,
): MembershipPayload => ({
  ok: true,
  users,
  userKeysRewrapped: r.userKeysRewrapped,
  valuesReEncrypted: r.totalMigrated,
  valuesFailed: r.totalFailed,
  ownerFailures: r.ownerFailures,
  lakehouseFilesFollow,
});

/**
 * After a move: the users' lakehouse files follow their key, once every
 * worker writes under it. Said only when the store encrypts under customer
 * keys and some live customer key is in the store's own KMS (the pass's own
 * guard): AWS KMS on S3, Cloud KMS on Cloud Storage. Found in R443's round:
 * this said AWS alone, so a Cloud KMS key's assignment moved no file.
 */
function filesFollow(
  affected: string[],
  why: string,
  keys: Array<{ provider: string; destroyed_at: string | null }>,
  actor: { userId: string; email: string | null },
): boolean {
  if (!affected.length || !lakehouseSseMode().on) return false;
  const provider = storeKeyProvider(lakehouseStore());
  if (!keys.some((k) => k.provider === provider && !k.destroyed_at)) return false;
  reEncryptFilesAfterMove(affected, why, actor);
  return true;
}

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
          error: `${clashes.length} of this group's members ${clashes.length === 1 ? "is" : "are"} already covered through another group by ${[
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
      const follow = filesFollow(affected, `assignment to "${key.name}"`, keys, guard);
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
          lakehouse_files_follow: follow,
        },
      });
      return membershipResult(affected.length, swept, follow);
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
      const keys = await listCustomerKeys();
      const key = keys.find((c) => c.id === removed.customer_key_id);
      const follow = filesFollow(
        affected,
        `removal from "${key?.name ?? removed.customer_key_id}"`,
        keys,
        guard,
      );
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
          lakehouse_files_follow: follow,
        },
      });
      return membershipResult(affected.length, swept, follow);
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
  .handler(
    async ({
      data,
    }): Promise<
      | {
          ok: true;
          userKeysErased: number;
          lakehouseSchemasLeft: number;
          lakehouseModelsLeft: number;
        }
      | Fail
    > => {
      const guard = await requireSuperadmin(data.access_token);
      if (!guard.ok) return { ok: false, error: guard.error };
      try {
        const row = (await listCustomerKeys()).find((c) => c.id === data.id);
        if (!row) return { ok: false, error: "That customer key does not exist" };
        if (row.destroyed_at) return { ok: false, error: "That customer key is already destroyed" };
        if (data.confirm_name.trim() !== row.name) {
          return { ok: false, error: `Type the key's name, ${row.name}, to destroy it` };
        }
        // Its members' lakehouse files stay under the customer's own KMS key:
        // the app cannot destroy that, and moves no file off it (R440). Said.
        const files = (await customerKeyFilesView()).perKey.get(row.id);
        const schemasLeft = files?.kmsKeyId ? files.schemas : 0;
        const modelsLeft = files?.kmsKeyId ? files.models : 0;
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
            ...(schemasLeft ? { lakehouse_schemas_left_under_key: schemasLeft } : {}),
            ...(modelsLeft ? { models_left_under_key: modelsLeft } : {}),
          },
        });
        return {
          ok: true,
          userKeysErased: erased,
          lakehouseSchemasLeft: schemasLeft,
          lakehouseModelsLeft: modelsLeft,
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

/**
 * Put every lakehouse file under the key its schema's owner is under, and
 * every model artifact under its model's owner's, now: the card's
 * "Re-encrypt lakehouse files". It reads how every file is stored
 * (one request per file) and copies in place the ones that are not; on a
 * large lakehouse that takes a while.
 */
export const reEncryptLakehouseFilesNow = createServerFn({ method: "POST" })
  .validator((input: unknown) => token.parse(input))
  .handler(async ({ data }): Promise<FilesPassResult | Fail> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return { ok: false, error: guard.error };
    try {
      const r = await reEncryptLakehouseFiles();
      auditEvent({
        userId: guard.userId,
        actorEmail: guard.email,
        action: FILES_PASS,
        resourceType: "security",
        resourceName: "every schema",
        detail: { trigger: "Re-encrypt lakehouse files", ...filesPassDetail(r) },
      });
      return r;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/**
 * Put every generated document and dataset copy under its owner's current
 * key, now: the card's "Encrypt stored files". The background pass does the
 * same a bounded number an hour (STORED_FILES_PER_PASS); this one has no
 * bound, and downloads each document that is not yet under its key.
 */
export const sealStoredFilesNow = createServerFn({ method: "POST" })
  .validator((input: unknown) => token.parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | ({ ok: true } & StoredFilesPass & {
            memory: MemoryPass;
            chat: ChatPass;
            traces: TracePass;
            runs: RunPass;
          })
      | Fail
    > => {
      const guard = await requireSuperadmin(data.access_token);
      if (!guard.ok) return { ok: false, error: guard.error };
      try {
        const r = await sealOlderStoredFiles();
        // And what agents kept before R445: one pass, one audit row.
        const { memoryPassDetail, sealOlderMemory } = await import("@/utils/memory/sealed.server");
        const m = await sealOlderMemory();
        // And Agent Chat history kept before R446.
        const { chatPassDetail, sealOlderChats } = await import("@/utils/chat/sealedChat.server");
        const c = await sealOlderChats();
        // And model call traces kept before R448.
        const { sealOlderTraces } = await import("@/utils/observability/sealedTraces.server");
        const t = await sealOlderTraces();
        // And swarm run traces kept before R449.
        const { sealOlderRuns } = await import("@/utils/observability/sealedRuns.server");
        const p = await sealOlderRuns();
        auditEvent({
          userId: guard.userId,
          actorEmail: guard.email,
          action: STORED_FILES_PASS,
          resourceType: "security",
          resourceName: "stored files",
          detail: {
            trigger: "Encrypt stored files",
            ...storedFilesPassDetail(r),
            ...memoryPassDetail(m),
            ...chatPassDetail(c),
            ...tracePassDetail(t),
            ...runPassDetail(p),
          },
        });
        return { ok: true, ...r, memory: m, chat: c, traces: t, runs: p };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

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
