// R432: two key providers' data keys side by side. Found from the UI in
// R431: a data key made for Azure Key Vault retired the AWS KMS one, so going
// back to KMS_PROVIDER=aws would have refused to start with no data key. A
// data key now retires only its own provider's, the card's status names the
// configured provider's key and lists the others, and nothing about another
// provider's key is guessed. The table is a recording stand-in; the Azure
// provider a fake (its protocol is tests/unit/azureKeyVault.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  provider: string;
  key_ref: string;
  material: string;
  kid: string;
  created_at: string;
  retired_at: string | null;
};

const db = vi.hoisted(() => ({ rows: [] as Row[], n: 0 }));

vi.mock("@/integrations/supabase/client.server", () => {
  const table = {
    select: () => ({
      order: async () => ({
        data: [...db.rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
        error: null,
      }),
    }),
    update(patch: Partial<Row>) {
      const where: Array<(r: Row) => boolean> = [];
      const chain = {
        eq(column: keyof Row, value: unknown) {
          where.push((r) => r[column] === value);
          return chain;
        },
        async is(column: keyof Row, value: null) {
          where.push((r) => r[column] === value);
          for (const r of db.rows) if (where.every((w) => w(r))) Object.assign(r, patch);
          return { error: null };
        },
      };
      return chain;
    },
    insert(payload: Omit<Row, "id" | "created_at" | "retired_at">) {
      const row: Row = {
        id: `row-${++db.n}`,
        created_at: `2026-11-01T00:00:${String(db.n).padStart(2, "0")}Z`,
        retired_at: null,
        ...payload,
      };
      db.rows.push(row);
      return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
    },
  };
  return { supabaseAdmin: { from: () => table } };
});
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));

// A fake Azure Key Vault: "wraps" by prefixing the hex of the bytes.
vi.mock("@/utils/kms/azure.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/utils/kms/azure.server")>();
  return {
    ...real,
    createAzureKeyVaultProvider: (config: { keyRef: string }) => ({
      id: "azure",
      keyRef: config.keyRef,
      async wrapDek(dek: Uint8Array) {
        return {
          provider: "azure",
          keyRef: config.keyRef,
          material: `az:${Buffer.from(dek).toString("hex")}`,
        };
      },
      async unwrapDek(w: { material: string }) {
        return new Uint8Array(Buffer.from(w.material.slice(3), "hex"));
      },
      async probe() {
        return { ok: true, detail: "fake vault" };
      },
    }),
  };
});

import { createDataKey, kidOfDek, kmsStatus, providerFor } from "@/utils/kms/keyring.server";

const AZ = "https://agentswarms-kv.vault.azure.net/keys/credential-kek";
const ARN = "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const SECRET = "s".repeat(64);

async function awsRow(): Promise<Row> {
  const dek = new Uint8Array(32).fill(7);
  const row: Row = {
    id: "aws-1",
    provider: "aws",
    key_ref: ARN,
    material: "aws-wrapped",
    kid: await kidOfDek(dek),
    created_at: "2026-10-01T00:00:00Z",
    retired_at: null,
  };
  db.rows.push(row);
  return row;
}

const azure = () => providerFor({ provider: "azure", keyRef: AZ }, {});

beforeEach(() => {
  db.rows = [];
  db.n = 0;
});

describe("a data key retires only its own provider's", () => {
  it("keeps the AWS KMS data key active when one is made for Azure Key Vault, and back", async () => {
    const aws = await awsRow();
    const first = await createDataKey({ provider: azure(), createdBy: "admin" });
    expect(aws.retired_at).toBeNull();
    expect(first.retired_at).toBeNull();

    // A second Azure data key is a rotation within Azure: the first retires.
    const second = await createDataKey({ provider: azure(), createdBy: "admin" });
    expect(db.rows.find((r) => r.id === first.id)?.retired_at).not.toBeNull();
    expect(second.retired_at).toBeNull();
    expect(aws.retired_at).toBeNull();
  });
});

describe("the status the card reads", () => {
  it("names the configured provider's data key and lists the other providers' as kept", async () => {
    await awsRow();
    // An older AWS data key, retired by a rotation within AWS: not Azure's to count.
    db.rows.push({
      id: "aws-0",
      provider: "aws",
      key_ref: ARN,
      material: "aws-wrapped-0",
      kid: "0123456789ab",
      created_at: "2026-09-01T00:00:00Z",
      retired_at: "2026-10-01T00:00:00Z",
    });
    const old = await createDataKey({ provider: azure(), createdBy: "admin" });
    const cur = await createDataKey({ provider: azure(), createdBy: "admin" });

    // env in use, Azure being set up.
    const s = await kmsStatus({ PROVIDER_CREDS_SECRET: SECRET, KMS_KEY_REF: AZ });
    expect(s.provider).toBe("env");
    expect(s.external?.id).toBe("azure");
    expect(s.activeDek).toMatchObject({ kid: cur.kid, provider: "azure", keyRef: AZ });
    expect(s.retiredDeks).toBe(1); // Azure's own retired key, old
    expect(s.otherDeks).toEqual([
      { kid: db.rows[0].kid, provider: "aws", keyRef: ARN, createdAt: "2026-10-01T00:00:00Z" },
    ]);
    expect(s.otherDeks.map((d) => d.kid)).not.toContain(old.kid);
    expect(s.ready).toBe(true);
  });

  it("with Azure in use, its key is current and the AWS one is listed, not loaded", async () => {
    const aws = await awsRow();
    const cur = await createDataKey({ provider: azure(), createdBy: "admin" });
    // The AWS key made after it (someone went back and forth): the newest
    // active row is not Azure's, and Azure's is still the one described.
    aws.created_at = "2026-12-01T00:00:00Z";
    const s = await kmsStatus({
      PROVIDER_CREDS_SECRET: SECRET,
      KMS_PROVIDER: "azure",
      KMS_KEY_REF: AZ,
    });
    expect(s.ready).toBe(true);
    expect(s.activeDek?.kid).toBe(cur.kid);
    expect(s.otherDeks.map((d) => d.provider)).toEqual(["aws"]);
  });

  it("with no provider configured, there is no data key of its own and every active one is listed", async () => {
    await awsRow();
    await createDataKey({ provider: azure(), createdBy: "admin" });
    const s = await kmsStatus({ PROVIDER_CREDS_SECRET: SECRET });
    expect(s.external).toBeNull();
    expect(s.activeDek).toBeNull();
    expect(s.retiredDeks).toBe(0);
    expect(s.otherDeks.map((d) => d.provider).sort()).toEqual(["aws", "azure"]);
  });
});
