// Personal data in lakehouse shares, suggested for masking and masked there
// (R554).
//
// The server module runs against an in-memory stand-in for the service-role
// client and fakes for the lake's reads. What is held: only the share's owner
// masks its columns, in the lake's spelling, and masks only grow; a mask in
// force drops the old snapshots; an approval is carried out once and gives
// its claim back on a failure; the sweep reads only shares someone can read
// now, as their owner, sees through what the share and the table's own policy
// already mask, and never asks about a column twice.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  audit: [] as Array<Record<string, unknown>>,
  notified: [] as Array<{ userId: string; title: string; body: string; link?: string }>,
  /** schema.table → its columns, or missing when it cannot be read. */
  lakeColumns: {} as Record<string, string[]>,
  /** schema.table → sampled rows, as the engine answers them (arrays). */
  sample: {} as Record<string, unknown[][]>,
  reads: [] as Array<{ userId: string; sql: string; via?: string }>,
  dropped: [] as string[],
  policies: new Map<string, { masked_columns: string[] }>(),
  failRead: null as string | null,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const subset = (have: unknown, want: unknown): boolean => {
    if (want === null || typeof want !== "object") return have === want;
    if (!have || typeof have !== "object") return false;
    return Object.entries(want as Row).every(([k, v]) => subset((have as Row)[k], v));
  };
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "insert" = "select";
    let values: Row | null = null;
    let single = false;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "range"]) b[m] = () => b;
    b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
    b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b);
    b.in = (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b);
    b.contains = (c: string, v: Row) => (filters.push((r) => subset(r[c], v)), b);
    b.update = (v: Row) => ((op = "update"), (values = v), b);
    b.insert = (v: Row) => ((op = "insert"), (values = v), b);
    b.single = b.maybeSingle = () => ((single = true), b);
    b.then = (resolve: (v: unknown) => void) => {
      const list = (db.tables[table] ??= []);
      let data: Row[];
      if (op === "insert") {
        const row = { id: `${table}-${list.length + 1}`, status: "pending", ...values };
        list.push(row);
        data = [row];
      } else {
        data = list.filter((r) => filters.every((f) => f(r)));
        if (op === "update") for (const r of data) Object.assign(r, values);
      }
      resolve(single ? { data: data[0] ?? null, error: null } : { data, error: null });
    };
    return b;
  }
  return { supabaseAdmin: { from } };
});
vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: Record<string, unknown>) => db.audit.push(e),
}));
vi.mock("@/utils/notify.server", () => ({
  notifyUser: async (userId: string, n: { title: string; body: string; link?: string }) =>
    void db.notified.push({ userId, ...n }),
}));
vi.mock("@/utils/lakehouse/tableColumns.server", () => ({
  lakehouseTableColumns: async (_u: string, schema: string, table: string) => {
    const cols = db.lakeColumns[`${schema}.${table}`];
    return cols ? cols.map((name) => ({ name, type: "VARCHAR" })) : null;
  },
}));
vi.mock("@/utils/dataMonitors/core", () => ({
  qualifiedTable: (s: string, t: string) => `"${s}"."${t}"`,
}));
vi.mock("@/utils/lakehouse/core.server", () => ({
  runLakehouseStatement: async (userId: string, sql: string, opts?: { auditVia?: string }) => {
    db.reads.push({ userId, sql, via: opts?.auditVia });
    const key = /FROM "([^"]+)"\."([^"]+)"/.exec(sql)!.slice(1).join(".");
    if (db.failRead === key) throw new Error("the engine said no");
    return {
      columns: (db.lakeColumns[key] ?? []).map((name) => ({ name, type: "VARCHAR" })),
      rows: db.sample[key] ?? [],
    };
  },
}));
vi.mock("@/utils/lakehouse/shares.server", () => ({
  dropShareTableSnapshots: async (id: string) => void db.dropped.push(id),
}));
vi.mock("@/utils/lakehouse/policies.server", () => ({
  loadPolicies: async () => db.policies,
}));

const server = await import("@/utils/lakehouse/shareMasking.server");
const { maskShareColumns, applyApprovedShareMask, sweepLakeShareMasking, liveTokens, SCAN_VIA } =
  server;
const lib = await import("@/lib/lakeShareMasking");
const { MASK_SHARE_ACTION, shareIdFromIntent, shareIntent, shareMaskFromPayload } = lib;

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SHARE = "11111111-1111-1111-1111-111111111111";
const QUIET = "22222222-2222-2222-2222-222222222222";
const ST = "33333333-3333-3333-3333-333333333333";
const ST2 = "44444444-4444-4444-4444-444444444444";
const ST_QUIET = "55555555-5555-5555-5555-555555555555";

const emails = (n: number) =>
  Array.from({ length: n }, (_, i) => [`c${i}`, `person${i}@example.com`, `${1000 + i}`]);
const shareTable = (id = ST) => db.tables.lakehouse_share_tables.find((r) => r.id === id)!;
const approvals = () => db.tables.approvals ?? [];

beforeEach(() => {
  db.audit = [];
  db.notified = [];
  db.reads = [];
  db.dropped = [];
  db.failRead = null;
  db.policies = new Map();
  db.lakeColumns = {
    "sales.customers": ["Id", "Contact", "Spend"],
    "sales.orders": ["order_id", "amount"],
  };
  db.sample = { "sales.customers": emails(20), "sales.orders": [["o1", "10"]] };
  db.tables = {
    lakehouse_shares: [
      { id: SHARE, user_id: OWNER, name: "auditors" },
      { id: QUIET, user_id: OWNER, name: "nobody-yet" },
    ],
    lakehouse_share_tables: [
      {
        id: ST,
        share_id: SHARE,
        schema_name: "sales",
        table_name: "customers",
        masked_columns: ["Spend"],
      },
      { id: ST2, share_id: SHARE, schema_name: "sales", table_name: "orders", masked_columns: [] },
      {
        id: ST_QUIET,
        share_id: QUIET,
        schema_name: "sales",
        table_name: "customers",
        masked_columns: [],
      },
    ],
    lakehouse_share_tokens: [
      { share_id: SHARE, revoked_at: null, expires_at: null, token_hash: "must-not-be-read" },
      { share_id: SHARE, revoked_at: null, expires_at: "2999-01-01T00:00:00Z" },
      { share_id: QUIET, revoked_at: "2026-11-01T00:00:00Z", expires_at: null },
      { share_id: QUIET, revoked_at: null, expires_at: "2026-01-01T00:00:00Z" },
    ],
    approvals: [],
  };
});

describe("the words and the link", () => {
  it("reads a suggestion back only from a whole payload", () => {
    const p = {
      share_id: SHARE,
      share_table_id: ST,
      share_name: "auditors",
      schema: "sales",
      table: "customers",
      columns: ["Contact"],
      findings: [{ column: "Contact", kind: "email", evidence: "20 of 20" }],
    };
    expect(shareMaskFromPayload(p)).toEqual(p);
    for (const k of ["share_id", "share_table_id", "schema", "table"]) {
      expect(shareMaskFromPayload({ ...p, [k]: "" })).toBeNull();
    }
    expect(shareMaskFromPayload({ ...p, columns: [] })).toBeNull();
    expect(shareMaskFromPayload({ ...p, columns: ["  "] })).toBeNull();
    expect(shareMaskFromPayload(null)).toBeNull();
  });

  it("opens the lakehouse page on one share, and only from a well-formed link", () => {
    expect(shareIntent(SHARE)).toBe(`share:${SHARE}`);
    expect(shareIdFromIntent(`share:${SHARE}`)).toBe(SHARE);
    expect(shareIdFromIntent("sales.customers")).toBeNull();
    expect(shareIdFromIntent("share:x")).toBeNull();
    expect(shareIdFromIntent(`share:${SHARE}/../x`)).toBeNull();
    expect(shareIdFromIntent(undefined)).toBeNull();
  });

  it("counts only tokens that can read now", () => {
    const now = new Date("2026-11-28T00:00:00Z");
    expect([
      ...liveTokens(
        db.tables.lakehouse_share_tokens as Parameters<typeof liveTokens>[0],
        now,
      ).entries(),
    ]).toEqual([[SHARE, 2]]);
  });

  it("says what approving does, with the recipients counted", () => {
    const f = [
      {
        column: "Contact",
        kind: "email" as const,
        basis: "values" as const,
        evidence: "e",
      },
    ];
    expect(lib.shareMaskDescription(f, 1)).toMatch(
      /^Contact \(email addresses\) looks personal from its values, and the one recipient who holds a token/,
    );
    expect(lib.shareMaskDescription([...f, { ...f[0], column: "Mail" }], 3)).toMatch(
      /look personal from their values, and the 3 recipients for this share can read them/,
    );
    expect(
      lib.shareMaskTitle({ schema: "sales", table: "customers", share_name: "auditors" }),
    ).toBe("Mask personal data in sales.customers in the share auditors");
  });
});

describe("masking columns in a share", () => {
  it("adds columns in the lake's spelling, keeps what it masked, and drops old snapshots", async () => {
    const res = await maskShareColumns(ST, ["contact", "spend"], OWNER);
    expect(res).toEqual({ ok: true, masked: ["Spend", "Contact"], added: ["Contact"] });
    expect(shareTable().masked_columns).toEqual(["Spend", "Contact"]);
    expect(db.dropped).toEqual([ST]);
    expect(db.audit.at(-1)).toMatchObject({
      action: "lakehouse.share.columns_masked",
      userId: OWNER,
      resourceId: SHARE,
      decisionId: null,
      detail: { table: "sales.customers", columns: ["Contact", "Spend"], added: ["Contact"] },
    });
  });

  it("changes nothing, and keeps the snapshots, when they were masked already", async () => {
    const res = await maskShareColumns(ST, ["SPEND"], OWNER);
    expect(res).toEqual({ ok: true, masked: ["Spend"], added: [] });
    expect(db.dropped).toEqual([]);
  });

  it("refuses anyone but the share's owner, with the same words as a missing one", async () => {
    const theirs = await maskShareColumns(ST, ["Contact"], OTHER);
    const missing = await maskShareColumns("nope", ["Contact"], OWNER);
    expect(theirs).toEqual({ ok: false, error: "Only the share's owner can mask its columns" });
    expect(missing).toEqual(theirs);
    expect(shareTable().masked_columns).toEqual(["Spend"]);
  });

  it("refuses a column the table does not have, or a table it cannot read", async () => {
    expect(await maskShareColumns(ST, ["Contact", "emial"], OWNER)).toEqual({
      ok: false,
      error: 'It has no column named "emial"',
    });
    delete db.lakeColumns["sales.customers"];
    expect((await maskShareColumns(ST, ["Contact"], OWNER)).ok).toBe(false);
    expect(shareTable().masked_columns).toEqual(["Spend"]);
  });
});

describe("carrying out an approved suggestion", () => {
  const file = (status: string, userId = OWNER) => {
    db.tables.approvals.push({
      id: "ap-1",
      user_id: userId,
      action_type: MASK_SHARE_ACTION,
      status,
      resumed_at: null,
      payload: {
        share_id: SHARE,
        share_table_id: ST,
        share_name: "auditors",
        schema: "sales",
        table: "customers",
        columns: ["Contact"],
        findings: [],
      },
    });
    return "ap-1";
  };

  it("masks once, as the owner", async () => {
    const id = file("approved");
    expect(await applyApprovedShareMask(id, OWNER)).toEqual({
      ok: true,
      masked: ["Spend", "Contact"],
      added: ["Contact"],
      shareId: SHARE,
    });
    expect(db.audit.at(-1)).toMatchObject({ decisionId: id, detail: { approval_id: id } });
    expect(await applyApprovedShareMask(id, OWNER)).toEqual({
      ok: false,
      error: "It has already been carried out",
    });
    expect(db.dropped).toEqual([ST]);
  });

  it("does nothing for a pending, someone else's, or another kind of approval", async () => {
    const id = file("pending");
    expect(await applyApprovedShareMask(id, OWNER)).toEqual({ ok: false, error: "It was pending" });
    expect(await applyApprovedShareMask(id, OTHER)).toEqual({
      ok: false,
      error: "Approval not found",
    });
    approvals()[0].status = "approved";
    approvals()[0].action_type = "dataset.hide_columns";
    expect((await applyApprovedShareMask(id, OWNER)).ok).toBe(false);
    expect(shareTable().masked_columns).toEqual(["Spend"]);
  });

  it("gives the claim back when the share has changed hands, so it is not lost", async () => {
    const id = file("approved");
    db.tables.lakehouse_shares[0].user_id = OTHER;
    expect((await applyApprovedShareMask(id, OWNER)).ok).toBe(false);
    expect(approvals()[0].resumed_at).toBeNull();
    db.tables.lakehouse_shares[0].user_id = OWNER;
    expect((await applyApprovedShareMask(id, OWNER)).ok).toBe(true);
  });
});

describe("the sweep", () => {
  it("asks the owner once about personal data a share's recipients can read", async () => {
    expect(await sweepLakeShareMasking(true)).toBe(1);
    expect(approvals()).toHaveLength(1);
    const ap = approvals()[0];
    expect(ap).toMatchObject({
      user_id: OWNER,
      action_type: MASK_SHARE_ACTION,
      status: "pending",
      action_title: "Mask personal data in sales.customers in the share auditors",
      risk_level: "medium",
    });
    expect(shareMaskFromPayload(ap.payload)).toMatchObject({
      share_id: SHARE,
      share_table_id: ST,
      columns: ["Contact"],
    });
    expect(String(ap.description)).toContain("the 2 recipients for this share");
    // Read as the owner, labelled as a monitor; never the quiet share's table.
    expect(db.reads.map((r) => [r.userId, r.via])).toEqual([
      [OWNER, SCAN_VIA],
      [OWNER, SCAN_VIA],
    ]);
    expect(db.reads.every((r) => r.sql.endsWith("LIMIT 500"))).toBe(true);
    expect(db.notified).toEqual([
      expect.objectContaining({
        userId: OWNER,
        link: `/lakehouse?open=${encodeURIComponent(`share:${SHARE}`)}`,
      }),
    ]);
    expect(db.audit.map((a) => a.action)).toEqual(["lakehouse.share.mask_suggested"]);
    expect(shareTable().masked_columns).toEqual(["Spend"]);
  });

  it("does not ask again while one waits, nor about a column it asked about before", async () => {
    await sweepLakeShareMasking(true);
    expect(await sweepLakeShareMasking(true)).toBe(0);
    approvals()[0].status = "rejected";
    expect(await sweepLakeShareMasking(true)).toBe(0);
    expect(approvals()).toHaveLength(1);
  });

  it("sees through what the share or the table's own policy masks already", async () => {
    shareTable().masked_columns = ["contact"];
    expect(await sweepLakeShareMasking(true)).toBe(0);
    shareTable().masked_columns = [];
    db.policies = new Map([["sales.customers", { masked_columns: ["CONTACT"] }]]);
    expect(await sweepLakeShareMasking(true)).toBe(0);
    expect(approvals()).toEqual([]);
  });

  it("reads nothing when no share has a recipient who can read it now", async () => {
    db.tables.lakehouse_share_tokens = db.tables.lakehouse_share_tokens.filter(
      (t) => t.share_id === QUIET,
    );
    expect(await sweepLakeShareMasking(true)).toBe(0);
    expect(db.reads).toEqual([]);
  });

  it("carries on past a table it cannot read", async () => {
    db.failRead = "sales.orders";
    expect(await sweepLakeShareMasking(true)).toBe(1);
  });

  it("runs a few times a day, not on every pass", async () => {
    await sweepLakeShareMasking(true);
    expect(await sweepLakeShareMasking()).toBeNull();
  });
});

describe("where it is wired", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("is the only code that changes a shared table's masks", () => {
    // Untracked too, so a new file is held to it before it is committed.
    const hits = execSync('git grep --untracked -l "lakehouse_share_tables" -- src', {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .filter((f) => /\.update\(\s*\{\s*masked_columns/.test(read(f)));
    expect(hits).toEqual(["src/utils/lakehouse/shareMasking.server.ts"]);
    expect(read("src/components/lakehouse/SharesDialog.tsx")).toContain(
      "maskFn({ data: { shareTableId, columns } })",
    );
  });

  it("never reads a recipient token's hash", () => {
    expect(read("src/utils/lakehouse/shareMasking.server.ts")).toContain(
      '.from("lakehouse_share_tokens")\n    .select("share_id, revoked_at, expires_at");',
    );
  });

  it("rides the scheduler's pass", () => {
    expect(read("src/utils/bi/refresh.server.ts")).toMatch(
      /"lake-share-masking",[\s\S]{0,200}sweepLakeShareMasking\(force\)/,
    );
  });

  it("is carried out from the inbox only on a yes", () => {
    const inbox = read("src/components/ApprovalInbox.tsx");
    const at = inbox.indexOf("if (item?.action_type === MASK_SHARE_ACTION) {");
    const branch = inbox.slice(at, inbox.indexOf("return;\n    }\n\n", at) + 40);
    const reject = branch.indexOf('if (status === "rejected")');
    const apply = branch.indexOf("applyShareMaskFn(");
    expect(at).toBeGreaterThan(0);
    expect(reject).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(reject);
    expect(branch.slice(reject, apply)).toContain("return;");
  });

  it("opens the share a link names", () => {
    const page = read("src/routes/_authenticated/lakehouse.tsx");
    expect(page).toContain("const shareId = shareIdFromIntent(id);");
    expect(page).toContain("openShareId={askedShare}");
  });
});
