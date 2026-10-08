// A failed read of the Iceberg catalog list detaches nothing (R372).
//
// FOUND BY READING (R372), for the class R369 and R371 made a queue entry of:
// an unreadable answer taken for an empty one, then acted on. Every engine
// connection syncs its attached Iceberg catalogs against `iceberg_catalogs`
// every 15 s: attach what is new, detach what was removed. The read dropped
// its error, so a read that failed (the database a moment away) answered no
// catalogs, and every attached catalog was detached: a query on a mounted
// schema (`ice_sales`, here) then failed until a later sync attached it again.
//
// Run with the database client mocked to answer, then fail, then answer an
// empty list, and a connection that records the SQL it is given.
import { describe, expect, it, vi } from "vitest";

const reads: Array<{ data: unknown; error: { message: string } | null }> = [];
vi.mock("@/integrations/supabase/client.server", () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    update: () => ({
      eq: () => ({ then: (f: (v: unknown) => unknown) => Promise.resolve(f(null)) }),
    }),
    then: (f: (v: unknown) => unknown) => Promise.resolve(f(reads.shift())),
  };
  return { supabaseAdmin: { from: () => chain } };
});
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));

const { ensureIcebergCatalogs } = await import("@/utils/lakehouse/iceberg.server");

const ROW = {
  id: "11111111-2222-3333-4444-555555555555",
  user_id: "u1",
  name: "local_rest",
  endpoint: "http://192.168.1.85:8181",
  warehouse: "s3://iceberg/",
  auth_type: "none",
  token_secret: null,
  client_id_secret: null,
  client_secret_secret: null,
  oauth2_server_uri: null,
  storage: null,
  is_active: true,
  last_error: null,
};

describe("the engine's Iceberg catalogs", () => {
  it("stay attached through a read of the catalog list that failed, and leave when removed", async () => {
    const sql: string[] = [];
    const c = { run: vi.fn(async (q: string) => void sql.push(q)) };

    reads.push({ data: [ROW], error: null });
    await ensureIcebergCatalogs(c as never, true);
    expect(sql.some((q) => /^ATTACH /i.test(q.trim()))).toBe(true);

    sql.length = 0;
    reads.push({ data: null, error: { message: "fetch failed" } });
    await ensureIcebergCatalogs(c as never, true);
    expect(sql.filter((q) => /DETACH/i.test(q))).toEqual([]);

    // A list that was read, and no longer has it: that is a removal.
    reads.push({ data: [], error: null });
    await ensureIcebergCatalogs(c as never, true);
    expect(sql.filter((q) => /DETACH/i.test(q))).toHaveLength(1);
  });
});
