// Model providers, integrations and warehouse connections name where their
// credentials go (R420, VA-2026-10-25-30).
//
// R419 made a secret shared with you resolve only toward hosts its owner
// allowed, and only where the call names them; providers, connections and
// integrations named none, so they took owned secrets only. Here each names
// the hosts its requests really reach, built the way the transports and
// drivers build them. A provider key and a Postgres password run for real
// below, through the real resolver over a stand-in table.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FIRECRAWL_API,
  integrationHosts,
  PROVIDER_DEFAULT_BASE_URL,
} from "@/utils/providers/integrationHosts";
import { warehouseCredentialFields, warehouseHosts } from "@/utils/warehouse/destinations";
import type { WarehouseConfig } from "@/utils/warehouse/types";
import { hostOf } from "@/lib/secretHosts";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let granted = new Set<string>();
const plaintext = new Map<string, unknown>();

vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    const rows = () =>
      (tables[table] ?? []).filter((r) => filters.every(([c, v]) => c === "*" || r[c] === v));
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      order: () => b,
      limit: () => b,
      in: () => b,
      or: () => b,
      eq: (c: string, v: unknown) => {
        filters.push([c, v]);
        return b;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => void) =>
        resolve({ data: rows(), error: null }),
    });
    return b;
  };
  return {
    supabaseAdmin: {
      from,
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

const { resolveOpenAICompatTransport } = await import("@/utils/providers/credentials.server");
const { loadWarehouseConnection } = await import("@/utils/warehouse/connections.server");

/** A secret OTHER owns and shares with OWNER, allowed toward `hosts`. */
function shared(name: string, value: string, hosts: string[]) {
  plaintext.set(`ct-${name}`, value);
  (tables.user_secrets ??= []).push({
    id: `id-${name}`,
    name,
    user_id: OTHER,
    value: { ciphertext: `ct-${name}`, iv: "iv" },
    allowed_hosts: hosts,
  });
  granted.add(`id-${name}`);
}

beforeEach(() => {
  tables = {};
  granted = new Set();
  plaintext.clear();
});

// ── Integrations ─────────────────────────────────────────────────────────────
describe("where an integration's credential goes", () => {
  it("a provider's key: its base URL when set, else its own API", () => {
    expect(integrationHosts("llm_provider", "openai")({})).toEqual(["https://api.openai.com/v1"]);
    expect(
      integrationHosts("llm_provider", "openai")({ base_url: "https://proxy.corp.test/v1" }),
    ).toEqual(["https://proxy.corp.test/v1"]);
    expect(integrationHosts("llm_provider", "ollama")({ endpoint: "http://gpu:11434" })).toEqual([
      "http://gpu:11434",
    ]);
    // vLLM has no public default: with no base URL there is nowhere to send it.
    expect(integrationHosts("llm_provider", "vllm")({})).toBeUndefined();
  });

  it("Gemini's key also goes to Google, whatever its base URL says (native streaming)", () => {
    expect(
      integrationHosts("llm_provider", "gemini")({ base_url: "https://proxy.corp.test" }),
    ).toEqual(["https://proxy.corp.test", PROVIDER_DEFAULT_BASE_URL.gemini]);
  });

  it("a gateway's and n8n's go to their URL; Firecrawl's to Firecrawl; a webhook nowhere shared", () => {
    expect(integrationHosts("llm_gateway")({ base_url: "https://gw.test" })).toEqual([
      "https://gw.test",
    ]);
    expect(integrationHosts("llm_gateway")({})).toBeUndefined();
    expect(integrationHosts("n8n")({ instance_url: "https://n8n.test" })).toEqual([
      "https://n8n.test",
    ]);
    expect(integrationHosts("firecrawl")({})).toEqual([FIRECRAWL_API]);
    expect(integrationHosts("notification")({ webhook_url: "https://hooks.slack.com/x" })).toBe(
      undefined,
    );
  });

  it("the defaults are the hosts the transports, adapters and health tests call", () => {
    const known = new Set(Object.values(PROVIDER_DEFAULT_BASE_URL).map((u) => hostOf(u)));
    for (const f of [
      "src/utils/providers/credentials.server.ts",
      "src/utils/providers/adapters/anthropic.server.ts",
      "src/utils/providers/adapters/grok.server.ts",
      "src/utils/providers/adapters/qwen.server.ts",
      "src/utils/providers/adapters/gemini.server.ts",
    ]) {
      for (const m of readFileSync(f, "utf8").matchAll(/["`](https?:\/\/[a-z0-9.:-]+)/g)) {
        expect(known, `${f}: ${m[1]}`).toContain(hostOf(m[1]));
      }
    }
    const tests = readFileSync("src/utils/integrations/testAdapters.server.ts", "utf8");
    for (const m of tests.matchAll(/["`](https?:\/\/[a-z0-9.:-]+)/g)) {
      expect([...known, hostOf(FIRECRAWL_API)], m[1]).toContain(hostOf(m[1]));
    }
  });
});

describe("a provider key shared with you, through the real transport", () => {
  const legacy = (config: Row) => {
    tables.integrations = [
      {
        user_id: OWNER,
        provider: "openai",
        type: "llm_provider",
        is_active: true,
        updated_at: "2026-10-31",
        config,
      },
    ];
  };

  it("is sent to OpenAI when its owner allowed api.openai.com", async () => {
    shared("OAI", "sk-shared", ["api.openai.com"]);
    legacy({ api_key: "{{secret:OAI}}" });
    const t = await resolveOpenAICompatTransport({ userId: OWNER, provider: "openai" });
    expect(t).toMatchObject({
      endpointUrl: "https://api.openai.com/v1/chat/completions",
      apiKey: "sk-shared",
    });
  });

  it("is refused when the base URL points anywhere else", async () => {
    shared("OAI", "sk-shared", ["api.openai.com"]);
    legacy({ api_key: "{{secret:OAI}}", base_url: "https://collector.attacker.test/v1" });
    await expect(
      resolveOpenAICompatTransport({ userId: OWNER, provider: "openai" }),
    ).rejects.toThrow(/not allowed it to be sent to collector\.attacker\.test/);
  });
});

// ── Warehouses ───────────────────────────────────────────────────────────────
const cfgOf = (c: Record<string, unknown>) => c as unknown as WarehouseConfig;

describe("where a connection's credential goes", () => {
  it("the host each driver connects to", () => {
    expect(warehouseHosts(cfgOf({ provider: "postgres", host: "db.corp.test" }))).toEqual([
      "db.corp.test",
    ]);
    expect(warehouseHosts(cfgOf({ provider: "snowflake", account: "xy123.eu-west-1" }))).toEqual([
      "https://xy123.eu-west-1.snowflakecomputing.com",
    ]);
    expect(warehouseHosts(cfgOf({ provider: "redshift", region: "eu-west-1" }))).toEqual([
      "https://redshift-data.eu-west-1.amazonaws.com",
    ]);
    expect(warehouseHosts(cfgOf({ provider: "athena", region: "us-east-1" }))).toEqual([
      "https://athena.us-east-1.amazonaws.com",
    ]);
    expect(warehouseHosts(cfgOf({ provider: "trino", host: "https://trino.test/x" }))).toEqual([
      "trino.test",
    ]);
    expect(warehouseHosts(cfgOf({ provider: "bigquery" }))).toEqual([
      "https://bigquery.googleapis.com",
      "https://oauth2.googleapis.com",
    ]);
    expect(warehouseHosts(cfgOf({ provider: "lakehouse" }))).toEqual([]);
  });

  it("only credential fields are shareable; what picks the host is not", () => {
    expect(warehouseCredentialFields(cfgOf({ provider: "postgres" }))).toEqual([
      "username",
      "password",
    ]);
    expect(warehouseCredentialFields(cfgOf({ provider: "snowflake" }))).toEqual(["token"]);
    for (const p of ["postgres", "snowflake", "redshift", "athena", "trino", "databricks"]) {
      const fields = warehouseCredentialFields(cfgOf({ provider: p }));
      for (const host of ["host", "account", "region", "url", "server", "ords_url"]) {
        expect(fields, `${p}.${host}`).not.toContain(host);
      }
    }
  });

  it("the drivers build those hosts the same way", () => {
    const d = readFileSync("src/utils/warehouse/drivers.server.ts", "utf8");
    expect(d).toContain("const base = `https://${cfg.account}.snowflakecomputing.com`;");
    expect(d).toContain('const service = "redshift-data";');
    expect(d).toContain('const service = "athena";');
    // Since R426 the drivers and warehouseHosts take Redshift's, Athena's and
    // BigQuery's host from one function, the private endpoint included.
    expect(d.match(/const host = new URL\(warehouseApiOrigin\(cfg\)\)\.host;/g)).toHaveLength(2);
    expect(d).toContain("const base = warehouseApiOrigin(cfg);");
    expect(d).toContain("`${base}/bigquery/v2/projects/");
    expect(d).toContain('const base = cfg.host.replace(/\\/+$/, "");');
    expect(d).toContain('const base = cfg.url.replace(/\\/+$/, "");');
    expect(d).toContain('const base = cfg.ords_url.trim().replace(/\\/+$/, "");');
  });
});

describe("a Postgres password shared with the connection's owner, through the real loader", () => {
  const conn = (config: Record<string, unknown>, owner = OWNER) => {
    plaintext.set("conn-ct", config);
    tables.data_warehouse_connections = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "warehouse",
        provider: "postgres",
        is_active: true,
        user_id: owner,
        credentials: { ciphertext: "conn-ct", iv: "iv" },
      },
    ];
  };
  const pg = (over: Record<string, unknown> = {}) => ({
    provider: "postgres",
    host: "db.corp.test",
    database: "app",
    username: "reader",
    password: "{{secret:PG_PW}}",
    ...over,
  });
  // loadWarehouseConnection queries through the client it is handed; the
  // stand-in admin client serves both the connection and the secrets.
  it("resolves toward the host its owner allowed", async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    shared("PG_PW", "pw-shared", ["db.corp.test"]);
    conn(pg());
    const c = await loadWarehouseConnection(
      supabaseAdmin as never,
      { connectionId: "11111111-1111-4111-8111-111111111111" },
      OWNER,
    );
    expect((c.config as { password: string }).password).toBe("pw-shared");
  });

  it("is refused toward another host, and never picks the host itself", async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    shared("PG_PW", "pw-shared", ["db.corp.test"]);
    conn(pg({ host: "pg.attacker.test" }));
    const ref = { connectionId: "11111111-1111-4111-8111-111111111111" };
    await expect(loadWarehouseConnection(supabaseAdmin as never, ref, OWNER)).rejects.toThrow(
      /pg\.attacker\.test/,
    );
    conn(pg({ host: "{{secret:PG_PW}}", password: "x" }));
    await expect(loadWarehouseConnection(supabaseAdmin as never, ref, OWNER)).rejects.toThrow(
      /must be one you own/,
    );
  });

  it("into a pipeline's environment, resolves only the owner's own", async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    shared("PG_PW", "pw-shared", ["db.corp.test"]);
    conn(pg());
    const ref = { connectionId: "11111111-1111-4111-8111-111111111111" };
    await expect(
      loadWarehouseConnection(supabaseAdmin as never, ref, OWNER, { into: "sandbox" }),
    ).rejects.toThrow(/must be one you own/);
  });
});

// ── Where they are written ───────────────────────────────────────────────────
const rd = (p: string) => readFileSync(p, "utf8");

describe("each saved-config read names its destination", () => {
  it("providers, own and granted, and the gateway", () => {
    const c = rd("src/utils/providers/credentials.server.ts");
    expect(c.match(/sendTo: integrationHosts\("llm_provider", provider\)/g)).toHaveLength(2);
    expect(c).toContain('{ sendTo: integrationHosts("llm_gateway") }');
  });

  it("chat: the gateway toward its URL, n8n toward this agent's webhook only", () => {
    const chat = rd("src/routes/api/chat.ts");
    expect(chat).toContain('{ sendTo: integrationHosts("llm_gateway") }');
    expect(chat).toMatch(
      /const webhook = agentN8nWebhookUrl;[\s\S]{0,200}sendTo: \(\) => \(webhook \? \[webhook\] : undefined\)/,
    );
  });

  it("the health check, the Firecrawl and n8n tools; notifications stay owner-only", () => {
    expect(rd("src/utils/integrations/health.server.ts")).toContain(
      "sendTo: integrationHosts(row.type, row.provider),",
    );
    const reg = rd("src/utils/tools/registry.server.ts");
    expect(reg).toContain('{ sendTo: integrationHosts("firecrawl") }');
    expect(reg).toContain('{ sendTo: integrationHosts("n8n") }');
    expect(rd("src/utils/notify.server.ts")).not.toMatch(/sendTo/);
  });

  it("ETL loads its connections owner-only", () => {
    const etl = rd("src/utils/etl/service.server.ts");
    const db = etl.slice(
      etl.indexOf("const databaseEnv = async"),
      etl.indexOf("if (conn.shared) {"),
    );
    expect(db).toMatch(/pipeline\.user_id,\s*\{ into: "sandbox" \},\s*\);/);
  });
});
