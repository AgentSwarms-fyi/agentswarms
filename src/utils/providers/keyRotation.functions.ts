// Superadmin-gated server functions for the credential-key rotation UI.
//
// The heavy lifting lives in keyRotation.server (blob-agnostic sweep) and
// crypto.server (the keyring). This file only adds the authorization gate, the
// audit trail, and a shape the admin page can render.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSuperadmin } from "@/utils/iam.server";
import { auditEvent } from "@/utils/audit.server";
import {
  configuredExternalProvider,
  createDataKey,
  kmsStatus,
  type KmsStatus,
} from "@/utils/kms/keyring.server";
import { keyringFingerprints, resetKeyringCache } from "./crypto.server";
import {
  keyEncryptionStatus,
  reEncryptAllToCurrentKey,
  type TableStatus,
  type TableRotation,
} from "./keyRotation.server";

export type KeyStatusPayload = {
  ok: true;
  current: string;
  previous: string[];
  tables: TableStatus[];
  totals: { blobs: number; onCurrent: number; onOther: number; legacy: number };
  /** Which key provider is in use, which one is configured, and the data key. */
  kms: KmsStatus;
};
export type KeyRotationError = { ok: false; error: string };

/** Read-only: the keyring fingerprints and per-table migration state. */
export const getKeyEncryptionStatus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<KeyStatusPayload | KeyRotationError> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return { ok: false, error: guard.error };
    try {
      const [fp, tables, kms] = await Promise.all([
        keyringFingerprints(),
        keyEncryptionStatus(),
        kmsStatus(),
      ]);
      const totals = tables.reduce(
        (a, t) => ({
          blobs: a.blobs + t.blobs,
          onCurrent: a.onCurrent + t.onCurrent,
          onOther: a.onOther + t.onOther,
          legacy: a.legacy + t.legacy,
        }),
        { blobs: 0, onCurrent: 0, onOther: 0, legacy: 0 },
      );
      return { ok: true, current: fp.current, previous: fp.previous, tables, totals, kms };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Status failed" };
    }
  });

export type CreateDataKeyPayload = { ok: true; kid: string; provider: string; keyRef: string };

/**
 * Create (or rotate) the data key under the external provider whose variables
 * are set. Nothing is re-encrypted here and the current key does not change:
 * the switch happens when KMS_PROVIDER names the provider and the process
 * restarts, then the sweep below moves the rows. Superadmin only, audited.
 */
export const createKmsDataKey = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<CreateDataKeyPayload | KeyRotationError> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return { ok: false, error: guard.error };
    try {
      const provider = configuredExternalProvider();
      if (!provider) {
        return {
          ok: false,
          error:
            "No external key provider is configured: set KMS_KEY_REF and the provider's variables (for Vault: VAULT_ADDR and a token or Kubernetes role), restart, then try again.",
        };
      }
      const row = await createDataKey({ provider, createdBy: guard.userId });
      resetKeyringCache();
      auditEvent({
        userId: guard.userId,
        actorEmail: guard.email,
        action: "security.kms.data_key.create",
        resourceType: "security",
        resourceId: row.id,
        detail: { provider: row.provider, key_ref: row.key_ref, kid: row.kid },
      });
      return { ok: true, kid: row.kid, provider: row.provider, keyRef: row.key_ref };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Could not create the data key" };
    }
  });

export type RotatePayload = {
  ok: true;
  tables: TableRotation[];
  totalMigrated: number;
  totalFailed: number;
};

/** Re-encrypt every stored credential onto the current key. Idempotent. */
export const reEncryptCredentials = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<RotatePayload | KeyRotationError> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return { ok: false, error: guard.error };
    try {
      const result = await reEncryptAllToCurrentKey();
      auditEvent({
        userId: guard.userId,
        action: "security.reencrypt_credentials",
        resourceType: "security",
        detail: {
          migrated: result.totalMigrated,
          failed: result.totalFailed,
          tables: result.tables
            .filter((t) => t.migrated > 0 || t.failed > 0 || t.error)
            .map((t) => ({
              table: t.table,
              migrated: t.migrated,
              failed: t.failed,
              error: t.error,
            })),
        },
      });
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Re-encryption failed" };
    }
  });
