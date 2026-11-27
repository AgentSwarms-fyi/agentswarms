// Hiding personal columns from a dataset's shares, and asking first (R521).
//
// The server module runs against an in-memory stand-in for the service-role
// client: enough of PostgREST's builder (select, eq, is, in, contains,
// update, insert, single) to hold the rules that matter here, which are about
// WHICH rows change: only the dataset owner's grants, only once per approval,
// and never because an approval row said so.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  audit: [] as Array<Record<string, unknown>>,
  notified: [] as Array<{ userId: string; title: string }>,
  failUpdateOn: null as string | null,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const matches = (row: Row, filters: Array<(r: Row) => boolean>) => filters.every((f) => f(row));
  const contains = (have: unknown, want: Record<string, unknown>) =>
    !!have &&
    typeof have === "object" &&
    Object.entries(want).every(([k, v]) => (have as Row)[k] === v);
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "insert" = "select";
    let values: Row | null = null;
    let single: "one" | "maybe" | null = null;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.range = () => b;
    b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
    b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b);
    b.in = (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b);
    b.contains = (c: string, v: Record<string, unknown>) => (
      filters.push((r) => contains(r[c], v)),
      b
    );
    b.update = (v: Row) => ((op = "update"), (values = v), b);
    b.insert = (v: Row) => ((op = "insert"), (values = v), b);
    b.single = () => ((single = "one"), b);
    b.maybeSingle = () => ((single = "maybe"), b);
    b.then = (resolve: (v: unknown) => void) => {
      const list = (db.tables[table] ??= []);
      let data: Row[] = [];
      let error: { message: string } | null = null;
      if (op === "insert") {
        const row = { id: `${table}-${list.length + 1}`, status: "pending", ...values };
        list.push(row);
        data = [row];
      } else if (op === "update") {
        if (db.failUpdateOn === table) error = { message: "update refused" };
        else {
          data = list.filter((r) => matches(r, filters));
          for (const r of data) Object.assign(r, values);
        }
      } else data = list.filter((r) => matches(r, filters));
      const out = single ? { data: data[0] ?? null, error } : { data, error };
      resolve(out);
    };
    return b;
  }
  return { supabaseAdmin: { from } };
});
vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: Record<string, unknown>) => db.audit.push(e),
}));
vi.mock("@/utils/notify.server", () => ({
  notifyUser: async (userId: string, n: { title: string }) =>
    void db.notified.push({ userId, title: n.title }),
}));
vi.mock("@/utils/data/datasetRows.server", () => ({
  scanDatasetRows: async (tableId: string) => ({
    rows: (db.tables.user_data_rows ?? [])
      .filter((r) => r.table_id === tableId)
      .map((r) => r.row as Row),
    truncated: false,
  }),
}));

const {
  hideColumnsFromShares,
  applyApprovedColumnHide,
  sweepSensitiveShares,
  HIDE_COLUMNS_ACTION,
} = await import("@/utils/data/sensitiveShares.server");

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DS = "11111111-1111-1111-1111-111111111111";
const ELSEWHERE = "22222222-2222-2222-2222-222222222222";

const grant = (id: string, resource_id: string, column_mask: string[]) => ({
  id,
  resource_type: "data_table",
  resource_id,
  column_mask,
});

beforeEach(() => {
  db.audit = [];
  db.notified = [];
  db.failUpdateOn = null;
  db.tables = {
    user_data_tables: [
      {
        id: DS,
        name: "customers",
        user_id: OWNER,
        is_sample: false,
        columns: [{ name: "Email" }, { name: "phone" }, { name: "region" }],
      },
      { id: ELSEWHERE, name: "other", user_id: OTHER, is_sample: false, columns: [] },
    ],
    iam_resource_grants: [
      grant("g1", DS, []),
      grant("g2", DS, ["EMAIL"]),
      grant("g3", ELSEWHERE, []),
      { ...grant("g4", DS, []), resource_type: "bi_dashboard" },
    ],
    user_data_rows: Array.from({ length: 12 }, (_, i) => ({
      table_id: DS,
      row: { Email: `p${i}@example.com`, phone: `+1 415 555 01${10 + i}`, region: "EU" },
    })),
    approvals: [],
  };
});

const mask = (id: string) =>
  db.tables.iam_resource_grants.find((g) => g.id === id)?.column_mask as string[];

describe("hiding columns: only the owner, only narrowing", () => {
  it("adds the columns to every grant on the dataset, as the dataset spells them", async () => {
    const res = await hideColumnsFromShares(DS, ["email", "PHONE"], OWNER);
    expect(res).toEqual({ ok: true, changed: 2, grants: 2, columns: ["Email", "phone"] });
    expect(mask("g1")).toEqual(["Email", "phone"]);
    // A grant that already hid one keeps its own spelling and gains the other.
    expect(mask("g2")).toEqual(["EMAIL", "phone"]);
    // Another dataset's grant, and a dashboard grant, are untouched.
    expect(mask("g3")).toEqual([]);
    expect(mask("g4")).toEqual([]);
    expect(db.audit).toMatchObject([
      { action: "dataset.columns.hidden", userId: OWNER, resourceId: DS },
    ]);
  });

  it("answers someone else exactly as it answers a missing dataset", async () => {
    const notOwner = await hideColumnsFromShares(DS, ["email"], OTHER);
    const missing = await hideColumnsFromShares(
      "33333333-3333-3333-3333-333333333333",
      ["x"],
      OTHER,
    );
    expect(notOwner).toEqual(missing);
    expect(notOwner.ok).toBe(false);
    expect(mask("g1")).toEqual([]);
  });

  it("refuses a bundled sample, which nobody owns", async () => {
    db.tables.user_data_tables[0].is_sample = true;
    expect((await hideColumnsFromShares(DS, ["email"], OWNER)).ok).toBe(false);
  });

  it("refuses a column the dataset does not have, hiding nothing", async () => {
    const res = await hideColumnsFromShares(DS, ["email", "emial"], OWNER);
    expect(res).toEqual({ ok: false, error: 'It has no column named "emial"' });
    expect(mask("g1")).toEqual([]);
  });

  it("says so when a grant could not be changed", async () => {
    db.failUpdateOn = "iam_resource_grants";
    const res = await hideColumnsFromShares(DS, ["phone"], OWNER);
    expect(res).toEqual({ ok: false, error: "Hidden from 0 of 2 grants, then: update refused" });
    expect(db.audit).toEqual([]);
  });

  it("changes nothing, and says so, when every grant already hides them", async () => {
    await hideColumnsFromShares(DS, ["email"], OWNER);
    const again = await hideColumnsFromShares(DS, ["email"], OWNER);
    expect(again).toEqual({ ok: true, changed: 0, grants: 2, columns: ["Email"] });
  });
});

const approval = (over: Row = {}) => {
  const row = {
    id: "ap1",
    user_id: OWNER,
    action_type: HIDE_COLUMNS_ACTION,
    status: "approved",
    resumed_at: null,
    payload: { dataset_id: DS, columns: ["phone"] },
    ...over,
  };
  db.tables.approvals.push(row);
  return row;
};

describe("an approved suggestion is carried out against the dataset, once", () => {
  it("hides the columns it names", async () => {
    approval();
    const res = await applyApprovedColumnHide("ap1", OWNER);
    expect(res).toMatchObject({ ok: true, columns: ["phone"], changed: 2 });
    expect(db.audit[0]).toMatchObject({ decisionId: "ap1" });
  });

  it("only once: a second press finds it carried out", async () => {
    approval();
    await applyApprovedColumnHide("ap1", OWNER);
    expect(await applyApprovedColumnHide("ap1", OWNER)).toEqual({
      ok: false,
      error: "It has already been carried out",
    });
    expect(db.audit).toHaveLength(1);
  });

  it("a forged row naming someone else's dataset hides nothing", async () => {
    // The attacker may write their own approval row, approved, naming the
    // victim's dataset. The dataset says who its owner is.
    approval({ user_id: OTHER, payload: { dataset_id: DS, columns: ["Email"] } });
    const res = await applyApprovedColumnHide("ap1", OTHER);
    expect(res).toEqual({ ok: false, error: "Only the dataset's owner can hide its columns" });
    expect(mask("g1")).toEqual([]);
    // The claim is given back, so a real failure can be retried.
    expect(db.tables.approvals[0].resumed_at).toBeNull();
  });

  it("someone else's approval is not found", async () => {
    approval();
    expect(await applyApprovedColumnHide("ap1", OTHER)).toEqual({
      ok: false,
      error: "Approval not found",
    });
  });

  it("refuses a pending or rejected one, and another kind of approval", async () => {
    approval({ status: "rejected" });
    expect((await applyApprovedColumnHide("ap1", OWNER)).ok).toBe(false);
    db.tables.approvals = [];
    approval({ action_type: "ml.promote" });
    expect(await applyApprovedColumnHide("ap1", OWNER)).toEqual({
      ok: false,
      error: "That approval is not a suggestion to hide columns",
    });
    expect(mask("g1")).toEqual([]);
  });
});

describe("the sweep asks the owner, once per column", () => {
  it("suggests the personal columns some grant can read, and tells the owner", async () => {
    expect(await sweepSensitiveShares(true)).toBe(1);
    const [ap] = db.tables.approvals;
    expect(ap).toMatchObject({
      user_id: OWNER,
      action_type: HIDE_COLUMNS_ACTION,
      status: "pending",
    });
    // Un-routed: row-level security lets only an un-routed approval's owner
    // decide it, and the owner is who decides about their own dataset.
    expect(ap.approver_user_ids ?? []).toEqual([]);
    expect(ap.approver_group_ids ?? []).toEqual([]);
    // g2 hides Email already, but g1 reads both.
    expect((ap.payload as { columns: string[] }).columns).toEqual(["Email", "phone"]);
    expect(String(ap.description)).toContain("the 2 grants that share it");
    expect(db.notified).toEqual([{ userId: OWNER, title: "Personal data in customers is shared" }]);
  });

  it("does not ask again while one is waiting, nor after a no", async () => {
    await sweepSensitiveShares(true);
    expect(await sweepSensitiveShares(true)).toBe(0);
    db.tables.approvals[0].status = "rejected";
    expect(await sweepSensitiveShares(true)).toBe(0);
    expect(db.tables.approvals).toHaveLength(1);
  });

  it("asks nothing when every grant already hides them", async () => {
    await hideColumnsFromShares(DS, ["Email", "phone"], OWNER);
    expect(await sweepSensitiveShares(true)).toBe(0);
  });

  it("runs on the scheduler's pass", () => {
    const pass = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
    expect(pass).toContain('"sensitive-shares"');
    expect(pass).toContain("m.sweepSensitiveShares(force)");
  });
});

describe("the inbox carries out an approved suggestion through the server", () => {
  const inbox = readFileSync("src/components/ApprovalInbox.tsx", "utf8");
  it("calls the server action, which re-checks the dataset", () => {
    expect(inbox).toContain("useServerFn(applyApprovedColumnHideFn)");
    expect(inbox).toContain("item?.action_type === HIDE_COLUMNS_ACTION");
  });
  it("does not call a suggestion a paused agent", () => {
    // The platform's suggestions (R521, R525's fixes, R554's share masks) are
    // "suggested": one condition, however it is wrapped.
    const word = /actionType === HIDE_COLUMNS_ACTION[^;{]*\)\s*return "suggested"/.exec(inbox)?.[0];
    expect(word).toBeTruthy();
    expect(word).toContain("actionType === MASK_SHARE_ACTION");
  });
});
