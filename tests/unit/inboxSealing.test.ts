// Approval requests and notifications under their owner's user key (R450).
//
// An approval's text is read by other users, so it stays under the OWNER'S key
// and the server opens it for whoever row-level security lets see the row. A
// request that cannot be sealed is still raised, and a notification that cannot
// be sealed is still written: each may be the only sign of what it reports. What
// leaves the app, an email or a channel message, is a copy outside all this.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";

const h = vi.hoisted(() => ({
  db: null as null | { from: (t: string) => unknown },
  // What row-level security lets each token see; the admin client sees it all.
  visible: {} as Record<string, unknown[]>,
  rlsAsked: [] as string[],
  mails: [] as Array<{ to: string; html: string }>,
  posted: [] as Array<{ title: string; body: string }>,
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      validator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (fn: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        fn({ data: validate(opts.data) }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      getUser: async (token: string) =>
        token === "alice-token"
          ? { data: { user: { id: "00000000-0000-4000-8000-00000000a11c" } }, error: null }
          : token === "bob-token"
            ? { data: { user: { id: "00000000-0000-4000-8000-000000000b0b" } }, error: null }
            : { data: { user: null }, error: { message: "invalid JWT" } },
      admin: {
        getUserById: async (id: string) => ({
          data: { user: { email: `${id.slice(-4)}@x.test` } },
        }),
      },
    },
    from: (t: string) => h.db!.from(t),
  },
}));
vi.mock("@supabase/supabase-js", async () => {
  const { fakePostgrest } = await import("../fixtures/fakePostgrest");
  const real =
    await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
  return {
    ...real,
    createClient: (
      _u: string,
      _k: string,
      o: { global: { headers: { Authorization: string } } },
    ) => {
      const t = o.global.headers.Authorization.replace("Bearer ", "");
      h.rlsAsked.push(t);
      return fakePostgrest({ approvals: (h.visible[t] ?? []) as never[] }).client;
    },
  };
});
vi.mock("@/lib/email/mailer.server", () => ({
  sendMail: async (m: { to: string; html: string }) => {
    h.mails.push(m);
    return { sent: true };
  },
}));
vi.mock("@/utils/providers/integrationConfig.server", () => ({
  resolveIntegrationConfig: async () => ({ webhook_url: "https://hooks.example.test/x" }),
}));
vi.mock("@/utils/integrations/testAdapters.server", () => ({
  postNotification: async (_p: string, _u: string, n: { title: string; body: string }) => {
    h.posted.push(n);
    return { ok: true, detail: "ok" };
  },
}));

import { __setKeyHierarchyForTests, keyHierarchy } from "@/utils/providers/crypto.server";
import { DataKeyUnavailableError } from "@/utils/kms/keyHierarchy.server";
import { isSealedJson } from "@/utils/chat/sealedThreads.server";
import {
  inboxSealPerPass,
  NOT_KEPT_BODY,
  NOT_KEPT_TITLE,
  openApprovalDescription,
  openApprovalRow,
  openApprovalRows,
  openNotificationRow,
  sealApprovalBody,
  sealNotification,
  sealOlderInbox,
} from "@/utils/sealedInbox.server";
import { inboxPassDetail } from "@/utils/inboxPass";
import {
  listNotifications,
  listPendingApprovals,
  raiseSwarmApproval,
} from "@/utils/inbox.functions";
import { notifySwarmApprovers } from "@/utils/swarmApprovals.functions";
import { notifyUser, storeNotification } from "@/utils/notify.server";
import { storedFilesPassLine } from "@/utils/storage/storedFiles";
import { fakePostgrest, type FakeDb } from "../fixtures/fakePostgrest";
import { memoryKeyStore, missingKeyStore, type MemoryKeyStore } from "../fixtures/keyStores";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const TEXT = "Refund Halvard 240 for a damaged item";

let fake: FakeDb;
let mem: MemoryKeyStore;

beforeEach(() => {
  process.env.PROVIDER_CREDS_SECRET = "f".repeat(64);
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  process.env.SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_PUBLISHABLE_KEY = "anon";
  fake = fakePostgrest({
    approvals: [],
    notifications: [],
    swarm_runs: [],
    profiles: [],
    iam_group_members: [],
    integrations: [],
  });
  h.db = fake.client as never;
  h.visible = {};
  h.rlsAsked = [];
  h.mails = [];
  h.posted = [];
  mem = memoryKeyStore();
  __setKeyHierarchyForTests(mem.store);
});
afterEach(() => {
  __setKeyHierarchyForTests(null);
  delete process.env.DATA_KEY_CACHE_SECONDS;
  vi.restoreAllMocks();
});

const ok = <T>(r: T): Exclude<T, { ok: false }> => {
  const v = r as { ok: boolean; error?: string };
  if (!v.ok) throw new Error(`expected ok: ${v.error}`);
  return r as Exclude<T, { ok: false }>;
};
const noText = (v: unknown) => expect(JSON.stringify(v)).not.toMatch(/Halvard/);
const refuseKeys = (who?: string) => {
  __setKeyHierarchyForTests({
    ...mem.store,
    activeUserKey: async (u: string) => {
      if (!who || u === who) throw new DataKeyUnavailableError("revoked", "denied");
      return mem.store.activeUserKey(u);
    },
  });
  keyHierarchy().forgetAll();
};

const approval = (over: Record<string, unknown> = {}) => ({
  id: ID1,
  user_id: ALICE,
  agent_name: "Human approval",
  action_type: "swarm_step",
  action_title: "Approve this request",
  description: TEXT as string | null,
  payload: { last_output: TEXT } as unknown,
  risk_level: "medium",
  status: "pending",
  approver_user_ids: [] as string[],
  approver_group_ids: [] as string[],
  created_at: new Date().toISOString(),
  ...over,
});
const sealed = async (over: Record<string, unknown> = {}) => {
  const row = approval(over);
  return { ...row, ...(await sealApprovalBody(row.user_id, row.id, row.action_type, row)) };
};
const notification = (over: Record<string, unknown> = {}) => ({
  id: ID1,
  user_id: ALICE,
  kind: "insight",
  title: "Halvard moved",
  body: "Revenue at Halvard fell 12%",
  link: "/ai-analyst",
  read_at: null as string | null,
  created_at: new Date().toISOString(),
  ...over,
});

describe("an approval request, as it is stored", () => {
  it("holds none of the step's text, and opens to what it was", async () => {
    const stored = await sealed();
    noText(stored);
    expect(stored.description).toMatch(/^ck1:/);
    expect(isSealedJson(stored.payload)).toBe(true);
    expect(await openApprovalRow(stored)).toMatchObject({
      description: TEXT,
      payload: { last_output: TEXT },
      action_title: "Approve this request",
      body_sealed: true,
      body_dropped: false,
      body_unreadable: null,
    });
  });

  it.each(["description", "payload"] as const)(
    "does not open on another row: %s, alone",
    async (c) => {
      const a = await sealed();
      const b = await sealed({ id: ID2 });
      const moved = await openApprovalRow({ ...b, [c]: a[c] });
      expect(moved.body_unreadable).toMatch(/It did not open/);
      noText(moved);
    },
  );

  it("a workflow's message is sealed, and its ids stay readable", async () => {
    const payload = { workflow_run_id: "r1", node_run_id: "n1" };
    const stored = await sealed({ action_type: "workflow_step", payload });
    noText(stored);
    expect(stored.payload).toEqual(payload);
    expect(await openApprovalRow(stored)).toMatchObject({ description: TEXT, payload });
  });

  it("as it was before the user-key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    const stored = await sealed();
    expect(stored).toMatchObject({ description: TEXT, payload: { last_output: TEXT } });
  });

  it("reads as it is from before R450, and a model promotion as ever", async () => {
    expect(await openApprovalRow(approval())).toMatchObject({
      description: TEXT,
      payload: { last_output: TEXT },
      body_sealed: false,
    });
    const promotion = { model_id: "m1", version_id: "v1" };
    expect(
      await openApprovalRow(approval({ action_type: "ml_promote", payload: promotion })),
    ).toMatchObject({ payload: promotion, body_unreadable: null });
  });
});

describe("a key that cannot be had when a request is raised", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("still raises it, without its text, and leaves nothing under another key", async () => {
    refuseKeys();
    const stored = await sealed();
    noText(stored);
    expect(JSON.stringify(stored)).not.toMatch(/ck1:/);
    expect(stored).toMatchObject({ description: null, payload: { body_dropped: true } });
    const opened = await openApprovalRow(stored);
    expect(opened).toMatchObject({ description: null, body_dropped: true, body_unreadable: null });
    expect(opened.payload).toEqual({});
  });

  it("keeps a workflow's ids, which it needs", async () => {
    refuseKeys();
    const stored = await sealed({
      action_type: "workflow_step",
      payload: { workflow_run_id: "r1" },
    });
    expect(stored.payload).toEqual({ workflow_run_id: "r1", body_dropped: true });
  });

  it("does not stop a canvas run's request being raised", async () => {
    refuseKeys();
    const r = ok(
      await raiseSwarmApproval({
        data: {
          access_token: "alice-token",
          run_id: null,
          label: "Gate",
          avatar: "x",
          title: "Approve",
          risk: "medium",
          content: TEXT,
          approver_user_ids: [],
          approver_group_ids: [],
        },
      }),
    );
    expect(fake.tables.approvals[0]).toMatchObject({ id: r.id, description: null });
    noText(fake.tables.approvals);
  });
});

describe("the inbox", () => {
  it("reads as the caller, so row-level security still decides who sees what", async () => {
    const stored = await sealed();
    // The owner's row, seen by an approver who is someone else.
    h.visible["bob-token"] = [stored];
    fake.tables.approvals.push(stored, await sealed({ id: ID2, user_id: BOB }));
    const r = ok(await listPendingApprovals({ data: { access_token: "bob-token" } }));
    expect(h.rlsAsked).toEqual(["bob-token"]);
    expect(r.approvals.map((a) => a.id)).toEqual([ID1]);
    expect(r.approvals[0]).toMatchObject({
      description: TEXT,
      payload: { last_output: TEXT },
      body_sealed: true,
    });
  });

  it("shows only what is pending", async () => {
    h.visible["alice-token"] = [await sealed(), await sealed({ id: ID2, status: "approved" })];
    const r = ok(await listPendingApprovals({ data: { access_token: "alice-token" } }));
    expect(r.approvals.map((a) => a.id)).toEqual([ID1]);
  });

  it("gives a caller with no session nothing, and asks nobody", async () => {
    expect(await listPendingApprovals({ data: { access_token: "nope" } })).toMatchObject({
      ok: false,
    });
    expect(h.rlsAsked).toEqual([]);
  });

  it("with the owner's key gone still loads, says why, and asks for the key once", async () => {
    h.visible["bob-token"] = [await sealed(), await sealed({ id: ID2 })];
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const before = mem.calls.userKeyByKid;
    const r = ok(await listPendingApprovals({ data: { access_token: "bob-token" } }));
    expect(r.approvals).toHaveLength(2);
    for (const a of r.approvals) {
      expect(a.description).toBeNull();
      expect(a.action_title).toBe("Approve this request");
      expect(a.body_unreadable).toMatch(/erased/);
    }
    // Its two columns ask together, once; the second row is not tried at all.
    expect(mem.calls.userKeyByKid - before).toBe(1);
  });

  it("one value that does not open costs one row, and does not refuse the key", async () => {
    const a = await sealed();
    const b = await sealed({ id: ID2 });
    const [first, second] = await openApprovalRows([{ ...a, description: b.description }, b]);
    expect(first!.body_unreadable).toMatch(/It did not open/);
    expect(second!.description).toBe(TEXT);
  });
});

describe("raising a request from a canvas run", () => {
  const raise = (over: Record<string, unknown> = {}) =>
    raiseSwarmApproval({
      data: {
        access_token: "alice-token",
        run_id: RUN,
        label: "Human approval",
        avatar: "x",
        title: "Approve this request",
        risk: "high",
        content: TEXT,
        approver_user_ids: [BOB],
        approver_group_ids: [],
        ...over,
      },
    });

  it("seals the text under the caller's key, bound to the row it is stored as", async () => {
    fake.tables.swarm_runs.push({ id: RUN, user_id: ALICE });
    const r = ok(await raise());
    const row = fake.tables.approvals[0] as ReturnType<typeof approval>;
    noText(row);
    expect(row).toMatchObject({
      id: r.id,
      user_id: ALICE,
      action_type: "swarm_step",
      swarm_run_id: RUN,
      approver_user_ids: [BOB],
      risk_level: "high",
    });
    expect(await openApprovalRow(row)).toMatchObject({
      description: TEXT,
      payload: { last_output: TEXT },
    });
  });

  it("cuts the description to its length, and keeps the whole text in the payload", async () => {
    const content = "x".repeat(3000);
    ok(await raise({ run_id: null, content }));
    const row = fake.tables.approvals[0] as ReturnType<typeof approval>;
    const opened = await openApprovalRow(row);
    expect(opened.description).toHaveLength(1000);
    expect(opened.payload).toEqual({ last_output: content });
  });

  it("makes the insert policy's check: a request may name only the caller's run", async () => {
    fake.tables.swarm_runs.push({ id: RUN, user_id: BOB });
    expect(await raise()).toEqual({ ok: false, error: "Run not found" });
    expect(fake.tables.approvals).toEqual([]);
  });

  it("refuses a caller with no session", async () => {
    expect(await raise({ access_token: "nope" })).toMatchObject({ ok: false });
    expect(fake.tables.approvals).toEqual([]);
  });

  it("takes no status or owner from the browser", () => {
    const src = readFileSync(path.resolve("src/utils/inbox.functions.ts"), "utf8");
    const at = src.indexOf("export const raiseSwarmApproval");
    const fn = src.slice(at, src.indexOf("export const listNotifications"));
    expect(fn).toContain("user_id: user,");
    expect(fn).toContain('action_type: "swarm_step",');
    expect(fn).not.toMatch(/\bstatus:/);
  });
});

describe("the email to approvers", () => {
  const notify = () =>
    notifySwarmApprovers({
      data: {
        access_token: "alice-token",
        approval_id: ID1,
        app_origin: "https://app.example.test",
      },
    });

  it("carries the text, opened", async () => {
    fake.tables.approvals.push(await sealed({ approver_user_ids: [BOB] }));
    expect(ok(await notify()).notified).toBe(1);
    expect(h.mails[0]!.html).toContain(TEXT);
    expect(h.mails[0]!.html).not.toMatch(/ck1:/);
  });

  it("goes without the text when it cannot be opened, rather than send the sealed form", async () => {
    fake.tables.approvals.push(await sealed({ approver_user_ids: [BOB] }));
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    expect(ok(await notify()).notified).toBe(1);
    expect(h.mails[0]!.html).toContain("Approve this request");
    expect(h.mails[0]!.html).not.toMatch(/ck1:/);
  });

  it("reads a request from before R450 as it is", async () => {
    expect(await openApprovalDescription({ id: ID1, description: "plain" })).toBe("plain");
    expect(await openApprovalDescription({ id: ID1, description: null })).toBe("");
  });
});

describe("what writes a request", () => {
  const read = (f: string) => readFileSync(path.resolve(f), "utf8");

  it("the canvas goes through the server", () => {
    const src = read("src/lib/swarmRuntime.ts");
    expect(src).toContain("await raiseApproval({");
    expect(src).not.toMatch(/\.from\("approvals"\)\s*\.insert/);
  });

  it("a server run seals what it raises, under the id it stores", () => {
    const src = read("src/utils/swarmExecute.server.ts");
    expect(src).toMatch(/const body = await sealApprovalBody\(args\.userId, id, "swarm_step"/);
    expect(src).toContain("description: body.description,");
    expect(src).toContain("payload: body.payload,");
    const at = src.indexOf('from("approvals").insert({');
    expect(src.slice(at, at + 60)).toContain("id,");
  });

  it("a workflow seals what it raises, under the id it stores", () => {
    const src = read("src/utils/workflows/adapters.server.ts");
    expect(src).toMatch(/sealApprovalBody\(userId, approvalId, "workflow_step"/);
    expect(src).toContain("id: approvalId,");
    expect(src).toContain("description: body.description,");
  });
});

describe("a notification", () => {
  it("holds none of what it says, and opens to what it was", async () => {
    const stored = await sealNotification(ALICE, ID1, notification());
    noText(stored);
    expect(stored.title).toMatch(/^ck1:/);
    expect(stored.body).toMatch(/^ck1:/);
    expect(await openNotificationRow({ ...notification(), ...stored })).toMatchObject({
      title: "Halvard moved",
      body: "Revenue at Halvard fell 12%",
      body_unreadable: null,
    });
  });

  it("seals an empty body too", async () => {
    const stored = await sealNotification(ALICE, ID1, { title: "x", body: "" });
    expect(stored.body).toMatch(/^ck1:/);
    expect((await openNotificationRow({ id: ID1, ...stored })).body).toBe("");
  });

  it.each(["title", "body"] as const)("does not open on another row: %s, alone", async (c) => {
    const a = await sealNotification(ALICE, ID1, notification());
    const b = await sealNotification(ALICE, ID2, notification());
    const moved = await openNotificationRow({ id: ID2, ...b, [c]: a[c] });
    expect(moved.title).toBe("Cannot be read");
    expect(moved.body_unreadable).toMatch(/It did not open/);
    noText(moved);
  });

  it("a key that cannot be had still leaves a notification, and says what happened to it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    refuseKeys();
    expect(await sealNotification(ALICE, ID1, notification())).toEqual({
      title: NOT_KEPT_TITLE,
      body: NOT_KEPT_BODY,
    });
  });

  it("as it was before the user-key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    const n = { title: "a", body: "b" };
    expect(await sealNotification(ALICE, ID1, n)).toEqual(n);
  });

  it("is stored under the id it is bound to", async () => {
    await storeNotification(ALICE, { title: "Halvard", body: "Halvard", link: "/x", kind: "info" });
    const row = fake.tables.notifications[0] as ReturnType<typeof notification>;
    noText(row);
    expect(row).toMatchObject({ user_id: ALICE, kind: "info", link: "/x" });
    expect(await openNotificationRow(row)).toMatchObject({ title: "Halvard", body: "Halvard" });
  });

  it("cuts what it stores to the lengths it always did", async () => {
    await storeNotification(ALICE, { title: "t".repeat(300), body: "b".repeat(3000) });
    const opened = await openNotificationRow(
      fake.tables.notifications[0] as ReturnType<typeof notification>,
    );
    expect(opened.title).toHaveLength(200);
    expect(opened.body).toHaveLength(2000);
  });

  it("is still mirrored to a channel in its own words: that copy has left the app", async () => {
    fake.tables.integrations.push({
      id: "ch",
      user_id: ALICE,
      provider: "slack",
      type: "notification",
      is_active: true,
      config: {},
    });
    await notifyUser(ALICE, { title: "Halvard moved", body: "Down 12%" });
    expect(h.posted).toEqual([
      expect.objectContaining({ title: "Halvard moved", body: "Down 12%" }),
    ]);
    noText(fake.tables.notifications);
  });

  it("every writer goes through the one way in", () => {
    for (const f of [
      "src/utils/catalog/schedule.server.ts",
      "src/utils/kb/schedule.server.ts",
      "src/utils/saas/schedule.server.ts",
    ]) {
      const src = readFileSync(path.resolve(f), "utf8");
      expect(src, f).toContain("await storeNotification(");
      expect(src, f).not.toContain('from("notifications")');
    }
  });
});

describe("the bell", () => {
  it("opens the caller's own, and one that cannot be says so in its place", async () => {
    const stored = await sealNotification(ALICE, ID1, notification());
    fake.tables.notifications.push(
      { ...notification(), ...stored },
      notification({ id: ID2, user_id: BOB, title: "Bob's" }),
      // One from before R450.
      notification({ id: ID3, title: "Older", body: "plain" }),
    );
    const r = ok(await listNotifications({ data: { access_token: "alice-token" } }));
    expect(r.notifications.map((n) => n.title).sort()).toEqual(["Halvard moved", "Older"]);

    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const after = ok(await listNotifications({ data: { access_token: "alice-token" } }));
    expect(after.notifications).toHaveLength(2);
    const gone = after.notifications.find((n) => n.id === ID1)!;
    expect(gone.title).toBe("Cannot be read");
    expect(gone.body).toMatch(/erased/);
    expect(gone.link).toBe("/ai-analyst");
  });

  it("gives a caller with no session nothing", async () => {
    expect(await listNotifications({ data: { access_token: "nope" } })).toMatchObject({
      ok: false,
    });
  });

  it("neither page reads a body itself", () => {
    const bell = readFileSync(path.resolve("src/components/NotificationBell.tsx"), "utf8");
    expect(bell).toContain("await myNotifications()");
    expect(bell).not.toContain('.select("id, kind, title, body');
    const inbox = readFileSync(path.resolve("src/components/ApprovalInbox.tsx"), "utf8");
    expect(inbox).toContain("await pendingApprovals()");
    expect(inbox).not.toMatch(/\.from\("approvals"\)\s*\.select/);
  });

  it("the new-approval toast shows only what is readable", () => {
    // Since R468 it is raised from the rows the inbox loads (a Realtime event
    // or a poll reloads them), not from the Realtime event's own row.
    const inbox = readFileSync(path.resolve("src/components/ApprovalInbox.tsx"), "utf8");
    const at = inbox.indexOf("const announce = (ap: Approval)");
    expect(at).toBeGreaterThan(-1);
    const handler = inbox.slice(at, inbox.indexOf("const load = async", at));
    expect(handler).toContain("description: ap.action_title");
    expect(handler).not.toMatch(/ap\.description|ap\.payload/);
    expect(inbox).not.toContain("payload.new");
  });
});

describe("the pass over what was kept before R450", () => {
  const writes = () => fake.log.filter((l: string) => l.startsWith("update ")).length;
  /** Runs `change` just before the pass's write, as another writer would. */
  const beforeWrite = (change: () => void) => {
    const real = fake.client.from.bind(fake.client);
    h.db = {
      from: (t: string) => {
        const q = real(t) as unknown as { update: (p: unknown) => unknown };
        const update = q.update.bind(q);
        q.update = (p: unknown) => {
          change();
          return update(p);
        };
        return q;
      },
    } as never;
  };
  /** The trigger as it is before migration 20261108000000. */
  const triggerRefusesPayloads = () => {
    const real = fake.client.from.bind(fake.client);
    h.db = {
      from: (t: string) => {
        const q = real(t) as unknown as { update: (p: Record<string, unknown>) => unknown };
        if (t !== "approvals") return q;
        const update = q.update.bind(q);
        q.update = (p: Record<string, unknown>) => {
          if (!("payload" in p)) return update(p);
          const refused = {
            eq: () => refused,
            not: () => refused,
            select: async () => ({
              data: null,
              error: {
                message: "An approval's identity and routing cannot be changed after it is created",
              },
            }),
          };
          return refused;
        };
        return q;
      },
    } as never;
  };

  it("seals both, says how many, and tries nothing the second time", async () => {
    fake.tables.approvals.push(approval());
    fake.tables.notifications.push(notification());
    expect(await sealOlderInbox()).toEqual({
      approvals: 1,
      notifications: 1,
      unreadable: 0,
      left: false,
      needsMigration: false,
      failed: 0,
      errors: [],
    });
    noText(fake.tables.approvals);
    noText(fake.tables.notifications);
    expect(
      await openApprovalRow(fake.tables.approvals[0] as ReturnType<typeof approval>),
    ).toMatchObject({ description: TEXT, payload: { last_output: TEXT } });
    expect(
      await openNotificationRow(fake.tables.notifications[0] as ReturnType<typeof notification>),
    ).toMatchObject({ title: "Halvard moved" });
    const before = writes();
    expect(await sealOlderInbox()).toMatchObject({ approvals: 0, notifications: 0 });
    expect(writes()).toBe(before);
  });

  it("leaves a request that holds nobody's words", async () => {
    const promotion = approval({ action_type: "ml_promote", payload: { model_id: "m1" } });
    fake.tables.approvals.push(promotion);
    expect((await sealOlderInbox()).approvals).toBe(0);
    expect(fake.tables.approvals[0]).toEqual(promotion);
    expect(writes()).toBe(0);
  });

  it("leaves an empty request, and tries nothing", async () => {
    fake.tables.approvals.push(approval({ description: "" }));
    expect((await sealOlderInbox()).approvals).toBe(0);
    expect(writes()).toBe(0);
  });

  it("does not touch a workflow's payload, so needs no migration for it", async () => {
    const payload = { workflow_run_id: "r1" };
    fake.tables.approvals.push(approval({ action_type: "workflow_step", payload }));
    triggerRefusesPayloads();
    expect(await sealOlderInbox()).toMatchObject({ approvals: 1, needsMigration: false });
    expect(fake.tables.approvals[0]!.payload).toEqual(payload);
    noText(fake.tables.approvals);
  });

  it("before the migration leaves swarm requests as they are, says so, and goes on", async () => {
    fake.tables.approvals.push(approval(), approval({ id: ID2 }));
    fake.tables.notifications.push(notification());
    triggerRefusesPayloads();
    const r = await sealOlderInbox();
    expect(r).toMatchObject({ approvals: 0, notifications: 1, needsMigration: true, failed: 0 });
    expect(fake.tables.approvals[0]).toMatchObject({ description: TEXT });
  });

  it("does not write over a request sealed while it worked", async () => {
    const newer = await sealed();
    fake.tables.approvals.push(approval());
    beforeWrite(() => Object.assign(fake.tables.approvals[0]!, newer));
    expect((await sealOlderInbox()).approvals).toBe(0);
    expect(fake.tables.approvals[0]!.description).toBe(newer.description);
  });

  it("does not write over a notification sealed while it worked", async () => {
    const newer = await sealNotification(ALICE, ID1, notification());
    fake.tables.notifications.push(notification());
    beforeWrite(() => Object.assign(fake.tables.notifications[0]!, newer));
    expect((await sealOlderInbox()).notifications).toBe(0);
    expect(fake.tables.notifications[0]!.title).toBe(newer.title);
  });

  it("stops at its limit, across both, and says more is left", async () => {
    fake.tables.approvals.push(approval());
    fake.tables.notifications.push(notification(), notification({ id: ID2 }));
    expect(await sealOlderInbox({ limit: 2 })).toMatchObject({
      approvals: 1,
      notifications: 1,
      left: true,
    });
    expect(await sealOlderInbox({ limit: 2 })).toMatchObject({ notifications: 1, left: false });
  });

  it("counts and leaves a row whose owner's key is refused, and goes on", async () => {
    fake.tables.approvals.push(approval(), approval({ id: ID2, user_id: BOB }));
    fake.tables.notifications.push(notification());
    refuseKeys(ALICE);
    expect(await sealOlderInbox()).toMatchObject({ approvals: 1, unreadable: 2, failed: 0 });
    expect(fake.tables.approvals[0]).toEqual(expect.objectContaining({ description: TEXT }));
  });

  it("does nothing before the user-key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    fake.tables.approvals.push(approval());
    fake.tables.notifications.push(notification());
    expect(await sealOlderInbox()).toMatchObject({ approvals: 0, notifications: 0 });
    expect(writes()).toBe(0);
  });

  it("reports a read that failed, and goes on to the next table", async () => {
    fake = fakePostgrest({ notifications: [notification()] });
    h.db = fake.client as never;
    const r = await sealOlderInbox();
    expect(r).toMatchObject({ notifications: 1, failed: 1 });
    expect(r.errors[0]).toMatch(/^approvals: /);
  });

  it("reports a write that failed, and goes on", async () => {
    fake.tables.notifications.push(notification(), notification({ id: ID2 }));
    const real = fake.client.from.bind(fake.client);
    let n = 0;
    h.db = {
      from: (t: string) => {
        const q = real(t) as unknown as { update: (p: unknown) => unknown };
        const update = q.update.bind(q);
        q.update = (p: unknown) => {
          if (++n > 1) return update(p);
          const refused = {
            eq: () => refused,
            not: () => refused,
            select: async () => ({ data: null, error: { message: "refused" } }),
          };
          return refused;
        };
        return q;
      },
    } as never;
    const r = await sealOlderInbox();
    expect(r).toMatchObject({ notifications: 1, failed: 1 });
    expect(r.errors[0]).toBe(`notification ${ID1}: refused`);
  });
});

describe("the migration", () => {
  const sql = readFileSync(
    path.resolve("supabase/migrations/20261108000000_approval_seal.sql"),
    "utf8",
  );

  it("lets the payload change only one way, for one role, on one kind of request", () => {
    expect(sql).toContain("current_user = 'service_role'");
    expect(sql).toContain("OLD.action_type = 'swarm_step'");
    expect(sql).toContain("NOT (OLD.payload ? 'ck1:sealed')");
    expect(sql).toContain("NEW.payload ? 'ck1:sealed'");
  });

  it("keeps every other immutable column immutable", () => {
    for (const c of [
      "user_id",
      "action_type",
      "agent_id",
      "swarm_run_id",
      "approver_user_ids",
      "approver_group_ids",
    ]) {
      expect(sql, c).toContain(`NEW.${c} IS DISTINCT FROM OLD.${c}`);
    }
  });

  it("has indexes that match what the pass asks", () => {
    expect(sql).toContain("WHERE description NOT LIKE 'ck1:%'");
    expect(sql).toContain("WHERE title NOT LIKE 'ck1:%'");
  });
});

describe("what the pass reports", () => {
  it("INBOX_SEAL_PER_PASS has a default and refuses nonsense", () => {
    expect(inboxSealPerPass("")).toBe(2000);
    expect(inboxSealPerPass("50")).toBe(50);
    expect(inboxSealPerPass("0")).toBe(2000);
    expect(inboxSealPerPass("-2")).toBe(2000);
    expect(inboxSealPerPass("lots")).toBe(2000);
    process.env.INBOX_SEAL_PER_PASS = "7";
    try {
      expect(inboxSealPerPass()).toBe(7);
    } finally {
      delete process.env.INBOX_SEAL_PER_PASS;
    }
  });

  it("is in the audit row only when it has something to say", () => {
    const empty = {
      approvals: 0,
      notifications: 0,
      unreadable: 0,
      left: false,
      needsMigration: false,
      failed: 0,
      errors: [],
    };
    expect(inboxPassDetail(empty)).toEqual({});
    expect(
      inboxPassDetail({
        approvals: 1,
        notifications: 2,
        unreadable: 3,
        left: true,
        needsMigration: true,
        failed: 4,
        errors: ["x"],
      }),
    ).toEqual({
      approvals_sealed: 1,
      notifications_sealed: 2,
      inbox_unreadable: 3,
      inbox_left: true,
      approvals_need_migration: true,
      inbox_failed: 4,
      inbox_errors: ["x"],
    });
  });

  it("reads as a line on the card", () => {
    const line = storedFilesPassLine({
      files: 0,
      documents: 0,
      dataset_copies: 0,
      approvals_sealed: 2,
      notifications_sealed: 30,
      inbox_unreadable: 1,
      inbox_left: true,
      approvals_need_migration: true,
      inbox_failed: 1,
    });
    expect(line).toContain(
      "2 approval requests, 30 notifications encrypted under their owner's key",
    );
    expect(line).toContain("1 of approvals and notifications whose owner's key cannot be had now");
    expect(line).toContain("more approvals and notifications left for the next pass");
    expect(line).toContain("older approval requests wait for migration 20261108000000");
    expect(line).toContain("1 of approvals and notifications failed");
  });
});
