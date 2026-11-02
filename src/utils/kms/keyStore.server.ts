// The key hierarchy's store in the database: user_keys, customer_keys and
// customer_key_members (migration 20261105000000), read and written as the
// service role only. A missing table is KeyStoreMissingError, which the
// caller turns into "the deployment's key, as before the migration"; any
// other database error is an error, never a quiet fallback.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  KeyStoreMissingError,
  type CustomerKeyRow,
  type KeyStore,
  type Membership,
  type NewUserKey,
  type UserKeyRow,
} from "./keyHierarchy.server";

const USER_KEY_COLUMNS =
  "id, user_id, kid, material, iv, customer_key_id, wrapped_by, created_at, erased_at";
const CUSTOMER_KEY_COLUMNS =
  "id, name, provider, key_ref, endpoint, material, iv, wrapped_by, kid, created_at, destroyed_at";

type DbError = { code?: string; message: string } | null;

/** PostgREST's "no such table" (PGRST205) or Postgres's (42P01). */
export function isMissingTable(error: DbError): boolean {
  if (!error) return false;
  return (
    error.code === "PGRST205" ||
    error.code === "42P01" ||
    /could not find the table|relation .* does not exist/i.test(error.message)
  );
}

function fail(what: string, error: NonNullable<DbError>): never {
  if (isMissingTable(error)) {
    throw new KeyStoreMissingError(
      `The user and customer key tables are not in the database yet (migration 20261105000000_customer_keys.sql): ${error.message}`,
    );
  }
  throw new Error(`Could not ${what}: ${error.message}`);
}

export function supabaseKeyStore(): KeyStore {
  return {
    async userKeyByKid(kid) {
      const { data, error } = await supabaseAdmin
        .from("user_keys")
        .select(USER_KEY_COLUMNS)
        .eq("kid", kid)
        .maybeSingle();
      if (error) fail("read a user key", error);
      return (data as UserKeyRow | null) ?? null;
    },

    async activeUserKey(userId) {
      const { data, error } = await supabaseAdmin
        .from("user_keys")
        .select(USER_KEY_COLUMNS)
        .eq("user_id", userId)
        .is("erased_at", null)
        .maybeSingle();
      if (error) fail("read the user's key", error);
      return (data as UserKeyRow | null) ?? null;
    },

    async insertUserKey(row: NewUserKey) {
      const { data, error } = await supabaseAdmin
        .from("user_keys")
        .insert(row)
        .select(USER_KEY_COLUMNS)
        .single();
      if (error) {
        // Another process made this user's key first, or (2^-48) the
        // fingerprint is taken: the caller reads again.
        if (error.code === "23505") return "conflict";
        fail("store the user's key", error);
      }
      return data as UserKeyRow;
    },

    async rewrapUserKey(id, from, to) {
      let q = supabaseAdmin
        .from("user_keys")
        .update(to)
        .eq("id", id)
        .eq("wrapped_by", from.wrapped_by)
        .is("erased_at", null);
      q = from.customer_key_id
        ? q.eq("customer_key_id", from.customer_key_id)
        : q.is("customer_key_id", null);
      const { data, error } = await q.select("id");
      if (error) fail("re-wrap the user's key", error);
      return (data ?? []).length === 1;
    },

    async customerKey(id) {
      const { data, error } = await supabaseAdmin
        .from("customer_keys")
        .select(CUSTOMER_KEY_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("read a customer key", error);
      return (data as CustomerKeyRow | null) ?? null;
    },

    async memberships(userId) {
      const groups = await supabaseAdmin
        .from("iam_group_members")
        .select("group_id")
        .eq("user_id", userId);
      if (groups.error) fail("read the user's groups", groups.error);
      const groupIds = (groups.data ?? []).map((g) => g.group_id as string);
      let q = supabaseAdmin
        .from("customer_key_members")
        .select("customer_key_id, user_id, group_id, customer_keys(name), iam_groups(name)");
      q =
        groupIds.length > 0
          ? q.or(`user_id.eq.${userId},group_id.in.(${groupIds.join(",")})`)
          : q.eq("user_id", userId);
      const { data, error } = await q;
      if (error) fail("read the user's customer key", error);
      return (data ?? []).map((m): Membership => {
        const keyName = (m.customer_keys as { name?: string } | null)?.name ?? m.customer_key_id;
        return m.user_id
          ? { via: "user", customerKeyId: m.customer_key_id, customerKeyName: keyName }
          : {
              via: "group",
              customerKeyId: m.customer_key_id,
              customerKeyName: keyName,
              groupId: m.group_id as string,
              groupName: (m.iam_groups as { name?: string } | null)?.name ?? (m.group_id as string),
            };
      });
    },
  };
}

// ── What the admin card reads and changes ────────────────────────────────────

export type CustomerKeyMemberRow = {
  id: string;
  customer_key_id: string;
  user_id: string | null;
  group_id: string | null;
  created_at: string;
};

export async function listCustomerKeys(): Promise<CustomerKeyRow[]> {
  const { data, error } = await supabaseAdmin
    .from("customer_keys")
    .select(CUSTOMER_KEY_COLUMNS)
    .order("created_at", { ascending: true });
  if (error) fail("list the customer keys", error);
  return (data ?? []) as CustomerKeyRow[];
}

export async function listCustomerKeyMembers(): Promise<CustomerKeyMemberRow[]> {
  const { data, error } = await supabaseAdmin
    .from("customer_key_members")
    .select("id, customer_key_id, user_id, group_id, created_at")
    .order("created_at", { ascending: true });
  if (error) fail("list the customer key assignments", error);
  return (data ?? []) as CustomerKeyMemberRow[];
}

/** Every user key, live and erased: the card's counts, and the sweep's re-wrap. */
export async function listUserKeys(): Promise<UserKeyRow[]> {
  const { data, error } = await supabaseAdmin.from("user_keys").select(USER_KEY_COLUMNS);
  if (error) fail("list the user keys", error);
  return (data ?? []) as UserKeyRow[];
}

export async function insertCustomerKey(
  row: Omit<CustomerKeyRow, "created_at" | "destroyed_at"> & { created_by: string | null },
): Promise<CustomerKeyRow> {
  const { data, error } = await supabaseAdmin
    .from("customer_keys")
    .insert(row)
    .select(CUSTOMER_KEY_COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error(`A customer key named "${row.name}" already exists`);
    }
    fail("store the customer key", error);
  }
  return data as CustomerKeyRow;
}

export async function updateCustomerKeyMaterial(
  id: string,
  from: string,
  to: { material: string; iv: string; wrapped_by: string },
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("customer_keys")
    .update(to)
    .eq("id", id)
    .eq("wrapped_by", from)
    .is("destroyed_at", null)
    .select("id");
  if (error) fail("re-wrap the customer key", error);
  return (data ?? []).length === 1;
}

export async function addCustomerKeyMember(args: {
  customerKeyId: string;
  userId?: string;
  groupId?: string;
  addedBy: string | null;
}): Promise<CustomerKeyMemberRow> {
  const { data, error } = await supabaseAdmin
    .from("customer_key_members")
    .insert({
      customer_key_id: args.customerKeyId,
      user_id: args.userId ?? null,
      group_id: args.groupId ?? null,
      added_by: args.addedBy,
    })
    .select("id, customer_key_id, user_id, group_id, created_at")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error(
        args.userId
          ? "This user is already assigned to a customer key; remove that assignment first"
          : "This group is already assigned to a customer key; remove that assignment first",
      );
    }
    fail("assign the customer key", error);
  }
  return data as CustomerKeyMemberRow;
}

export async function removeCustomerKeyMember(id: string): Promise<CustomerKeyMemberRow | null> {
  const { data, error } = await supabaseAdmin
    .from("customer_key_members")
    .delete()
    .eq("id", id)
    .select("id, customer_key_id, user_id, group_id, created_at");
  if (error) fail("remove the assignment", error);
  return ((data ?? [])[0] as CustomerKeyMemberRow | undefined) ?? null;
}

/** Erase a user's live key. The row stays, without its material. */
export async function eraseUserKeyRow(
  userId: string,
  by: string | null,
): Promise<UserKeyRow | null> {
  const { data, error } = await supabaseAdmin
    .from("user_keys")
    .update({
      material: null,
      iv: null,
      erased_at: new Date().toISOString(),
      erased_by: by,
    })
    .eq("user_id", userId)
    .is("erased_at", null)
    .select(USER_KEY_COLUMNS);
  if (error) fail("erase the user's key", error);
  return ((data ?? [])[0] as UserKeyRow | undefined) ?? null;
}

/** Destroy a customer key: one transaction (destroy_customer_key). User keys erased. */
export async function destroyCustomerKeyRow(id: string, by: string | null): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("destroy_customer_key", {
    p_id: id,
    p_by: by as string,
  });
  if (error) fail("destroy the customer key", error);
  return Number(data ?? 0);
}

/** The users each group has, for the card and for re-wrapping on assignment. */
export async function groupMembers(groupIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (groupIds.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from("iam_group_members")
    .select("group_id, user_id")
    .in("group_id", groupIds);
  if (error) fail("read the groups' members", error);
  for (const r of data ?? []) {
    const list = out.get(r.group_id as string) ?? [];
    list.push(r.user_id as string);
    out.set(r.group_id as string, list);
  }
  return out;
}
