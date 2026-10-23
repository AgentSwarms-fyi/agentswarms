// A retention window that could not be read is not the default window.
//
// FOUND IN R252, from the sweep-7 "destructive on a blip" row: "the audit purge
// uses default retention". The purge read iam_settings and dropped the error,
// so a failed read was "no settings": both windows fell back to 365 days and
// the 183-day provenance floor, and every row older than that was deleted - on
// a deployment whose operator keeps years of trail for a regulator. A deleted
// audit row does not come back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({
  settings: { data: null, error: null } as Resp,
  deletes: [] as string[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = (table: string) => {
    let deleting = false;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "limit", "lt", "is", "not", "order", "range", "eq"]) b[m] = () => b;
    b.delete = () => {
      deleting = true;
      return b;
    };
    const answer = (): Resp => {
      if (deleting) {
        db.deletes.push(table);
        return { data: null, error: null };
      }
      if (table === "iam_settings") return db.settings;
      // Nothing old enough to archive.
      return { data: [], error: null };
    };
    b.maybeSingle = () => Promise.resolve(answer());
    b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(answer()).then(res, rej);
    return b;
  };
  return { supabaseAdmin: { from: (t: string) => chain(t) } };
});

beforeEach(() => {
  db.deletes = [];
  vi.stubEnv("AUDIT_ARCHIVE_ON_PURGE", "0");
});
afterEach(() => vi.unstubAllEnvs());

describe("purgeAuditEvents", () => {
  it("purges on the operator's window when it reads (the baseline)", async () => {
    db.settings = {
      data: { audit_retention_days: 2555, provenance_retention_days: 2555 },
      error: null,
    };
    const { purgeAuditEvents } = await import("@/utils/audit.server");
    await purgeAuditEvents(true);
    expect(db.deletes).toEqual(["audit_events", "audit_events"]);
  });

  it("deletes nothing when the retention settings cannot be read", async () => {
    db.settings = { data: null, error: { message: "connection reset" } };
    const { purgeAuditEvents } = await import("@/utils/audit.server");
    await purgeAuditEvents(true);
    // Before R252: two deletes, on the 365-day and 183-day defaults.
    expect(db.deletes).toEqual([]);
  });

  it("still uses the defaults on a deployment that has never set them", async () => {
    db.settings = { data: null, error: null };
    const { purgeAuditEvents } = await import("@/utils/audit.server");
    await purgeAuditEvents(true);
    expect(db.deletes).toEqual(["audit_events", "audit_events"]);
  });
});
