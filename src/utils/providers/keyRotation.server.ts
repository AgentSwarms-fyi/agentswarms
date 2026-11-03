// Re-encrypt every stored credential to the current key.
//
// Rotating PROVIDER_CREDS_SECRET is two moves. The OPERATOR does the part
// software cannot: set the new secret as PROVIDER_CREDS_SECRET, move the old one
// to PROVIDER_CREDS_SECRET_OLD, and restart. From that moment both keys decrypt
// and everything new is written with the new key. This module does the other
// part — sweeping existing rows onto the new key — which the admin UI triggers.
//
// "The current key" of a value is its owner's user key
// (src/utils/kms/keyHierarchy.server.ts). The sweep therefore does three
// things, in order: re-wraps the customer keys the app holds and the user keys
// that an older deployment key wraps (a rotation then re-encrypts no value),
// moves each user key under the customer key its owner's membership says,
// and re-encrypts every value not yet on its owner's key.
//
// It is deliberately blob-shape-agnostic. Every table that stores a credential
// is listed here; within a row, `reEncryptDeep` finds and rewrites every
// ciphertext at any JSON depth, so a whole-column blob, a nested `_enc` field
// and a `{token: …}` object are all handled the same way. Adding a new
// encrypted column later means adding the table name here, nothing else.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  KeyStoreMissingError,
  type CustomerKeyRow,
  type DataKey,
  type UserKeyRow,
} from "@/utils/kms/keyHierarchy.server";
import {
  groupMembers,
  listCustomerKeyMembers,
  listCustomerKeys,
  listUserKeys,
  updateCustomerKeyMaterial,
  type CustomerKeyMemberRow,
} from "@/utils/kms/keyStore.server";
import {
  blobKeyStatus,
  keyHierarchy,
  keyringFingerprints,
  reEncryptDeep,
  writeKeyFor,
} from "./crypto.server";

/**
 * Every table any `encryptJson` caller writes to. Derived by grepping all call
 * sites, not guessed — the set is closed because nothing else produces a blob.
 * Empty tables are listed anyway so rotation covers them once they hold data.
 * Slack workspaces, Teams bots and signed embed viewers were missing (R438):
 * their secrets were left on a retired key by the sweep, and the card did not
 * count them. tests/unit/encryptedTables.test.ts now holds the list to the
 * call sites.
 */
export const ENCRYPTED_TABLES = [
  "user_secrets",
  "data_warehouse_connections",
  "saas_connections",
  "integrations",
  "provider_credentials",
  "catalog_sources",
  "git_export_config",
  "kb_sources",
  "mcp_servers",
  "slack_workspaces",
  "teams_bots",
  "embed_keys",
] as const;

export type TableStatus = {
  table: string;
  rows: number;
  blobs: number;
  onCurrent: number;
  /** On the deployment's current key, not yet on its owner's key: a sweep moves it. */
  onDeploymentKey: number;
  /** On an older key this server holds: a sweep moves it. */
  onOther: number;
  /** On a key this server does not hold: a sweep cannot move it (R432). */
  unreadable: number;
  unreadableKids: string[];
  legacy: number;
  error?: string;
};

export type TableRotation = {
  table: string;
  rowsScanned: number;
  rowsUpdated: number;
  migrated: number;
  alreadyCurrent: number;
  failed: number;
  error?: string;
};

/** Which column identifies a row for the write-back. Every encrypted table has
 *  one of these; `id` is preferred. */
function rowKey(row: Record<string, unknown>): { col: string; val: unknown } | null {
  if (typeof row.id === "string") return { col: "id", val: row.id };
  if (typeof row.user_id === "string") return { col: "user_id", val: row.user_id };
  return null;
}

const ownerOf = (row: Record<string, unknown>) =>
  typeof row.user_id === "string" ? row.user_id : null;

// ── Who should be under which key ────────────────────────────────────────────

/** The customer key a user's membership names, or the conflict that stops it. */
export type Expected = { customerKeyId: string } | { conflict: string[] };

/**
 * From the assignments: a direct one wins; otherwise the one customer key the
 * user's groups name; two different ones are a conflict. Users with neither
 * are absent (the deployment's key).
 */
export function expectedCustomerKeys(
  members: Pick<CustomerKeyMemberRow, "customer_key_id" | "user_id" | "group_id">[],
  usersOfGroup: Map<string, string[]>,
): Map<string, Expected> {
  const direct = new Map<string, string>();
  const viaGroups = new Map<string, Set<string>>();
  for (const m of members) {
    if (m.user_id) direct.set(m.user_id, m.customer_key_id);
    else if (m.group_id) {
      for (const u of usersOfGroup.get(m.group_id) ?? []) {
        const set = viaGroups.get(u) ?? new Set<string>();
        set.add(m.customer_key_id);
        viaGroups.set(u, set);
      }
    }
  }
  const out = new Map<string, Expected>();
  for (const [u, keys] of viaGroups) {
    out.set(u, keys.size === 1 ? { customerKeyId: [...keys][0] } : { conflict: [...keys].sort() });
  }
  for (const [u, k] of direct) out.set(u, { customerKeyId: k });
  return out;
}

export type UserKeySummary = {
  /** The user and customer key tables exist (migration 20261105000000). */
  enabled: boolean;
  live: number;
  erased: number;
  /** Live user keys a customer key wraps. */
  underCustomer: number;
  /** Live user keys an older deployment key wraps, which this server holds: the sweep re-wraps them. */
  onOlderDeploymentKey: number;
  /** Live user keys not under the key their owner's membership says: the sweep moves them. */
  toMove: number;
  /** Users whose groups name two customer keys. */
  conflicts: number;
  /** Live user keys whose wrapping key this server does not hold. */
  unheld: number;
  /** Why each fingerprint a value may be on does not read here. */
  notes: Record<string, string>;
  error?: string;
};

export type KeyContext = {
  instanceCurrent: string;
  /** Every fingerprint whose values this server can read. */
  held: Set<string>;
  /** Owner → the fingerprint of their live user key. */
  liveByOwner: Map<string, string>;
  userKeys: UserKeyRow[];
  customerKeys: CustomerKeyRow[];
  expected: Map<string, Expected>;
  summary: UserKeySummary;
};

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "?");

/** Everything the counts and the sweep need to know about the keys, read once. */
export async function keyContext(): Promise<KeyContext> {
  const { current, previous } = await keyringFingerprints();
  const instanceKids = new Set([current, ...previous]);
  const summary: UserKeySummary = {
    enabled: false,
    live: 0,
    erased: 0,
    underCustomer: 0,
    onOlderDeploymentKey: 0,
    toMove: 0,
    conflicts: 0,
    unheld: 0,
    notes: {},
  };
  const ctx: KeyContext = {
    instanceCurrent: current,
    held: new Set(instanceKids),
    liveByOwner: new Map(),
    userKeys: [],
    customerKeys: [],
    expected: new Map(),
    summary,
  };
  try {
    const [userKeys, customerKeys, members] = await Promise.all([
      listUserKeys(),
      listCustomerKeys(),
      listCustomerKeyMembers(),
    ]);
    const groupIds = [...new Set(members.map((m) => m.group_id).filter((g): g is string => !!g))];
    ctx.expected = expectedCustomerKeys(members, await groupMembers(groupIds));
    ctx.userKeys = userKeys;
    ctx.customerKeys = customerKeys;
  } catch (e) {
    if (!(e instanceof KeyStoreMissingError)) summary.error = (e as Error).message;
    return ctx;
  }
  summary.enabled = true;
  const customers = new Map(ctx.customerKeys.map((c) => [c.id, c]));
  for (const exp of ctx.expected.values()) if ("conflict" in exp) summary.conflicts++;
  for (const k of ctx.userKeys) {
    if (k.erased_at) {
      summary.erased++;
      summary.notes[k.kid] = `a user key erased on ${day(k.erased_at)}`;
      continue;
    }
    summary.live++;
    ctx.liveByOwner.set(k.user_id, k.kid);
    const exp = ctx.expected.get(k.user_id);
    const wantCustomer = exp && "customerKeyId" in exp ? exp.customerKeyId : null;
    if (exp && "conflict" in exp) {
      // Counted under conflicts; where it is now stays readable.
    } else if (wantCustomer !== k.customer_key_id) summary.toMove++;
    if (k.customer_key_id) {
      summary.underCustomer++;
      const c = customers.get(k.customer_key_id);
      if (!c || c.destroyed_at) {
        summary.unheld++;
        summary.notes[k.kid] = `a user key under a destroyed customer key`;
        continue;
      }
      if (c.provider === "app" && (!c.wrapped_by || !instanceKids.has(c.wrapped_by))) {
        summary.unheld++;
        summary.notes[k.kid] =
          `a user key under the customer key "${c.name}", which the deployment key ${c.wrapped_by} wraps, and this server does not hold that key`;
        continue;
      }
      ctx.held.add(k.kid);
    } else if (instanceKids.has(k.wrapped_by)) {
      if (k.wrapped_by !== current) summary.onOlderDeploymentKey++;
      ctx.held.add(k.kid);
    } else {
      summary.unheld++;
      summary.notes[k.kid] =
        `a user key wrapped by the deployment key ${k.wrapped_by}, which this server does not hold`;
    }
  }
  return ctx;
}

/** Read-only: how many blobs each table holds and how many are on the current key. */
export async function keyEncryptionStatus(context?: KeyContext): Promise<TableStatus[]> {
  const ctx = context ?? (await keyContext());
  const out: TableStatus[] = [];
  for (const table of ENCRYPTED_TABLES) {
    const { data, error } = await supabaseAdmin.from(table).select("*");
    if (error) {
      out.push({
        table,
        rows: 0,
        blobs: 0,
        onCurrent: 0,
        onDeploymentKey: 0,
        onOther: 0,
        unreadable: 0,
        unreadableKids: [],
        legacy: 0,
        error: error.message,
      });
      continue;
    }
    let blobs = 0;
    let onCurrent = 0;
    let onDeploymentKey = 0;
    let onOther = 0;
    let unreadable = 0;
    const unreadableKids = new Set<string>();
    let legacy = 0;
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const owner = ownerOf(row);
      // An owner's values belong on their user key, once there are user keys;
      // until the owner has one, every value of theirs is still to move.
      const keys =
        ctx.summary.enabled && owner
          ? {
              current: ctx.liveByOwner.get(owner) ?? null,
              deployment: ctx.instanceCurrent,
              held: ctx.held,
            }
          : { current: ctx.instanceCurrent, held: ctx.held };
      for (const val of Object.values(row)) {
        const s = await blobKeyStatus(val, keys);
        blobs += s.total;
        onCurrent += s.onCurrent;
        onDeploymentKey += s.onDeploymentKey;
        onOther += s.onOther;
        unreadable += s.unreadable;
        for (const k of s.unreadableKids) unreadableKids.add(k);
        legacy += s.legacy;
      }
    }
    out.push({
      table,
      rows: (data ?? []).length,
      blobs,
      onCurrent,
      onDeploymentKey,
      onOther,
      unreadable,
      unreadableKids: [...unreadableKids],
      legacy,
    });
  }
  return out;
}

export type StatusTotals = Omit<TableStatus, "table" | "rows" | "error">;

/** The tables' counts added up; the unreadable keys once each, sorted. */
export function statusTotals(tables: TableStatus[]): StatusTotals {
  const kids = new Set<string>();
  const t: StatusTotals = {
    blobs: 0,
    onCurrent: 0,
    onDeploymentKey: 0,
    onOther: 0,
    unreadable: 0,
    unreadableKids: [],
    legacy: 0,
  };
  for (const s of tables) {
    t.blobs += s.blobs;
    t.onCurrent += s.onCurrent;
    t.onDeploymentKey += s.onDeploymentKey;
    t.onOther += s.onOther;
    t.unreadable += s.unreadable;
    t.legacy += s.legacy;
    for (const k of s.unreadableKids) kids.add(k);
  }
  t.unreadableKids = [...kids].sort();
  return t;
}

export type SweepResult = {
  tables: TableRotation[];
  totalMigrated: number;
  totalFailed: number;
  /** User keys moved under another customer key, or re-wrapped by the current deployment key. */
  userKeysRewrapped: number;
  customerKeysRewrapped: number;
  /** Owners whose key could not be had, with why (a conflict, a refusal…). */
  ownerFailures: Array<{ userId: string; error: string }>;
};

const CHUNK = 100;

/**
 * Sweep every row of every encrypted table onto its owner's current key.
 * Idempotent: a row already fully on it is read but not written. A row that
 * cannot be decrypted, or whose owner's key cannot be had, is counted as
 * failed and left exactly as it was — never destroyed — so a bad key config
 * or a corrupt blob costs nothing and the sweep can be re-run after fixing it.
 */
export function reEncryptAllToCurrentKey(): Promise<SweepResult> {
  return sweep(null);
}

/**
 * The same, for these owners only: what an assignment to a customer key, or
 * its removal, runs for the users it covers, so everything they stored is
 * under the right key at once.
 */
export function reEncryptOwners(userIds: string[]): Promise<SweepResult> {
  return sweep([...new Set(userIds)]);
}

async function sweep(owners: string[] | null): Promise<SweepResult> {
  const result: SweepResult = {
    tables: [],
    totalMigrated: 0,
    totalFailed: 0,
    userKeysRewrapped: 0,
    customerKeysRewrapped: 0,
    ownerFailures: [],
  };
  if (owners && owners.length === 0) return result;
  const failedOwners = new Map<string, string>();
  const ctx = await keyContext();

  if (ctx.summary.enabled) {
    // 1. Customer keys the app holds, on an older deployment key.
    if (!owners) {
      for (const c of ctx.customerKeys) {
        try {
          const next = await keyHierarchy().rewrapAppCustomerKey(c);
          if (next && c.wrapped_by && (await updateCustomerKeyMaterial(c.id, c.wrapped_by, next))) {
            result.customerKeysRewrapped++;
          }
        } catch (e) {
          console.warn(
            `[kms] customer key "${c.name}" was not re-wrapped: ${(e as Error).message}`,
          );
        }
      }
    }
    // 2. User keys under the wrong key: moved, or re-wrapped by the current one.
    const scope = owners ? new Set(owners) : null;
    const customers = new Map(ctx.customerKeys.map((c) => [c.id, c]));
    for (const k of ctx.userKeys) {
      if (k.erased_at || (scope && !scope.has(k.user_id))) continue;
      const exp = ctx.expected.get(k.user_id);
      const want = exp && "customerKeyId" in exp ? customers.get(exp.customerKeyId) : null;
      const settled =
        exp && "conflict" in exp
          ? false
          : (want?.id ?? null) === k.customer_key_id &&
            k.wrapped_by === (want ? want.kid : ctx.instanceCurrent);
      if (settled) continue;
      try {
        if ((await keyHierarchy().reconcile(k.user_id)) === "moved") result.userKeysRewrapped++;
      } catch (e) {
        failedOwners.set(k.user_id, (e as Error).message);
      }
    }
  }

  // 3. Values, onto their owner's key, which is looked up once per owner.
  const targets = new Map<string, Promise<DataKey>>();
  const targetOf = (owner: string | null) => {
    const k = owner ?? "";
    let t = targets.get(k);
    if (!t) {
      t = writeKeyFor(owner);
      t.catch((e: Error) => {
        if (owner) failedOwners.set(owner, e.message);
      });
      targets.set(k, t);
    }
    return t;
  };

  for (const table of ENCRYPTED_TABLES) {
    const r: TableRotation = {
      table,
      rowsScanned: 0,
      rowsUpdated: 0,
      migrated: 0,
      alreadyCurrent: 0,
      failed: 0,
    };
    const rows: Record<string, unknown>[] = [];
    if (owners) {
      for (let i = 0; i < owners.length && !r.error; i += CHUNK) {
        const { data, error } = await supabaseAdmin
          .from(table)
          .select("*")
          .in("user_id", owners.slice(i, i + CHUNK));
        if (error) r.error = error.message;
        else rows.push(...((data ?? []) as Record<string, unknown>[]));
      }
    } else {
      const { data, error } = await supabaseAdmin.from(table).select("*");
      if (error) r.error = error.message;
      else rows.push(...((data ?? []) as Record<string, unknown>[]));
    }
    if (r.error) {
      result.tables.push(r);
      continue;
    }

    for (const row of rows) {
      r.rowsScanned++;
      const key = rowKey(row);
      const owner = ownerOf(row);
      const patch: Record<string, unknown> = {};
      let rowMigrated = 0;

      for (const [col, val] of Object.entries(row)) {
        const d = await reEncryptDeep(val, { target: () => targetOf(owner) });
        r.migrated += d.migrated;
        r.alreadyCurrent += d.alreadyCurrent;
        r.failed += d.failed;
        if (d.migrated > 0) {
          patch[col] = d.value;
          rowMigrated += d.migrated;
        }
      }

      if (rowMigrated > 0) {
        if (!key) {
          // No id/user_id to write back against — count the migrated blobs as
          // failed rather than silently leaving them on the old key.
          r.failed += rowMigrated;
          r.migrated -= rowMigrated;
          continue;
        }
        // The patch is built by walking the row, so its shape is only known at
        // runtime; the generated table types cannot express that.
        const { error: upErr } = await supabaseAdmin
          .from(table)
          .update(patch as never)
          .eq(key.col, key.val as string);
        if (upErr) {
          r.error = upErr.message;
          r.failed += rowMigrated;
          r.migrated -= rowMigrated;
        } else {
          r.rowsUpdated++;
        }
      }
    }

    result.totalMigrated += r.migrated;
    result.totalFailed += r.failed;
    result.tables.push(r);
  }

  result.ownerFailures = [...failedOwners].map(([userId, error]) => ({ userId, error }));
  return result;
}

/**
 * After an IAM group's members change (Admin → IAM, SCIM) or a group is
 * deleted: move the users it touched under the key their membership now says.
 * Nothing to do, and nothing read beyond the assignments, while no customer
 * key covers anyone. A failure is logged; the user's next save, or the next
 * sweep, moves them.
 */
export async function reconcileOwners(userIds: string[], why: string): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  try {
    const [members, keys] = await Promise.all([listCustomerKeyMembers(), listUserKeys()]);
    if (members.length === 0 && !keys.some((k) => !k.erased_at && k.customer_key_id)) return;
  } catch {
    return; // No tables yet, or none readable: nothing to move.
  }
  const r = await reEncryptOwners(ids);
  for (const f of r.ownerFailures) console.warn(`[kms] after ${why}: user ${f.userId}: ${f.error}`);
  // Their lakehouse files follow the same key (R440), once every worker writes under it.
  await import("@/utils/lakehouse/customerKeyFiles.server")
    .then((m) => m.reEncryptFilesAfterMove(ids, why))
    .catch((e) => console.warn(`[kms] lakehouse files after ${why}:`, (e as Error).message));
}
