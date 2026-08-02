// Scheduled re-validation of DATA CONNECTION credentials — warehouses and app
// sources.
//
// The Integration Hub already re-tests LLM keys on a cadence (health.server).
// Data connections had no equivalent, which is the worse gap of the two: a
// warehouse password expires on the customer's rotation policy, and the first
// anyone knew was a dashboard rendering an error at 9am, or worse, a scheduled
// refresh failing quietly overnight for a week.
//
// Mirrors health.server's design decisions deliberately, because they were the
// right ones and two different answers to the same question is its own bug:
//   * bounded per pass, batched with limited concurrency, cheap probes only;
//   * is_active is NEVER flipped automatically — surfacing the signal is our
//     job, deciding what to do about it is the user's;
//   * transition-only notifications, so a connection failing for a week does
//     not send seven identical alerts.
//
// The probes are the SAME functions the product uses. A warehouse is tested
// with testWarehouseConnection (a SELECT 1 through the real driver); an app
// source with listSaasStreams (the same call the UI's "test" button makes). A
// bespoke probe here would pass while the real read path was broken.
//
// Cadence: CONNECTION_HEALTH_HOURS (default 12; "0"/"off" disables).

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import type { SaasConfig } from "@/utils/saas/types";

const MAX_CHECKS_PER_PASS = 10;
const CONCURRENCY = 3;
/** Scan for due connections at most this often. */
const SCAN_INTERVAL_MS = 15 * 60 * 1000;
let lastScan = 0;

function healthIntervalMs(): number | null {
  const raw = (process.env.CONNECTION_HEALTH_HOURS ?? "").trim();
  if (/^(0|off|false|no)$/i.test(raw)) return null;
  const hours = Number(raw);
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3_600_000;
}

/**
 * Age past which a credential is called out in the UI.
 *
 * Advisory only — nothing expires, nothing stops working. Enterprises commonly
 * run a 90-day rotation policy, so that is the default.
 */
export function credentialMaxAgeDays(): number {
  const n = Number((process.env.CREDENTIAL_MAX_AGE_DAYS ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 90;
}

/**
 * Whole days since the credential was last rotated, or null if unknown.
 *
 * Reads credentials_rotated_at, NOT updated_at: the health pass writes to
 * every row it checks, so updated_at would report every credential as rotated
 * moments ago — inverting the signal exactly when it matters.
 */
export function credentialAgeDays(rotatedAt: string | null | undefined): number | null {
  if (!rotatedAt) return null;
  const t = Date.parse(rotatedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

export function isCredentialStale(rotatedAt: string | null | undefined): boolean {
  const age = credentialAgeDays(rotatedAt);
  return age !== null && age >= credentialMaxAgeDays();
}

type Kind = "warehouse" | "saas";

type ConnRow = {
  id: string;
  user_id: string;
  name: string;
  provider: string;
  last_test_status: string | null;
  last_tested_at: string | null;
};

const TABLE: Record<Kind, "data_warehouse_connections" | "saas_connections"> = {
  warehouse: "data_warehouse_connections",
  saas: "saas_connections",
};

const LABEL: Record<Kind, string> = {
  warehouse: "Data source",
  saas: "App source",
};

/** Run the product's own probe for this connection kind. */
async function probe(kind: Kind, row: ConnRow): Promise<{ ok: boolean; detail: string }> {
  try {
    if (kind === "warehouse") {
      const { loadWarehouseConnection } = await import("@/utils/warehouse/connections.server");
      const { testWarehouseConnection } = await import("@/utils/warehouse/drivers.server");
      // Scoped to the OWNER. This runs under the service role with RLS off, so
      // the id alone is not a tenant boundary — the same reasoning as every
      // other service-role load path.
      const conn = await loadWarehouseConnection(
        supabaseAdmin,
        { connectionId: row.id },
        row.user_id,
      );
      await testWarehouseConnection(conn.config);
    } else {
      const { decryptJson } = await import("@/utils/providers/crypto.server");
      const { listSaasStreams } = await import("@/utils/saas/sync.server");
      const { data } = await supabaseAdmin
        .from("saas_connections")
        .select("config")
        .eq("id", row.id)
        // Owner-scoped for the same reason as the warehouse branch: RLS is off
        // under the service role, so the id alone is not a tenant boundary.
        .eq("user_id", row.user_id)
        .maybeSingle();
      const enc = data?.config as { ciphertext?: string; iv?: string } | undefined;
      if (!enc?.ciphertext || !enc?.iv) return { ok: false, detail: "No stored credentials" };
      // Decrypt then probe — exactly what discoverSaasStreams does. App source
      // configs hold literal credentials; unlike warehouses they have no
      // {{secret:NAME}} indirection to resolve.
      const cfg = await decryptJson<SaasConfig>(enc.ciphertext, enc.iv);
      await listSaasStreams(cfg);
    }
    return { ok: true, detail: "OK" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

async function recordResult(
  kind: Kind,
  row: ConnRow,
  result: { ok: boolean; detail: string },
): Promise<void> {
  const status = result.ok ? "ok" : "error";
  const prev = row.last_test_status;

  // Only the health columns are written. credentials_rotated_at is untouched
  // on purpose — a health check is not a rotation, and writing it here would
  // make every checked credential look brand new.
  // The cast is needed because `TABLE[kind]` is a union of two table names, so
  // supabase-js cannot narrow the Update shape to one of them. The three
  // columns exist on both tables — that is what makes the union safe here.
  const patch = {
    last_test_status: status,
    last_test_error: result.ok ? null : result.detail.slice(0, 300),
    last_tested_at: new Date().toISOString(),
  };
  await supabaseAdmin
    .from(TABLE[kind])
    .update(patch as never)
    .eq("id", row.id)
    .eq("user_id", row.user_id);

  // Fire ONCE per transition, not on every failing pass.
  if (status === "error" && prev !== "error") {
    auditEvent({
      userId: row.user_id,
      action: "connection.health_failed",
      resourceType: kind === "warehouse" ? "warehouse_connection" : "saas_connection",
      resourceId: row.id,
      resourceName: row.name,
      detail: { provider: row.provider, detail: result.detail.slice(0, 300) },
    });
    const { notifyUser } = await import("@/utils/notify.server");
    await notifyUser(row.user_id, {
      title: `${LABEL[kind]} "${row.name}" is failing its health check`,
      body: result.detail.slice(0, 300),
      link: "/integrations",
    });
  } else if (status === "ok" && prev === "error") {
    auditEvent({
      userId: row.user_id,
      action: "connection.health_recovered",
      resourceType: kind === "warehouse" ? "warehouse_connection" : "saas_connection",
      resourceId: row.id,
      resourceName: row.name,
      detail: { provider: row.provider },
    });
  }
}

async function checkKind(kind: Kind, interval: number, force: boolean, onlyUserId?: string) {
  const now = Date.now();
  let scan = supabaseAdmin
    .from(TABLE[kind])
    .select("id, user_id, name, provider, last_test_status, last_tested_at")
    .eq("is_active", true);
  if (onlyUserId) scan = scan.eq("user_id", onlyUserId);
  const { data: rows, error } = await scan;
  if (error) {
    console.warn(`[connection-health] ${kind} scan failed:`, error.message);
    return 0;
  }

  const due = (rows ?? [])
    .map((r) => {
      const at = (r as ConnRow).last_tested_at;
      const checkedAt = at ? new Date(at).getTime() : 0;
      return { row: r as ConnRow, checkedAt: Number.isFinite(checkedAt) ? checkedAt : 0 };
    })
    .filter((c) => force || now - c.checkedAt >= interval)
    .sort((a, b) => a.checkedAt - b.checkedAt)
    .slice(0, MAX_CHECKS_PER_PASS)
    .map((c) => c.row);

  let checked = 0;
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    await Promise.all(
      due.slice(i, i + CONCURRENCY).map(async (row) => {
        try {
          await recordResult(kind, row, await probe(kind, row));
          checked++;
        } catch (e) {
          // One unwritable row must never kill the pass for the rest.
          console.warn(`[connection-health] ${kind} ${row.id} failed:`, (e as Error).message);
        }
      }),
    );
  }
  return checked;
}

/**
 * One bounded health pass across both connection kinds.
 *
 * `onlyUserId` scopes it to a single tenant, so admin tooling and the
 * verification suite can force a pass without touching other users' rows.
 */
export async function checkConnectionHealth(
  force = false,
  opts: { onlyUserId?: string } = {},
): Promise<number> {
  const interval = healthIntervalMs();
  if (!interval) return 0;
  const now = Date.now();
  if (!force && now - lastScan < SCAN_INTERVAL_MS) return 0;
  lastScan = now;

  const warehouse = await checkKind("warehouse", interval, force, opts.onlyUserId);
  const saas = await checkKind("saas", interval, force, opts.onlyUserId);
  const total = warehouse + saas;
  if (total > 0) {
    console.log(`[connection-health] checked ${warehouse} warehouse + ${saas} app source(s)`);
  }
  return total;
}
