// Scheduled SaaS syncs.
//
// The failure this guards is not "the sync broke" — it is "the sync ran twice
// and nobody noticed". A scheduled sync REPLACES its datasets, so a double run
// rebuilds them and adds a spurious snapshot to the version history, and every
// symptom of that looks like normal operation.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { nextSyncAt } from "@/utils/saas/sync.server";
import { SYNC_SCHEDULES } from "@/utils/saas/types";

const scheduleSrc = readFileSync("src/utils/saas/schedule.server.ts", "utf8");
const syncSrc = readFileSync("src/utils/saas/sync.server.ts", "utf8");
const functionsSrc = readFileSync("src/utils/saas.functions.ts", "utf8");
const refreshSrc = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
const migrations = readFileSync(
  "supabase/migrations/20260777000000_saas_sync_schedule.sql",
  "utf8",
);

describe("nextSyncAt", () => {
  const from = new Date("2026-08-01T12:00:00.000Z");

  it("spaces each cadence correctly", () => {
    expect(nextSyncAt("hourly", from)).toBe("2026-08-01T13:00:00.000Z");
    expect(nextSyncAt("daily", from)).toBe("2026-08-02T12:00:00.000Z");
    expect(nextSyncAt("weekly", from)).toBe("2026-08-08T12:00:00.000Z");
  });

  it("returns null for manual, which keeps it out of the scheduler entirely", () => {
    // The partial index is `WHERE sync_schedule <> 'manual'`, and a null
    // next_sync_at also fails the `lte` filter — two independent reasons a
    // manual source is never picked up.
    expect(nextSyncAt("manual", from)).toBeNull();
  });

  it("returns null for anything unrecognised rather than defaulting to soon", () => {
    // A bad value must not become "every hour".
    expect(nextSyncAt("", from)).toBeNull();
    expect(nextSyncAt("hourley", from)).toBeNull();
  });

  it("covers every schedule the UI offers", () => {
    for (const s of SYNC_SCHEDULES) {
      if (s === "manual") continue;
      expect(nextSyncAt(s, from), `${s} has no interval`).not.toBeNull();
    }
  });
});

describe("the scheduler claims a source before syncing it", () => {
  it("pushes next_sync_at forward with a conditional UPDATE", () => {
    // `lte("next_sync_at", now)` in the UPDATE is what makes the claim atomic:
    // it only matches while the row is still due, so of two instances polling
    // the same second exactly one gets a row back.
    const claim = scheduleSrc.slice(
      scheduleSrc.indexOf("async function claim"),
      scheduleSrc.indexOf("async function notify"),
    );
    expect(claim).toContain(".update({ next_sync_at: nextSyncAt(row.sync_schedule) })");
    expect(claim).toContain('.lte("next_sync_at", nowIso)');
    expect(claim).toContain(".select(");
  });

  it("skips the source when the claim matched nothing", () => {
    // Without this the conditional update is decoration — both instances would
    // carry on and sync anyway.
    expect(scheduleSrc).toMatch(/if \(!\(await claim\(row, nowIso\)\)\) continue;/);
  });

  it("claims BEFORE running, so a hard failure cannot tight-loop", () => {
    // Compared against the CALL, not the import at the top of the file — the
    // first version of this assertion measured the import and passed for the
    // wrong reason.
    expect(scheduleSrc.indexOf("await claim(")).toBeLessThan(
      scheduleSrc.indexOf("runConnectionSync(supabaseAdmin"),
    );
  });
});

describe("the scheduler stays inside its lane", () => {
  it("only considers active, non-manual, due sources", () => {
    expect(scheduleSrc).toContain('.neq("sync_schedule", "manual")');
    expect(scheduleSrc).toContain('.eq("is_active", true)');
    expect(scheduleSrc).toContain('.lte("next_sync_at", nowIso)');
  });

  it("scopes its writes by user_id as well as id", () => {
    // It runs under the service role with RLS off; the id alone is not a
    // tenant boundary.
    const errorPath = scheduleSrc.slice(scheduleSrc.indexOf('last_sync_status: "error"'));
    expect(errorPath).toContain('.eq("user_id", row.user_id)');
  });

  it("records a failure that happened BEFORE the sync could run", () => {
    // A credential that no longer decrypts never reaches runConnectionSync, so
    // without this the source sits showing its last success for ever.
    expect(scheduleSrc).toContain('last_sync_status: "error"');
  });

  it("notifies the owner on failure and on a partial run", () => {
    expect(scheduleSrc).toContain("Scheduled sync failed");
    expect(scheduleSrc).toContain("Sync partly failed");
  });

  it("is registered on the shared scheduler pass", () => {
    // Unregistered, every assertion above is about code that never runs.
    expect(refreshSrc).toContain("processDueSaasSyncs(force)");
  });
});

describe("manual and scheduled syncs cannot disagree", () => {
  it("both go through runConnectionSync", () => {
    // Two copies of "what counts as success" is how a source shows green in
    // the UI and red in the scheduler, or the reverse.
    //
    // Matched as a CALL rather than by exact argument text: the manual path now
    // CHOOSES its client, because a shared source syncs with the service role
    // as its owner. `[^{;]*` cannot cross into the object literal, so this
    // still fails if the call is removed or inlined. Which client it picks is
    // connectionGrants' business, not this file's.
    expect(functionsSrc).toMatch(/runConnectionSync\([^{;]*,\s*\{/);
    expect(scheduleSrc).toContain("runConnectionSync(supabaseAdmin, {");
  });

  it("records a partial run as partial, in the one place that decides it", () => {
    expect(syncSrc).toContain('result.failed.length === 0 ? "ok" : "partial"');
    // And nowhere else — a second copy would be the drift this prevents.
    expect(functionsSrc).not.toContain('? "ok" : "partial"');
  });
});

describe("the migration", () => {
  it("defaults to manual, so an existing source does not start syncing itself", () => {
    expect(migrations).toMatch(/sync_schedule text NOT NULL DEFAULT 'manual'/i);
  });

  it("constrains the schedule to the values the code understands", () => {
    const m = migrations.match(/sync_schedule IN \(([^)]*)\)/i);
    expect(m, "no CHECK on sync_schedule").not.toBeNull();
    const allowed = [...m![1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    expect(new Set(allowed)).toEqual(new Set(SYNC_SCHEDULES));
  });

  it("indexes the scheduler's query", () => {
    expect(migrations).toMatch(/CREATE INDEX IF NOT EXISTS idx_saas_connections_due/i);
  });
});
