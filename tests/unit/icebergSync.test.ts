// The per-instance catalog sync: a catalog whose endpoint is down is noted on
// its row and skipped, tried again on a backoff rather than on every sync,
// and at once when a statement has just met the missing catalog (a forced
// sync). Once it answers, it is attached and its error cleared.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updates: Array<{ table: string; patch: Record<string, unknown>; id: unknown }> = [];
let rows: Array<Record<string, unknown>> = [];

/** A thenable query builder: select/eq/update chain, then resolves. */
function builder(table: string) {
  let patch: Record<string, unknown> | null = null;
  const b = {
    select: () => b,
    update: (p: Record<string, unknown>) => {
      patch = p;
      return b;
    },
    eq: (col: string, value: unknown) => {
      if (patch) updates.push({ table, patch, id: value });
      return b;
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: patch ? null : rows, error: null }).then(resolve, reject),
  };
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => builder(table) },
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));
vi.mock("@/utils/secrets.server", () => ({ resolveSecretRefs: vi.fn() }));

const { ensureIcebergCatalogs } = await import("@/utils/lakehouse/iceberg.server");

const catalog = {
  id: "11111111-2222-4333-8444-555555555555",
  user_id: "u1",
  name: "down_catalog",
  endpoint: "http://catalog.example.com",
  warehouse: "s3://iceberg/",
  auth_type: "none",
  token_secret: null,
  client_id_secret: null,
  client_secret_secret: null,
  oauth2_server_uri: null,
  storage: "lakehouse",
  is_active: true,
  last_error: "an older failure",
};

describe("ensureIcebergCatalogs", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T10:00:00Z"));
    updates.length = 0;
    rows = [catalog];
  });
  afterEach(() => {
    vi.useRealTimers();
    warn.mockClear();
  });

  it("retries a dead endpoint on a backoff, at once when forced, and clears the error when it answers", async () => {
    const run = vi.fn(async () => {
      throw new Error("Connection refused");
    });
    const c = { run } as never;

    // A forced sync tries the catalog; the failure lands on its row.
    await ensureIcebergCatalogs(c, true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(String(run.mock.calls[0][0])).toContain("ATTACH IF NOT EXISTS");
    expect(updates).toEqual([
      { table: "iceberg_catalogs", patch: { last_error: "Connection refused" }, id: catalog.id },
    ]);

    // Twenty seconds on, a routine sync runs again but leaves the failed
    // catalog alone: no attach, no write.
    vi.advanceTimersByTime(20_000);
    await ensureIcebergCatalogs(c);
    expect(run).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);

    // A forced sync (a statement just met the missing catalog) tries at once.
    await ensureIcebergCatalogs(c, true);
    expect(run).toHaveBeenCalledTimes(2);

    // After the backoff a routine sync tries again.
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await ensureIcebergCatalogs(c);
    expect(run).toHaveBeenCalledTimes(3);

    // The endpoint answers: attached, error cleared, and no further attach on
    // the next routine sync.
    run.mockResolvedValue(undefined as never);
    await ensureIcebergCatalogs(c, true);
    expect(run).toHaveBeenCalledTimes(4);
    expect(updates.at(-1)).toEqual({
      table: "iceberg_catalogs",
      patch: { last_error: null },
      id: catalog.id,
    });
    vi.advanceTimersByTime(20_000);
    await ensureIcebergCatalogs(c);
    expect(run).toHaveBeenCalledTimes(4);

    // The catalog is removed: the next routine sync detaches it.
    rows = [];
    vi.advanceTimersByTime(20_000);
    await ensureIcebergCatalogs(c);
    expect(run).toHaveBeenCalledTimes(5);
    expect(String(run.mock.calls[4][0])).toContain("DETACH");
  });
});
