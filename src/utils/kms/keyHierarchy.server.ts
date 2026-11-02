// User keys and customer keys: the layer between the deployment's key and a
// user's stored values.
//
//   the deployment's key (the keyring's current key: from PROVIDER_CREDS_SECRET,
//   │                     or the data key a KMS unwraps)
//   │ wraps, here                              a customer's own KMS key
//   ├─────────────► customer key, held by       │ wraps, in that KMS
//   │               the app                     ▼
//   │                     │            customer key, in the customer's KMS
//   │                     └──────┬──────────────┘
//   │                            │ wraps, here (the user is a member)
//   ▼                            ▼
//   user key ◄───────────────────┘
//   │ AES-256-GCM
//   the user's stored values, each stamped with the user key's fingerprint
//
// Every user's values are under that user's own key. Erasing the key leaves
// the values unreadable; destroying a customer key, or the customer revoking
// it in their own KMS, leaves every member's unreadable, and nobody else's.
// Moving a user between customers re-wraps one key; no value is re-encrypted.
//
// Rules this module keeps:
// - Never make a key up in place of one that will not unwrap. A user key that
//   cannot be had is an error naming why (erased, destroyed, refused), and a
//   save fails rather than writing under a different key: a member's value
//   written under the deployment's key would be outside the customer's
//   control while looking fine.
// - The deployment's own keyring is untouched: values with its fingerprints
//   decrypt exactly as before, and the boot check does not depend on any
//   customer's KMS.
// - An unwrapped key is kept for DATA_KEY_CACHE_SECONDS, then read again, so a
//   key erased, destroyed or revoked elsewhere stops working within that long
//   in every process.
//
// Pure apart from what it is given: the store, the deployment's keyring and
// the customer key providers are arguments, so the tests drive every branch.
import type { KeyEntry, Keyring } from "./keyring.server";
import { base64ToBytes, bytesToBase64, type KeyProvider, type KmsProviderId } from "./types";

const ALGO = "AES-GCM";

// Domain separation, as the keyring's: a fingerprint reveals nothing about the
// key, and a user key's cannot collide with a customer key's by construction.
const KID_DOMAIN_USER = "agentswarms/creds-kid/v1|user|";
const KID_DOMAIN_CUSTOMER = "agentswarms/creds-kid/v1|customer|";

/** The default for DATA_KEY_CACHE_SECONDS. */
export const DEFAULT_DATA_KEY_CACHE_SECONDS = 300;

// A key that failed to unwrap is not asked for again for this long, so a
// customer KMS that is down is not called on every read. Capped by the cache
// setting: with caching off, every read asks again.
const FAILURE_BACKOFF_MS = 15_000;

export type UserKeyRow = {
  id: string;
  user_id: string;
  /** The user key's fingerprint; the values written under it carry it as `kid`. */
  kid: string;
  /** The user key, wrapped (AES-256-GCM) by its wrapper; null once erased. */
  material: string | null;
  iv: string | null;
  /** The customer key that wraps it; null when the deployment's key does. */
  customer_key_id: string | null;
  /** The wrapper's fingerprint: a deployment key's, or the customer key's. */
  wrapped_by: string;
  created_at: string;
  erased_at: string | null;
};

export type NewUserKey = Pick<
  UserKeyRow,
  "user_id" | "kid" | "material" | "iv" | "customer_key_id" | "wrapped_by"
>;

export type CustomerKeyProvider = "app" | Exclude<KmsProviderId, "env">;

export type CustomerKeyRow = {
  id: string;
  name: string;
  /** "app": wrapped by the deployment's key, here. Otherwise the customer's own key provider. */
  provider: CustomerKeyProvider;
  /** The customer's KMS key (an ARN, a key identifier…); null when held by the app. */
  key_ref: string | null;
  /** OCI Vault only: the customer vault's cryptographic endpoint. */
  endpoint: string | null;
  /** The customer key, wrapped; null once destroyed. */
  material: string | null;
  /** Held by the app: the AES-GCM nonce, and the deployment key that wrapped it. */
  iv: string | null;
  wrapped_by: string | null;
  kid: string;
  created_at: string;
  destroyed_at: string | null;
};

export type Membership = {
  customerKeyId: string;
  customerKeyName: string;
} & ({ via: "user" } | { via: "group"; groupId: string; groupName: string });

/** Where user keys and customer keys are kept. The database in the app; a Map in tests. */
export interface KeyStore {
  userKeyByKid(kid: string): Promise<UserKeyRow | null>;
  activeUserKey(userId: string): Promise<UserKeyRow | null>;
  /** "conflict" when the user already has an active key, or the fingerprint is taken. */
  insertUserKey(row: NewUserKey): Promise<UserKeyRow | "conflict">;
  /**
   * Re-wrap, compare-and-set on the current wrapper: false when another
   * process moved or erased the key first.
   */
  rewrapUserKey(
    id: string,
    from: { wrapped_by: string; customer_key_id: string | null },
    to: { material: string; iv: string; wrapped_by: string; customer_key_id: string | null },
  ): Promise<boolean>;
  customerKey(id: string): Promise<CustomerKeyRow | null>;
  memberships(userId: string): Promise<Membership[]>;
}

/** The tables are not there: the migration has not been applied. */
export class KeyStoreMissingError extends Error {}

/**
 * A value's key cannot be had, and why. `reason` lets a caller tell an
 * erasure (enter it again) from a refusal (the customer's KMS said no) from a
 * conflict (an admin must choose).
 */
export class DataKeyUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "erased" | "destroyed" | "refused" | "unheld" | "conflict" | "tampered",
  ) {
    super(message);
    this.name = "DataKeyUnavailableError";
  }
}

export type DataKey = { key: CryptoKey; kid: string };

export type HierarchyDeps = {
  store: KeyStore;
  /** The deployment's keyring: what wraps user keys and app-held customer keys. */
  instance: () => Promise<Keyring>;
  /** The KMS provider for a customer key held in the customer's own KMS. */
  customerProvider: (row: CustomerKeyRow) => KeyProvider;
  /** How long an unwrapped key is kept, in milliseconds. 0: not kept. */
  cacheMs: () => number;
  now?: () => number;
  random?: (n: number) => Uint8Array;
};

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function kidIn(domain: string, key: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(domain);
  const joined = new Uint8Array(prefix.length + key.length);
  joined.set(prefix, 0);
  joined.set(key, prefix.length);
  const h = await crypto.subtle.digest("SHA-256", buf(joined));
  return bytesToHex(new Uint8Array(h)).slice(0, 12);
}

/** A user key's fingerprint. */
export const kidOfUserKey = (key: Uint8Array) => kidIn(KID_DOMAIN_USER, key);
/** A customer key's fingerprint. */
export const kidOfCustomerKey = (key: Uint8Array) => kidIn(KID_DOMAIN_CUSTOMER, key);

// What a wrapped key is bound to. A user key's material moved onto another
// user's row, or a customer key's onto another customer's, does not unwrap.
const userAad = (userId: string, kid: string) =>
  new TextEncoder().encode(`agentswarms:user-key|v1|${userId}|${kid}`);
const customerAad = (id: string, kid: string) =>
  new TextEncoder().encode(`agentswarms:customer-key|v1|${id}|${kid}`);

export async function importDataKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buf(raw), { name: ALGO }, false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM wrap of a 32-byte key under a wrapping key, bound to `aad`. */
export async function wrapLocal(
  wrapper: CryptoKey,
  raw: Uint8Array,
  aad: Uint8Array,
  random: (n: number) => Uint8Array,
): Promise<{ material: string; iv: string }> {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt(
    { name: ALGO, iv: buf(iv), additionalData: buf(aad) },
    wrapper,
    buf(raw),
  );
  return { material: bytesToBase64(new Uint8Array(ct)), iv: bytesToBase64(iv) };
}

export async function unwrapLocal(
  wrapper: CryptoKey,
  material: string,
  iv: string,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: ALGO, iv: buf(base64ToBytes(iv)), additionalData: buf(aad) },
    wrapper,
    buf(base64ToBytes(material)),
  );
  return new Uint8Array(pt);
}

const when = (iso: string | null) => (iso ? iso.slice(0, 10) : "an earlier date");

/** The deployment key with this fingerprint, if this process holds it. */
function instanceEntry(ring: Keyring, kid: string): KeyEntry | undefined {
  return [ring.current, ...ring.previous].find((e) => e.kid === kid);
}

type Cached<T> = { at: number; value?: T; error?: unknown };

export type KeyHierarchy = ReturnType<typeof createKeyHierarchy>;

export function createKeyHierarchy(deps: HierarchyDeps) {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const userCache = new Map<string, Cached<DataKey>>();
  const customerCache = new Map<string, Cached<CryptoKey>>();
  const inflight = new Map<string, Promise<unknown>>();

  function fresh<T>(entry: Cached<T> | undefined): entry is Cached<T> {
    if (!entry) return false;
    const ttl = deps.cacheMs();
    if (ttl <= 0) return false;
    const age = now() - entry.at;
    return entry.error === undefined ? age < ttl : age < Math.min(ttl, FAILURE_BACKOFF_MS);
  }

  /** One unwrap at a time per key, shared by every reader waiting on it. */
  function once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = run().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function unwrapCustomerRaw(row: CustomerKeyRow, ring: Keyring): Promise<Uint8Array> {
    if (row.destroyed_at || !row.material) {
      throw new DataKeyUnavailableError(
        `The customer key "${row.name}" was destroyed on ${when(row.destroyed_at)}; what was stored under it cannot be read`,
        "destroyed",
      );
    }
    let raw: Uint8Array;
    if (row.provider === "app") {
      const wrapper = row.wrapped_by ? instanceEntry(ring, row.wrapped_by) : undefined;
      if (!wrapper || !row.iv) {
        throw new DataKeyUnavailableError(
          `The customer key "${row.name}" is wrapped by the deployment key ${row.wrapped_by ?? "(none)"}, which this server does not hold. Put that key back (PROVIDER_CREDS_SECRET_OLD, or its key provider) to read it.`,
          "unheld",
        );
      }
      try {
        raw = await unwrapLocal(wrapper.key, row.material, row.iv, customerAad(row.id, row.kid));
      } catch {
        throw new DataKeyUnavailableError(
          `The customer key "${row.name}" did not unwrap under the deployment key ${wrapper.kid}; its stored form was changed`,
          "tampered",
        );
      }
    } else {
      if (!row.key_ref) {
        throw new DataKeyUnavailableError(
          `The customer key "${row.name}" names no key in ${row.provider}`,
          "tampered",
        );
      }
      try {
        raw = await deps
          .customerProvider(row)
          .unwrapDek({ provider: row.provider, keyRef: row.key_ref, material: row.material });
      } catch (e) {
        throw new DataKeyUnavailableError(
          `The customer key "${row.name}" (${row.key_ref}) was refused by its key provider: ${(e as Error).message}`,
          "refused",
        );
      }
    }
    if ((await kidOfCustomerKey(raw)) !== row.kid) {
      raw.fill(0);
      throw new DataKeyUnavailableError(
        `The customer key "${row.name}" unwrapped to a key whose fingerprint is not ${row.kid}; refusing to use it`,
        "tampered",
      );
    }
    return raw;
  }

  /** A customer key, unwrapped: from the cache, or its row and its provider. */
  async function customerKey(id: string, ring: Keyring): Promise<CryptoKey> {
    const hit = customerCache.get(id);
    if (fresh(hit)) {
      if (hit.error !== undefined) throw hit.error;
      return hit.value as CryptoKey;
    }
    return once(`c:${id}`, async () => {
      const row = await deps.store.customerKey(id);
      if (!row) {
        throw new DataKeyUnavailableError(
          `A user key names customer key ${id}, which does not exist`,
          "tampered",
        );
      }
      try {
        const raw = await unwrapCustomerRaw(row, ring);
        const key = await importDataKey(raw);
        raw.fill(0);
        customerCache.set(id, { at: now(), value: key });
        return key;
      } catch (e) {
        customerCache.set(id, { at: now(), error: e });
        throw e;
      }
    });
  }

  /** The key a user key is wrapped by, as the row names it. */
  async function wrapperFor(row: UserKeyRow, ring: Keyring): Promise<CryptoKey> {
    if (row.customer_key_id) return customerKey(row.customer_key_id, ring);
    const entry = instanceEntry(ring, row.wrapped_by);
    if (!entry) {
      throw new DataKeyUnavailableError(
        `This user's key is wrapped by the deployment key ${row.wrapped_by}, which this server does not hold. Put that key back (PROVIDER_CREDS_SECRET_OLD, or its key provider) to read it.`,
        "unheld",
      );
    }
    return entry.key;
  }

  async function unwrapUserRaw(row: UserKeyRow, ring: Keyring): Promise<Uint8Array> {
    if (row.erased_at || !row.material || !row.iv) {
      throw new DataKeyUnavailableError(
        `This was stored under a user key that was erased on ${when(row.erased_at)}; enter it again`,
        "erased",
      );
    }
    const wrapper = await wrapperFor(row, ring);
    let raw: Uint8Array;
    try {
      raw = await unwrapLocal(wrapper, row.material, row.iv, userAad(row.user_id, row.kid));
    } catch {
      throw new DataKeyUnavailableError(
        `The user key ${row.kid} did not unwrap under its wrapping key; its stored form was changed`,
        "tampered",
      );
    }
    if ((await kidOfUserKey(raw)) !== row.kid) {
      raw.fill(0);
      throw new DataKeyUnavailableError(
        `The user key unwrapped to a key whose fingerprint is not ${row.kid}; refusing to use it`,
        "tampered",
      );
    }
    return raw;
  }

  async function userKeyFromRow(row: UserKeyRow, ring: Keyring): Promise<DataKey> {
    const hit = userCache.get(row.kid);
    if (fresh(hit) && hit.error === undefined) return hit.value as DataKey;
    const raw = await unwrapUserRaw(row, ring);
    const key = { key: await importDataKey(raw), kid: row.kid };
    raw.fill(0);
    userCache.set(row.kid, { at: now(), value: key });
    return key;
  }

  /** The customer key a user's values belong under, or null for the deployment's. */
  async function targetFor(userId: string): Promise<CustomerKeyRow | null> {
    const ms = await deps.store.memberships(userId);
    const direct = ms.find((m) => m.via === "user");
    let id: string | null = direct?.customerKeyId ?? null;
    if (!id) {
      const viaGroups = ms.filter((m) => m.via === "group");
      const ids = [...new Set(viaGroups.map((m) => m.customerKeyId))];
      if (ids.length > 1) {
        const which = viaGroups
          .map((m) => `"${m.customerKeyName}" (group ${m.via === "group" ? m.groupName : ""})`)
          .join(", ");
        throw new DataKeyUnavailableError(
          `This user is in groups assigned to different customer keys: ${which}. An admin can assign the user directly to one of them (Admin → IAM → Settings → Customer keys); until then nothing new is stored for them.`,
          "conflict",
        );
      }
      id = ids[0] ?? null;
    }
    if (!id) return null;
    const row = await deps.store.customerKey(id);
    if (!row) {
      throw new DataKeyUnavailableError(`The customer key ${id} does not exist`, "tampered");
    }
    if (row.destroyed_at) {
      throw new DataKeyUnavailableError(
        `This user is assigned to the customer key "${row.name}", which was destroyed on ${when(row.destroyed_at)}; an admin must remove the assignment`,
        "destroyed",
      );
    }
    return row;
  }

  async function wrapUserRaw(
    raw: Uint8Array,
    userId: string,
    kid: string,
    target: CustomerKeyRow | null,
    ring: Keyring,
  ): Promise<{ material: string; iv: string; wrapped_by: string; customer_key_id: string | null }> {
    const wrapper = target ? await customerKey(target.id, ring) : ring.current.key;
    const w = await wrapLocal(wrapper, raw, userAad(userId, kid), random);
    return {
      ...w,
      wrapped_by: target ? target.kid : ring.current.kid,
      customer_key_id: target?.id ?? null,
    };
  }

  async function createUserKey(
    userId: string,
    target: CustomerKeyRow | null,
    ring: Keyring,
  ): Promise<DataKey | "conflict"> {
    let raw = random(32);
    let kid = await kidOfUserKey(raw);
    // A fingerprint the deployment's keyring already uses would send a value
    // to the wrong key first; draw again (2^-48 per key, but free to rule out).
    while (instanceEntry(ring, kid)) {
      raw = random(32);
      kid = await kidOfUserKey(raw);
    }
    const wrapped = await wrapUserRaw(raw, userId, kid, target, ring);
    const res = await deps.store.insertUserKey({ user_id: userId, kid, ...wrapped });
    if (res === "conflict") {
      raw.fill(0);
      return "conflict";
    }
    const key = { key: await importDataKey(raw), kid };
    raw.fill(0);
    userCache.set(kid, { at: now(), value: key });
    return key;
  }

  /**
   * The key a value of `userId` is written with: that user's key, made when
   * there is none, and moved first when it is not under the key the user's
   * membership says (a customer joined or left, or the deployment's key was
   * rotated). Never a different key when that fails.
   */
  async function writeKey(userId: string): Promise<DataKey> {
    const target = await targetFor(userId);
    const ring = await deps.instance();
    const wantCustomer = target?.id ?? null;
    const wantWrapper = target ? target.kid : ring.current.kid;
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await deps.store.activeUserKey(userId);
      if (!row) {
        const made = await createUserKey(userId, target, ring);
        if (made === "conflict") continue;
        return made;
      }
      if (row.customer_key_id === wantCustomer && row.wrapped_by === wantWrapper) {
        return userKeyFromRow(row, ring);
      }
      const raw = await unwrapUserRaw(row, ring);
      try {
        const to = await wrapUserRaw(raw, userId, row.kid, target, ring);
        const moved = await deps.store.rewrapUserKey(
          row.id,
          { wrapped_by: row.wrapped_by, customer_key_id: row.customer_key_id },
          to,
        );
        if (!moved) continue;
        const key = { key: await importDataKey(raw), kid: row.kid };
        userCache.set(row.kid, { at: now(), value: key });
        return key;
      } finally {
        raw.fill(0);
      }
    }
    throw new Error("This user's key changed three times during one save; try again");
  }

  /**
   * The user key with this fingerprint, unwrapped; null when no user key has
   * it (the value is on a deployment key, or on none this server knows).
   */
  async function readKey(kid: string): Promise<DataKey | null> {
    const hit = userCache.get(kid);
    if (fresh(hit) && hit.error === undefined) return hit.value as DataKey;
    return once(`u:${kid}`, async () => {
      const row = await deps.store.userKeyByKid(kid);
      if (!row) return null;
      return userKeyFromRow(row, await deps.instance());
    });
  }

  /**
   * Re-wrap one user key where its membership or the deployment's key says it
   * should be. "unchanged", "moved", or "none" when the user has no key yet.
   */
  async function reconcile(userId: string): Promise<"none" | "unchanged" | "moved"> {
    const before = await deps.store.activeUserKey(userId);
    if (!before) return "none";
    await writeKey(userId);
    const after = await deps.store.activeUserKey(userId);
    return after &&
      (after.wrapped_by !== before.wrapped_by || after.customer_key_id !== before.customer_key_id)
      ? "moved"
      : "unchanged";
  }

  /**
   * Make a customer key's material: 32 random bytes (or the provider's own,
   * AWS KMS's GenerateDataKey), wrapped by the app's current key or by the
   * customer's KMS, and proven to unwrap to the same bytes before anything is
   * stored. `id` is the row's id, chosen first: an app-held key is bound to it.
   */
  async function makeCustomerKeyMaterial(args: {
    id: string;
    name: string;
    provider: CustomerKeyProvider;
    keyRef: string | null;
    endpoint: string | null;
  }): Promise<Pick<CustomerKeyRow, "material" | "iv" | "wrapped_by" | "kid">> {
    const ring = await deps.instance();
    if (args.provider === "app") {
      const raw = random(32);
      try {
        const kid = await kidOfCustomerKey(raw);
        const w = await wrapLocal(ring.current.key, raw, customerAad(args.id, kid), random);
        const back = await unwrapLocal(
          ring.current.key,
          w.material,
          w.iv,
          customerAad(args.id, kid),
        );
        if (back.length !== 32 || back.some((b, i) => b !== raw[i])) {
          throw new Error("The customer key did not unwrap to the same bytes; nothing was stored");
        }
        return { material: w.material, iv: w.iv, wrapped_by: ring.current.kid, kid };
      } finally {
        raw.fill(0);
      }
    }
    if (!args.keyRef) throw new Error("A customer key in a key provider needs the key's reference");
    const draft: CustomerKeyRow = {
      id: args.id,
      name: args.name,
      provider: args.provider,
      key_ref: args.keyRef,
      endpoint: args.endpoint,
      material: null,
      iv: null,
      wrapped_by: null,
      kid: "",
      created_at: new Date(now()).toISOString(),
      destroyed_at: null,
    };
    const provider = deps.customerProvider(draft);
    const { dek, wrapped } = provider.generateDek
      ? await provider.generateDek()
      : await (async () => {
          const dek = random(32);
          return { dek, wrapped: await provider.wrapDek(dek) };
        })();
    try {
      if (dek.length !== 32) {
        throw new Error(`${provider.id} gave a ${dek.length}-byte key, not 32; nothing was stored`);
      }
      const back = await provider.unwrapDek(wrapped);
      if (back.length !== 32 || back.some((b, i) => b !== dek[i])) {
        throw new Error(
          `${provider.id} wrapped the customer key but did not unwrap it to the same bytes; nothing was stored`,
        );
      }
      return {
        material: wrapped.material,
        iv: null,
        wrapped_by: null,
        kid: await kidOfCustomerKey(dek),
      };
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Unwrap a customer key now, past the cache: what "Check" on the card does.
   * Throws the DataKeyUnavailableError a read would meet.
   */
  async function checkCustomerKey(row: CustomerKeyRow): Promise<void> {
    customerCache.delete(row.id);
    const raw = await unwrapCustomerRaw(row, await deps.instance());
    const key = await importDataKey(raw);
    raw.fill(0);
    customerCache.set(row.id, { at: now(), value: key });
  }

  /**
   * An app-held customer key wrapped by an older deployment key, wrapped
   * again by the current one (the sweep, after a rotation). The new material
   * is returned for the caller to store; null when it is already current.
   */
  async function rewrapAppCustomerKey(
    row: CustomerKeyRow,
  ): Promise<{ material: string; iv: string; wrapped_by: string } | null> {
    const ring = await deps.instance();
    if (row.provider !== "app" || row.destroyed_at || row.wrapped_by === ring.current.kid) {
      return null;
    }
    const raw = await unwrapCustomerRaw(row, ring);
    try {
      const w = await wrapLocal(ring.current.key, raw, customerAad(row.id, row.kid), random);
      return { ...w, wrapped_by: ring.current.kid };
    } finally {
      raw.fill(0);
    }
  }

  return {
    writeKey,
    readKey,
    reconcile,
    makeCustomerKeyMaterial,
    checkCustomerKey,
    rewrapAppCustomerKey,
    /** Forget one customer key and every user key under it (destroyed, members moved). */
    forgetCustomer(id: string) {
      customerCache.delete(id);
      userCache.clear();
    },
    /** Forget one user key (erased). */
    forgetUserKey(kid: string) {
      userCache.delete(kid);
    },
    /** Forget everything: the deployment's keyring changed, or a test. */
    forgetAll() {
      userCache.clear();
      customerCache.clear();
    },
  };
}

/** DATA_KEY_CACHE_SECONDS, in milliseconds. A value that is not a number is the default. */
export function dataKeyCacheMs(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.DATA_KEY_CACHE_SECONDS ?? "").trim();
  if (!raw) return DEFAULT_DATA_KEY_CACHE_SECONDS * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DATA_KEY_CACHE_SECONDS * 1000;
  return Math.floor(n * 1000);
}
