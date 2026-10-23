// "Leave it blank to keep the saved key" - kept only if the saved key was read.
//
// FOUND IN R254, from the sweep-7 "writes on a blip" row: "saved secrets wiped
// on edit". A blank secret field means "keep what is stored", and the promise
// is kept by merging with the row the save reads first. Both saves dropped that
// read's error:
//
//   saveIntegrationForUser  nothing to merge with, so the save fell through to
//       an INSERT; the unique index refused it, and the 23505 retry UPDATED the
//       saved row with a config merged with nothing - blanks where its secrets
//       were. An edit that only renamed an LLM provider erased its API key.
//   gitSaveConfig  an omitted token keeps `existing.token_enc`; a failed read
//       kept null, and the upsert erased the stored token.
//
// The 23505 retry had the flaw on its own, too: it merged with the row it
// failed to find, not the row it was about to overwrite.
import { describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string; code?: string } | null };

const db = vi.hoisted(() => ({
  /** The read by id, the singleton lookup, and the 23505 retry's read. */
  byId: { data: null, error: null } as Resp,
  singleton: { data: [], error: null } as Resp,
  winner: { data: null, error: null } as Resp,
  insert: { data: null, error: null } as Resp,
  /** Every config written by an update, in order. */
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = () => {
    let op: "select" | "update" | "insert" = "select";
    let byId = false;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string) => {
      if (col === "id" && op === "select") byId = true;
      return b;
    };
    b.order = () => b;
    b.limit = () => b;
    b.update = (row: { config: Record<string, unknown> }) => {
      op = "update";
      db.updates.push(row.config);
      return b;
    };
    b.insert = (row: { config: Record<string, unknown> }) => {
      op = "insert";
      db.inserts.push(row.config);
      return b;
    };
    b.single = () => Promise.resolve(db.insert);
    b.maybeSingle = () => Promise.resolve(byId ? db.byId : db.winner);
    b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(op === "update" ? { data: null, error: null } : db.singleton).then(res, rej);
    return b;
  };
  return { supabaseAdmin: { from: () => chain() } };
});

vi.mock("@/utils/providers/crypto.server", () => ({
  encryptJson: async (v: unknown) => ({ enc: v }),
  decryptJson: async (v: { enc: unknown }) => v.enc,
}));
vi.mock("@/utils/secrets.server", () => ({
  containsSecretRef: () => false,
  resolveSecretRefsInObject: async (o: unknown) => o,
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));

const ROW_ID = "11111111-1111-1111-1111-111111111111";
const SAVED = { base_url: "https://openrouter.ai/api/v1", api_key_enc: { enc: "sk-saved" } };

function reset() {
  db.byId = { data: { id: ROW_ID, config: SAVED }, error: null };
  db.singleton = { data: [{ id: ROW_ID, config: SAVED }], error: null };
  db.winner = { data: { id: ROW_ID, config: SAVED }, error: null };
  db.insert = { data: null, error: { message: "duplicate key", code: "23505" } };
  db.updates = [];
  db.inserts = [];
}

/** An edit that renames the provider and leaves the key blank. */
const rename = {
  id: ROW_ID,
  type: "llm_provider",
  provider: "openrouter",
  name: "OpenRouter (renamed)",
  config: { base_url: "https://openrouter.ai/api/v1", api_key: "" },
  is_active: true,
};

describe("saveIntegrationForUser, leaving the key blank", () => {
  it("keeps the saved key when the row reads (the baseline)", async () => {
    reset();
    const { saveIntegrationForUser } = await import("@/utils/integrations.functions");
    expect(await saveIntegrationForUser("u1", rename)).toEqual({ ok: true, id: ROW_ID });
    expect(db.updates.at(-1)?.api_key_enc).toEqual({ enc: "sk-saved" });
  });

  it("refuses rather than erase the key when the saved row cannot be read", async () => {
    reset();
    db.byId = { data: null, error: { message: "connection reset" } };
    db.singleton = { data: null, error: { message: "connection reset" } };
    const { saveIntegrationForUser } = await import("@/utils/integrations.functions");
    const r = await saveIntegrationForUser("u1", rename);
    expect(r.ok).toBe(false);
    // Nothing written at all, and in particular no update carrying a blank key.
    expect(db.updates).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  // Each read on its own: failing both at once let either check hide behind
  // the other, and a mutation run showed it.
  it("refuses when only the id read fails, on a type with no singleton fallback", async () => {
    reset();
    db.byId = { data: null, error: { message: "connection reset" } };
    db.insert = { data: { id: "new-row" }, error: null };
    const { saveIntegrationForUser } = await import("@/utils/integrations.functions");
    const r = await saveIntegrationForUser("u1", {
      id: ROW_ID,
      type: "notification",
      provider: "slack",
      name: "Alerts (renamed)",
      config: { webhook_url: "" },
      is_active: true,
    });
    expect(r.ok).toBe(false);
    // Before R254: a second, webhook-less channel was inserted beside the real one.
    expect(db.inserts).toEqual([]);
  });

  it("refuses when only the singleton lookup fails, rather than relying on the collision", async () => {
    reset();
    db.singleton = { data: null, error: { message: "connection reset" } };
    const { saveIntegrationForUser } = await import("@/utils/integrations.functions");
    const r = await saveIntegrationForUser("u1", { ...rename, id: undefined });
    expect(r.ok).toBe(false);
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it("keeps the winner's key when a save loses the insert race", async () => {
    reset();
    // The id read finds nothing (a stale id) and so does the singleton lookup,
    // so the save inserts, collides, and updates the row that won.
    db.byId = { data: null, error: null };
    db.singleton = { data: [], error: null };
    const { saveIntegrationForUser } = await import("@/utils/integrations.functions");
    expect((await saveIntegrationForUser("u1", rename)).ok).toBe(true);
    expect(db.updates.at(-1)?.api_key_enc).toEqual({ enc: "sk-saved" });
  });
});

describe("gitSaveConfig source", () => {
  it("refuses an edit whose saved token could not be read", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/utils/gitExport.functions.ts", "utf8");
    const fn = src.slice(src.indexOf("export const gitSaveConfig"));
    const check = fn.indexOf("if (existingErr) {");
    expect(check).toBeGreaterThan(-1);
    // Before the token is decided, and so before the upsert that would erase it.
    expect(check).toBeLessThan(fn.indexOf("let token_enc = existing?.token_enc ?? null;"));
  });
});
