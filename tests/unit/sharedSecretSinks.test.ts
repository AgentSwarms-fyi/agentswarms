// Each place a {{secret:NAME}} resolves names where the value goes, or nothing
// (R419; VA-2026-10-25-29, -30 and -45).
//
// The resolver's rule (secretsOwnedOnly.test.ts): a secret shared with you
// resolves only toward hosts its owner allowed, and only where the call names
// those hosts. This file holds the sinks to it — the swarm HTTP node and the
// catalog's stored sources run for real against the real resolver over a
// stand-in secrets table; the rest are pinned where they are written.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";

type SecretRow = {
  id: string;
  name: string;
  user_id: string;
  value: { ciphertext: string; iv: string };
  allowed_hosts?: string[];
};
let secrets: SecretRow[] = [];
let granted = new Set<string>();
// What decryptJson returns per ciphertext: secret values and stored configs.
const plaintext = new Map<string, unknown>();

vi.mock("@/integrations/supabase/client.server", () => {
  const builder = () => {
    let name: string | undefined;
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: (col: string, v: string) => {
        if (col === "name") name = v;
        return b;
      },
      then: (resolve: (v: { data: SecretRow[]; error: null }) => void) =>
        resolve({ data: secrets.filter((s) => s.name === name), error: null }),
    });
    return b;
  };
  return {
    supabaseAdmin: {
      from: () => builder(),
      rpc: async (_n: string, args: { rid: string }) => ({ data: granted.has(args.rid) }),
    },
  };
});
vi.mock("@/utils/providers/crypto.server", () => ({
  decryptJson: async (ct: string) => {
    if (!plaintext.has(ct)) throw new Error(`no plaintext for ${ct}`);
    return plaintext.get(ct);
  },
  encryptJson: async () => ({ ciphertext: "ct", iv: "iv" }),
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));

const { runHttpNodeCore } = await import("@/utils/swarmNodes.server");
const { loadStorageConfig, loadIcebergConfig } = await import("@/utils/catalog/crawler.server");

/** A secret OTHER owns and shares with OWNER, allowed toward `hosts`. */
function shared(name: string, value: string, hosts: string[]) {
  const ct = `ct-${name}`;
  plaintext.set(ct, value);
  secrets.push({
    id: `id-${name}`,
    name,
    user_id: OTHER,
    value: { ciphertext: ct, iv: "iv" },
    allowed_hosts: hosts,
  });
  granted.add(`id-${name}`);
}
function owned(name: string, value: string) {
  const ct = `ct-own-${name}`;
  plaintext.set(ct, value);
  secrets.push({ id: `own-${name}`, name, user_id: OWNER, value: { ciphertext: ct, iv: "iv" } });
}
/** A stored catalog source whose decrypted config is `cfg`. */
function source(cfg: unknown, extra: Record<string, unknown> = {}) {
  const ct = `src-${plaintext.size}`;
  plaintext.set(ct, cfg);
  return { name: "src", credentials: { ciphertext: ct, iv: "iv" }, ...extra } as never;
}

beforeEach(() => {
  secrets = [];
  granted = new Set();
  plaintext.clear();
});

// ── The swarm HTTP node ─────────────────────────────────────────────────────
let srv: Server;
let base = "";
const seen: IncomingMessage["headers"][] = [];
beforeAll(async () => {
  srv = createServer((req, res) => {
    seen.push(req.headers);
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv?.close());

describe("the swarm HTTP node (VA-2026-10-25-30)", () => {
  it("sends a shared secret in a header to a host its owner allowed", async () => {
    shared("API_KEY", "SHARED-VALUE", ["127.0.0.1"]);
    seen.length = 0;
    const r = await runHttpNodeCore(OWNER, {
      method: "GET",
      url: `${base}/ok`,
      headers: [{ key: "Authorization", value: "Bearer {{secret:API_KEY}}" }],
    });
    expect(r.ok).toBe(true);
    expect(seen.at(-1)?.authorization).toBe("Bearer SHARED-VALUE");
  });

  it("refuses it toward a host its owner did not allow, before any request", async () => {
    shared("API_KEY", "SHARED-VALUE", ["api.example.com"]);
    seen.length = 0;
    const r = await runHttpNodeCore(OWNER, {
      method: "GET",
      url: `${base}/collect`,
      headers: [{ key: "Authorization", value: "Bearer {{secret:API_KEY}}" }],
    });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/not allowed it to be sent to 127\.0\.0\.1/);
    expect(seen).toHaveLength(0);
  });

  it("never puts a shared secret in the URL or the body, even toward an allowed host", async () => {
    shared("API_KEY", "SHARED-VALUE", ["127.0.0.1"]);
    seen.length = 0;
    const inUrl = await runHttpNodeCore(OWNER, {
      method: "GET",
      url: `${base}/?k={{secret:API_KEY}}`,
    });
    expect(!inUrl.ok && inUrl.error).toMatch(/must be one you own/);
    const inBody = await runHttpNodeCore(OWNER, {
      method: "POST",
      url: `${base}/echo`,
      body: '{"k":"{{secret:API_KEY}}"}',
    });
    expect(!inBody.ok && inBody.error).toMatch(/must be one you own/);
    expect(seen).toHaveLength(0);
  });

  it("uses a secret the builder owns anywhere, URL and body included", async () => {
    owned("MINE", "OWN-VALUE");
    const r = await runHttpNodeCore(OWNER, { method: "GET", url: `${base}/?k={{secret:MINE}}` });
    expect(r.ok && JSON.parse(r.body).path).toBe("/?k=OWN-VALUE");
  });
});

// ── Catalog sources ─────────────────────────────────────────────────────────
describe("a stored object-store source (VA-2026-10-25-30)", () => {
  const minio = (over: Record<string, unknown> = {}) => ({
    provider: "minio",
    endpoint: "https://store.example.com",
    region: "us-east-1",
    bucket: "lake",
    access_key_id: "AKIA",
    secret_access_key: "{{secret:S3_KEY}}",
    ...over,
  });

  it("resolves a shared key toward the endpoint its owner allowed", async () => {
    shared("S3_KEY", "SHARED-S3", ["store.example.com"]);
    const cfg = await loadStorageConfig(OWNER, source(minio()));
    expect(cfg.secret_access_key).toBe("SHARED-S3");
  });

  it("checks the host the requests really go to: a virtual-hosted bucket is a name under it", async () => {
    shared("S3_KEY", "SHARED-S3", ["store.example.com"]);
    await expect(loadStorageConfig(OWNER, source(minio({ path_style: false })))).rejects.toThrow(
      /lake\.store\.example\.com/,
    );
    secrets = [];
    shared("S3_KEY", "SHARED-S3", ["*.amazonaws.com"]);
    const aws = await loadStorageConfig(
      OWNER,
      source(minio({ provider: "aws", endpoint: "", region: "eu-west-1" })),
    );
    expect(aws.secret_access_key).toBe("SHARED-S3");
  });

  it("refuses the key toward an endpoint the owner did not allow", async () => {
    shared("S3_KEY", "SHARED-S3", ["store.example.com"]);
    await expect(
      loadStorageConfig(OWNER, source(minio({ endpoint: "https://attacker.test" }))),
    ).rejects.toThrow(/attacker\.test/);
  });

  it("never lets a shared secret choose the endpoint, or Azure's account (the host)", async () => {
    shared("S3_KEY", "SHARED-S3", ["store.example.com", "*.blob.core.windows.net"]);
    await expect(
      loadStorageConfig(OWNER, source(minio({ endpoint: "https://{{secret:S3_KEY}}.test" }))),
    ).rejects.toThrow(/must be one you own/);
    await expect(
      loadStorageConfig(
        OWNER,
        source(
          minio({
            provider: "azure",
            endpoint: "",
            access_key_id: "{{secret:S3_KEY}}",
            secret_access_key: "k",
          }),
        ),
      ),
    ).rejects.toThrow(/must be one you own/);
    // Even with an endpoint override, where the host is known and allowed:
    // the account stays out of a shared secret's reach.
    await expect(
      loadStorageConfig(
        OWNER,
        source(
          minio({
            provider: "azure",
            endpoint: "https://store.example.com",
            access_key_id: "{{secret:S3_KEY}}",
            secret_access_key: "k",
          }),
        ),
      ),
    ).rejects.toThrow(/must be one you own/);
  });

  it("into a pipeline's environment, resolves only what the owner owns", async () => {
    shared("S3_KEY", "SHARED-S3", ["store.example.com"]);
    await expect(loadStorageConfig(OWNER, source(minio()), { into: "sandbox" })).rejects.toThrow(
      /must be one you own/,
    );
    secrets = [];
    owned("S3_KEY", "OWN-S3");
    const cfg = await loadStorageConfig(OWNER, source(minio()), { into: "sandbox" });
    expect(cfg.secret_access_key).toBe("OWN-S3");
  });
});

describe("a stored Iceberg REST source", () => {
  it("resolves its token reference as the owner toward the catalog's host (it never did)", async () => {
    // Before R419 the reference was stored as typed and sent as the bearer.
    shared("ICE_TOKEN", "SHARED-TOKEN", ["catalog.example.com"]);
    const row = source(
      { token: "{{secret:ICE_TOKEN}}" },
      { user_id: OWNER, config: { uri: "https://catalog.example.com/api" } },
    );
    const cfg = await loadIcebergConfig(row);
    expect(cfg.token).toBe("SHARED-TOKEN");
    const elsewhere = source(
      { token: "{{secret:ICE_TOKEN}}" },
      { user_id: OWNER, config: { uri: "https://attacker.test/api" } },
    );
    await expect(loadIcebergConfig(elsewhere)).rejects.toThrow(/attacker\.test/);
  });
});

// ── Where the rest are written ───────────────────────────────────────────────
const rd = (p: string) => readFileSync(p, "utf8");

describe("the sandboxes name no destination (VA-2026-10-25-29, -45)", () => {
  const etl = rd("src/utils/etl/service.server.ts");

  it("nothing in the ETL run's environment can take a shared secret", () => {
    // Every value there is readable by the pipeline's own code.
    expect(etl).not.toMatch(/sendTo/);
    expect(etl).toMatch(/loadStorageConfig\(pipeline\.user_id, src, \{ into: "sandbox" \}\)/);
  });

  it("a pipeline refuses a connection shared with its owner, before its URL is built", () => {
    const db = etl.slice(
      etl.indexOf("const databaseEnv = async"),
      etl.indexOf("const graph = normalizeGraph"),
    );
    const refuse = db.indexOf("if (conn.shared) {");
    expect(refuse).toBeGreaterThan(-1);
    expect(db.slice(refuse, refuse + 300)).toMatch(/throw new Error/);
    expect(refuse).toBeLessThan(db.indexOf("env[`${stem}_DEST_CREDS`]"));
    expect(refuse).toBeLessThan(db.indexOf("env[`${stem}_URL`]"));
  });

  it("the MCP sandbox names none either", () => {
    expect(rd("src/routes/api/notebook.runtime.source.ts")).not.toMatch(/sendTo/);
  });
});

describe("the destination-naming sinks", () => {
  it("the HTTP node: header values toward the URL; URL and body owner-only", () => {
    const http = rd("src/utils/swarmNodes.server.ts");
    expect(http).toMatch(/url = await resolveSecretRefs\(userId, p\.url\);/);
    expect(http).toMatch(/resolveSecretRefs\(userId, h\.value, \{ sendTo: \[url\] \}\)/);
    expect(http).toMatch(
      /body = p\.body \? await resolveSecretRefs\(userId, p\.body\) : undefined;/,
    );
  });

  it("catalog create: the Iceberg token toward its URI, bucket keys toward the store", () => {
    const cat = rd("src/utils/catalog.functions.ts");
    expect(cat).toMatch(/\["token"\],\s*\(c\) => \[c\.uri\],/);
    expect(cat).toMatch(/objectStoreCredentialFields\(cfg\),\s*objectStoreHosts,/);
    expect(cat).not.toMatch(/resolveSecretRefsInObject/);
  });

  it("lakehouse Iceberg catalogs: the token toward the catalog, client credentials toward the token server", () => {
    const ice = rd("src/utils/lakehouse/iceberg.server.ts");
    expect(ice).toMatch(
      /const tokenServer = cfg\.oauth2_server_uri\?\.trim\(\) \|\| cfg\.endpoint;/,
    );
    expect(ice).toMatch(/sendTo: \[key === "token" \? cfg\.endpoint : tokenServer\]/);
  });

  it("only these files name a destination: a new one is a decision, not an accident", () => {
    const out = execFileSync(
      "git",
      ["grep", "--untracked", "-l", "-E", "sendTo|resolveCredentialConfig", "--", "src"],
      { encoding: "utf8" },
    );
    const files = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
    expect(files).toEqual(
      [
        "src/routes/api/a2a.ts",
        "src/routes/api/chat.ts",
        "src/utils/catalog.functions.ts",
        "src/utils/catalog/crawler.server.ts",
        "src/utils/integrations.functions.ts",
        "src/utils/integrations/health.server.ts",
        "src/utils/lakehouse/iceberg.server.ts",
        "src/utils/providers/credentials.server.ts",
        "src/utils/providers/integrationConfig.server.ts",
        "src/utils/providers/integrationHosts.ts",
        "src/utils/secrets.server.ts",
        "src/utils/swarmNodes.server.ts",
        "src/utils/tools/registry.server.ts",
        "src/utils/warehouse/connections.server.ts",
      ].sort(),
    );
  });
});

describe("the owner sets the list, and the database holds it to that (migration 20261102000000)", () => {
  const sql = rd("supabase/migrations/20261102000000_secret_allowed_hosts.sql");
  const fns = rd("src/utils/secrets.functions.ts");

  it("adds a bounded, non-null text[] column, defaulting to nobody", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS allowed_hosts text\[\] NOT NULL DEFAULT '\{\}'/);
    expect(sql).toMatch(/cardinality\(allowed_hosts\) <= 50/);
  });

  it("refuses to apply if any policy that can write the row is not owner-only", () => {
    expect(sql).toMatch(/cmd IN \('ALL', 'UPDATE', 'INSERT'\)/);
    expect(sql).toMatch(
      /RAISE EXCEPTION 'secret allowed hosts: policy % on user_secrets is not owner-only'/,
    );
  });

  it("create and update validate the list with the editor's own rules", () => {
    expect(fns.match(/allowed_hosts: AllowedHostsSchema,/g)).toHaveLength(2);
    expect(fns).toMatch(/const parsed = parseAllowedHosts\(v\);/);
    expect(fns).toMatch(
      /if \(data\.allowed_hosts !== undefined\) patch\.allowed_hosts = data\.allowed_hosts;/,
    );
  });
});
