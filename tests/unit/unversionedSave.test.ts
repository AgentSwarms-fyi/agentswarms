// A save that does not say which version it edits (R303, sweep 9).
//
// FOUND IN R290'S UNEXPLAINED RUN, FIXED IN R303. Five editors write over the
// stored row only on the version they read, and leaving the version out meant
// "Overwrite with mine". A tab opened before those rounds were deployed sends
// no version, so its save was taken for an overwrite. Driven on the MCP
// builder: a tab holding the source from before another tab's autosave saved
// over it, the reply was "ok", and the other tab's line was gone. Each save
// now refuses an update that carries neither its version nor `overwrite: true`,
// before it reads or writes a table. The real handlers run here, against a
// Supabase stub that records every table touched and fails the read.
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    tables: [] as string[],
    updates: [] as Record<string, unknown>[],
    table(name: string): never {
      state.tables.push(name);
      throw new Error("reached the table");
    },
  };
  return state;
});

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (v: unknown) => unknown = (v) => v;
    const b = {
      middleware: () => b,
      validator: (v: (x: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (o: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data: unknown; context?: unknown }) =>
          h({ data: validate(opts.data), context: opts.context }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (name: string) => db.table(name),
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));

const { unversionedSave } = await import("@/lib/saveVersion");
const { biReportSave } = await import("@/utils/biReports.functions");
const { workflowSave } = await import("@/utils/workflows.functions");
const { saveEtlPipeline } = await import("@/utils/etl.functions");
const { sqlModelSave } = await import("@/utils/sqlModels.functions");
const { mcpAppSave } = await import("@/utils/mcpApps.functions");

const ID = "11111111-1111-4111-8111-111111111111";
const FP = "a".repeat(64);
const REFUSED = "did not say which version";

/** The MCP builder's user-scoped client: an update is recorded, a read fails. */
const mcpContext = {
  userId: "user-1",
  supabase: {
    from: (name: string) => ({
      update: (patch: Record<string, unknown>) => {
        db.tables.push(name);
        db.updates.push(patch);
        return { eq: async () => ({ error: null }) };
      },
      select: () => db.table(name),
    }),
  },
};

type Call = (extra: Record<string, unknown>) => unknown;
const call =
  (fn: unknown, base: Record<string, unknown>, context?: unknown): Call =>
  (extra) =>
    (fn as (o: { data: unknown; context?: unknown }) => unknown)({
      data: { ...base, ...extra },
      context,
    });

/** What a save answered: its error, the message it threw, or its reply. */
async function outcome(run: () => unknown): Promise<string> {
  try {
    const r = (await run()) as { ok?: boolean; error?: string } | null;
    return r && r.ok === false && r.error ? r.error : JSON.stringify(r);
  } catch (e) {
    return (e as Error).message;
  }
}

const SAVES: { what: string; save: Call; version: Record<string, unknown> }[] = [
  {
    what: "report",
    save: call(biReportSave, {
      accessToken: "t",
      id: ID,
      name: "R303 report",
      page: { size: "a4", orientation: "portrait", margin: 36 },
      header: {},
      footer: {},
      blocks: [],
    }),
    version: { expectedUpdatedAt: "2026-10-06T00:00:00.000Z" },
  },
  {
    what: "workflow",
    save: call(workflowSave, {
      accessToken: "t",
      id: ID,
      name: "R303 workflow",
      schedule: "manual",
      overlap: "skip",
      notifyOn: "never",
      timeoutMinutes: 60,
      isActive: true,
      nodes: [],
      edges: [],
      params: [],
    }),
    version: { expectedUpdatedAt: "2026-10-06T00:00:00.000Z" },
  },
  {
    what: "pipeline",
    save: call(saveEtlPipeline, {
      access_token: "t",
      id: ID,
      name: "r303",
      mode: "code",
      source_code: "print(1)",
    }),
    version: { expected_fingerprint: FP },
  },
  {
    what: "model",
    save: call(sqlModelSave, {
      access_token: "t",
      id: ID,
      name: "r303",
      schema_name: "analytics",
      sql: "select 1",
      materialization: "table",
      tests: [],
      schedule: "manual",
    }),
    version: { expected_fingerprint: FP },
  },
  {
    what: "MCP server's source",
    save: call(mcpAppSave, { id: ID, source_code: "print(1)", requirements: "" }, mcpContext),
    version: { expected_source_fingerprint: FP },
  },
];

beforeEach(() => {
  db.tables = [];
  db.updates = [];
});

describe("unversionedSave", () => {
  it("lets a save through with its version or an explicit overwrite, and only then", () => {
    expect(unversionedSave("report", { version: "2026-10-06" })).toBeNull();
    expect(unversionedSave("report", { version: undefined, overwrite: true })).toBeNull();
    expect(unversionedSave("report", { version: null, overwrite: false })).toContain(REFUSED);
    expect(unversionedSave("report", { version: "" })).toBe(
      "This save did not say which version of the report it was editing, so it could have undone a save made since. Nothing was saved. The page was most likely opened before the app was updated: copy your changes, reload the page, and save again.",
    );
  });
});

describe.each(SAVES)("saving a $what", ({ what, save, version }) => {
  it("refuses an update with neither, before touching a table", async () => {
    expect(await outcome(() => save({}))).toBe(unversionedSave(what, { version: undefined }));
    expect(db.tables).toEqual([]);
  });

  it("goes past the check with the version it read", async () => {
    expect(await outcome(() => save(version))).not.toContain(REFUSED);
  });

  it("goes past the check when asked to overwrite", async () => {
    expect(await outcome(() => save({ overwrite: true }))).not.toContain(REFUSED);
  });
});

describe("a new row has no version to send", () => {
  it.each([
    ["report", SAVES[0].save, { id: null }],
    ["pipeline", SAVES[2].save, { id: undefined }],
    ["model", SAVES[3].save, { id: null }],
  ])("a new %s goes past the check", async (_what, save, extra) => {
    expect(await outcome(() => save(extra))).not.toContain(REFUSED);
  });
});

describe("the MCP builder's settings", () => {
  it("save without a fingerprint: they are not the source", async () => {
    const out = await outcome(() =>
      (mcpAppSave as unknown as (o: unknown) => unknown)({
        data: { id: ID, keep_warm: true },
        context: mcpContext,
      }),
    );
    expect(out).toBe('{"ok":true}');
    expect(db.updates).toEqual([{ keep_warm: true }]);
  });

  it("the packages alone are the source too", async () => {
    const out = await outcome(() =>
      (mcpAppSave as unknown as (o: unknown) => unknown)({
        data: { id: ID, requirements: "stripe" },
        context: mcpContext,
      }),
    );
    expect(out).toContain(REFUSED);
    expect(db.updates).toEqual([]);
  });

  it("an overwrite writes the source, and not the word overwrite", async () => {
    expect(await outcome(() => SAVES[4].save({ overwrite: true }))).toBe('{"ok":true}');
    expect(db.updates).toEqual([{ source_code: "print(1)", requirements: "" }]);
  });
});
