// Scheduled re-validation of Integration Hub credentials.
//
// Save-time tests only prove a key worked ONCE. A key revoked upstream (org
// rotation, billing lapse, deleted n8n API key) used to be discovered when an
// agent run failed mid-conversation. This pass re-runs the exact same cheap
// live tests on a fixed cadence and stamps the result into the integration's
// config, where the Integrations page shows a "failing health checks" badge.
//
// Design constraints:
//  * Runs inside runCronPass under the fleet-wide scheduler lease — so it must
//    stay CHEAP and BOUNDED: at most MAX_CHECKS_PER_PASS integrations per
//    pass, batched with limited concurrency, each test on a short timeout.
//  * Health results are advisory: is_active is NEVER flipped automatically —
//    disabling an integration is the user's call; we only surface the signal
//    (badge + in-app notification + audit event on each transition).
//  * The write-back merges health keys onto a freshly re-read config so a
//    concurrent user save is never clobbered, and `<field>_enc` ciphertext is
//    carried through untouched — decrypted values never get written back.
//
// Cadence: INTEGRATION_HEALTH_HOURS (default 6; "0"/"off" disables).

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { resolveIntegrationConfig } from "@/utils/providers/integrationConfig.server";
import {
  TESTABLE_INTEGRATION_PROVIDERS,
  runProviderTest,
  testFirecrawlCore,
  testGatewayCore,
  testN8nCore,
  type TestResult,
} from "./testAdapters.server";

const MAX_CHECKS_PER_PASS = 10;
const CONCURRENCY = 5;
/** Scan for due integrations at most this often (the checks themselves are
 * throttled per-row by INTEGRATION_HEALTH_HOURS). */
const SCAN_INTERVAL_MS = 15 * 60 * 1000;
let lastScan = 0;

function healthIntervalMs(): number | null {
  const raw = (process.env.INTEGRATION_HEALTH_HOURS ?? "").trim();
  if (/^(0|off|false|no)$/i.test(raw)) return null;
  const hours = Number(raw);
  return (Number.isFinite(hours) && hours > 0 ? hours : 6) * 3_600_000;
}

type CandidateRow = {
  id: string;
  user_id: string;
  type: string;
  provider: string | null;
  name: string;
  config: Record<string, unknown>;
};

/** Coerce a decrypted config into the string map the test adapters take. */
function stringConfig(cfg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg)) if (typeof v === "string") out[k] = v;
  return out;
}

async function runHealthTest(row: CandidateRow): Promise<TestResult> {
  // Decrypt `<field>_enc` + resolve {{secret:NAME}} refs — same read path the
  // runtime uses, so the test exercises exactly what an agent call would.
  const cfg = stringConfig(await resolveIntegrationConfig(row.user_id, row.type, row.config ?? {}));
  switch (row.type) {
    case "llm_provider":
      return runProviderTest(row.provider ?? "", cfg);
    case "llm_gateway":
      return testGatewayCore({
        base_url: cfg.base_url ?? "",
        api_key: cfg.api_key ?? "",
        provider: cfg.provider,
      });
    case "n8n":
      return testN8nCore({
        instance_url: cfg.instance_url ?? "",
        webhook_token: cfg.webhook_token,
        auth_type: cfg.auth_type,
      });
    case "firecrawl":
      return testFirecrawlCore(cfg.api_key ?? "");
    default:
      return { ok: false, detail: `No health test for type ${row.type}` };
  }
}

async function recordResult(row: CandidateRow, result: TestResult): Promise<void> {
  const status = result.ok ? "ok" : "error";
  // Re-read the row so a user save between our scan and this write is not
  // clobbered — we merge ONLY the health keys onto the freshest config.
  const { data: fresh } = await supabaseAdmin
    .from("integrations")
    .select("config")
    .eq("id", row.id)
    .maybeSingle();
  if (!fresh) return; // deleted meanwhile
  const freshCfg =
    fresh.config && typeof fresh.config === "object" && !Array.isArray(fresh.config)
      ? (fresh.config as Record<string, unknown>)
      : {};
  const prev = typeof freshCfg.health_status === "string" ? freshCfg.health_status : null;
  const nextCfg = {
    ...freshCfg,
    health_status: status,
    health_detail: result.detail.slice(0, 300),
    health_checked_at: new Date().toISOString(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin.from("integrations") as any).update({ config: nextCfg }).eq("id", row.id);

  // Transition signals fire ONCE per flip, not on every failing pass.
  const label = row.type === "llm_provider" ? (row.provider ?? row.name) : row.type;
  if (status === "error" && prev !== "error") {
    auditEvent({
      userId: row.user_id,
      action: "integration.health_failed",
      resourceType: "integration",
      resourceId: row.id,
      resourceName: label,
      detail: { type: row.type, provider: row.provider, detail: result.detail.slice(0, 300) },
    });
    const { notifyUser } = await import("@/utils/notify.server");
    await notifyUser(row.user_id, {
      title: `Integration "${label}" is failing health checks`,
      body: result.detail.slice(0, 300),
      link: "/integrations",
    });
  } else if (status === "ok" && prev === "error") {
    auditEvent({
      userId: row.user_id,
      action: "integration.health_recovered",
      resourceType: "integration",
      resourceId: row.id,
      resourceName: label,
      detail: { type: row.type, provider: row.provider },
    });
  }
}

/**
 * One bounded health pass: pick the integrations whose last check is oldest
 * (or missing), re-test them, stamp results. Returns how many were checked.
 *
 * `onlyUserId` scopes the pass to a single tenant — used by admin tooling and
 * the verification suite so a forced pass can never touch other users' rows.
 */
export async function checkIntegrationHealth(
  force = false,
  opts: { onlyUserId?: string } = {},
): Promise<number> {
  const interval = healthIntervalMs();
  if (!interval) return 0; // disabled by the operator
  const now = Date.now();
  if (!force && now - lastScan < SCAN_INTERVAL_MS) return 0;
  lastScan = now;

  let scan = supabaseAdmin
    .from("integrations")
    .select("id, user_id, type, provider, name, config")
    .eq("is_active", true)
    .in("type", ["llm_provider", "llm_gateway", "n8n", "firecrawl"]);
  if (opts.onlyUserId) scan = scan.eq("user_id", opts.onlyUserId);
  const { data: rows, error } = await scan;
  if (error) {
    console.warn("[integration-health] scan failed:", error.message);
    return 0;
  }

  const due = (rows ?? [])
    .map((r) => ({
      ...r,
      config:
        r.config && typeof r.config === "object" && !Array.isArray(r.config)
          ? (r.config as Record<string, unknown>)
          : {},
    }))
    .filter(
      (r) =>
        r.type !== "llm_provider" ||
        (r.provider != null && TESTABLE_INTEGRATION_PROVIDERS.has(r.provider)),
    )
    .map((r) => {
      const at = r.config.health_checked_at;
      const checkedAt = typeof at === "string" ? new Date(at).getTime() : 0;
      return { row: r as CandidateRow, checkedAt: Number.isFinite(checkedAt) ? checkedAt : 0 };
    })
    .filter((c) => force || now - c.checkedAt >= interval)
    .sort((a, b) => a.checkedAt - b.checkedAt)
    .slice(0, MAX_CHECKS_PER_PASS)
    .map((c) => c.row);

  let checked = 0;
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const batch = due.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        try {
          const result = await runHealthTest(row);
          await recordResult(row, result);
          checked++;
        } catch (e) {
          // A throwing test is itself a failed check — record it as such so
          // the badge still surfaces, but never let one row kill the pass.
          try {
            await recordResult(row, {
              ok: false,
              detail: `Health check errored: ${(e as Error).message}`.slice(0, 300),
            });
            checked++;
          } catch {
            console.warn("[integration-health] record failed for", row.id);
          }
        }
      }),
    );
  }
  if (checked > 0) console.log(`[integration-health] checked ${checked} integration(s)`);
  return checked;
}

// ── One-time re-encryption sweep for legacy plaintext secrets ──────────────
// Rows saved before at-rest encryption keep working via the read-both
// fallback, but their plaintext key ships to the browser on every
// integrations SELECT until re-saved. This retires that exposure without
// waiting for a manual re-save: any secret field found as a non-empty
// plaintext literal (not a {{secret:NAME}} reference) is encrypted in place.
// Runs at most once a day per process, bounded, and NEVER touches rows that
// are already ciphertext-only (dropping their `_enc` would destroy the key).

let lastSweep = 0;
const SWEEP_INTERVAL_MS = 24 * 3_600_000;
const SWEEP_TYPES = ["llm_provider", "llm_gateway", "n8n", "firecrawl", "notification"];

export async function sweepPlaintextSecrets(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_INTERVAL_MS) return 0;
  lastSweep = now;
  try {
    const { encryptIntegrationConfig, preserveBlankSecrets, integrationSecretFields } =
      await import("@/utils/providers/integrationConfig.server");
    const { containsSecretRef } = await import("@/utils/secrets.server");
    const { data: rows, error } = await supabaseAdmin
      .from("integrations")
      .select("id, type, config")
      .in("type", SWEEP_TYPES)
      .limit(500);
    if (error || !rows) return 0;
    let swept = 0;
    for (const r of rows) {
      const cfg =
        r.config && typeof r.config === "object" && !Array.isArray(r.config)
          ? (r.config as Record<string, unknown>)
          : {};
      const needs = integrationSecretFields(r.type).some((f) => {
        const v = cfg[f];
        return typeof v === "string" && v.length > 0 && !containsSecretRef(v);
      });
      if (!needs) continue;
      let next = await encryptIntegrationConfig(r.type, cfg);
      // Belt-and-braces: restore ciphertext for any secret field that had no
      // plaintext value, so the sweep can never lose a stored key.
      next = preserveBlankSecrets(r.type, next, cfg);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upErr } = await (supabaseAdmin.from("integrations") as any)
        .update({ config: next })
        .eq("id", r.id);
      if (!upErr) swept++;
    }
    if (swept > 0)
      console.log(`[integration-sweep] re-encrypted ${swept} legacy plaintext secret(s)`);
    return swept;
  } catch (e) {
    console.warn("[integration-sweep] failed:", (e as Error).message);
    return 0;
  }
}
