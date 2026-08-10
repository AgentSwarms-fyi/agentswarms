// Superadmin-gated server functions for the credential-key rotation UI.
//
// The heavy lifting lives in keyRotation.server (blob-agnostic sweep) and
// crypto.server (the keyring). This file only adds the authorization gate, the
// audit trail, and a shape the admin page can render.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSuperadmin } from "@/utils/iam.server";
import { auditEvent } from "@/utils/audit.server";
import { keyringFingerprints } from "./crypto.server";
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
};
export type KeyRotationError = { ok: false; error: string };

/** Read-only: the keyring fingerprints and per-table migration state. */
export const getKeyEncryptionStatus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<KeyStatusPayload | KeyRotationError> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return { ok: false, error: guard.error };
    try {
      const [fp, tables] = await Promise.all([keyringFingerprints(), keyEncryptionStatus()]);
      const totals = tables.reduce(
        (a, t) => ({
          blobs: a.blobs + t.blobs,
          onCurrent: a.onCurrent + t.onCurrent,
          onOther: a.onOther + t.onOther,
          legacy: a.legacy + t.legacy,
        }),
        { blobs: 0, onCurrent: 0, onOther: 0, legacy: 0 },
      );
      return { ok: true, current: fp.current, previous: fp.previous, tables, totals };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Status failed" };
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
