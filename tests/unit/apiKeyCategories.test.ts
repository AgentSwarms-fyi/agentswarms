// The API keys hub lists every key and credential the app holds — and keeps
// listing them as the schema grows (R385).
//
// PR #95's registry said it covered "every credential/key store in the app".
// Measured against the migrations it did not: MCP app keys, notebook keys,
// lakehouse share tokens, workflow and ETL trigger tokens and SCIM tokens — all
// keys that reach INTO this instance — had no card, nor did warehouse, catalog,
// Knowledge Base, Iceberg, app-connector, Slack/Teams and integration
// credentials. Its counts were also wrong in two ways: "active" included
// expired keys (only revoking flips is_active), and LLM provider keys were
// counted from one of the two tables they live in — live, it read "0" over a
// panel showing two connected providers.
//
// The guard below scans the migrations for credential-bearing columns, so the
// next key table added without a card fails here rather than going unseen.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  API_KEY_CATEGORIES,
  EXCLUDED_CREDENTIAL_TABLES,
  countOps,
  needsUserId,
  type ApiKeyCategoryId,
} from "@/lib/apiKeyCategories";

// ── The schema, as the migrations define it ─────────────────────────────────

const MIGRATIONS = "supabase/migrations";
/** table → every column a migration gives it (CREATE TABLE body + ADD COLUMN). */
const COLUMNS = new Map<string, Set<string>>();
const addCol = (t: string, c: string) => {
  if (!COLUMNS.has(t)) COLUMNS.set(t, new Set());
  COLUMNS.get(t)!.add(c);
};
for (const f of readdirSync(MIGRATIONS)
  .filter((x) => x.endsWith(".sql"))
  .sort()) {
  // Strip -- comments so prose never reads as a column.
  const sql = readFileSync(join(MIGRATIONS, f), "utf8")
    .replace(/\r/g, "")
    .replace(/--[^\n]*/g, "");
  for (const m of sql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\n\);/g,
  )) {
    if (!COLUMNS.has(m[1])) COLUMNS.set(m[1], new Set());
    for (const line of m[2].split("\n")) {
      const col = line.trim().split(/\s+/)[0];
      if (/^[a-z_0-9]+$/.test(col) && !/^(constraint|primary|unique|check|foreign)$/.test(col))
        addCol(m[1], col);
    }
  }
  for (const m of sql.matchAll(
    /ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?([a-z_0-9]+)([\s\S]*?);/g,
  )) {
    for (const a of m[2].matchAll(/ADD COLUMN (?:IF NOT EXISTS )?([a-z_0-9]+)/g))
      addCol(m[1], a[1]);
  }
}

/** A column that holds a credential, or a capability URL that works like one. */
const CREDENTIAL_COLUMN =
  /^(credentials|auth_token|(?:[a-z]+_)?(?:key|token)_hash|[a-z_]*_secret(?:_enc)?|[a-z_]*password(?:_enc)?|[a-z0-9_]*webhook_url)$/;
/** Names that match but hold no credential: references to a secret by name. */
const NOT_A_CREDENTIAL = /^secret_refs$/;

const credentialTables = [...COLUMNS]
  .filter(([, cols]) =>
    [...cols].some((c) => CREDENTIAL_COLUMN.test(c) && !NOT_A_CREDENTIAL.test(c)),
  )
  .map(([t]) => t)
  .sort();

const sourceTables = new Set(API_KEY_CATEGORIES.flatMap((c) => c.sources.map((s) => s.table)));

describe("the registry covers every credential the schema can hold", () => {
  it("finds the credential tables at all (the scan is not silently empty)", () => {
    // A broken parser would pass the next test vacuously.
    expect(credentialTables.length).toBeGreaterThan(15);
    for (const t of ["gateway_keys", "mcp_app_keys", "lakehouse_share_tokens", "kb_sources"]) {
      expect(credentialTables, `${t} should be detected`).toContain(t);
    }
  });

  it("lists every credential table as a card's source, or excludes it with a reason", () => {
    const uncovered = credentialTables.filter(
      (t) => !sourceTables.has(t) && !(t in EXCLUDED_CREDENTIAL_TABLES),
    );
    // Adding a key table? Give it a card in src/lib/apiKeyCategories.ts —
    // or, if no user holds it, a reasoned line in EXCLUDED_CREDENTIAL_TABLES.
    expect(uncovered).toEqual([]);
  });

  it("excludes only tables the scan actually flags (the list cannot rot)", () => {
    for (const [t, why] of Object.entries(EXCLUDED_CREDENTIAL_TABLES)) {
      expect(credentialTables, `${t} is excluded but holds no credential column`).toContain(t);
      expect(why.length, `${t} needs a reason`).toBeGreaterThan(20);
    }
  });

  it("covers the issued keys that had no card before R385", () => {
    const ids = API_KEY_CATEGORIES.map((c) => c.id);
    for (const id of [
      "mcp_app_keys",
      "notebook_keys",
      "share_tokens",
      "workflow_triggers",
      "etl_triggers",
      "scim_tokens",
    ] satisfies ApiKeyCategoryId[]) {
      expect(ids).toContain(id);
      expect(API_KEY_CATEGORIES.find((c) => c.id === id)!.group).toBe("issued");
    }
  });
});

describe("every name the registry uses exists in the schema", () => {
  // A misspelled table or column does not crash: PostgREST answers an error,
  // and the card shows "—" forever. Checked here instead.
  for (const c of API_KEY_CATEGORIES) {
    for (const s of c.sources) {
      it(`${c.id}: ${s.table} and its columns exist`, () => {
        const cols = COLUMNS.get(s.table);
        expect(cols, `table ${s.table}`).toBeDefined();
        for (const f of s.filters ?? []) expect(cols, `${s.table}.${f.column}`).toContain(f.column);
        if (s.expiresColumn)
          expect(cols, `${s.table}.${s.expiresColumn}`).toContain(s.expiresColumn);
      });
    }
  }

  it("has unique ids, and SCIM is the only superadmin-only card", () => {
    const ids = API_KEY_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(API_KEY_CATEGORIES.filter((c) => c.superadminOnly).map((c) => c.id)).toEqual([
      "scim_tokens",
    ]);
  });
});

describe("countOps: what each card actually counts", () => {
  const ctx = {
    userId: "11111111-1111-4111-8111-111111111111",
    now: new Date("2026-10-26T12:00:00.000Z"),
  };
  const opsFor = (id: ApiKeyCategoryId, i = 0) =>
    countOps(API_KEY_CATEGORIES.find((c) => c.id === id)!.sources[i], ctx);
  const expiry = (col: string) => ({
    method: "or",
    args: [`${col}.is.null,${col}.gt."2026-10-26T12:00:00.000Z"`],
  });

  it("does not count an expired key as live (it is refused at use, yet still is_active)", () => {
    for (const id of [
      "gateway",
      "ml",
      "embeds",
      "mcp_app_keys",
      "notebook_keys",
      "share_tokens",
    ] as const) {
      expect(opsFor(id), id).toContainEqual(expiry("expires_at"));
    }
  });

  it("quotes the timestamp, which PostgREST would otherwise split on its colons", () => {
    const or = opsFor("gateway").find((o) => o.method === "or")!;
    expect(or.args[0]).toMatch(/\.gt\."[^"]+"$/);
  });

  it("leaves the platform's internal MCP key out of 'keys you issued'", () => {
    expect(opsFor("mcp_app_keys")).toEqual([
      { method: "eq", args: ["is_active", true] },
      { method: "eq", args: ["is_internal", false] },
      expiry("expires_at"),
    ]);
  });

  it("counts provider keys from BOTH tables they live in", () => {
    const providers = API_KEY_CATEGORIES.find((c) => c.id === "providers")!;
    expect(providers.sources.map((s) => s.table)).toEqual(["provider_credentials", "integrations"]);
    expect(opsFor("providers", 1)).toEqual([
      { method: "eq", args: ["type", "llm_provider"] },
      { method: "eq", args: ["is_active", true] },
    ]);
  });

  it("counts only YOUR catalog and Knowledge Base sources, not ones shared with you", () => {
    expect(opsFor("catalog_sources")).toEqual([{ method: "eq", args: ["user_id", ctx.userId] }]);
    expect(opsFor("kb_connectors")).toEqual([
      { method: "eq", args: ["user_id", ctx.userId] },
      { method: "not", args: ["credentials", "is", null] },
      { method: "neq", args: ["kind", "web"] },
    ]);
    expect(needsUserId(API_KEY_CATEGORIES.find((c) => c.id === "catalog_sources")!)).toBe(true);
    expect(needsUserId(API_KEY_CATEGORIES.find((c) => c.id === "gateway")!)).toBe(false);
  });

  it("does not count a Knowledge Base source whose connector takes no credential", () => {
    // The save path stores an encrypted {} for these, so `credentials` alone
    // cannot tell them apart. Read the connector list rather than trusting a
    // hand-kept copy: a second credentialless connector must fail here.
    const src = readFileSync("src/utils/kb/connectors.server.ts", "utf8");
    const credentialless = [...src.matchAll(/kind: "([a-z_]+)",[^}]*?credentialless: true/g)].map(
      (m) => m[1],
    );
    expect(credentialless).toEqual(["web"]);
    const kb = API_KEY_CATEGORIES.find((c) => c.id === "kb_connectors")!;
    for (const kind of credentialless) {
      expect(kb.sources[0].filters).toContainEqual({ column: "kind", op: "neq", value: kind });
    }
  });

  it("counts a trigger token by its hash being present, and an unrevoked share token", () => {
    expect(opsFor("workflow_triggers")).toEqual([
      { method: "not", args: ["trigger_token_hash", "is", null] },
    ]);
    expect(opsFor("etl_triggers")).toEqual([
      { method: "not", args: ["trigger_token_hash", "is", null] },
    ]);
    expect(opsFor("share_tokens")).toEqual([
      { method: "is", args: ["revoked_at", null] },
      expiry("expires_at"),
    ]);
  });

  it("counts the credential-bearing integration types and agents' n8n webhooks", () => {
    expect(opsFor("integrations", 0)).toEqual([
      { method: "in", args: ["type", ["llm_gateway", "n8n", "firecrawl", "notification"]] },
    ]);
    expect(opsFor("integrations", 1)).toEqual([
      { method: "eq", args: ["user_id", ctx.userId] },
      { method: "not", args: ["n8n_webhook_url", "is", null] },
      { method: "neq", args: ["n8n_webhook_url", ""] },
    ]);
  });
});

describe("the hub's panels", () => {
  const hub = readFileSync("src/components/settings/ApiKeysSettingsPanel.tsx", "utf8");
  const issued = readFileSync("src/components/settings/IssuedKeysPanel.tsx", "utf8");
  const stored = readFileSync("src/components/settings/StoredCredentialsPanel.tsx", "utf8");
  const etl = readFileSync("src/utils/etl.functions.ts", "utf8");

  it("sums every source and treats one unreadable source as an unknown total", () => {
    expect(hub).toMatch(/for \(const source of category\.sources\)/);
    expect(hub).toMatch(/countOps\(source, \{ userId, now \}\)/);
    expect(hub).toMatch(/if \(error \|\| n === null\) \{\s*setFailed\(true\);\s*return;/);
  });

  it("re-counts the cards when a category dialog closes", () => {
    expect(hub).toMatch(/setCountsVersion\(\(n\) => n \+ 1\)/);
    expect(hub).toMatch(/refreshKey=\{countsVersion\}/);
  });

  it("shows the SCIM card to superadmins only", () => {
    expect(hub).toMatch(/!c\.superadminOnly \|\| isSuperadmin/);
  });

  it("revokes each issued key through that key's own server function", () => {
    for (const fn of [
      "mcpAppKeyRevoke",
      "nbApiKeyRevoke",
      "revokeLakehouseShareToken",
      "workflowRevokeToken",
      "revokeEtlTriggerToken",
      "iamRevokeScimToken",
    ]) {
      expect(issued, fn).toMatch(new RegExp(`useServerFn\\(${fn}\\)`));
    }
    // Re-read after a revoke rather than trusting a local edit.
    expect(issued).toMatch(/await load\(\);\s*toast\.success\(/);
  });

  it("never lists the internal MCP key, and never selects a hash", () => {
    expect(issued).toMatch(/\.eq\("is_internal", false\)/);
    expect(issued).not.toMatch(/select\([^)]*(key_hash|token_hash|trigger_token_hash)/);
  });

  it("never reads a credential column into the browser to list connections", () => {
    const selects = [...stored.matchAll(/select: "([^"]+)"/g)].map((m) => m[1]);
    expect(selects.length).toBeGreaterThan(5);
    for (const s of selects) {
      for (const col of s.split(",").map((x) => x.trim())) {
        expect(CREDENTIAL_COLUMN.test(col) || col === "config", `${col} in "${s}"`).toBe(false);
      }
    }
  });

  it("says so when a list cannot be read, rather than showing an empty one", () => {
    expect(issued).toMatch(/Could not load your \{copy\.plural\}/);
    expect(stored).toMatch(/Could not load these credentials/);
  });

  it("can take an ETL trigger token away, scoped to its owner and audited", () => {
    const fn = etl.slice(etl.indexOf("export const revokeEtlTriggerToken"));
    expect(fn.slice(0, 1200)).toMatch(/\.update\(\{ trigger_token_hash: null \}\)/);
    expect(fn.slice(0, 1200)).toMatch(/\.eq\("user_id", userId\)/);
    expect(fn.slice(0, 1200)).toMatch(/action: "etl\.trigger_token\.revoke"/);
  });
});
