// R432: the counts the credential key card shows, per table and in total.
// A value on a key this server does not hold — another key provider's data
// key after a switch, or a secret dropped from PROVIDER_CREDS_SECRET_OLD —
// was counted as "on an older key" under "These still decrypt". It is
// counted apart now, with the key it is on, so the card can name it.
import { afterEach, describe, expect, it, vi } from "vitest";

const tables = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]> }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (name: string) => ({
      select: async () =>
        name === "kb_sources"
          ? { data: null, error: { message: "permission denied" } }
          : { data: tables.rows[name] ?? [], error: null },
    }),
  },
}));

import type { Keyring } from "@/utils/kms/keyring.server";
import { __setKeyringLoaderForTests } from "@/utils/providers/crypto.server";
import { keyEncryptionStatus, statusTotals } from "@/utils/providers/keyRotation.server";

const blob = (kid?: string) => ({ ciphertext: "c", iv: "i", ...(kid ? { kid } : {}) });

afterEach(() => {
  __setKeyringLoaderForTests(null);
  tables.rows = {};
});

describe("the credential key counts", () => {
  it("count a value per key: current, held, not held (with its key), unstamped", async () => {
    __setKeyringLoaderForTests(
      async () =>
        ({
          config: { provider: "env" },
          current: { kid: "cur000000000", source: "env" },
          previous: [{ kid: "old000000000", source: "env-previous" }],
          activeDek: null,
        }) as unknown as Keyring,
    );
    tables.rows = {
      user_secrets: [
        { id: "1", value: blob("cur000000000") },
        { id: "2", value: blob("aws931a2e06b") },
      ],
      integrations: [
        {
          id: "3",
          config: { api_key_enc: blob("old000000000"), nested: [blob("aws931a2e06b"), blob()] },
        },
        { id: "4", config: { token: blob("gone00000000") } },
      ],
    };
    const status = await keyEncryptionStatus();
    const by = Object.fromEntries(status.map((s) => [s.table, s]));
    expect(by.user_secrets).toMatchObject({
      rows: 2,
      blobs: 2,
      onCurrent: 1,
      onOther: 0,
      unreadable: 1,
      unreadableKids: ["aws931a2e06b"],
      legacy: 0,
    });
    expect(by.integrations).toMatchObject({
      rows: 2,
      blobs: 4,
      onCurrent: 0,
      onOther: 1,
      unreadable: 2,
      legacy: 1,
    });
    expect([...by.integrations.unreadableKids].sort()).toEqual(["aws931a2e06b", "gone00000000"]);
    // A table that cannot be read says so, and counts nothing.
    expect(by.kb_sources).toMatchObject({ blobs: 0, unreadable: 0, error: "permission denied" });

    expect(statusTotals(status)).toEqual({
      blobs: 6,
      onCurrent: 1,
      onDeploymentKey: 0,
      onOther: 1,
      unreadable: 3,
      unreadableKids: ["aws931a2e06b", "gone00000000"],
      legacy: 1,
    });
  });
});
