// The SaaS connections table and its server functions.
//
// The provider CHECK test here exists because the warehouse table's equivalent
// went five providers stale and silently rejected every save — the insert
// failed on a constraint violation naming neither the provider nor the reason,
// and types could not catch it because the union, the driver and the form were
// all correct. Only the database disagreed, and only at runtime.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SAAS_LABELS, SAAS_PROVIDERS } from "@/utils/saas/types";

const MIGRATIONS = "supabase/migrations";
const functionsSrc = readFileSync("src/utils/saas.functions.ts", "utf8");
const tabSrc = readFileSync("src/components/integrations/SaasSourcesTab.tsx", "utf8");

/** Providers permitted by the most recent saas_connections CHECK. */
function providersInCheck(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let latest: string[] | null = null;
  for (const f of files) {
    const sql = readFileSync(`${MIGRATIONS}/${f}`, "utf8");
    // Anchored to the table, then read the list that FOLLOWS it — another
    // migration may mention this table in a comment while carrying its own
    // unrelated `provider IN`.
    const anchor = sql.search(
      /(CREATE TABLE public\.saas_connections|ALTER TABLE public\.saas_connections)/i,
    );
    if (anchor < 0) continue;
    const m = sql.slice(anchor).match(/provider\s+IN\s*\(([\s\S]*?)\)/i);
    if (m) latest = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  }
  if (!latest) throw new Error("No saas_connections provider CHECK found");
  return latest;
}

describe("the database accepts every SaaS provider the app offers", () => {
  it("permits exactly the providers in SAAS_PROVIDERS", () => {
    const allowed = new Set(providersInCheck());
    const missing = SAAS_PROVIDERS.filter((p) => !allowed.has(p));
    expect(
      missing,
      `Offered in the app but REJECTED by the saas_connections CHECK constraint. ` +
        `Add them in a new migration: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("permits nothing the app cannot sync", () => {
    const known = new Set<string>(SAAS_PROVIDERS);
    expect(providersInCheck().filter((p) => !known.has(p))).toEqual([]);
  });
});

describe("the table is scoped to its owner", () => {
  const migration = readdirSync(MIGRATIONS)
    .filter((f) => f.includes("saas_connections"))
    .map((f) => readFileSync(`${MIGRATIONS}/${f}`, "utf8"))
    .join("\n");

  it("enables row level security", () => {
    // Without this the policy below is decoration and every row is world-readable.
    expect(migration).toMatch(/ALTER TABLE public\.saas_connections ENABLE ROW LEVEL SECURITY/i);
  });

  it("restricts both reads and writes to the owner", () => {
    expect(migration).toMatch(/USING \(auth\.uid\(\) = user_id\)/i);
    // WITH CHECK is the half people forget: without it a user can INSERT a row
    // owned by someone else, even though they could never read it back.
    expect(migration).toMatch(/WITH CHECK \(auth\.uid\(\) = user_id\)/i);
  });

  it("cascades when the user is deleted", () => {
    expect(migration).toMatch(/REFERENCES auth\.users\(id\) ON DELETE CASCADE/i);
  });

  it("keeps names unique per user, so a sync cannot target the wrong source", () => {
    expect(migration).toMatch(/UNIQUE \(user_id, name\)/i);
  });
});

describe("credentials never leave the server", () => {
  it("encrypts the config before storing it", () => {
    expect(functionsSrc).toContain("encryptJson(data.config)");
  });

  it("does NOT select config when listing connections", () => {
    // A summary that selected `config` would ship the ciphertext to every
    // client that opens the tab. Encrypted or not, it has no business there.
    const listBlock = functionsSrc.slice(
      functionsSrc.indexOf("listSaasConnections"),
      functionsSrc.indexOf("saveSaasConnection"),
    );
    expect(listBlock).not.toMatch(/select\([^)]*\bconfig\b/s);
  });

  it("filters by user_id on every read of a stored config", () => {
    // RLS already does this under a JWT client, but the explicit filter is what
    // keeps it correct if a service-role caller is ever added — the same
    // reasoning as loadWarehouseConnection's ownerUserId.
    const loadBlock = functionsSrc.slice(
      functionsSrc.indexOf("async function loadConnection"),
      functionsSrc.indexOf("export const listSaasConnections"),
    );
    expect(loadBlock).toContain('.eq("user_id", userId)');
  });

  it("scopes delete to the owner as well as the id", () => {
    const delBlock = functionsSrc.slice(
      functionsSrc.indexOf("deleteSaasConnection"),
      functionsSrc.indexOf("discoverSaasStreams"),
    );
    expect(delBlock).toContain('.eq("user_id", userId)');
  });
});

describe("sync outcomes are reported honestly", () => {
  // The status decision lives in sync.server's runConnectionSync, which the
  // manual button and the scheduler BOTH call — deliberately one place, so
  // the two cannot disagree about what counts as success.
  const syncSrc = readFileSync("src/utils/saas/sync.server.ts", "utf8");

  it("records a partial sync as 'partial', not as success", () => {
    // One tab of six silently failing is how a dashboard goes stale for a
    // quarter without anyone noticing.
    expect(syncSrc).toContain('result.failed.length === 0 ? "ok" : "partial"');
  });

  it("stores why it failed, not just that it did", () => {
    expect(syncSrc).toMatch(/last_sync_error/);
    expect(syncSrc).toMatch(/f\.stream.*f\.error|`\$\{f\.stream\}: \$\{f\.error\}`/);
  });

  it("surfaces a partial sync in the UI as a warning rather than a success", () => {
    expect(tabSrc).toContain("toast.warning");
  });
});

describe("every provider is presentable", () => {
  it("has a label and setup help", () => {
    for (const p of SAAS_PROVIDERS) {
      expect(SAAS_LABELS[p]?.length, `${p} has no label`).toBeGreaterThan(0);
      expect(tabSrc.includes(`${p}:`), `${p} has no PROVIDER_HELP entry`).toBe(true);
    }
  });

  it("tells the user about the share step, which is the usual 403", () => {
    // The single most common Google Sheets setup mistake. The connector catches
    // the 403 too, but saying it up front is cheaper than a failed attempt.
    expect(tabSrc).toMatch(/client_email/);
  });
});
